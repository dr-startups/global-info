import type {
  OrionConsistencyInspection,
  OrionConsistencyViolation,
  OrionFinalDeckManifest,
  OrionGpt55SectionAnalysis,
  OrionSlideManifest,
} from "./types";

function pushViolation(
  list: OrionConsistencyViolation[],
  input: {
    section: string;
    microStage: string;
    slide: string;
    field: string;
    expected: string;
    actual: string;
  }
) {
  list.push(input);
}

function checkNoRawThemeKeys(json: string, violations: OrionConsistencyViolation[]): void {
  const rawTheme = /\b(sanctions_watchlist|political_exposure|legal_dispute|adverse_media|pep_political_exposure|pep_rca)\b/;
  if (rawTheme.test(json)) {
    pushViolation(violations, {
      section: "client-policy",
      microStage: "all",
      slide: "all",
      field: "rawThemeKeys",
      expected: "localized labels only",
      actual: "raw theme key detected",
    });
  }
}

function checkNoForbiddenTokens(json: string, violations: OrionConsistencyViolation[]): void {
  const forbidden = ["internaldebug", "providererror", "storagekey", "rawmodelresponse", "openai_api_key", "c:\\", "/users/"];
  for (const token of forbidden) {
    if (json.toLowerCase().includes(token)) {
      pushViolation(violations, {
        section: "client-policy",
        microStage: "all",
        slide: "all",
        field: "forbiddenToken",
        expected: "no internal/provider/local path leaks",
        actual: token,
      });
    }
  }
}

function checkGenericThemeRepetition(json: string, violations: OrionConsistencyViolation[]): void {
  const count = (json.match(/Тема требует классификации/g) ?? []).length;
  if (count > 1) {
    pushViolation(violations, {
      section: "content",
      microStage: "all",
      slide: "all",
      field: "genericThemePhrase",
      expected: "<= 1 occurrence",
      actual: String(count),
    });
  }
}

export function runOrionConsistencyChecks(input: {
  finalDeckManifest: OrionFinalDeckManifest;
  slideManifests: OrionSlideManifest[];
  analyses: OrionGpt55SectionAnalysis[];
  clientReportJson: Record<string, unknown>;
  reportLanguage: "ru" | "en";
}): OrionConsistencyInspection {
  const violations: OrionConsistencyViolation[] = [];
  const warnings: string[] = [];
  const clientJsonStr = JSON.stringify(input.clientReportJson ?? {});

  const stageSetFromDeck = new Set(
    input.finalDeckManifest.sections.flatMap((section) => section.slides.map((slide) => slide.slideId.split("-")[0]))
  );
  for (const stageManifest of input.slideManifests) {
    if (stageManifest.microStageKey === "cover" || stageManifest.microStageKey === "toc_global") continue;
    if (!stageSetFromDeck.has(stageManifest.microStageKey)) {
      pushViolation(violations, {
        section: stageManifest.macroSectionKey,
        microStage: stageManifest.microStageKey,
        slide: "n/a",
        field: "deck-composition",
        expected: "micro-stage included in final deck",
        actual: "missing",
      });
    }
  }

  const analysisByStage = new Map(input.analyses.map((a) => [a.microStageKey, a]));
  const ruAnalyses = input.analyses.filter((a) => a.microStageKey.startsWith("ru_"));
  const uaeAnalyses = input.analyses.filter((a) => a.microStageKey.startsWith("uae_"));
  const executive = analysisByStage.get("executive_narrative_summary");
  const ruSummary = analysisByStage.get("ru_audit_summary");
  const uaeSummary = analysisByStage.get("uae_audit_summary");
  const lexisOverview = analysisByStage.get("lexisnexis_profile_overview");
  const lexisVisual = analysisByStage.get("lexisnexis_visual_pages");
  for (const stageManifest of input.slideManifests) {
    const analysis = analysisByStage.get(stageManifest.microStageKey);
    if (!analysis) {
      pushViolation(violations, {
        section: stageManifest.macroSectionKey,
        microStage: stageManifest.microStageKey,
        slide: "n/a",
        field: "analysis",
        expected: "analysis exists",
        actual: "missing",
      });
      continue;
    }
    if (analysis.evidenceSummary.total === 0 && stageManifest.slides.length > 0) {
      warnings.push(`Micro-stage ${stageManifest.microStageKey} has slide content but zero evidence summary.`);
    }
    if (
      analysis.evidenceSummary.confirmed === 0 &&
      analysis.evidenceSummary.requiresReview > 0 &&
      !analysis.clientNarrative.whatRequiresReview.join(" ").toLowerCase().includes("провер")
    ) {
      pushViolation(violations, {
        section: stageManifest.macroSectionKey,
        microStage: stageManifest.microStageKey,
        slide: stageManifest.slides[0]?.slideId ?? "n/a",
        field: "requiresReviewWording",
        expected: "manual review wording present",
        actual: "missing manual review cue",
      });
    }
  }

  // R9.2 real-data consistency checks.
  const ruSignals = ruAnalyses.reduce(
    (acc, x) => {
      acc.total += x.evidenceSummary.total;
      acc.review += x.evidenceSummary.requiresReview;
      acc.confirmed += x.evidenceSummary.confirmed;
      return acc;
    },
    { total: 0, review: 0, confirmed: 0 }
  );
  const uaeSignals = uaeAnalyses.reduce(
    (acc, x) => {
      acc.total += x.evidenceSummary.total;
      acc.review += x.evidenceSummary.requiresReview;
      acc.confirmed += x.evidenceSummary.confirmed;
      return acc;
    },
    { total: 0, review: 0, confirmed: 0 }
  );
  if (ruSummary && ruSignals.total > 0 && ruSummary.evidenceSummary.total === 0) {
    pushViolation(violations, {
      section: "consistency",
      microStage: "ru_audit_summary",
      slide: "ru_audit_summary-01",
      field: "ru-summary-counts",
      expected: "RU summary reflects RU micro-stage evidence",
      actual: "RU summary total is zero while RU stages have evidence",
    });
  }
  if (uaeSummary && uaeSignals.total > 0 && uaeSummary.evidenceSummary.total === 0) {
    pushViolation(violations, {
      section: "consistency",
      microStage: "uae_audit_summary",
      slide: "uae_audit_summary-01",
      field: "uae-summary-counts",
      expected: "UAE summary reflects UAE micro-stage evidence",
      actual: "UAE summary total is zero while UAE stages have evidence",
    });
  }
  if (
    executive &&
    executive.evidenceSummary.confirmed === 0 &&
    executive.evidenceSummary.requiresReview > 0 &&
    !/требует ручной проверки/i.test(executive.clientNarrative.plainConclusion)
  ) {
    pushViolation(violations, {
      section: "consistency",
      microStage: "executive_narrative_summary",
      slide: "executive_narrative_summary-01",
      field: "executive-wording",
      expected: "plainConclusion explains review-required without confirmed negatives",
      actual: executive.clientNarrative.plainConclusion,
    });
  }
  if (input.analyses.some((a) => a.evidenceSummary.total > 0) && /не собрано/i.test(clientJsonStr)) {
    pushViolation(violations, {
      section: "consistency",
      microStage: "all",
      slide: "all",
      field: "not-collected-contradiction",
      expected: "no 'не собрано' wording when data exists",
      actual: "phrase detected",
    });
  }
  for (const a of input.analyses) {
    if (a.evidenceSummary.total > 0 && (a.evidenceSummary.keyDomains ?? []).length === 0) {
      warnings.push(`Micro-stage ${a.microStageKey} has evidence but no key domains.`);
    }
  }
  if (
    lexisOverview &&
    lexisOverview.evidenceSummary.total > 0 &&
    /не запрошен/i.test(JSON.stringify(executive?.clientNarrative ?? {}))
  ) {
    pushViolation(violations, {
      section: "consistency",
      microStage: "lexisnexis_profile_overview",
      slide: "lexisnexis_profile_overview-01",
      field: "lexis-status-contradiction",
      expected: "executive wording consistent with Lexis section",
      actual: "executive says lexis not requested while lexis data exists",
    });
  }
  if (
    lexisVisual &&
    lexisVisual.evidenceSummary.total > 0 &&
    input.finalDeckManifest.lexisNexisVisualPageCount === 0 &&
    !input.slideManifests
      .flatMap((x) => x.slides)
      .some((s) => s.slideType === "lexisnexis_unavailable_fallback")
  ) {
    pushViolation(violations, {
      section: "consistency",
      microStage: "lexisnexis_visual_pages",
      slide: "lexisnexis_visual_pages-01",
      field: "lexis-visual-contract",
      expected: "visual pages or explicit fallback slide",
      actual: "no visual pages and no fallback",
    });
  }

  checkNoRawThemeKeys(clientJsonStr, violations);
  checkNoForbiddenTokens(clientJsonStr, violations);
  checkGenericThemeRepetition(clientJsonStr, violations);

  if (input.reportLanguage === "ru" && /[A-Za-z]{6,}/.test(clientJsonStr)) {
    warnings.push("Potential English leakage detected in RU report payload.");
  }

  return {
    status: violations.length === 0 ? "PASS" : "BLOCKED",
    violations,
    warnings,
  };
}

