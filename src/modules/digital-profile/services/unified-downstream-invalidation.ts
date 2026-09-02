/**
 * Mark downstream unified artifacts stale after new Arsenkin observations ingest.
 * Preserves forensic lineage files; clears UI links; forces new job-scoped hashes.
 */

import { writeUnifiedArtifact } from "./unified-collection-job-store";
import type { UnifiedCollectionJob } from "./unified-collection-types";

export type DownstreamInvalidationReport = {
  markedStale: string[];
  clearedReportLinks: boolean;
  clearedCompositeDatasetId: boolean;
  forensicPreserved: string[];
  contentHashEpoch: string;
};

/**
 * Имя стоп-маркера выводится здесь и только здесь.
 *
 * Читает маркеры загрузчик реюза собранной деки, а пишет их этот модуль. Пока
 * обе стороны чеканили строку сами, переименование артефакта или смена суффикса
 * оставляли бы тесты зелёными, а единственную защиту от реюза доингестной деки
 * — выключенной.
 */
export function staleMarkerFileName(artifact: string): string {
  return `${artifact}.stale.json`;
}

/** Артефакт собранной деки: по его маркеру отказывает реюз. */
export const ASSEMBLED_DECK_ARTIFACT = "assembled-deck.json";

const STALE_ARTIFACT_MARKERS = [
  "composite-serp-observations.json",
  "composite-serp-provenance.json",
  "report-data-binding.json",
  "provider-surface-coverage.json",
  "unified-collection-summary.json",
  "base-observation-coverage.json",
  ASSEMBLED_DECK_ARTIFACT,
  "report-deck-manifest.json",
  "report-section-manifest.json",
  "section-build-log.json",
  "assembly-validation-report.json",
  "executive-summary.json",
  "executive-summary-input.json",
  "verified-finding-bundle.json",
  "surface-analysis.json",
  "provider-delta.json",
  "render-checkpoint.json",
  "golden-render-meta.json",
  "layout-telemetry.json",
  "acceptance-report.json",
] as const;

const FORENSIC_PRESERVE = [
  "base-collection-manifest.json",
  "arsenkin-enrichment-state.json",
  "arsenkin-enrichment-observations.json",
  "unified-recovery-audit.json",
] as const;

/**
 * Write stale markers next to existing artifacts without deleting forensic lineage.
 */
export async function invalidateDownstreamAfterEnrichmentIngest(input: {
  job: UnifiedCollectionJob;
  reason: string;
  previousCompositeDatasetId?: string | null;
  previousContentHash?: string | null;
}): Promise<{
  jobPatch: Partial<UnifiedCollectionJob>;
  report: DownstreamInvalidationReport;
}> {
  const epoch = `invalidated-${Date.now().toString(36)}`;
  const markedStale: string[] = [];
  for (const name of STALE_ARTIFACT_MARKERS) {
    const path = await writeUnifiedArtifact(
      input.job.caseId,
      input.job.unifiedJobId,
      staleMarkerFileName(name),
      {
        version: "downstream-stale-marker-v1",
        artifact: name,
        reason: input.reason,
        previousCompositeDatasetId:
          input.previousCompositeDatasetId ?? input.job.compositeDatasetId,
        previousContentHash: input.previousContentHash ?? null,
        contentHashEpoch: epoch,
        markedAt: new Date().toISOString(),
        doNotReuse: true,
      }
    );
    markedStale.push(path);
  }

  // Explicit invalidation ledger (UI / recovery reads this).
  await writeUnifiedArtifact(input.job.caseId, input.job.unifiedJobId, "downstream-invalidation.json", {
    version: "downstream-invalidation-v1",
    reason: input.reason,
    markedStale: [...STALE_ARTIFACT_MARKERS],
    forensicPreserved: [...FORENSIC_PRESERVE],
    previousCompositeDatasetId: input.previousCompositeDatasetId ?? input.job.compositeDatasetId,
    previousContentHash: input.previousContentHash ?? null,
    contentHashEpoch: epoch,
    clearReportLinks: true,
    markedAt: new Date().toISOString(),
  });

  return {
    jobPatch: {
      compositeDatasetId: null,
      reportLinks: {},
      warnings: [
        ...input.job.warnings.filter((w) => !/^downstream-invalidated:/i.test(w)),
        `downstream-invalidated:${input.reason}`,
        `contentHashEpoch:${epoch}`,
      ],
    },
    report: {
      markedStale: [...STALE_ARTIFACT_MARKERS],
      clearedReportLinks: true,
      clearedCompositeDatasetId: true,
      forensicPreserved: [...FORENSIC_PRESERVE],
      contentHashEpoch: epoch,
    },
  };
}
