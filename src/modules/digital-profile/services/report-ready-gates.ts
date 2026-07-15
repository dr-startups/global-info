/**
 * Fail-closed REPORT_READY gates for unified collection.
 */

import type { BaseCollectionManifest, ReportDataBinding, SurfaceCoverageBreakdown } from "./unified-collection-types";
import type { CompositeMergeResult } from "./composite-serp-merge";

export type ReportReadyGateResult = {
  ok: boolean;
  code: string | null;
  errors: string[];
};

export function assertReportReadyGates(input: {
  binding: ReportDataBinding | null;
  manifest: BaseCollectionManifest | null;
  merge: CompositeMergeResult | null;
  /** Dataset id actually consumed by prepare/renderer */
  prepareDatasetId: string | null;
  clientContentDatasetId?: string | null;
  realCollectionSufficient: boolean;
  allowMockReport?: boolean;
  coverage?: SurfaceCoverageBreakdown | null;
}): ReportReadyGateResult {
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
  if (!input.prepareDatasetId) {
    errors.push("prepare/renderer dataset id missing");
  } else if (input.binding && input.prepareDatasetId !== input.binding.compositeDatasetId) {
    errors.push(
      `prepare/renderer reads stale dataset ${input.prepareDatasetId}, expected composite ${input.binding.compositeDatasetId}`
    );
  }
  if (
    input.clientContentDatasetId &&
    input.binding &&
    input.clientContentDatasetId !== input.binding.compositeDatasetId
  ) {
    errors.push("client content dataset id mismatch");
  }
  if (input.manifest && input.merge && input.merge.compositeCount < input.manifest.baseCount) {
    errors.push(
      `compositeCount ${input.merge.compositeCount} < baseCount ${input.manifest.baseCount}`
    );
  }
  if (input.merge) {
    const hasBase =
      input.merge.provenance.baseProviders.length > 0 ||
      input.merge.provenance.baseSearchResultIds.length > 0 ||
      input.merge.provenance.baseSearchSurfaceItemIds.length > 0;
    if (!hasBase) errors.push("provenance missing base providers/ids");
  }
  if (!input.allowMockReport && !input.realCollectionSufficient) {
    errors.push("real collection insufficient (mock/fallback cannot unlock REPORT_READY)");
  }

  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? null : "REPORT_READY_GATE_FAILED",
    errors,
  };
}
