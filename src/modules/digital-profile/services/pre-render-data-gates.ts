/**
 * PRE_RENDER_DATA_GATE — must pass before assembly/HTTP render.
 */

import type { BaseCollectionManifest, ReportDataBinding } from "./unified-collection-types";
import type { CompositeMergeResult } from "./composite-serp-merge";
import type { ArsenkinEnrichmentState } from "./arsenkin-enrichment-state";
import type { TopvisorEnrichmentState } from "./topvisor-positions-tick";
import { assertEnrichmentReadyForComposite } from "./arsenkin-enrichment-state";
import {
  assertBaseObservationCoverage,
  buildBaseObservationCoverage,
  type BaseObservationCoverage,
} from "./base-observation-coverage";

export type PreRenderDataGateResult = {
  ok: boolean;
  code: string | null;
  errors: string[];
  coverage: BaseObservationCoverage | null;
};

export function assertPreRenderDataGates(input: {
  binding: ReportDataBinding | null;
  manifest: BaseCollectionManifest | null;
  merge: CompositeMergeResult | null;
  enrichmentState: ArsenkinEnrichmentState | null;
  /**
   * Состояние Topvisor судится по данным прогона, а не по режиму машины: есть
   * состояние — выдачу собирал Topvisor, и без его строк таблицы вышли бы
   * пустыми при зелёном прогоне. Пересборка старого прогона в другом режиме
   * на это не влияет.
   */
  topvisorState?: TopvisorEnrichmentState | null;
  realCollectionSufficient: boolean;
  /** Провайдеры, подменённые демо-данными, — для внятного сообщения. */
  mockProviders?: string[];
  allowMockReport?: boolean;
}): PreRenderDataGateResult {
  const errors: string[] = [];

  if (!input.binding?.compositeDatasetId) {
    errors.push("report-data-binding missing compositeDatasetId");
  }
  if (!input.merge?.compositeDatasetId) {
    errors.push("merge missing compositeDatasetId");
  }
  if (
    input.binding &&
    input.merge &&
    input.binding.compositeDatasetId !== input.merge.compositeDatasetId
  ) {
    errors.push("binding.compositeDatasetId !== merge.compositeDatasetId");
  }

  if (input.manifest && input.binding) {
    if (input.manifest.caseId !== input.binding.caseId) {
      errors.push("lineage caseId mismatch (manifest vs binding)");
    }
    if (input.manifest.unifiedJobId !== input.binding.unifiedJobId) {
      errors.push("lineage unifiedJobId mismatch (manifest vs binding)");
    }
    if (
      input.manifest.baseReportRunId &&
      input.binding.baseReportRunId &&
      input.manifest.baseReportRunId !== input.binding.baseReportRunId
    ) {
      errors.push("lineage baseReportRunId mismatch");
    }
  }

  if (input.merge && input.manifest) {
    if (input.merge.provenance.unifiedJobId !== input.manifest.unifiedJobId) {
      errors.push("lineage unifiedJobId mismatch (merge provenance)");
    }
  }

  if (!input.enrichmentState) {
    errors.push("arsenkin enrichment state missing");
  } else {
    const enr = assertEnrichmentReadyForComposite(input.enrichmentState);
    if (!enr.ok) errors.push(...enr.errors.map((e) => `enrichment: ${e}`));
  }

  if (input.topvisorState) {
    if (input.topvisorState.phase !== "DONE") {
      errors.push(`topvisor: проверка позиций не завершена (${input.topvisorState.phase})`);
    } else {
      const topvisorRows = (input.merge?.observations ?? []).filter((o) =>
        o.providers.some((p) => /^topvisor-/i.test(p))
      ).length;
      if (topvisorRows === 0) {
        errors.push("topvisor: выдачу собирал Topvisor, но ни одной его строки в слиянии нет (rows=0)");
      }
    }
  }

  let coverage: BaseObservationCoverage | null = null;
  if (input.manifest && input.merge) {
    coverage = buildBaseObservationCoverage({
      manifest: input.manifest,
      merge: input.merge,
    });
    const cov = assertBaseObservationCoverage(coverage);
    if (!cov.ok) errors.push(...cov.errors);
  } else {
    errors.push("cannot build base observation coverage without manifest+merge");
  }

  if (input.merge) {
    const hasBase =
      input.merge.provenance.baseProviders.length > 0 ||
      input.merge.provenance.baseSearchResultIds.length > 0 ||
      input.merge.provenance.baseSearchSurfaceItemIds.length > 0;
    if (!hasBase) errors.push("provenance missing base providers/ids");
  }

  if (!input.allowMockReport && !input.realCollectionSufficient) {
    // Причина называется явно: «mock/fallback» вводило в заблуждение, когда
    // никакой подмены не было — например, провайдер просто отказал (шаг 13, B2).
    errors.push(
      input.mockProviders?.length
        ? `demo data cannot be presented as a real collection (${input.mockProviders.join(", ")})`
        : "no required search provider completed a real collection"
    );
  }

  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? null : "PRE_RENDER_DATA_GATE_FAILED",
    errors,
    coverage,
  };
}
