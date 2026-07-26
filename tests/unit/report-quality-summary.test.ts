/**
 * Ported from smoke-report-quality-summary — pure warning aggregator helpers.
 * NETWORK_CALLS=0 (vitest.config env).
 */

import { describe, expect, it } from "vitest";
import {
  buildReportQualityWarnings,
  mergeJobWarnings,
  REPORT_QUALITY_SUMMARY_VERSION,
  type ReportQualitySummary,
} from "../../src/modules/digital-profile/services/report-quality-summary";

function emptyCounts(): ReportQualitySummary["counts"] {
  return {
    dbSearchResults: null,
    dbSurfaceItems: null,
    manifestIds: null,
    manifestDeltaCount: null,
    manifestCorpusCount: null,
    compositeObservations: null,
    subjectMatch: null,
    likelySubject: null,
    ambiguous: null,
    otherSubject: null,
    insufficient: null,
    verifiedFindings: null,
    ambiguousFindings: null,
    appliedOverrides: null,
  };
}

describe("report-quality-summary aggregator helpers", () => {
  it("mergeJobWarnings replaces prior quality warnings with the same prefix", () => {
    const merged = mergeJobWarnings(
      ["arsenkin-awaiting-ingest", "gpt-stage1-fallback:old", "empty-state-slides:9"],
      ["gpt-stage1-fallback:schema: x", "empty-state-slides:2", "visual-asset-warning:sharp"]
    );
    expect(merged).toEqual([
      "arsenkin-awaiting-ingest",
      "gpt-stage1-fallback:schema: x",
      "empty-state-slides:2",
      "visual-asset-warning:sharp",
    ]);
  });

  it("buildReportQualityWarnings maps GPT / empty-state / sidebar degradations", () => {
    const summary: ReportQualitySummary = {
      version: REPORT_QUALITY_SUMMARY_VERSION,
      caseId: "case-q",
      unifiedJobId: "unified-q",
      generatedAt: "2026-07-16T00:00:00.000Z",
      counts: emptyCounts(),
      gpt: {
        stage1: { status: "FAILED", reason: "schema: overallRiskLevel Required" },
        stage2: {
          applied: 1,
          noChanges: 0,
          skippedDeterministic: 0,
          skippedEmpty: 0,
          skippedCached: 0,
          fallbackError: 1,
          fallbackValidation: 1,
          rejectedFieldsTop: [],
          caseAnalysisUsed: false,
        },
      },
      visuals: { built: 0, failed: 0, warning: "visual asset build failed: sharp missing" },
      slides: {
        total: 4,
        withContent: 2,
        emptyState: [
          { slotId: "p11_ru_suggestions", reason: "no-suggestions" },
          { slotId: "p14_ru_images_1", reason: "VISUAL_ASSET_UNAVAILABLE" },
        ],
      },
      arsenkin: { agents: [], enrichmentComplete: null, enrichmentObservationCount: null },
      render: {
        pdfExportMode: "fitz-fallback",
        warningCount: 2,
        sidebarDegradedCount: 1,
        warnings: [],
      },
    };

    const warnings = buildReportQualityWarnings(summary);
    expect(warnings.some((w) => w.startsWith("visual-asset-warning:"))).toBe(true);
    expect(warnings.some((w) => w.startsWith("gpt-stage1-fallback:"))).toBe(true);
    expect(warnings.some((w) => /^gpt-stage2-fallback:2\/\d+$/.test(w))).toBe(true);
    expect(warnings).toContain("empty-state-slides:2");
    expect(warnings).toContain("sidebar-degraded:1");
  });

  it("omits GPT/visual warnings when the funnel is clean", () => {
    const warnings = buildReportQualityWarnings({
      version: REPORT_QUALITY_SUMMARY_VERSION,
      caseId: "c",
      unifiedJobId: "j",
      generatedAt: "2026-07-16T00:00:00.000Z",
      counts: { ...emptyCounts(), manifestIds: 1, manifestDeltaCount: 1, manifestCorpusCount: 0 },
      gpt: {
        stage1: { status: "APPLIED" },
        stage2: {
          applied: 2,
          noChanges: 0,
          skippedDeterministic: 0,
          skippedEmpty: 0,
          skippedCached: 0,
          fallbackError: 0,
          fallbackValidation: 0,
          rejectedFieldsTop: [],
          caseAnalysisUsed: true,
        },
      },
      visuals: { built: 3, failed: 0, warning: null },
      slides: { total: 2, withContent: 2, emptyState: [] },
      arsenkin: { agents: [], enrichmentComplete: true, enrichmentObservationCount: 1 },
      render: {
        pdfExportMode: null,
        warningCount: 0,
        sidebarDegradedCount: 0,
        warnings: [],
      },
    });
    expect(warnings).toEqual([]);
  });
});
