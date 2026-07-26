/**
 * Шаг 12 плана.
 *
 * Исполнитель шагов. Заменяет цепочку `setTimeout` внутри веб-процесса, из-за
 * которой обычный деплой посреди сбора бросал оплаченную работу: джоба
 * оставалась в WAITING навсегда, и сдвинуть её мог только человек, заметивший
 * застой.
 *
 * Расписание живёт в базе (`nextRunAt`), а не в памяти процесса, поэтому
 * перезапуск ничего не теряет: следующий цикл подберёт всё просроченное.
 */

import { randomUUID } from "node:crypto";
import { claimNextStep, completeStep, releaseStepLease } from "./step-store";
import type { StepOutcome, WorkflowStepRow } from "./step-types";

export type StepHandler = (step: WorkflowStepRow) => Promise<StepOutcome>;

export interface StepRunnerDeps {
  /** Обработчики по имени шага. Отсутствие обработчика — ошибка конфигурации. */
  handlers: Record<string, StepHandler>;
  now?: () => Date;
  /** Длина лизы: сколько шаг считается «в работе» без признаков жизни. */
  leaseMs?: number;
  ownerId?: string;
  onError?: (err: unknown, step: WorkflowStepRow | null) => void;
  /** Вызывается после записи исхода — точка сверки состояний. */
  onStepSettled?: (step: WorkflowStepRow) => Promise<void>;
}

/**
 * Исполняет один готовый шаг, если такой есть.
 *
 * Возвращает `false`, когда работы нет — цикл по этому признаку решает, спать
 * ли до следующего опроса.
 */
export async function runOneStep(deps: StepRunnerDeps): Promise<boolean> {
  const ownerId = deps.ownerId ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  const now = deps.now?.() ?? new Date();
  const step = await claimNextStep({ ownerId, leaseMs: deps.leaseMs, now });
  if (!step) return false;

  const handler = deps.handlers[step.name];
  if (!handler) {
    // Шаг без обработчика — не повод молча его потерять: он падает внятно,
    // и конвейер останавливается там, где ошибка видна.
    await completeStep({
      step,
      outcome: {
        kind: "failed",
        code: "STEP_HANDLER_MISSING",
        message: `Нет обработчика для шага ${step.name}`,
        retryable: false,
      },
      now,
    });
    return true;
  }

  let outcome: StepOutcome;
  try {
    outcome = await handler(step);
  } catch (err) {
    deps.onError?.(err, step);
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "STEP_THREW";
    outcome = { kind: "failed", code, message: message.slice(0, 500), retryable: true };
  }

  try {
    await completeStep({ step, outcome, now: deps.now?.() ?? new Date() });
    await deps.onStepSettled?.(step);
  } catch (err) {
    // Не удалось записать исход — снимаем лизу, чтобы шаг не висел «в работе»
    // до её истечения. Исход потерян, но шаг будет исполнен заново.
    deps.onError?.(err, step);
    await releaseStepLease(step.id, ownerId).catch(() => {});
  }
  return true;
}

export interface StepWorkerOptions extends StepRunnerDeps {
  /** Пауза, когда готовой работы нет. */
  idleDelayMs?: number;
  /** Сколько шагов исполнить подряд, прежде чем снова уснуть. */
  batchSize?: number;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Цикл воркера: забирать готовые шаги, спать, когда их нет.
 *
 * Выходит по `signal`, чтобы контейнер останавливался, доделав текущий шаг, а
 * не обрывая его посередине.
 */
export async function runStepWorker(options: StepWorkerOptions): Promise<void> {
  const idle = options.idleDelayMs ?? 1_000;
  const batch = Math.max(1, options.batchSize ?? 10);

  while (!options.signal?.aborted) {
    let did = 0;
    try {
      while (did < batch && !options.signal?.aborted) {
        if (!(await runOneStep(options))) break;
        did += 1;
      }
    } catch (err) {
      // Сбой самого цикла (например, недоступна БД) не должен ронять воркер:
      // иначе один разрыв соединения останавливает все прогоны до деплоя.
      options.onError?.(err, null);
    }
    if (did === 0) await sleep(idle, options.signal);
  }
}
