/**
 * Шаг 12.4 плана.
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

import { STAGE_OWNER, deriveJobStage } from "./step-plan";
import type { WorkflowStepRow } from "./step-types";

/**
 * Стадии, которых вывод по шагам не описывает.
 *
 * `COMPLETED_PARTIAL` из этого списка ушёл: полнота результата теперь хранится
 * отдельным полем `completeness`, и вывод её больше не затирает (шаг 12.4b).
 * Отмена остаётся: она приходит извне конвейера.
 */
const RESULT_STAGES = new Set(["CANCELLED"]);

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
  steps: readonly WorkflowStepRow[],
  completeness?: "full" | "partial" | null
): StageDrift | null {
  const stored = String(storedStage ?? "").trim();
  if (!stored || steps.length === 0) return null;
  if (RESULT_STAGES.has(stored)) return null;

  const derived = deriveJobStage(steps, completeness).stage;
  if (derived === stored) return null;

  // Хранимая стадия живёт внутри шага, и выведенная — стадия этого же шага:
  // конвейер такого различия не делает, и это не расхождение. Кто чей владелец
  // — один ответ на модуль, в реестре.
  if (STAGE_OWNER.get(stored) === derived) return null;

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
