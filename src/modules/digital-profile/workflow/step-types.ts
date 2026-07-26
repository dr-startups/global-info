/**
 * Шаг 12 плана (docs/rework/12-durable-step-execution.md).
 *
 * Типы долговечного исполнения. Без React, без Prisma, без сети — чтобы
 * инварианты конвейера можно было проверить тестом, а не прогоном.
 */

/**
 * Состояния шага.
 *
 * `WAITING` отличается от `PENDING` намеренно: первое означает «шаг работает и
 * ждёт внешнего события» (задача у провайдера ещё считается), второе —
 * «шаг к исполнению готов, но ещё не начинался». Их смешение и породило
 * дефект 11.1, где идущая работа выглядела отказом.
 */
export type StepState = "PENDING" | "RUNNING" | "WAITING" | "DONE" | "FAILED" | "SKIPPED";

export const TERMINAL_STEP_STATES: ReadonlySet<StepState> = new Set<StepState>([
  "DONE",
  "FAILED",
  "SKIPPED",
]);

/** Состояния, из которых шаг ещё может быть исполнен воркером. */
export const RUNNABLE_STEP_STATES: ReadonlySet<StepState> = new Set<StepState>([
  "PENDING",
  "WAITING",
]);

export interface WorkflowStepRow {
  id: string;
  caseId: string;
  jobId: string;
  name: string;
  position: number;
  state: StepState;
  attempts: number;
  maxAttempts: number;
  nextRunAt: Date | null;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  inputHash: string | null;
  outputRef: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  /** Когда шаг впервые начал исполняться; от него отсчитывается ожидание. */
  startedAt?: Date | null;
}

/**
 * Чем закончилось исполнение шага.
 *
 * `waiting` — не ошибка: шаг отдал управление и просит разбудить его позже.
 * Именно так выражается опрос задач Arsenkin, который занимает минуты.
 */
export type StepOutcome =
  | { kind: "done"; outputRef?: string | null }
  | { kind: "waiting"; retryAfterMs?: number }
  | { kind: "failed"; code: string; message: string; retryable: boolean }
  | { kind: "skipped"; reason: string };

export interface StepDefinition {
  name: string;
  /** Порядок в конвейере: 1-based, задаёт и вывод стадии, и очередь исполнения. */
  position: number;
  /** Стадия джобы, которую этот шаг представляет во внешнем API и UI. */
  stage: string;
  /**
   * Бюджет **отказов**. Ожидание его не тратит: у ожидания своя граница —
   * `maxWaitMs` (шаг 15). Смешение этих двух вещей и убивало здоровые прогоны.
   */
  maxAttempts?: number;
  /**
   * Сколько шаг вправе ждать внешнего события, считая от начала исполнения.
   *
   * Ограничивать ожидание нужно временем, а не числом пробуждений: число
   * пробуждений зависит от интервала опроса, поэтому «40 попыток» означало
   * двадцать минут при паузе 30 секунд — ровно длину честного прогона
   * Arsenkin.
   */
  maxWaitMs?: number;
}
