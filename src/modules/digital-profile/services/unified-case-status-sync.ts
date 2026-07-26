/**
 * Шаг 11.3 плана.
 *
 * У кейса есть собственный статус (`CaseStatus`), и его никто никогда не
 * двигал. Кейс, чей прогон дошёл до `REPORT_READY`, в списке и в шапке
 * оставался `DRAFT`, а рядом печатался второй статус — «Unified: Report ready».
 * Два разных ответа на один вопрос в одной строке; в списке кейсов при этом
 * все записи выглядели черновиками независимо от того, что сделано.
 *
 * Значения перечисления уже описывают жизненный цикл прогона, поэтому статус
 * кейса выводится из стадии джобы, а не хранится отдельно.
 */

import type { UnifiedCollectionStage } from "./unified-collection-types";

export type CaseStatusValue =
  | "DRAFT"
  | "COLLECTING"
  | "REVIEW"
  | "REPORT_READY"
  | "CLOSED"
  | "ARCHIVED";

/** Статусы, которые ставит человек: автоматика их не перебивает. */
const TERMINAL_HUMAN_STATUSES: ReadonlySet<CaseStatusValue> = new Set<CaseStatusValue>([
  "CLOSED",
  "ARCHIVED",
]);

const COLLECTING_STAGES: ReadonlySet<string> = new Set([
  "BASE_COLLECTION",
  "ARSENKIN_ENRICHMENT",
  "COMPOSITE_MERGE",
  "ORION_PREPARE",
  "CLIENT_CONTENT",
  // Отказ, из которого можно продолжить, — это по-прежнему идущая работа,
  // а не возврат кейса в черновик.
  "FAILED_RETRYABLE",
]);

const READY_STAGES: ReadonlySet<string> = new Set(["REPORT_READY", "COMPLETED_PARTIAL"]);

/**
 * Какой статус кейса соответствует стадии прогона. `null` — оставить как есть.
 *
 * Понижение исключено: кейс, уже дошедший до готового отчёта, не возвращается
 * в «сбор» из-за нового прогона, пока тот не даст результат.
 */
export function caseStatusForStage(
  stage: UnifiedCollectionStage | string | null | undefined,
  current: CaseStatusValue | string | null | undefined
): CaseStatusValue | null {
  const now = String(current ?? "").toUpperCase() as CaseStatusValue;
  if (TERMINAL_HUMAN_STATUSES.has(now)) return null;

  const s = String(stage ?? "").toUpperCase();
  if (READY_STAGES.has(s)) return now === "REPORT_READY" ? null : "REPORT_READY";
  if (COLLECTING_STAGES.has(s)) {
    // REVIEW и REPORT_READY — более поздние состояния, чем сбор.
    if (now === "REVIEW" || now === "REPORT_READY") return null;
    return now === "COLLECTING" ? null : "COLLECTING";
  }
  return null;
}
