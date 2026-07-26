/**
 * Прежний вывод «где мы остановились» — только для прогонов без конвейера
 * (шаг 12.4e).
 *
 * До шага 12 ответ выводился эвристиками из шести полей джобы: `stage`,
 * `resumeCheckpoint`, длина `enrichmentRunIds`, флаг `enrichmentComplete`
 * внутри блоба, `lastErrorCode` и наличие `compositeDatasetId`. Именно здесь
 * нашлись дефекты 08.0-bis и 11.1: состояние «пять прогонов зарегистрировано,
 * задач две» проходило проверку `enrichmentCount >= 5`, и восстановление
 * уходило опрашивать несуществующие задачи до исчерпания бюджета.
 *
 * Сегодня на вопрос отвечает `planResumeFromSteps`, и для любого прогона с
 * конвейером этот код **недостижим**: решение принимается раньше. Он остаётся
 * ровно для двух случаев — прогоны, созданные до шага 12, и сбой чтения
 * таблицы шагов: потерять возможность восстановления из-за недоступности
 * таблицы хуже, чем ответить по-старому.
 *
 * Вынесен в отдельный файл, чтобы две реализации одного вопроса не жили в
 * одном месте и чтобы никому не пришло в голову развивать эту. Перенос
 * механический: поведение не менялось.
 */

import { isDeterministicPrepareGate } from "./prepare-gate-advice";
import { readUnifiedArtifact } from "./unified-collection-job-store";
import type {
  BaseCollectionManifest,
  UnifiedCollectionJob,
} from "./unified-collection-types";

export type LegacyRecoveryEligibility = {
  recoveryAllowed: boolean;
  recoveryBlockerReason: string | null;
  recoveryReason: string | null;
};

function manifestHasBaseObservations(manifest: BaseCollectionManifest | null | undefined): boolean {
  if (!manifest) return false;
  if (manifest.caseId && manifest.unifiedJobId) {
    /* lineage fields present */
  } else {
    return false;
  }
  const idCount =
    (manifest.searchResultIds?.length ?? 0) +
    (manifest.searchSurfaceItemIds?.length ?? 0) +
    (manifest.caseCorpusSearchResultIds?.length ?? 0) +
    (manifest.caseCorpusSurfaceItemIds?.length ?? 0);
  return (manifest.baseCount ?? 0) > 0 || idCount > 0;
}

function hasHistoricalNoBaseReportDefect(job: UnifiedCollectionJob): boolean {
  const blob = [...(job.warnings ?? []), job.lastErrorCode ?? "", job.lastError ?? ""].join("\n");
  return (
    /arsenkin-skipped:no-baseReportRunId/i.test(blob) ||
    /arsenkin-blocked:no-baseReportRunId/i.test(blob) ||
    /BASE_REPORT_RUN_MISSING/i.test(blob)
  );
}

/**
 * Ответ прежней эвристики. Вызывается только когда конвейера шагов нет.
 */
export async function evaluateLegacyRecoveryEligibility(input: {
  job: UnifiedCollectionJob;
  manifest?: BaseCollectionManifest | null;
}): Promise<LegacyRecoveryEligibility> {
  const job = input.job;
    const manifest =
      input.manifest !== undefined
        ? input.manifest
        : await readUnifiedArtifact<BaseCollectionManifest>(
            job.caseId,
            job.unifiedJobId,
            "base-collection-manifest.json"
          );

    if (!manifest) {
      return {
        recoveryAllowed: false,
        recoveryBlockerReason: "BASE_MANIFEST_MISSING",
        recoveryReason: null,
      };
    }
    if (manifest.caseId !== job.caseId || manifest.unifiedJobId !== job.unifiedJobId) {
      return {
        recoveryAllowed: false,
        recoveryBlockerReason: "MANIFEST_LINEAGE_MISMATCH",
        recoveryReason: null,
      };
    }
    if (!manifestHasBaseObservations(manifest)) {
      return {
        recoveryAllowed: false,
        recoveryBlockerReason: "BASE_MANIFEST_EMPTY_OR_CORRUPT",
        recoveryReason: null,
      };
    }

    // Idempotent in-flight recovery checkpoint (same job, already rebound).
    if (
      (job.stage === "ARSENKIN_ENRICHMENT" || job.stage === "ORION_PREPARE") &&
      (job.status === "WAITING" || job.status === "RUNNING") &&
      Boolean(job.baseReportRunId) &&
      Boolean(job.recoveryAudit)
    ) {
      return {
        recoveryAllowed: true,
        recoveryBlockerReason: null,
        recoveryReason:
          job.resumeCheckpoint === "RENDER" || job.stage === "ORION_PREPARE"
            ? "IDEMPOTENT_RENDER_RESUME"
            : "IDEMPOTENT_RESUME",
      };
    }

    const enrichmentCount = job.enrichmentRunIds?.length ?? 0;
    const enrichmentComplete = Boolean(job.arsenkinEnrichmentState?.enrichmentComplete);
    const isRenderFailure =
      job.resumeCheckpoint === "RENDER" ||
      job.lastErrorCode === "RENDER_FAILED" ||
      /render failed/i.test(job.lastError ?? "");
    // Ingest resume must not steal RENDER_FAILED jobs (isRenderFailure).
    // Job B pattern: FAILED_TERMINAL + composite present + enrichment never ingested.
    const needsArsenkinIngest =
      !isRenderFailure &&
      (job.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" ||
        (enrichmentCount >= 5 && !enrichmentComplete && Boolean(job.baseReportRunId)));

    // Waiting for Arsenkin ingest (durable poll) — recoverable / idempotent.
    if (
      job.stage === "ARSENKIN_ENRICHMENT" &&
      (job.status === "WAITING" || job.status === "RUNNING") &&
      (job.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" ||
        (enrichmentCount >= 5 && !enrichmentComplete))
    ) {
      return {
        recoveryAllowed: true,
        recoveryBlockerReason: null,
        recoveryReason: "ARSENKIN_INGEST_RESUME",
      };
    }

    if (job.stage === "FAILED_RETRYABLE" && isRenderFailure) {
      if (!job.baseReportRunId || enrichmentCount < 5 || !job.compositeDatasetId) {
        return {
          recoveryAllowed: false,
          recoveryBlockerReason: "RENDER_RESUME_PRECONDITIONS_MISSING",
          recoveryReason: null,
        };
      }
      return {
        recoveryAllowed: true,
        recoveryBlockerReason: null,
        recoveryReason: "RENDER_RESUME",
      };
    }

    if (job.stage === "FAILED_RETRYABLE" && needsArsenkinIngest) {
      return {
        recoveryAllowed: true,
        recoveryBlockerReason: null,
        recoveryReason: "ARSENKIN_INGEST_RESUME",
      };
    }

    if (job.stage === "FAILED_RETRYABLE") {
      return {
        recoveryAllowed: true,
        recoveryBlockerReason: null,
        recoveryReason: "FAILED_RETRYABLE_RESUME",
      };
    }

    if (job.stage === "FAILED_TERMINAL") {
      const missingBaseId = !String(job.baseReportRunId ?? "").trim();
      const historical = hasHistoricalNoBaseReportDefect(job);
      if (missingBaseId && historical) {
        return {
          recoveryAllowed: true,
          recoveryBlockerReason: null,
          recoveryReason: "HISTORICAL_NO_BASE_REPORT_RUN",
        };
      }
      // Job B pattern: terminal after gate/render but Arsenkin never ingested.
      if (needsArsenkinIngest && manifestHasBaseObservations(manifest)) {
        return {
          recoveryAllowed: true,
          recoveryBlockerReason: null,
          recoveryReason: "ARSENKIN_INGEST_RESUME",
        };
      }
      // Section/assembly QA failure with intact composite — retry prepare only.
      const isAssemblyFailure =
        job.lastErrorCode === "ASSEMBLY_FAILED" ||
        job.lastErrorCode === "REQUIRED_SECTION_FAILED" ||
        /required sections failed|ASSEMBLY_FAILED/i.test(job.lastError ?? "");
      if (
        isAssemblyFailure &&
        Boolean(job.compositeDatasetId) &&
        Boolean(job.baseReportRunId) &&
        manifestHasBaseObservations(manifest)
      ) {
        return {
          recoveryAllowed: true,
          recoveryBlockerReason: null,
          recoveryReason: "ASSEMBLY_RESUME",
        };
      }
      // Гейт подготовки, вычисляемый из собранных данных, повтором не лечится:
      // та же сборка над тем же набором даст тот же ответ. Кнопка здесь была бы
      // приглашением потратить время впустую (шаг 15, E1).
      if (isDeterministicPrepareGate(job.lastError)) {
        return {
          recoveryAllowed: false,
          recoveryBlockerReason: "PREPARE_GATE_NOT_FIXED_BY_RETRY",
          recoveryReason: null,
        };
      }
      return {
        recoveryAllowed: false,
        recoveryBlockerReason: "FAILED_TERMINAL_NOT_RECOVERABLE",
        recoveryReason: null,
      };
    }

    return {
      recoveryAllowed: false,
      recoveryBlockerReason: `STAGE_NOT_RECOVERABLE:${job.stage}`,
      recoveryReason: null,
    };
}
