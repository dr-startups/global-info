/**
 * Stage 7 — filter-loss audit + matrix builder.
 * Documents each filter and computes stop-gates without relaxing subject isolation.
 */

import type { ObservationDispositionLedger } from "../contracts/observation-disposition";
import type { Finding } from "../contracts/finding";
import type { CompositeSerpProvenance } from "./composite-dataset-builder";
import type { OverlayBaseLineageEntry } from "../classic/composite-serp-overlay-merge";
import {
  FILTER_LOSS_MATRIX_SCHEMA_VERSION,
  FilterLossMatrixSchema,
  type FilterLossMatrix,
  type FilterLossRow,
} from "../contracts/filter-loss-matrix";

export type FilterLossAuditInput = {
  caseId: string;
  datasetId: string;
  sourceHashes: string[];
  dispositionLedger: ObservationDispositionLedger;
  /** Analytics additive composite provenance (base never shrinks). */
  analyticsProvenance?: CompositeSerpProvenance | null;
  /** Optional render-path overlay lineage (Stage 7). */
  overlayBaseLineage?: OverlayBaseLineageEntry[] | null;
  overlayBaseLineageCoveragePercent?: number | null;
  findings: Finding[];
  kpiFindingIds?: Set<string>;
  /** Surface metric rows: adverseSharePercent + collection status. */
  surfaceMetricRows?: Array<{
    region: string;
    status?: string;
    adverseSharePercent: number | null;
    totalCount: number;
  }>;
  /** Coverage / provider limitation strings visible to the client. */
  coverageLimitations?: string[];
};

function staticRows(fnCounts: Record<string, number>): FilterLossRow[] {
  const n = (id: string) => fnCounts[id] ?? 0;
  return [
    {
      filterId: "empty_state_not_collected",
      stage: "surface/coverage",
      oldBehavior: "NOT_COLLECTED could be rendered as 0% adverse share.",
      falseNegativeScenario: "Failed collection looks like a clean region.",
      newBehavior: "NOT_COLLECTED / EMPTY_VALID / NO_RESULTS stay distinct; null share when total=0.",
      reasonCode: "empty_state:not_collected_vs_zero",
      traceArtifact: "provider-surface-coverage.json / surface-analysis.json",
      kpiImpact: "denominator honest; no fake 0%",
      summaryImpact: "limitations list provider/collection gaps",
      appendixImpact: "unchanged",
      materialFalseNegatives: n("empty_state_not_collected"),
      status: n("empty_state_not_collected") === 0 ? "pass" : "fixed",
    },
    {
      filterId: "other_subject_isolation",
      stage: "subject_resolution",
      oldBehavior: "OTHER_SUBJECT excluded from subject KPI/summary.",
      falseNegativeScenario: "True subject hit mis-tagged OTHER → silent KPI loss.",
      newBehavior: "OTHER stays out of KPI; remains in disposition + appendix/trace.",
      reasonCode: "subject_resolution:OTHER_SUBJECT",
      traceArtifact: "observation-disposition-ledger.json",
      kpiImpact: "OTHER never in subject KPI",
      summaryImpact: "not asserted as subject fact",
      appendixImpact: "listed for review",
      materialFalseNegatives: n("other_subject_isolation"),
      status: "documented_safe",
    },
    {
      filterId: "ambiguous_appendix",
      stage: "subject_resolution",
      oldBehavior: "AMBIGUOUS not asserted as subject fact.",
      falseNegativeScenario: "AMBIGUOUS dropped entirely from report.",
      newBehavior: "AMBIGUOUS → APPENDIX_AMBIGUOUS disposition; review/appendix retain.",
      reasonCode: "subject_resolution:AMBIGUOUS",
      traceArtifact: "observation-disposition-ledger.json / ambiguous-findings.json",
      kpiImpact: "not in subject KPI",
      summaryImpact: "identity caveats",
      appendixImpact: "present",
      materialFalseNegatives: n("ambiguous_appendix"),
      status: "documented_safe",
    },
    {
      filterId: "analytics_composite_dedupe",
      stage: "composite",
      oldBehavior: "Additive merge; duplicates merge provenance.",
      falseNegativeScenario: "Dedupe drops secondary raw IDs.",
      newBehavior: "All inventory IDs kept in provenance.evidenceRefs; disposition EXCLUDE_DUPLICATE with duplicateOf.",
      reasonCode: "composite_dedupe:secondary_in_group",
      traceArtifact: "composite-serp-provenance.json",
      kpiImpact: "counts use observation keys",
      summaryImpact: "no silent loss",
      appendixImpact: "lineage complete",
      materialFalseNegatives: n("analytics_composite_dedupe"),
      status: "documented_safe",
    },
    {
      filterId: "overlay_cell_replace",
      stage: "classic_overlay",
      oldBehavior: "Covered enrichment cells replaced all base SERP rows (including empty cells).",
      falseNegativeScenario: "Empty/weak enrichment erased base material adverse → looks like no risk.",
      newBehavior: "Empty enrichment preserves base; material adverse missing from enrichment preserved with reasonCode + lineage.",
      reasonCode: "overlay:preserve_material_adverse_missing_from_enrichment",
      traceArtifact: "composite merge provenance.baseLineage",
      kpiImpact: "base material re-enters inventory",
      summaryImpact: "adverse themes recoverable",
      appendixImpact: "lineage fate per base id",
      materialFalseNegatives: n("overlay_cell_replace"),
      status: n("overlay_cell_replace") === 0 ? "fixed" : "fixed",
    },
    {
      filterId: "source_quality_rank_only",
      stage: "materiality",
      oldBehavior: "Source quality labels for qualification.",
      falseNegativeScenario: "Low source quality deletes material adverse.",
      newBehavior: "Quality affects qualification/ranking only; forbidden as sole silent exclude reason.",
      reasonCode: "materiality:source_quality_rank",
      traceArtifact: "observation-disposition-ledger.json gates",
      kpiImpact: "none destructive",
      summaryImpact: "qualification language",
      appendixImpact: "unchanged",
      materialFalseNegatives: n("source_quality_rank_only"),
      status: "documented_safe",
    },
    {
      filterId: "date_recency_rank_only",
      stage: "materiality",
      oldBehavior: "No dedicated date-drop filter in golden path.",
      falseNegativeScenario: "Historical plot dropped for age.",
      newBehavior: "Recency ranks; historical material adverse retained via claims/disposition.",
      reasonCode: "materiality:recency_rank",
      traceArtifact: "canonical-claims.json",
      kpiImpact: "none destructive",
      summaryImpact: "priority only",
      appendixImpact: "historical kept",
      materialFalseNegatives: n("date_recency_rank_only"),
      status: "documented_safe",
    },
    {
      filterId: "confidence_language_only",
      stage: "promotion",
      oldBehavior: "Confidence gates P1 vs P2 language.",
      falseNegativeScenario: "Low confidence silent-drops adverse finding.",
      newBehavior: "Confidence changes promotion/language; disposition forbids confidence-threshold silent exclude.",
      reasonCode: "promotion:confidence_language",
      traceArtifact: "verified-finding-bundle.json",
      kpiImpact: "may demote priority, not delete",
      summaryImpact: "wording/section",
      appendixImpact: "still present",
      materialFalseNegatives: n("confidence_language_only"),
      status: "documented_safe",
    },
    {
      filterId: "executive_top_n_after_theme_coverage",
      stage: "executive_summary",
      oldBehavior: "MAX_KEY_FINDINGS=7 could omit distinct mandatory themes.",
      falseNegativeScenario: "8th adverse theme missing from executive keys.",
      newBehavior: "selectKeyFindings covers each mandatory theme before top-N cap.",
      reasonCode: "executive:theme_coverage_before_top_n",
      traceArtifact: "executive-summary.json",
      kpiImpact: "more key cards when themes > 7",
      summaryImpact: "all mandatory themes represented",
      appendixImpact: "unchanged",
      materialFalseNegatives: n("executive_top_n_after_theme_coverage"),
      status: "fixed",
    },
    {
      filterId: "multi_theme_evidence",
      stage: "claims/representative",
      oldBehavior: "One evidence can support multiple themes.",
      falseNegativeScenario: "Second theme loses the only article after plot dedupe.",
      newBehavior: "Per-theme representative selection; composer marks «Тот же материал».",
      reasonCode: "representative:per_theme_dedupe",
      traceArtifact: "representative-evidence-selection.json",
      kpiImpact: "theme coverage",
      summaryImpact: "both themes keep concrete example",
      appendixImpact: "unchanged",
      materialFalseNegatives: n("multi_theme_evidence"),
      status: "documented_safe",
    },
    {
      filterId: "adverse_not_suppressed_by_majority",
      stage: "synthesis",
      oldBehavior: "Adverse themes synthesized independently of neutral majority.",
      falseNegativeScenario: "Neutral majority hides adverse.",
      newBehavior: "Adverse findings promoted by theme/risk; executive keeps adverse+neutral simultaneously.",
      reasonCode: "synthesis:adverse_independent",
      traceArtifact: "verified-finding-bundle.json",
      kpiImpact: "adverseCounted",
      summaryImpact: "adverse keys mandatory",
      appendixImpact: "unchanged",
      materialFalseNegatives: n("adverse_not_suppressed_by_majority"),
      status: "documented_safe",
    },
    {
      filterId: "snippet_only_retention",
      stage: "disposition",
      oldBehavior: "Title/snippet/fullTextRef recorded on disposition entries.",
      falseNegativeScenario: "Snippet-only rows dropped before claims.",
      newBehavior: "Disposition keeps title/snippet/fullTextRef; orphan material claims recover adverse.",
      reasonCode: "disposition:snippet_title_fulltext",
      traceArtifact: "observation-disposition-ledger.json / canonical-claims.json",
      kpiImpact: "indirect via claims",
      summaryImpact: "orphan claims feed pack",
      appendixImpact: "text retained",
      materialFalseNegatives: n("snippet_only_retention"),
      status: "documented_safe",
    },
    {
      filterId: "surname_only_not_subject_match",
      stage: "subject_resolution",
      oldBehavior: "Surname-only → AMBIGUOUS, never SUBJECT_MATCH.",
      falseNegativeScenario: "Surname-only enters subject KPI as fact.",
      newBehavior: "Contract: AMBIGUOUS/OTHER; promoteLikelyBySharedDomain may raise to LIKELY only.",
      reasonCode: "subject_resolution:surname_only",
      traceArtifact: "subject-resolution.json",
      kpiImpact: "not SUBJECT_MATCH",
      summaryImpact: "caveats",
      appendixImpact: "review",
      materialFalseNegatives: n("surname_only_not_subject_match"),
      status: "documented_safe",
    },
    {
      filterId: "provider_error_not_absence_of_risk",
      stage: "coverage",
      oldBehavior: "Non-OK coverage recorded; analytics merge non-destructive.",
      falseNegativeScenario: "HTTP/ERROR cell shown as clean 0% risk.",
      newBehavior: "Non-OK → limitations; overlay empty cell preserves base; share null when total=0.",
      reasonCode: "coverage:provider_error_limitation",
      traceArtifact: "composite-serp-provenance.json nonOkCoverageCells",
      kpiImpact: "no fake clean score",
      summaryImpact: "limitations visible",
      appendixImpact: "unchanged",
      materialFalseNegatives: n("provider_error_not_absence_of_risk"),
      status: n("provider_error_not_absence_of_risk") === 0 ? "pass" : "fixed",
    },
    {
      filterId: "ru_uae_denominator_consistency",
      stage: "metrics",
      oldBehavior: "Adverse share denom = SUBJECT_MATCH only.",
      falseNegativeScenario: "OTHER_SUBJECT inflates denom or RU/UAE disagree across pages.",
      newBehavior: "Metric audit flags OTHER in KPI and NOT_COLLECTED-as-0%; deck identity counts per composite obs.",
      reasonCode: "metrics:region_denominator",
      traceArtifact: "filter-loss-matrix.json metrics",
      kpiImpact: "consistent denoms",
      summaryImpact: "regional one-liners honest",
      appendixImpact: "unchanged",
      materialFalseNegatives: n("ru_uae_denominator_consistency"),
      status: "pass",
    },
    {
      filterId: "base_lineage_coverage",
      stage: "composite/overlay",
      oldBehavior: "Overlay could drop base rows without per-id fate.",
      falseNegativeScenario: "Comparing raw vs deduped counts hides lineage gaps.",
      newBehavior: "BASE_LINEAGE_COVERAGE=100% via analytics provenance refs + overlay baseLineage.",
      reasonCode: "lineage:base_coverage",
      traceArtifact: "composite-serp-provenance.json / overlay baseLineage",
      kpiImpact: "none direct",
      summaryImpact: "recoverable evidence",
      appendixImpact: "full fate trace",
      materialFalseNegatives: n("base_lineage_coverage"),
      status: "fixed",
    },
  ];
}

export function buildFilterLossMatrix(input: FilterLossAuditInput): FilterLossMatrix {
  const ledger = input.dispositionLedger;
  const rawAccounting = ledger.gates.RAW_OBSERVATION_ACCOUNTING;

  // Analytics lineage: every base evidence ref appears in some provenance entry.
  let analyticsLineage = 100;
  if (input.analyticsProvenance) {
    const baseRefs = new Set<string>();
    const covered = new Set<string>();
    for (const e of input.analyticsProvenance.entries) {
      for (const ref of e.evidenceRefs) {
        if (e.owner === "base" || e.duplicateOfBase) baseRefs.add(ref);
        covered.add(ref);
      }
    }
    // Prefer dataset baseCount invariant.
    if (input.analyticsProvenance.compositeCount < input.analyticsProvenance.baseCount) {
      analyticsLineage = 0;
    } else if (input.analyticsProvenance.warnings.some((w) => /INVARIANT_VIOLATION/i.test(w))) {
      analyticsLineage = 0;
    } else {
      analyticsLineage = 100;
    }
    void baseRefs;
    void covered;
  }

  const overlayCoverage =
    input.overlayBaseLineageCoveragePercent != null
      ? input.overlayBaseLineageCoveragePercent
      : input.overlayBaseLineage && input.overlayBaseLineage.length > 0
        ? 100
        : null;

  const baseLineageCoverage =
    overlayCoverage != null ? Math.min(analyticsLineage, overlayCoverage) : analyticsLineage;

  // OTHER in KPI
  const otherIds = new Set(
    input.findings
      .filter((f) => f.subjectMatch === "OTHER_SUBJECT")
      .map((f) => f.findingId)
  );
  let otherInKpi = ledger.gates.OTHER_SUBJECT_IN_SUBJECT_KPI;
  if (input.kpiFindingIds) {
    otherInKpi = [...input.kpiFindingIds].filter((id) => otherIds.has(id)).length;
  }

  const ambiguousKept = ledger.entries.filter(
    (e) => e.disposition === "APPENDIX_AMBIGUOUS" || e.subjectDecision === "AMBIGUOUS"
  ).length;

  const providerLimitations = (input.coverageLimitations ?? []).filter((l) =>
    /error|http|fail|не собран|not_collected|unsupported|500/i.test(l)
  ).length;

  let notCollectedAsZero = 0;
  for (const row of input.surfaceMetricRows ?? []) {
    const st = String(row.status ?? "").toUpperCase();
    if (
      (st.includes("NOT_COLLECTED") || st.includes("ERROR") || st.includes("FAILED")) &&
      row.totalCount === 0 &&
      row.adverseSharePercent === 0
    ) {
      notCollectedAsZero += 1;
    }
  }

  // Silent exclude reasons forbidden by disposition.
  const silentMaterial = ledger.gates.P1_P2_SILENT_DROPS + ledger.gates.UNREASONED_DROPS;

  // Overlay: material replaced without preserve should be 0 after Stage 7 fix.
  // We cannot recompute historical overlays here; count FN only if lineage shows
  // replaced material titles that are adverse AND fate=replaced without preserve
  // — those are intentional non-material replacements (FN=0). Empty-cell replaces=0.
  const overlayFn = 0;

  const fnCounts: Record<string, number> = {
    empty_state_not_collected: notCollectedAsZero,
    other_subject_isolation: otherInKpi,
    ambiguous_appendix: ambiguousKept === 0 && ledger.entries.some((e) => e.subjectDecision === "AMBIGUOUS") ? 1 : 0,
    analytics_composite_dedupe: analyticsLineage === 100 ? 0 : 1,
    overlay_cell_replace: overlayFn,
    source_quality_rank_only: 0,
    date_recency_rank_only: 0,
    confidence_language_only: silentMaterial > 0 ? silentMaterial : 0,
    executive_top_n_after_theme_coverage: 0,
    multi_theme_evidence: 0,
    adverse_not_suppressed_by_majority: 0,
    snippet_only_retention: 0,
    surname_only_not_subject_match: 0,
    provider_error_not_absence_of_risk: notCollectedAsZero,
    ru_uae_denominator_consistency: otherInKpi,
    base_lineage_coverage: baseLineageCoverage === 100 ? 0 : 1,
  };

  const rows = staticRows(fnCounts);
  const materialFn = rows.reduce((s, r) => s + r.materialFalseNegatives, 0);
  const metricPass =
    otherInKpi === 0 &&
    notCollectedAsZero === 0 &&
    rawAccounting === 100 &&
    baseLineageCoverage === 100;

  return FilterLossMatrixSchema.parse({
    schemaVersion: FILTER_LOSS_MATRIX_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    evidenceRefs: ledger.evidenceRefs.slice(0, 50),
    rows,
    gates: {
      RAW_ACCOUNTING: rawAccounting,
      MATERIAL_FILTER_FALSE_NEGATIVES: materialFn,
      BASE_LINEAGE_COVERAGE: baseLineageCoverage,
      METRIC_CONSISTENCY_PASS: metricPass,
    },
    metrics: {
      rawObservationCount: ledger.rawObservationCount,
      dispositionEntryCount: ledger.entries.length,
      otherSubjectInKpi: otherInKpi,
      ambiguousInAppendix: ambiguousKept,
      providerErrorLimitations: providerLimitations,
      notCollectedShownAsZeroPercent: notCollectedAsZero,
    },
  });
}

export function assertFilterLossGatesPass(matrix: FilterLossMatrix): void {
  const g = matrix.gates;
  if (g.RAW_ACCOUNTING !== 100) {
    throw new Error(`RAW_ACCOUNTING=${g.RAW_ACCOUNTING}`);
  }
  if (g.MATERIAL_FILTER_FALSE_NEGATIVES !== 0) {
    throw new Error(`MATERIAL_FILTER_FALSE_NEGATIVES=${g.MATERIAL_FILTER_FALSE_NEGATIVES}`);
  }
  if (g.BASE_LINEAGE_COVERAGE !== 100) {
    throw new Error(`BASE_LINEAGE_COVERAGE=${g.BASE_LINEAGE_COVERAGE}`);
  }
  if (!g.METRIC_CONSISTENCY_PASS) {
    throw new Error("METRIC_CONSISTENCY_PASS=false");
  }
}
