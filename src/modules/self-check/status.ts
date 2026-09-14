/**
 * Статусы записи проверки. Переходы только вперёд: повторный вход по той же
 * ссылке показывает текущее состояние, а не начинает заново.
 */

export const SELF_CHECK_STATUSES = [
  "CREATED",
  "PERSONA_PENDING",
  "PERSONA_DECIDED",
  "RUNNING",
  "DONE",
  "FAILED",
  "BLOCKED",
  "EXPIRED",
] as const;

export type SelfCheckStatus = (typeof SELF_CHECK_STATUSES)[number];

/**
 * Где посетитель может оставить заявку: там, откуда проверка сама дальше не
 * пойдёт, — результат, упавший прогон, отказ квоты.
 *
 * `PERSONA_DECIDED` здесь, пока ручка запуска не работает: решение по персоне
 * — последнее состояние, до которого посетитель доходит, и без него заявку
 * было бы оставить негде. Когда прогон появится, решение станет проходным
 * состоянием и из списка уйдёт.
 */
export const LEAD_ACCEPTING_STATUSES: readonly string[] = [
  "PERSONA_DECIDED",
  "DONE",
  "FAILED",
  "BLOCKED",
];

/** Статус заявки меняет менеджер; посетитель только создаёт её. */
export const LEAD_STATUSES = ["NONE", "NEW", "CONTACTED", "CLOSED"] as const;
