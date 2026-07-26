/**
 * Шаг 12 плана.
 *
 * Реестр конвейера и чистые правила продвижения. Здесь нет ни БД, ни сети:
 * всё, что определяет «что делать дальше» и «где мы находимся», должно быть
 * проверяемо тестом.
 *
 * Ключевое отличие от прежней схемы: **стадия джобы выводится из состояний
 * шагов, а не хранится отдельным полем**. Раньше прогресс был представлен
 * трижды — `job.stage` + `resumeCheckpoint`, блоб `arsenkinEnrichmentState` и
 * строки `ProviderTask` — и все дефекты шагов 08.0-bis и 11.1 оказались
 * расхождениями между этими представлениями.
 */

import {
  RUNNABLE_STEP_STATES,
  type StepDefinition,
  type StepOutcome,
  type WorkflowStepRow,
} from "./step-types";

/**
 * Конвейер сбора. Порядок здесь — единственный источник правды о порядке.
 *
 * Два бюджета, и они разные:
 *
 * - `maxAttempts` — бюджет **отказов**. Сколько раз шаг вправе упасть с
 *   ошибкой и быть повторённым.
 * - `maxWaitMs` — сколько шаг вправе **ждать** внешнего события.
 *
 * Раньше это была одна величина, и ожидание тратило бюджет попыток. Число
 * пробуждений зависит от интервала опроса, поэтому «40 попыток» означало
 * около двадцати минут при паузе 30 секунд — ровно длину честного прогона
 * Arsenkin. На живом прогоне шаг `ARSENKIN_ENRICHMENT` умер с
 * `STEP_ATTEMPTS_EXCEEDED`, пока провайдер работал и агенты завершались один
 * за другим (шаг 15).
 */
export const UNIFIED_PIPELINE: readonly StepDefinition[] = [
  {
    name: "BASE_COLLECTION",
    position: 1,
    stage: "BASE_COLLECTION",
    maxAttempts: 10,
    maxWaitMs: 30 * 60_000,
  },
  {
    name: "ARSENKIN_ENRICHMENT",
    position: 2,
    stage: "ARSENKIN_ENRICHMENT",
    maxAttempts: 10,
    // Совпадает с потолком ожидания обогащения в `arsenkin-poll-budget`:
    // два разных предела на одно и то же ожидание противоречили бы друг другу.
    maxWaitMs: 4 * 60 * 60_000,
  },
  {
    name: "COMPOSITE_MERGE",
    position: 3,
    stage: "COMPOSITE_MERGE",
    maxAttempts: 10,
    maxWaitMs: 30 * 60_000,
  },
  {
    name: "REPORT_PREPARE",
    position: 4,
    stage: "ORION_PREPARE",
    maxAttempts: 10,
    maxWaitMs: 60 * 60_000,
  },
] as const;

/** Потолок ожидания шага, если реестр его не задаёт. */
export const DEFAULT_STEP_MAX_WAIT_MS = 60 * 60_000;

export function stepDefinition(name: string): StepDefinition | null {
  return UNIFIED_PIPELINE.find((s) => s.name === name) ?? null;
}

/** Право шага ждать внешнего события, мс. */
export function stepMaxWaitMs(name: string | undefined): number {
  return stepDefinition(name ?? "")?.maxWaitMs ?? DEFAULT_STEP_MAX_WAIT_MS;
}

/** Шаги конвейера в порядке исполнения, отсортированные по позиции. */
function ordered(steps: readonly WorkflowStepRow[]): WorkflowStepRow[] {
  return [...steps].sort((a, b) => a.position - b.position);
}

/**
 * Какой шаг исполнять следующим.
 *
 * Конвейер строго последовательный: шаг не начинается, пока предыдущий не
 * завершён. `null` означает, что делать нечего — либо всё готово, либо работа
 * упёрлась в отказ, либо ближайший шаг ещё спит.
 */
export function nextRunnableStep(
  steps: readonly WorkflowStepRow[],
  now: Date
): WorkflowStepRow | null {
  for (const step of ordered(steps)) {
    if (step.state === "DONE" || step.state === "SKIPPED") continue;
    // Отказ останавливает конвейер: следующие шаги работали бы на неполных
    // данных, а это дороже простоя.
    if (step.state === "FAILED") return null;
    // Чужая живая лиза — шаг уже исполняется другим процессом.
    if (step.leaseUntil && step.leaseUntil.getTime() > now.getTime()) return null;
    if (!RUNNABLE_STEP_STATES.has(step.state) && step.state !== "RUNNING") return null;
    if (step.nextRunAt && step.nextRunAt.getTime() > now.getTime()) return null;
    return step;
  }
  return null;
}

export type DerivedJobStage = {
  stage: string;
  status: "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";
  /** Доля завершённых шагов — то же, что раньше держал `progress`. */
  progress: number;
};

/**
 * Стадия и статус джобы, выведенные из шагов.
 *
 * Прежде это были отдельные поля, которые каждый обработчик обновлял сам, и
 * рассинхронизация с реальностью была вопросом времени.
 */
export function deriveJobStage(
  steps: readonly WorkflowStepRow[],
  /**
   * Полнота результата — свойство того, что собрали, а не места в конвейере.
   * Без неё вывод стадии затирал бы факт «собрали не всё» (шаг 12.4b).
   */
  completeness?: "full" | "partial" | null
): DerivedJobStage {
  const list = ordered(steps);
  if (list.length === 0) {
    return { stage: "BASE_COLLECTION", status: "WAITING", progress: 0 };
  }

  const settled = list.filter((s) => s.state === "DONE" || s.state === "SKIPPED").length;
  const progress = settled / list.length;

  const failed = list.find((s) => s.state === "FAILED");
  if (failed) {
    // Признак повторяемости — запланированный повтор, а не остаток бюджета.
    // Невосстановимый отказ (`retryable: false`) закрывает шаг, не потратив
    // весь бюджет, и по числу попыток выглядел бы как «можно попробовать ещё»,
    // то есть выдавал бы безнадёжную джобу за восстановимую.
    const willRetry = failed.nextRunAt !== null && failed.attempts < failed.maxAttempts;
    return {
      stage: willRetry ? "FAILED_RETRYABLE" : "FAILED_TERMINAL",
      status: "FAILED",
      progress,
    };
  }

  const current = list.find((s) => s.state !== "DONE" && s.state !== "SKIPPED");
  if (!current) {
    return {
      stage: completeness === "partial" ? "COMPLETED_PARTIAL" : "REPORT_READY",
      status: "COMPLETED",
      progress: 1,
    };
  }

  const def = stepDefinition(current.name);
  return {
    stage: def?.stage ?? current.name,
    status: current.state === "RUNNING" ? "RUNNING" : "WAITING",
    progress,
  };
}

/**
 * Экспоненциальная задержка с потолком.
 *
 * Потолок в 30 секунд взят не из воздуха: на нём построен допуск застоя в
 * `isPollOverdue` (две минуты тишины заведомо вне нормы, шаг 11.1-bis).
 * Меняя одно, надо менять другое.
 */
export const MAX_STEP_BACKOFF_MS = 30_000;

export function stepBackoffMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(MAX_STEP_BACKOFF_MS, 2_000 * 2 ** Math.min(n, 4));
}

export type StepTransition = {
  state: WorkflowStepRow["state"];
  attempts: number;
  nextRunAt: Date | null;
  outputRef?: string | null;
  lastError: string | null;
  lastErrorCode: string | null;
  finished: boolean;
};

/**
 * Как исход исполнения превращается в новое состояние строки.
 *
 * Отдельная чистая функция, потому что именно здесь легко ошибиться: молчаливо
 * оставить шаг в RUNNING (и получить вечно висящую джобу) или считать ожидание
 * попыткой (и сжечь бюджет на работе, которая идёт штатно).
 */
export function applyStepOutcome(
  step: Pick<WorkflowStepRow, "attempts" | "maxAttempts"> & {
    name?: string;
    /** Начало исполнения — от него отсчитывается право ждать. */
    startedAt?: Date | null;
  },
  outcome: StepOutcome,
  now: Date
): StepTransition {
  switch (outcome.kind) {
    case "done":
      return {
        state: "DONE",
        attempts: step.attempts,
        nextRunAt: null,
        outputRef: outcome.outputRef ?? null,
        lastError: null,
        lastErrorCode: null,
        finished: true,
      };

    case "skipped":
      return {
        state: "SKIPPED",
        attempts: step.attempts,
        nextRunAt: null,
        lastError: outcome.reason,
        lastErrorCode: "SKIPPED",
        finished: true,
      };

    case "waiting": {
      // Ожидание бюджет отказов НЕ тратит. Опасение «провайдер никогда не
      // ответит» верное, но граница для него — время, а не число пробуждений:
      // число пробуждений зависит от интервала опроса, и «40 попыток»
      // означало двадцать минут при паузе 30 секунд (шаг 15).
      const maxWaitMs = stepMaxWaitMs(step.name);
      const startedMs = step.startedAt ? step.startedAt.getTime() : null;
      const waitedMs = startedMs == null ? 0 : now.getTime() - startedMs;
      if (waitedMs > maxWaitMs) {
        return {
          state: "FAILED",
          attempts: step.attempts,
          nextRunAt: null,
          lastError:
            `Шаг ждал внешнего события ${Math.round(waitedMs / 60_000)} минут ` +
            `(предел ${Math.round(maxWaitMs / 60_000)})`,
          lastErrorCode: "STEP_WAIT_TIMEOUT",
          finished: true,
        };
      }
      const delay = outcome.retryAfterMs ?? stepBackoffMs(step.attempts);
      return {
        state: "WAITING",
        attempts: step.attempts,
        nextRunAt: new Date(now.getTime() + delay),
        lastError: null,
        lastErrorCode: null,
        finished: false,
      };
    }

    case "failed": {
      const attempts = step.attempts + 1;
      const exhausted = !outcome.retryable || attempts >= step.maxAttempts;
      return {
        state: "FAILED",
        attempts,
        nextRunAt: exhausted ? null : new Date(now.getTime() + stepBackoffMs(attempts)),
        lastError: outcome.message,
        lastErrorCode: outcome.code,
        finished: exhausted,
      };
    }
  }
}

/**
 * Можно ли повторить упавший шаг вручную.
 *
 * Неисчерпанный бюджет попыток — да; исчерпанный требует осознанного решения
 * оператора, поэтому наверх отдаётся отдельным признаком.
 */
export function stepIsRetryable(step: Pick<WorkflowStepRow, "state" | "attempts" | "maxAttempts">): boolean {
  return step.state === "FAILED" && step.attempts < step.maxAttempts;
}
