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
import { STAGE_OWNER, UNIFIED_PIPELINE, stepDefinition } from "./step-plan";
import type { StepHandler } from "./step-runner";
import type { StepOutcome, WorkflowStepRow } from "./step-types";

/**
 * Исход шага приостановленного прогона.
 *
 * Пауза — решение оператора, и `skipped` для неё не годится: пропуск считается
 * улаженным состоянием, `completeStep` будит следующий шаг, тот тоже
 * пропускается — каскад до конца конвейера. Все строки `SKIPPED` дают
 * `planResumeFromSteps` ответ `completed`, то есть возобновить паузу было бы
 * нечем **никогда**, а собранное осталось бы оплаченным и недоступным.
 *
 * Отказ конвейер останавливает (`nextRunnableStep` возвращает `null` на
 * `FAILED`) и оставляет «где мы остановились» отвечать местом остановки. Из
 * шести состояний шага это единственное, которое умеет и то и другое. Слово
 * `FAILED` внутреннее и клиенту не печатается; строка шага несёт код и текст,
 * которые говорят, что произошло на самом деле.
 */
const PAUSED_OUTCOME: StepOutcome = {
  kind: "failed",
  code: "RUN_PAUSED",
  message: "Прогон приостановлен оператором",
  retryable: false,
};

/**
 * Что конечная стадия джобы значит для шага — **один** ответ на весь модуль.
 *
 * Раньше отвечали дважды. `outcomeFromJob` (после вызова тика) различал:
 * отмена — пропуск, терминальный отказ — отказ с кодом джобы, и только
 * готовый отчёт — «сделано». Проверка перед вызовом тика различать перестала:
 * любая конечная стадия давала `done`.
 *
 * Цена расхождения не косметическая. `completeStep` на `DONE` будит следующий
 * шаг, поэтому один неверный `done` идёт каскадом до конца конвейера; все
 * строки `DONE` дают `deriveJobStage` → `REPORT_READY` при джобе в
 * `FAILED_TERMINAL`, а `planResumeFromSteps` отвечает `completed` **навсегда**:
 * восстановление отдаёт `JOB_ALREADY_COMPLETED`, и кнопки «Возобновить» у
 * оператора больше нет. Именно так выглядел дрейф на прогоне 19.08 — у
 * владельца работала ровно одна кнопка не потому, что так задумано.
 *
 * `null` — стадия не конечная, шагу есть что делать.
 */
export function outcomeForStoppedJob(job: UnifiedCollectionJob): StepOutcome | null {
  if (job.stage === "CANCELLED") return PAUSED_OUTCOME;

  if (job.stage === "FAILED_TERMINAL") {
    return {
      kind: "failed",
      code: job.lastErrorCode ?? "STAGE_FAILED_TERMINAL",
      message: job.lastError ?? "Стадия завершилась терминальным отказом",
      retryable: false,
    };
  }

  if (job.stage === "REPORT_READY" || job.stage === "COMPLETED_PARTIAL") {
    return { kind: "done", outputRef: job.compositeDatasetId ?? job.baseReportRunId ?? null };
  }

  return null;
}

/**
 * Позиция стадии джобы в конвейере — чтобы понимать «дошли до сюда или дальше».
 *
 * Стадия внутри шага (`CLIENT_CONTENT`) занимает позицию своего шага, и кто
 * чей — сказано данными в реестре (`STAGE_OWNER`). Числа здесь нет намеренно:
 * вторая половина сравнения ниже читается из реестра, и записанная числом
 * первая разъехалась бы с ней при первой же вставке шага.
 *
 * `0` — стадия конвейеру не принадлежит вовсе (отказ, отмена, готовый отчёт).
 */
function jobStagePosition(stage: string): number {
  const owner = STAGE_OWNER.get(stage) ?? stage;
  return UNIFIED_PIPELINE.find((d) => d.stage === owner)?.position ?? 0;
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

  // Пауза запрошена, но тик ещё не успел перевести джобу в `CANCELLED`:
  // признак живёт на джобе, а не на стадии, поэтому спрашивается отдельно.
  if (after.cancelRequested) return PAUSED_OUTCOME;

  const stopped = outcomeForStoppedJob(after);
  if (stopped) return stopped;

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
    /*
     * Прогон уже остановлен — платный тик не запускаем.
     *
     * Ради этого короткое замыкание и заводили: без него проснувшийся шаг
     * подготовки запускал бы сбор заново. Вердикт при этом берётся общий, тот
     * же, что и после вызова тика: шаг, который не работал, сделанным не
     * называется.
     *
     * `cancelRequested` здесь намеренно не спрашивается: в `CANCELLED` джобу
     * переводит сам тик, и пропуск шага до вызова оставил бы отмену
     * невыполненной.
     */
    const stopped = outcomeForStoppedJob(before);
    if (stopped) return stopped;

    /*
     * Шаг, который джоба уже переросла, работу не запускает.
     *
     * Обработчик один на все шаги, и он выполняет **текущую** стадию джобы, а
     * не свою. Пока сборка отчёта идёт шесть минут, ждущий шаг обогащения
     * просыпается по своему расписанию, вызывает тот же тик — и отчёт
     * собирается второй раз, параллельно. На живом прогоне это видно по логу:
     * чтение ста двадцати страниц и отрисовка отработали дважды с промежутком
     * ровно в паузу опроса. Отчёт при этом выходил верный, но платили за него
     * вдвое.
     *
     * Правило то же, по которому шаг признаётся сделанным после тика
     * (`outcomeFromJob`): джоба ушла дальше — шаг сделан. Просто спрашиваем об
     * этом до работы, а не после.
     */
    const stepPosition = stepDefinition(step.name)?.position ?? 0;
    if (jobStagePosition(before.stage) > stepPosition) {
      return {
        kind: "done",
        outputRef: before.compositeDatasetId ?? before.baseReportRunId ?? null,
      };
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
