/**
 * Шаг 12.4 плана (docs/rework/12-durable-step-execution.md).
 *
 * Сверка стадии джобы с состоянием шагов.
 *
 * Стадия ещё **хранится** в джобе: обработчики стадий не переписывались, и они
 * же её проставляют. Полный переход на вывод стадии из шагов упирается в то,
 * что `COMPLETED_PARTIAL` — это свойство результата («собрали не всё»), а не
 * места в конвейере, и до его отдельного моделирования вывод стадии затирал бы
 * этот факт.
 *
 * Поэтому здесь не переключение, а детектор: расхождение между тем, что джоба
 * говорит о себе, и тем, что следует из шагов, перестаёт быть тихим. Это то,
 * чего не хватало раньше — дефекты 08.0-bis и 11.1 были именно расхождениями,
 * и обнаруживались только на живом платном прогоне.
 */

import { deriveJobStage } from "./step-plan";
import type { WorkflowStepRow } from "./step-types";

/** Стадии, которых вывод по шагам не описывает — они про результат, не про место. */
const RESULT_STAGES = new Set(["COMPLETED_PARTIAL", "CANCELLED"]);

export const STAGE_DRIFT_WARNING = "workflow-stage-drift";

export type StageDrift = {
  storedStage: string;
  derivedStage: string;
  warning: string;
};

/**
 * Расходятся ли хранимая и выводимая стадии.
 *
 * `null` — согласны либо сравнение неприменимо.
 */
export function detectStageDrift(
  storedStage: string | null | undefined,
  steps: readonly WorkflowStepRow[]
): StageDrift | null {
  const stored = String(storedStage ?? "").trim();
  if (!stored || steps.length === 0) return null;
  if (RESULT_STAGES.has(stored)) return null;

  const derived = deriveJobStage(steps).stage;
  if (derived === stored) return null;

  // `CLIENT_CONTENT` — внутренняя стадия шага подготовки отчёта: конвейер
  // такого различия не делает, и это не расхождение.
  if (stored === "CLIENT_CONTENT" && derived === "ORION_PREPARE") return null;

  return {
    storedStage: stored,
    derivedStage: derived,
    warning: `${STAGE_DRIFT_WARNING}:${stored}!=${derived}`,
  };
}

/** Заменяет прежнюю отметку о расхождении новой, не накапливая их. */
export function mergeDriftWarning(
  warnings: readonly string[],
  drift: StageDrift | null
): string[] {
  const kept = warnings.filter((w) => !w.startsWith(`${STAGE_DRIFT_WARNING}:`));
  return drift ? [...kept, drift.warning] : kept;
}
