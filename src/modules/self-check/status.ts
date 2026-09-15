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
 * пойдёт, — результат, упавший прогон, отказ.
 *
 * `PERSONA_DECIDED` сюда не входит: из решения по персоне посетитель идёт к
 * запуску, и заявка без результата была бы лидом, которому нечего предложить.
 */
export const LEAD_ACCEPTING_STATUSES: readonly string[] = [
  "DONE",
  "FAILED",
  "BLOCKED",
];

/** Статус заявки меняет менеджер; посетитель только создаёт её. */
export const LEAD_STATUSES = ["NONE", "NEW", "CONTACTED", "CLOSED"] as const;
