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

  const clientJsonStr = JSON.stringify(input.clientReportJson ?? {});
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

