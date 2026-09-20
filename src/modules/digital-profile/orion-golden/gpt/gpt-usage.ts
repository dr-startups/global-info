/**
 * Счёт расхода модели по стадиям (шаг 0119).
 *
 * Ответ API несёт `usage`, но клиент читал из него только `output_tokens` и
 * только чтобы понять, не обрезан ли ответ. На вопрос «сколько стоило дело»
 * отвечал счёт в кабинете провайдера, а не отчёт: какая стадия сколько съела,
 * было неизвестно, и экономию от смены модели нечем было измерить — ровно
 * поэтому выбор модели три месяца держался на ощущении.
 *
 * Модуль — лист: ни сети, ни базы, ни модели. Клиент записывает сюда каждый
 * ответ, подготовка отчёта снимает счёт и кладёт его артефактом рядом с
 * остальными.
 *
 * **Счёт принадлежит прогону, а не процессу** (шаг 0120). Первая редакция
 * держала его модульной переменной и обнуляла в начале подготовки — защита от
 * «следующее дело унаследует чужие числа», написанная под последовательные
 * прогоны. Три прогона 20.09.2026 пошли в одном процессе одновременно, и
 * артефакты вышли такими: у первого 259 вызовов всех трёх дел, у второго 6, у
 * третьего 0, часть вызовов потеряна чужим сбросом. Теперь у каждой подготовки
 * своя область (`AsyncLocalStorage`), и смешаться им негде. Вызовы вне области
 * (админская проверка очереди) идут в запасной счёт процесса: он никуда не
 * течёт и ничей чужой счёт не портит.
 *
 * Деньги здесь — **оценка**, и она об этом говорит: рядом с суммой едет дата
 * прайса (`GPT_PRICE_TABLE_DATE`), а модель без цены не превращается в ноль,
 * а называется в `modelsWithoutPrice` — итог тогда неполон, и это видно.
 */

import { AsyncLocalStorage } from "node:async_hooks";

import {
  CACHE_WRITE_MULTIPLIER,
  GPT_PRICE_TABLE_DATE,
  GPT_STAGE_MODELS,
  priceForModel,
  type GptServiceTier,
  type GptStage,
} from "../../config/defaults";

/**
 * Во сколько раз медленный тариф дешевле обычного.
 *
 * Провайдер считает его по цене пакетной обработки — это половина стандартной
 * цены и входа, и выхода. Без этого множителя артефакт показывал бы полную
 * цену там, где заплачена половина, и проверить, сработал ли тариф, было бы
 * нечем.
 */
const FLEX_PRICE_FACTOR = 0.5;

/** `usage` ответа OpenAI — ровно те поля, из которых складывается счёт. */
export type OpenAiUsageShape = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
};

export type GptStageUsage = {
  stage: GptStage;
  /** Русское название стадии: артефакт читает владелец, а не только код. */
  label: string;
  model: string;
  /** Тариф, по которому вызовы прошли на самом деле; `undefined` — обычный. */
  tier?: GptServiceTier;
  calls: number;
  /**
   * Вызовы, на которые провайдер не прислал счёт токенов. Считаются отдельно:
   * «ноль токенов» и «мы не знаем» — разные ответы, и молча складывать их
   * значит занижать итог, не сказав об этом.
   */
  callsWithoutUsage: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** Токены рассуждения; провайдер уже включил их в выход, здесь — для разбора. */
  reasoningTokens: number;
  /** Оценка в долларах или `null`, если у модели нет цены в таблице. */
  costUsd: number | null;
};

export type GptUsageLedger = {
  version: "gpt-usage-v1";
  /** Дата прайса, по которому посчитаны деньги. */
  priceTableDate: string;
  calls: number;
  callsWithoutUsage: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /** Сумма известных стоимостей. Неполна ровно тогда, когда список ниже непуст. */
  costUsd: number;
  /** Модели, для которых цены в таблице нет: итог выше их не учитывает. */
  modelsWithoutPrice: string[];
  byStage: GptStageUsage[];
};

type Row = Omit<GptStageUsage, "costUsd">;

/** Ключ строки — пара «стадия и модель»: смена модели на стадии обязана быть видна. */
type Rows = Map<string, Row>;

const scope = new AsyncLocalStorage<Rows>();

/**
 * Счёт вызовов, сделанных вне области прогона.
 *
 * Такие вызовы есть: авто-аналитик очереди работает из админской проверки, а
 * не из подготовки отчёта. Их некуда отнести, и запасной счёт нужен ровно для
 * того, чтобы они **не оседали** в счёте дела, которое готовится в это же
 * время.
 */
const outsideAnyRun: Rows = new Map();

function currentRows(): Rows {
  return scope.getStore() ?? outsideAnyRun;
}

/**
 * Выполнить работу в своей области счёта.
 *
 * `onUsage` вызывается **всегда**, в том числе когда работа упала: деньги за
 * упавший прогон уже потрачены, и назвать их — единственный честный ответ.
 */
export async function runWithGptUsage<T>(
  fn: () => Promise<T>,
  onUsage?: (usage: GptUsageLedger) => void
): Promise<{ value: T; usage: GptUsageLedger }> {
  const rows: Rows = new Map();
  let usage: GptUsageLedger | undefined;
  try {
    const value = await scope.run(rows, fn);
    usage = ledgerOf(rows);
    return { value, usage };
  } finally {
    onUsage?.(usage ?? ledgerOf(rows));
  }
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Стоимость вызова так, как её берёт провайдер.
 *
 * Кэшированный вход и запись кэша — **части** общего входа, а не добавка к
 * нему: провайдер считает `input_tokens` целиком и отдельно говорит, какая
 * доля пришла из кэша и какая в него записана. Поэтому обычный вход считается
 * вычитанием, иначе одни и те же токены оплачивались бы дважды.
 */
function costOf(model: string, row: Row): number | null {
  const price = priceForModel(model);
  if (!price) return null;
  const plainInput = Math.max(0, row.inputTokens - row.cachedInputTokens - row.cacheWriteTokens);
  const tierFactor = row.tier === "flex" ? FLEX_PRICE_FACTOR : 1;
  return (
    ((plainInput * price.input +
      row.cachedInputTokens * price.cachedInput +
      row.cacheWriteTokens * price.input * CACHE_WRITE_MULTIPLIER +
      row.outputTokens * price.output) *
      tierFactor) /
    1e6
  );
}

/**
 * Записать ответ модели в счёт.
 *
 * Никогда не бросает: сбой учёта не имеет права уронить оплаченный прогон.
 */
export function recordGptUsage(input: {
  stage: GptStage;
  model: string;
  /** Тариф, которым вызов прошёл: у медленного своя цена (шаг 0124). */
  tier?: GptServiceTier;
  usage?: OpenAiUsageShape | null;
}): void {
  const rows = currentRows();
  // Тариф в ключе: откат с медленного на обычный обязан быть виден строкой, а
  // не спрятан в среднем по стадии.
  const key = `${input.stage}|${input.model}|${input.tier ?? "default"}`;
  const row =
    rows.get(key) ??
    ({
      stage: input.stage,
      label: GPT_STAGE_MODELS[input.stage]?.label ?? input.stage,
      model: input.model,
      ...(input.tier ? { tier: input.tier } : {}),
      calls: 0,
      callsWithoutUsage: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    } satisfies Row);
  row.calls += 1;
  const usage = input.usage;
  if (!usage || (usage.input_tokens === undefined && usage.output_tokens === undefined)) {
    row.callsWithoutUsage += 1;
  } else {
    row.inputTokens += num(usage.input_tokens);
    row.outputTokens += num(usage.output_tokens);
    row.cachedInputTokens += num(usage.input_tokens_details?.cached_tokens);
    row.cacheWriteTokens += num(usage.input_tokens_details?.cache_write_tokens);
    row.reasoningTokens += num(usage.output_tokens_details?.reasoning_tokens);
  }
  rows.set(key, row);
}

/**
 * Обнулить счёт текущей области.
 *
 * Подготовке отчёта это больше не нужно — область у неё своя и всегда пустая;
 * остаётся для тестов и для запасного счёта процесса.
 */
export function resetGptUsage(): void {
  currentRows().clear();
}

/** Снять счёт текущей области и обнулить её. */
export function consumeGptUsage(): GptUsageLedger {
  const rows = currentRows();
  const ledger = ledgerOf(rows);
  rows.clear();
  return ledger;
}

/** Свести строки в счёт. Сами строки не трогаются. */
function ledgerOf(rows: Rows): GptUsageLedger {
  const byStage: GptStageUsage[] = [];
  const withoutPrice = new Set<string>();
  const ledger: GptUsageLedger = {
    version: "gpt-usage-v1",
    priceTableDate: GPT_PRICE_TABLE_DATE,
    calls: 0,
    callsWithoutUsage: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    modelsWithoutPrice: [],
    byStage,
  };
  for (const row of rows.values()) {
    const costUsd = costOf(row.model, row);
    if (costUsd === null) withoutPrice.add(row.model);
    else ledger.costUsd += costUsd;
    ledger.calls += row.calls;
    ledger.callsWithoutUsage += row.callsWithoutUsage;
    ledger.inputTokens += row.inputTokens;
    ledger.cachedInputTokens += row.cachedInputTokens;
    ledger.cacheWriteTokens += row.cacheWriteTokens;
    ledger.outputTokens += row.outputTokens;
    ledger.reasoningTokens += row.reasoningTokens;
    byStage.push({ ...row, costUsd });
  }
  ledger.modelsWithoutPrice = [...withoutPrice];
  return ledger;
}

/** Строка о расходе для лога прогона — читается в консоли Railway. */
export function gptUsageLogLine(ledger: GptUsageLedger): string {
  if (ledger.calls === 0) return "[digital-profile][расход] вызовов модели не было";
  const money =
    ledger.modelsWithoutPrice.length > 0
      ? `≈ $${ledger.costUsd.toFixed(2)} (без цены: ${ledger.modelsWithoutPrice.join(", ")})`
      : `≈ $${ledger.costUsd.toFixed(2)}`;
  const stages = ledger.byStage
    .map((s) => `${s.stage}${s.tier ? `/${s.tier}` : ""} ${s.calls}`)
    .join(", ");
  return (
    `[digital-profile][расход] вызовов ${ledger.calls}, вход ${ledger.inputTokens}, ` +
    `выход ${ledger.outputTokens}, ${money} по прайсу ${ledger.priceTableDate}; ${stages}`
  );
}
