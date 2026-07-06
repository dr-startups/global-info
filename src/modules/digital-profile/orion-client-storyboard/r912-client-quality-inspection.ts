import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertNoClientHostileTokens,
  collectClientVisibleTextFromStoryboard,
} from "./client-text-contract";
import type { EvidenceRelevanceReport } from "./evidence-relevance-classifier";
import { scanStoryboardClientText } from "./schema";
import type { ClientStoryboard, GptStoryboardSectionAnalysis } from "./types";

export type R912ClientQualityVerdict =
  | "PASS"
  | "BLOCKED_CLIENT_TEXT_LEAK"
  | "BLOCKED_RELEVANCE_FILTER"
  | "BLOCKED_LAYOUT_OVERLAP"
  | "BLOCKED_GPT_NOT_USED"
  | "BLOCKED_OPENAI_RATE_LIMIT"
  | "BLOCKED_LEXIS_ANALYSIS_WEAK"
  | "BLOCKED";

export interface R912ClientQualityInspection {
  version: string;
  passed: boolean;
  verdict: R912ClientQualityVerdict;
  checks: Array<{ id: string; passed: boolean; detail?: string }>;
}

const NOISE_TERMS = ["aliexpress", "лампа", "lilygo", "led lamp"];

export function inspectR912ClientQuality(input: {
  outputRoot: string;
  storyboard: ClientStoryboard;
  relevanceReport: EvidenceRelevanceReport;
  gptAnalyses: GptStoryboardSectionAnalysis[];
  generatedBy: string;
}): R912ClientQualityInspection {
  const checks: R912ClientQualityInspection["checks"] = [];
  const clientText = collectClientVisibleTextFromStoryboard(input.storyboard);

  const scanIssues = scanStoryboardClientText(clientText);
  const hostileIssues = assertNoClientHostileTokens(clientText, "r912");
  checks.push({
    id: "text-no-raw-ids",
    passed: scanIssues.filter((i) => i.includes("cmr") || i.includes("evidence-ref")).length === 0,
    detail: scanIssues.join(",") || "0",
  });
  checks.push({
    id: "text-no-hostile-tokens",
    passed: hostileIssues.length === 0,
    detail: hostileIssues.slice(0, 5).join(",") || "0",
  });
  checks.push({
    id: "text-no-debug-mock",
    passed: !/\b(mock|fallback|debug|manifest|fixture)\b/i.test(clientText),
  });

  const keyText = input.storyboard.slides
    .filter((s) => s.slideType === "relevant_sources" || s.slideType === "search_results_table")
    .flatMap((s) => s.evidenceRefs.map((e) => `${e.label} ${e.summary}`))
    .join("\n")
    .toLowerCase();
  checks.push({
    id: "relevance-led-excluded",
    passed: !NOISE_TERMS.some((t) => keyText.includes(t)),
    detail: NOISE_TERMS.filter((t) => keyText.includes(t)).join(",") || "none",
  });
  checks.push({
    id: "relevance-noise-flag",
    passed: input.relevanceReport.noiseExcludedFromKeyResults,
  });
  checks.push({
    id: "relevance-excluded-slide",
    passed: input.storyboard.slides.some((s) => s.slideType === "excluded_matches"),
  });

  const requiredGpt = [
    "executive_summary",
    "ru_audit_summary",
    "ru_search_results",
    "lexis_summary",
    "recommended_actions",
  ];
  for (const key of requiredGpt) {
    const a = input.gptAnalyses.find((g) => g.sectionKey === key);
    checks.push({
      id: `gpt-${key}`,
      passed: a?.generatedBy === "gpt-5.5",
      detail: a?.generatedBy,
    });
  }
  checks.push({
    id: "gpt-no-deterministic",
    passed: input.generatedBy === "gpt-5.5",
    detail: input.generatedBy,
  });

  const exec = input.storyboard.slides.find((s) => s.slideType === "executive_summary");
  checks.push({
    id: "layout-exec-metrics",
    passed: (exec?.metrics?.length ?? 0) >= 2 && Boolean(exec?.clientTakeaway?.trim()),
  });
  checks.push({
    id: "layout-exec-actions",
    passed: (exec?.recommendedActions?.length ?? 0) >= 1,
  });

  const ru = input.storyboard.slides.find((s) => s.slideType === "region_summary");
  checks.push({
    id: "layout-ru-cards",
    passed: (ru?.findings?.length ?? 0) >= 1 && Boolean(ru?.clientTakeaway?.trim()),
    detail: String(ru?.findings?.length ?? 0),
  });

  let maxBulletsOk = true;
  for (const slide of input.storyboard.slides) {
    const count =
      slide.findings.length + slide.recommendedActions.length + slide.evidenceRefs.length;
    if (count > 5) maxBulletsOk = false;
    for (const f of slide.findings) {
      if ((f.summary?.length ?? 0) > 230) checks.push({ id: `clipped-${slide.slideId}`, passed: false });
    }
  }
  checks.push({ id: "layout-max-bullets", passed: maxBulletsOk });

  const lexisSummary = input.storyboard.slides.find((s) => s.slideType === "lexisnexis_summary");
  const lexisSignals = input.storyboard.slides.find((s) => s.slideType === "lexisnexis_signals");
  const lexisPages = input.storyboard.slides.filter((s) => s.slideType === "lexisnexis_visual_page");
  const lexisSummaryIdx = input.storyboard.slides.findIndex((s) => s.slideType === "lexisnexis_summary");
  const firstLexisPageIdx = input.storyboard.slides.findIndex((s) => s.slideType === "lexisnexis_visual_page");
  checks.push({
    id: "lexis-analytical-before-appendix",
    passed: lexisSummaryIdx >= 0 && (firstLexisPageIdx < 0 || lexisSummaryIdx < firstLexisPageIdx),
  });
  checks.push({
    id: "lexis-signals-slide",
    passed: Boolean(lexisSignals) && (lexisSignals?.findings?.length ?? 0) >= 1,
    detail: String(lexisSignals?.findings?.length ?? 0),
  });
  checks.push({
    id: "lexis-summary-content",
    passed: Boolean(lexisSummary?.clientTakeaway?.trim()) && (lexisSummary?.metrics?.length ?? 0) >= 2,
  });

  const serpSlides = input.storyboard.slides.filter((s) => s.slideType === "serp_screenshot");
  checks.push({ id: "serp-slides-present", passed: serpSlides.length >= 1, detail: String(serpSlides.length) });

  const analyticalTypes = new Set([
    "scope_overview",
    "risk_conclusion",
    "region_summary",
    "relevant_sources",
    "excluded_matches",
    "adverse_media_summary",
    "lexisnexis_summary",
    "lexisnexis_signals",
    "recommended_actions",
  ]);
  for (const slide of input.storyboard.slides.filter((s) => analyticalTypes.has(s.slideType))) {
    const hasQ1 = Boolean(slide.clientTakeaway?.trim());
    const hasQ2 =
      slide.findings.length + slide.evidenceRefs.length >= 1 ||
      slide.metrics.length >= 1 ||
      (slide.slideType === "recommended_actions" && slide.recommendedActions.length >= 1);
    checks.push({
      id: `readability-${slide.slideId}`,
      passed: hasQ1 && hasQ2,
      detail: slide.slideType,
    });
  }

  const pdfExists = existsSync(join(input.outputRoot, "rendered-client.pdf"));
  checks.push({ id: "artifact-pdf", passed: pdfExists });

  let verdict: R912ClientQualityVerdict = "PASS";
  if (checks.some((c) => c.id.startsWith("text-") && !c.passed)) verdict = "BLOCKED_CLIENT_TEXT_LEAK";
  else if (checks.some((c) => c.id.startsWith("relevance-") && !c.passed)) verdict = "BLOCKED_RELEVANCE_FILTER";
  else if (checks.some((c) => c.id.startsWith("layout-") && !c.passed)) verdict = "BLOCKED_LAYOUT_OVERLAP";
  else if (checks.some((c) => c.id.startsWith("gpt-") && !c.passed)) verdict = "BLOCKED_GPT_NOT_USED";
  else if (checks.some((c) => c.id.startsWith("lexis-") && !c.passed)) verdict = "BLOCKED_LEXIS_ANALYSIS_WEAK";
  else if (!checks.every((c) => c.passed)) verdict = "BLOCKED";

  return {
    version: "r912-client-quality-inspection-v1",
    passed: verdict === "PASS",
    verdict,
    checks,
  };
}
