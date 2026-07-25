/**
 * Шаг 12.3 плана (docs/rework/12-durable-step-execution.md).
 *
 * Мост между конвейером шагов и существующими обработчиками стадий.
 *
 * Тела обработчиков намеренно не переписываются: бизнес-логика сбора покрыта
 * смоками, и менять её одновременно со сменой исполнителя значило бы потерять
 * возможность понять, что именно сломалось. Меняется только то, **кто и когда**
 * их вызывает — вместо цепочки `setTimeout` в веб-процессе это воркер,
 * читающий расписание из базы.
 *
 * Исход шага выводится из состояния джобы после вызова: обработчики уже умеют
 * переводить джобу в следующую стадию, ждать или падать, и это их поведение
 * здесь переводится на язык `StepOutcome`.
 */

import { loadUnifiedCollectionJob } from "../services/unified-collection-job-store";
import type { UnifiedCollectionJob } from "../services/unified-collection-types";
import {
  computeUnifiedPollDelayMs,
  runUnifiedCollectionTick,
  type UnifiedOrchestratorDeps,
} from "../services/unified-orion-collection-orchestrator";
import { stepDefinition } from "./step-plan";
import type { StepHandler } from "./step-runner";
import type { StepOutcome, WorkflowStepRow } from "./step-types";

/** Стадии, дальше которых конвейер не идёт. */
const TERMINAL_STAGES = new Set([
  "REPORT_READY",
  "COMPLETED_PARTIAL",
  "FAILED_TERMINAL",
  "CANCELLED",
]);

/**
 * Что стало с джобой после вызова обработчика.
 *
 * Правило чтения: если джоба ушла со стадии шага — шаг сделан; осталась и
 * ждёт — шаг ждёт; упала — шаг упал.
 */
export function outcomeFromJob(
  step: WorkflowStepRow,
  before: UnifiedCollectionJob | null,
  after: UnifiedCollectionJob | null,
  now: Date
): StepOutcome {
  if (!after) {
    return {
      kind: "failed",
      code: "JOB_DISAPPEARED",
      message: "Джоба исчезла во время исполнения шага",
      retryable: false,
    };
  }

  if (after.cancelRequested || after.stage === "CANCELLED") {
    return { kind: "skipped", reason: "Прогон отменён" };
  }

  if (after.stage === "FAILED_TERMINAL") {
    return {
      kind: "failed",
      code: after.lastErrorCode ?? "STAGE_FAILED_TERMINAL",
      message: after.lastError ?? "Стадия завершилась терминальным отказом",
      retryable: false,
    };
  }

  if (after.stage === "FAILED_RETRYABLE") {
    return {
      kind: "failed",
      code: after.lastErrorCode ?? "STAGE_FAILED",
      message: after.lastError ?? "Стадия завершилась отказом",
      retryable: true,
    };
  }

  const stepStage = stepDefinition(step.name)?.stage ?? step.name;
  const stillHere = after.stage === stepStage || after.stage === before?.stage;

  if (!stillHere || TERMINAL_STAGES.has(after.stage)) {
    return { kind: "done", outputRef: after.compositeDatasetId ?? after.baseReportRunId ?? null };
  }

  // Осталась на своей стадии — работа продолжается. Пауза берётся из
  // расписания джобы, чтобы опрос провайдера не участился.
  return {
    kind: "waiting",
    retryAfterMs: computeUnifiedPollDelayMs(after, now.getTime()),
  };
}

/**
 * Обработчик шага поверх стадии оркестратора.
 *
 * `ORION_PREPARE` и `CLIENT_CONTENT` — две стадии одного шага `REPORT_PREPARE`:
 * обработчик один, и переход между ними для конвейера внутренний.
 */
function handlerForStage(deps: UnifiedOrchestratorDeps): StepHandler {
  return async (step: WorkflowStepRow): Promise<StepOutcome> => {
    const before = await loadUnifiedCollectionJob(step.caseId);
    if (!before) {
      return {
        kind: "failed",
        code: "JOB_NOT_FOUND",
        message: `Нет джобы для кейса ${step.caseId}`,
        retryable: false,
      };
    }
    if (TERMINAL_STAGES.has(before.stage)) {
      return { kind: "done", outputRef: before.compositeDatasetId ?? null };
    }

    const after = await runUnifiedCollectionTick(step.caseId, deps);
    return outcomeFromJob(step, before, after, deps.now?.() ?? new Date());
  };
}

/** Реестр обработчиков для воркера. */
export function unifiedStepHandlers(deps: UnifiedOrchestratorDeps = {}): Record<string, StepHandler> {
  const handler = handlerForStage(deps);
  return {
    BASE_COLLECTION: handler,
    ARSENKIN_ENRICHMENT: handler,
    COMPOSITE_MERGE: handler,
    REPORT_PREPARE: handler,
  };
}
