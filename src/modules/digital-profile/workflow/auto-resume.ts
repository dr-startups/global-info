/**
 * Продолжит ли конвейер сам (шаг 14).
 *
 * Наблюдение с ручного тестирования: прогон показывал отказ и кнопку, при том
 * что задачи Arsenkin выполнялись, а воркер собирался вернуться к шагу по
 * расписанию. Пользователь нажимал кнопку несколько раз, и в итоге сбор
 * доходил до конца — то есть оркестрация лежала на нём.
 *
 * Кнопка уместна ровно тогда, когда без неё ничего не произойдёт. Пока у шага
 * есть запланированный повтор, звать пользователя нельзя: он не ускорит
 * провайдера, а его нажатие стоит денег и сбивает уже идущий опрос.
 *
 * Модуль чистый: принимает строки шагов и время, возвращает решение.
 */

import type { WorkflowStepRow } from "./step-types";

export type AutoResumeState = {
  /** Конвейер вернётся к работе сам. */
  pending: boolean;
  /** Когда именно (ISO), если известно. */
  resumeAt: string | null;
  /** Имя шага, который продолжится. */
  stepName: string | null;
};

export const NO_AUTO_RESUME: AutoResumeState = {
  pending: false,
  resumeAt: null,
  stepName: null,
};

/**
 * Шаг, который воркер подберёт сам.
 *
 * Это шаг в состоянии, допускающем исполнение, с назначенным сроком и
 * неисчерпанным бюджетом попыток. `RUNNING` сюда не входит намеренно: шаг уже
 * исполняется, и это отдельное состояние — «идёт», а не «вернётся».
 */
export function autoResumeState(
  steps: readonly WorkflowStepRow[],
  now: Date
): AutoResumeState {
  let best: { at: number; step: WorkflowStepRow } | null = null;
  for (const step of steps) {
    if (step.state !== "PENDING" && step.state !== "WAITING" && step.state !== "FAILED") continue;
    if (step.nextRunAt == null) continue;
    if (step.attempts >= step.maxAttempts) continue;
    const at = new Date(step.nextRunAt).getTime();
    if (!Number.isFinite(at)) continue;
    if (!best || at < best.at) best = { at, step };
  }
  if (!best) return NO_AUTO_RESUME;
  return {
    pending: true,
    // Срок в прошлом означает «уже готов к исполнению» — воркер возьмёт его
    // на ближайшем обороте, и показывать прошедшее время незачем.
    resumeAt: new Date(Math.max(best.at, now.getTime())).toISOString(),
    stepName: best.step.name,
  };
}

/**
 * Предлагать ли пользователю восстановление.
 *
 * Единственное основание — что само оно не продолжится. Всё остальное
 * (стадия, код ошибки, «выглядит как отказ») к вопросу отношения не имеет:
 * пользователь нажимает кнопку не потому, что что-то сломалось, а потому что
 * без него дело не сдвинется.
 */
export function recoveryNeedsUser(input: {
  recoveryAllowed: boolean;
  autoResume: AutoResumeState;
}): boolean {
  return input.recoveryAllowed && !input.autoResume.pending;
}
