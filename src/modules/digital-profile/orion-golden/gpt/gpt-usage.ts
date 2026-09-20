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
 * остальными. Счёт живёт в процессе, поэтому подготовка **обнуляет его в
 * начале**: иначе следующее дело унаследовало бы чужие числа.
 *
 * Деньги здесь — **оценка**, и она об этом говорит: рядом с суммой едет дата
 * прайса (`GPT_PRICE_TABLE_DATE`), а модель без цены не превращается в ноль,
 * а называется в `modelsWithoutPrice` — итог тогда неполон, и это видно.
 */

import {
  CACHE_WRITE_MULTIPLIER,
  GPT_PRICE_TABLE_DATE,
  GPT_STAGE_MODELS,
  priceForModel,
  type GptStage,
} from "../../config/defaults";

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
const rows = new Map<string, Row>();

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
  return (
    (plainInput * price.input +
      row.cachedInputTokens * price.cachedInput +
      row.cacheWriteTokens * price.input * CACHE_WRITE_MULTIPLIER +
      row.outputTokens * price.output) /
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
  usage?: OpenAiUsageShape | null;
}): void {
  const key = `${input.stage}|${input.model}`;
  const row =
    rows.get(key) ??
    ({
      stage: input.stage,
      label: GPT_STAGE_MODELS[input.stage]?.label ?? input.stage,
      model: input.model,
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

/** Обнулить счёт: подготовка отчёта делает это до первого вызова модели. */
export function resetGptUsage(): void {
  rows.clear();
}

/** Снять счёт и обнулить его. */
export function consumeGptUsage(): GptUsageLedger {
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
  rows.clear();
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
    .map((s) => `${s.stage} ${s.calls}`)
    .join(", ");
  return (
    `[digital-profile][расход] вызовов ${ledger.calls}, вход ${ledger.inputTokens}, ` +
    `выход ${ledger.outputTokens}, ${money} по прайсу ${ledger.priceTableDate}; ${stages}`
  );
}
