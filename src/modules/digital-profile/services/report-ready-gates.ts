/**
 * POST_RENDER / REPORT_READY gates for unified collection.
 * Base coverage is enforced by PRE_RENDER_DATA_GATE — not compositeCount >= baseCount.
 */

import type { BaseCollectionManifest, ReportDataBinding, SurfaceCoverageBreakdown } from "./unified-collection-types";
import type { CompositeMergeResult } from "./composite-serp-merge";
import {
  assertBaseObservationCoverage,
  buildBaseObservationCoverage,
} from "./base-observation-coverage";

export type ReportReadyGateResult = {
  ok: boolean;
  code: string | null;
  errors: string[];
};

/**
 * Post-prepare dataset/lineage checks. Does NOT re-run expensive geometry;
 * PRE_RENDER already validated coverage + enrichment.
 */
export function assertReportReadyGates(input: {
  binding: ReportDataBinding | null;
  manifest: BaseCollectionManifest | null;
  merge: CompositeMergeResult | null;
  /** Dataset id actually consumed by prepare/renderer */
  prepareDatasetId: string | null;
  clientContentDatasetId?: string | null;
  realCollectionSufficient: boolean;
  /** Провайдеры, подменённые демо-данными, — для внятного сообщения. */
  mockProviders?: string[];
  allowMockReport?: boolean;
  coverage?: SurfaceCoverageBreakdown | null;
  /** RENDER-only resume: dataset lineage only (coverage already enforced pre-render). */
  skipBaseCoverage?: boolean;
  /**
   * REMEDIATION §4.1 — when true, REPORT_READY requires an applied GPT layer
   * (stage-2 APPLIED > 0 or stage-1 case analysis used).
   */
  requireAiReport?: boolean;
  gptLayerApplied?: boolean;
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

  // Coverage invariant (replaces compositeCount >= baseCount).
  if (!input.skipBaseCoverage && input.manifest && input.merge) {
    const coverage = buildBaseObservationCoverage({
      manifest: input.manifest,
      merge: input.merge,
    });
    const cov = assertBaseObservationCoverage(coverage);
    if (!cov.ok) errors.push(...cov.errors);
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

  if (input.requireAiReport && !input.gptLayerApplied) {
    errors.push(
      "DIGITAL_PROFILE_REQUIRE_AI_REPORT=true but GPT layer was not applied (no stage-1 analysis / no stage-2 APPLIED fragments)"
    );
  }

  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? null : "REPORT_READY_GATE_FAILED",
    errors,
  };
}

/** True when quality summary shows an applied GPT client layer. */
export function gptLayerAppliedFromQuality(quality: {
  gpt?: {
    stage1?: { status?: string };
    stage1Status?: string;
    stage2?: { applied?: number; caseAnalysisUsed?: boolean };
    stage2Applied?: number;
    caseAnalysisUsed?: boolean;
  };
} | null | undefined): boolean {
  if (!quality?.gpt) return false;
  const stage2Applied =
    quality.gpt.stage2?.applied ?? quality.gpt.stage2Applied ?? 0;
  if (stage2Applied > 0) return true;
  if (quality.gpt.stage2?.caseAnalysisUsed || quality.gpt.caseAnalysisUsed) return true;
  const stage1 = quality.gpt.stage1?.status ?? quality.gpt.stage1Status;
  return stage1 === "APPLIED";
}
