/**
 * Шаг 12.3 плана.
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
import { UNIFIED_PIPELINE, stepDefinition } from "./step-plan";
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
 * Позиция стадии джобы в конвейере — чтобы понимать «дошли до сюда или дальше».
 *
 * `CLIENT_CONTENT` делит позицию с `ORION_PREPARE`: это движение внутри одного
 * шага подготовки отчёта.
 */
function jobStagePosition(stage: string): number {
  const byStage = UNIFIED_PIPELINE.find((d) => d.stage === stage);
  if (byStage) return byStage.position;
  if (stage === "CLIENT_CONTENT") return 4;
  return 0;
}

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

  // Шаг завершён, когда джоба **дошла до его стадии или дальше**.
  //
  // Сравнивать «сдвинулась ли джоба за этот вызов» нельзя: если она обогнала
  // шаг ещё до его исполнения, каждый вызов выглядел бы как «работа идёт», шаг
  // ждал бы вечно и сжёг бы бюджет попыток, остановив конвейер. Ровно это и
  // случилось на первом живом прогоне.
  if (TERMINAL_STAGES.has(after.stage)) {
    return { kind: "done", outputRef: after.compositeDatasetId ?? after.baseReportRunId ?? null };
  }
  const stepPos = stepDefinition(step.name)?.position ?? 0;
  const jobPos = jobStagePosition(after.stage);
  if (jobPos > stepPos) {
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
/**
 * Стадия, к которой надо вернуть джобу перед новой попыткой шага.
 *
 * Джоба помнит прошлый отказ, а `outcomeFromJob` спрашивает именно её стадию.
 * Пока вердикт прошлой попытки лежит на джобе, новая попытка получает **чужой**
 * исход, не начав работы: на боевом прогоне 28.07 шаг `ARSENKIN_ENRICHMENT`
 * сжёг все десять попыток за 45 секунд с одним и тем же текстом
 * «41 опросов подряд» — при `pollAttempt`, сброшенном в ноль, и без единой
 * записи об исполнении в логе.
 *
 * На вопрос «упал ли этот шаг» отвечали двое — состояние шага и стадия джобы,
 * — и шаг проиграть был обязан. Перепостановка шага чинила один ответ из двух.
 *
 * Возвращается только для повторяемого отказа: `FAILED_TERMINAL` и отмена
 * остаются как есть, потому что там граница «нужно решение оператора».
 *
 * `null` — сбрасывать нечего.
 */
export function stageForRetryAttempt(
  stepName: string,
  jobStage: string | null | undefined
): string | null {
  if (jobStage !== "FAILED_RETRYABLE") return null;
  const def = UNIFIED_PIPELINE.find((d) => d.name === stepName);
  return def ? def.stage : null;
}

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

    // Вердикт прошлой попытки снимается до начала новой: иначе тик отработает,
    // а исход всё равно возьмётся из памяти джобы об отказе.
    const retryStage = stageForRetryAttempt(step.name, before.stage);
    if (retryStage) {
      const { patchUnifiedCollectionJob } = await import(
        "../services/unified-collection-job-store"
      );
      await patchUnifiedCollectionJob(step.caseId, {
        stage: retryStage as UnifiedCollectionJob["stage"],
        lastError: null,
        lastErrorCode: null,
      } as Partial<UnifiedCollectionJob>);
    }

    const after = await runUnifiedCollectionTick(step.caseId, deps);
    return outcomeFromJob(step, before, after, deps.now?.() ?? new Date());
  };
}

/**
 * Сверяет стадию джобы с состоянием шагов после каждого шага.
 *
 * Расхождение — это дефект (класс 08.0-bis и 11.1), и до сих пор оно
 * обнаруживалось только на живом платном прогоне. Теперь оно попадает в
 * предупреждения джобы, то есть видно в интерфейсе и в диагностике.
 */
export async function reconcileStageAfterStep(step: WorkflowStepRow): Promise<void> {
  try {
    const { listPipelineSteps } = await import("./step-store");
    const { patchUnifiedCollectionJob } = await import("../services/unified-collection-job-store");
    const { detectStageDrift, mergeDriftWarning } = await import("./stage-reconciliation");

    const job = await loadUnifiedCollectionJob(step.caseId);
    if (!job) return;
    const steps = await listPipelineSteps(step.jobId);
    const drift = detectStageDrift(job.stage, steps, job.completeness);
    if (!drift) {
      const cleaned = mergeDriftWarning(job.warnings ?? [], null);
      if (cleaned.length !== (job.warnings ?? []).length) {
        await patchUnifiedCollectionJob(step.caseId, { warnings: cleaned });
      }
      return;
    }

    // На границе шага побеждают шаги: место в конвейере — это их предмет.
    // Отказы исключены намеренно — их семантикой владеют обработчики стадий,
    // и переписать её здесь значило бы менять поведение вслепую.
    const settled = steps.find((s) => s.id === step.id);
    const boundary =
      settled?.state === "DONE" || settled?.state === "SKIPPED";
    const failureInvolved =
      drift.derivedStage.startsWith("FAILED") || drift.storedStage.startsWith("FAILED");

    if (boundary && !failureInvolved) {
      console.warn(
        `[workflow] стадия джобы ${job.unifiedJobId} приведена к шагам: ` +
          `${drift.storedStage} → ${drift.derivedStage}`
      );
      await patchUnifiedCollectionJob(step.caseId, {
        stage: drift.derivedStage as UnifiedCollectionJob["stage"],
        warnings: mergeDriftWarning(job.warnings ?? [], null),
      });
      return;
    }

    console.warn(
      `[workflow] стадия джобы ${job.unifiedJobId} расходится с шагами: ${drift.warning}`
    );
    await patchUnifiedCollectionJob(step.caseId, {
      warnings: mergeDriftWarning(job.warnings ?? [], drift),
    });
  } catch {
    /* сверка вспомогательна: её сбой не должен ронять шаг */
  }
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
