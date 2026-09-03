/**
 * Подсказки Topvisor → строки автодополнения отчёта.
 *
 * Собирает их `edit/keywords_2/collect/go` (0,90 ₽ за исходную фразу), а
 * результат сервис кладёт в **свою** группу: переданный `group_id` он
 * игнорирует и заводит «DI (регион): фраза». Группа приходит выключенной
 * (`on: 0`) — и это важно деньгами: включённая, она попала бы в следующую
 * проверку позиций, а фраз в ней вчетверо больше исходных.
 *
 * `hint_generators` обязателен: с пустым списком подбор собирает ноль фраз и
 * всё равно берёт деньги (три пустых списания на пилоте). Из четырёх значений,
 * названных сервисом (`letter`, `letter_ru`, `number`, `space`), берётся
 * `space` — это базовый список подсказок, тот самый, который человек видит,
 * набирая имя; буквенные генераторы перебирают алфавит и дают не то, что
 * увидит клиент.
 */

import { createHash } from "node:crypto";
import { topvisorProviderName, type TopvisorAuditRegion } from "../regions";
import { normalizeKeyword, type SnapshotProvenance, type TopvisorObservation } from "./positions";

/** Генераторы подсказок: базовый список, а не перебор алфавита. */
export const TOPVISOR_HINT_GENERATORS = ["space"] as const;

/** Глубина подсказок: одна ступень — то, что видно в строке поиска. */
export const TOPVISOR_HINT_DEPTH = 1;

/**
 * Имя группы подбора **не годится** для защиты от двойной оплаты.
 *
 * Сервис называет её «DI (город): фраза», и в имени нет поисковика: подбор по
 * одной фразе в Яндексе и в Google Москвы даёт две группы с одинаковым именем.
 * Вдобавок сервис пишет фразу без «ё». Поэтому уже заказанный подбор узнаётся
 * по **строке задачи** (`toolName: "collect"`), которая заводится до платного
 * вызова и дополняется идентификатором группы сразу после каждого — как у
 * проверки позиций. Функция оставлена для чтения диагностики.
 */
export function isCollectGroupName(groupName: string): boolean {
  return /^di \(/i.test(String(groupName ?? "").trim());
}

type KeywordRow = { name?: unknown; group_id?: unknown };

export function suggestionsFromKeywords(input: {
  body: unknown;
  groupId: number;
  region: TopvisorAuditRegion;
  /** Исходная фраза в нашем написании — она и есть запрос строки. */
  sourceQuery: string;
  provenance: SnapshotProvenance;
}): { observations: TopvisorObservation[]; warnings: string[] } {
  const rows = ((input.body as { result?: unknown } | null)?.result ?? []) as KeywordRow[];
  const provider = topvisorProviderName(input.region.engine);
  const observations: TopvisorObservation[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (Number(row?.group_id) !== input.groupId) continue;
    const suggestion = String(typeof row.name === "string" ? row.name : "").trim();
    const key = normalizeKeyword(suggestion);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    observations.push({
      kind: "suggestion",
      surface: "autocomplete",
      region: input.region.region,
      engine: input.region.engine,
      query: input.sourceQuery,
      suggestion,
      provider,
      providerTaskId: input.provenance.providerTaskId,
      externalTaskId: input.provenance.externalTaskId,
      tool: "collect",
      caseAgent: "TOPVISOR_SUGGESTIONS",
      enrichmentRunId: input.provenance.enrichmentRunId,
      unifiedJobId: input.provenance.unifiedJobId,
      sourceUrlOrQuery: input.sourceQuery,
      clientEvidence: true,
      resultHash: createHash("sha256")
        .update([input.provenance.externalTaskId ?? "", input.region.key, input.sourceQuery, key].join("|"))
        .digest("hex"),
    });
  }

  if (observations.length === 0) {
    warnings.push(`suggestions-empty:${input.region.key}:${normalizeKeyword(input.sourceQuery)}`);
  }
  return { observations, warnings };
}
