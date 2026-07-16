/**
 * Stage 1 regression fixtures — characterize defect shapes for later prompts.
 * No production fixes here.
 */

export type Stage1DefectFlag =
  | "REPEATED_TOC_PAGE_SUFFIX"
  | "RED_MARKER_WITHOUT_LABEL"
  | "OTHER_SUBJECT_ENTERING_KPI"
  | "NOT_COLLECTED_SHOWN_AS_ZERO_PERCENT"
  | "STALE_ARSENKIN_ONLY_BINDING"
  | "ADVERSE_FINDING_ABSENT_FROM_SUMMARY"
  | "TRUNCATED_AI_LEXIS_SENTENCE"
  | "EMPTY_FULL_PAGE_STATE";

export type Stage1RegressionFixture = {
  id: string;
  defectFlag: Stage1DefectFlag;
  description: string;
  /** Minimal payload used by characterization tests */
  payload: Record<string, unknown>;
  expectedSignals: string[];
};

export const FIXTURE_REPEATED_TOC: Stage1RegressionFixture = {
  id: "repeated-toc-n-str",
  defectFlag: "REPEATED_TOC_PAGE_SUFFIX",
  description: "TOC entry shows duplicated page-count suffix like '(12 стр.) (12 стр.)'",
  payload: {
    tocLines: [
      "1. Резюме (3 стр.)",
      "2. Поисковая выдача (12 стр.) (12 стр.)",
      "3. Риски (5 стр.)",
    ],
  },
  expectedSignals: ["(12 стр.) (12 стр.)"],
};

export const FIXTURE_RED_MARKER_WITHOUT_LABEL: Stage1RegressionFixture = {
  id: "red-marker-without-label",
  defectFlag: "RED_MARKER_WITHOUT_LABEL",
  description: "Adverse/highlight marker present without client-safe label",
  payload: {
    slideId: "serp-ru-organic-1",
    markers: [{ kind: "adverse_red", label: "", evidenceRef: "obs:1" }],
  },
  expectedSignals: ["adverse_red", "empty_label"],
};

export const FIXTURE_OTHER_SUBJECT_ENTERING_KPI: Stage1RegressionFixture = {
  id: "other-subject-entering-kpi",
  defectFlag: "OTHER_SUBJECT_ENTERING_KPI",
  description: "Mikhail Glinka / composer hit counted in Sergey subject KPI denominator",
  payload: {
    subject: "Сергей Глинка",
    kpi: { surface: "organic", adverseCount: 1, total: 10 },
    rows: [
      {
        title: "Михаил Глинка — оперы и партитуры",
        subjectMatch: "OTHER_SUBJECT",
        countedInKpi: true,
      },
    ],
  },
  expectedSignals: ["OTHER_SUBJECT", "countedInKpi:true"],
};

export const FIXTURE_NOT_COLLECTED_ZERO_PERCENT: Stage1RegressionFixture = {
  id: "not-collected-zero-percent",
  defectFlag: "NOT_COLLECTED_SHOWN_AS_ZERO_PERCENT",
  description: "NOT_COLLECTED surface rendered as 0% instead of not-collected",
  payload: {
    surface: "paa_related",
    region: "UAE",
    sampleStatus: "NOT_COLLECTED",
    displayedMetric: "0%",
  },
  expectedSignals: ["NOT_COLLECTED", "0%"],
};

export const FIXTURE_STALE_ARSENKIN_ONLY_BINDING: Stage1RegressionFixture = {
  id: "stale-arsenkin-only-binding",
  defectFlag: "STALE_ARSENKIN_ONLY_BINDING",
  description: "Binding lists Arsenkin enrichment without valid canonical baseReportRunId",
  payload: {
    canonicalBaseReportRunId: null,
    enrichmentRunIds: ["orion-arsenkin-first36-full-stale-1"],
    effectiveReportRunId: "orion-arsenkin-first36-full-stale-1",
  },
  expectedSignals: ["base_missing", "arsenkin_only"],
};

export const FIXTURE_ADVERSE_ABSENT_FROM_SUMMARY: Stage1RegressionFixture = {
  id: "adverse-finding-absent-from-summary",
  defectFlag: "ADVERSE_FINDING_ABSENT_FROM_SUMMARY",
  description: "Adverse finding present in verified bundle but missing from executive summary keys",
  payload: {
    findingIds: ["finding-offshore-1"],
    summaryKeyFindingIds: [],
    finding: {
      findingId: "finding-offshore-1",
      theme: "offshore",
      riskLevel: "high",
      subjectMatch: "SUBJECT_MATCH",
    },
  },
  expectedSignals: ["finding-offshore-1", "missing_from_summary"],
};

export const FIXTURE_TRUNCATED_AI_LEXIS_SENTENCE: Stage1RegressionFixture = {
  id: "truncated-ai-lexis-sentence",
  defectFlag: "TRUNCATED_AI_LEXIS_SENTENCE",
  description: "AI/Lexis-style client sentence cut mid-phrase with ellipsis",
  payload: {
    text: "По открытым источникам субъект связан с офшорными структурами в…",
    source: "ai_answer",
  },
  expectedSignals: ["…", "truncated"],
};

export const FIXTURE_EMPTY_FULL_PAGE_STATE: Stage1RegressionFixture = {
  id: "empty-full-page-state",
  defectFlag: "EMPTY_FULL_PAGE_STATE",
  description: "Full-page slide slot with no fragments/assets/findings",
  payload: {
    slideId: "continuation-images-uae-3",
    role: "continuation",
    fragmentIds: [],
    assetRefs: [],
    findingIds: [],
  },
  expectedSignals: ["empty_page"],
};

export const STAGE1_REGRESSION_FIXTURES: Stage1RegressionFixture[] = [
  FIXTURE_REPEATED_TOC,
  FIXTURE_RED_MARKER_WITHOUT_LABEL,
  FIXTURE_OTHER_SUBJECT_ENTERING_KPI,
  FIXTURE_NOT_COLLECTED_ZERO_PERCENT,
  FIXTURE_STALE_ARSENKIN_ONLY_BINDING,
  FIXTURE_ADVERSE_ABSENT_FROM_SUMMARY,
  FIXTURE_TRUNCATED_AI_LEXIS_SENTENCE,
  FIXTURE_EMPTY_FULL_PAGE_STATE,
];

export function characterizeFixture(fixture: Stage1RegressionFixture): {
  id: string;
  defectFlag: Stage1DefectFlag;
  matched: boolean;
  matchedSignals: string[];
} {
  const blob = JSON.stringify(fixture.payload);
  const matchedSignals = fixture.expectedSignals.filter((s) => {
    if (s === "empty_label") {
      const markers = (fixture.payload.markers as Array<{ label?: string }> | undefined) ?? [];
      return markers.some((m) => !m.label || m.label.trim() === "");
    }
    if (s === "countedInKpi:true") {
      return blob.includes('"countedInKpi":true');
    }
    if (s === "base_missing") {
      return fixture.payload.canonicalBaseReportRunId == null;
    }
    if (s === "arsenkin_only") {
      const enrich = fixture.payload.enrichmentRunIds as string[] | undefined;
      return Array.isArray(enrich) && enrich.length > 0 && fixture.payload.canonicalBaseReportRunId == null;
    }
    if (s === "missing_from_summary") {
      const keys = fixture.payload.summaryKeyFindingIds as string[] | undefined;
      const ids = fixture.payload.findingIds as string[] | undefined;
      return Array.isArray(ids) && ids.some((id) => !(keys ?? []).includes(id));
    }
    if (s === "truncated") {
      return /…|\.\.\.$/.test(String(fixture.payload.text ?? ""));
    }
    if (s === "empty_page") {
      const fr = fixture.payload.fragmentIds as unknown[] | undefined;
      const ar = fixture.payload.assetRefs as unknown[] | undefined;
      const fi = fixture.payload.findingIds as unknown[] | undefined;
      return (fr?.length ?? 0) === 0 && (ar?.length ?? 0) === 0 && (fi?.length ?? 0) === 0;
    }
    return blob.includes(s);
  });
  return {
    id: fixture.id,
    defectFlag: fixture.defectFlag,
    matched: matchedSignals.length === fixture.expectedSignals.length,
    matchedSignals,
  };
}
