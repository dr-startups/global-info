/**
 * Пауза прогона — единственное место, где выставляется признак остановки.
 *
 * До этого шага признак `cancelRequested` во всём коде только инициализировался
 * `false` и проверялся: оркестратор его honors, хранилище переживает
 * перезапуск, а выставить было некому. Оператор не мог остановить идущий
 * прогон иначе как «Начать новый аудит с повторным сбором данных», то есть
 * заплатив за новый сбор. Вопрос владельца от 20.08 (пункт CC).
 *
 * Решение владельца 21.08: **отмена — это пауза.** Приостановленный прогон и
 * возобновляется с места остановки, и позволяет собрать отчёт из уже
 * собранного; признак снимает восстановление.
 */

import { ConflictError, NotFoundError, ValidationError } from "../http/errors";
import {
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
} from "./unified-collection-job-store";
import type { UnifiedCollectionJob, UnifiedCollectionStage } from "./unified-collection-types";

/** Стадии, на которых прогон действительно работает и его есть что останавливать. */
const PAUSABLE_STAGES: ReadonlySet<UnifiedCollectionStage> = new Set<UnifiedCollectionStage>([
  "BASE_COLLECTION",
  "ARSENKIN_ENRICHMENT",
  "COMPOSITE_MERGE",
  "ORION_PREPARE",
  "CLIENT_CONTENT",
]);

export type UnifiedPauseEligibility = {
  pauseAllowed: boolean;
  pauseBlockerReason: string | null;
};

/**
 * Можно ли поставить прогон на паузу.
 *
 * Ответ один и тот же для статуса и для ручки: интерфейс не должен показывать
 * кнопку, которую сервер откажется исполнить.
 */
export function evaluateUnifiedPauseEligibility(
  job: UnifiedCollectionJob | null
): UnifiedPauseEligibility {
  if (!job) return { pauseAllowed: false, pauseBlockerReason: "JOB_NOT_FOUND" };
  if (job.cancelRequested || job.stage === "CANCELLED" || job.status === "CANCELLED") {
    return { pauseAllowed: false, pauseBlockerReason: "ALREADY_PAUSED" };
  }
  if (!PAUSABLE_STAGES.has(job.stage)) {
    return { pauseAllowed: false, pauseBlockerReason: `STAGE_NOT_RUNNING:${job.stage}` };
  }
  return { pauseAllowed: true, pauseBlockerReason: null };
}

export type PauseUnifiedCollectionResult = {
  accepted: true;
  jobId: string;
  unifiedJobId: string;
  stage: string;
  status: string;
};

/**
 * Просит прогон остановиться.
 *
 * Останавливает не эта функция: она поднимает признак, а переводит джобу в
 * `CANCELLED` ближайший тик — тот же, который двигает работу. Так пауза не
 * обрывает шаг посередине и не спорит с лизой.
 */
export async function pauseUnifiedCollectionRun(input: {
  caseId: string;
  jobId: string;
  actorId: string;
}): Promise<PauseUnifiedCollectionResult> {
  const jobId = String(input.jobId ?? "").trim();
  if (!jobId) throw new ValidationError("jobId is required");

  const job = await loadUnifiedCollectionJob(input.caseId);
  if (!job) throw new NotFoundError("unified collection job not found");
  if (job.jobId !== jobId && job.unifiedJobId !== jobId) {
    throw new NotFoundError("jobId does not belong to this case");
  }

  const elig = evaluateUnifiedPauseEligibility(job);
  if (!elig.pauseAllowed) {
    throw new ConflictError(elig.pauseBlockerReason ?? "pause not allowed");
  }

  const patched =
    (await patchUnifiedCollectionJob(input.caseId, {
      cancelRequested: true,
      warnings: [...job.warnings.filter((w) => w !== PAUSE_MARKER), PAUSE_MARKER],
    })) ?? job;

  return {
    accepted: true,
    jobId: patched.jobId,
    unifiedJobId: patched.unifiedJobId,
    stage: patched.stage,
    status: patched.status,
  };
}

/** Отметка, по которой видно, что прогон остановил человек, а не сторож. */
export const PAUSE_MARKER = "run-paused-by-operator";
