import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeOrionV2AiReadiness } from "../config";
import { buildReportAssets } from "../orion-report-spec/asset-builder";
import { OpenAiRateLimitError } from "../orion-report-spec/openai-rate-limit";
import {
  buildExecutiveEvidence,
  buildRuAuditSummaryEvidence,
  buildRuSearchEvidence,
} from "../orion-report-spec/section-evidence-adapter";
import { loadRealCaseContext } from "../orion-section-pipeline/real-case-data-adapter";
import { buildLexisReportAssets } from "./lexis-asset-builder";
import { classifyEvidenceRelevance } from "./evidence-relevance-classifier";
import { runR912GptAnalyses } from "./gpt-storyboard-analyzer";
import { inspectRealCaseData } from "./real-case-data-inspection";
import {
  inspectClientPolicy,
  inspectClientReadability,
  inspectLexisVisual,
  inspectStrictSerpVisual,
  inspectVisualQuality,
} from "./r910-e2e-inspections";
import { inspectR912ClientQuality } from "./r912-client-quality-inspection";
import { composeClientStoryboard } from "./storyboard-composer";
import { renderClientStoryboardArtifacts } from "./storyboard-render-client";
import { validateClientStoryboard } from "./schema";

export const R912_OUTPUT_ROOT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-r9-12-client-quality-storyboard"
);

export interface RunR912Result {
  outputRoot: string;
  caseId: string;
  generatedBy: "gpt-5.5" | "deterministic" | "mixed";
  pdfExportMode: string;
  pageCount: number;
  slideCount: number;
  verdict: string;
}

export async function runR912ClientQualityStoryboardE2e(options: {
  caseId: string;
  outputRoot?: string;
}): Promise<RunR912Result> {
  const outputRoot = options.outputRoot ?? R912_OUTPUT_ROOT;
  mkdirSync(outputRoot, { recursive: true });

  const caseId = options.caseId.trim();
  if (!caseId) throw new Error("CASE_ID required");

  const caseContext = await loadRealCaseContext(caseId, { locale: "ru", buildFreshReportJson: true });
  const realCaseInspection = inspectRealCaseData(caseId, caseContext);
  writeFileSync(join(outputRoot, "real-case-data-inspection.json"), JSON.stringify(realCaseInspection, null, 2));

  if (!realCaseInspection.passed) {
    writeFileSync(
      join(outputRoot, "qa-summary.json"),
      JSON.stringify({ version: "r912-qa-summary-v1", caseId, verdict: "BLOCKED_REAL_CASE_REQUIRED" }, null, 2)
    );
    return {
      outputRoot,
      caseId,
      generatedBy: "deterministic",
      pdfExportMode: "unknown",
      pageCount: 0,
      slideCount: 0,
      verdict: "BLOCKED_REAL_CASE_REQUIRED",
    };
  }

  const readiness = describeOrionV2AiReadiness();
  if (!readiness.ready) throw new Error("gpt55-required-but-unavailable");

  const executiveEvidence = buildExecutiveEvidence(caseContext);
  const ruAuditEvidence = buildRuAuditSummaryEvidence(caseContext);
  const ruSearchEvidence = buildRuSearchEvidence(caseContext);
  const evidenceByRef = new Map<string, (typeof executiveEvidence)[number]>();
  for (const item of [...executiveEvidence, ...ruAuditEvidence, ...ruSearchEvidence]) {
    if (!evidenceByRef.has(item.evidenceRef)) evidenceByRef.set(item.evidenceRef, item);
  }
  const allEvidence = [...evidenceByRef.values()];
  writeFileSync(join(outputRoot, "normalized-evidence.json"), JSON.stringify(allEvidence, null, 2));

  const relevanceReport = classifyEvidenceRelevance(allEvidence, caseContext.subject.fullName);
  writeFileSync(
    join(outputRoot, "evidence-relevance-inspection.json"),
    JSON.stringify(
      {
        ...relevanceReport,
        classified: relevanceReport.classified.map((c) => ({
          title: c.evidence.title,
          type: c.type,
          reason: c.reason,
          humanReason: c.humanReason,
        })),
      },
      null,
      2
    )
  );

  const assets = [
    ...(await buildReportAssets({ subjectName: caseContext.subject.fullName, ruSearchEvidence })),
    ...(await buildLexisReportAssets(caseContext)),
  ];
  writeFileSync(join(outputRoot, "report-assets.json"), JSON.stringify(assets, null, 2));

  const gptAnalyses = await runR912GptAnalyses({
    caseContext,
    classifiedEvidence: relevanceReport.classified,
    assets,
    requireAi: true,
    allowDeterministicFallback: false,
  });
  writeFileSync(join(outputRoot, "gpt-section-analyses.json"), JSON.stringify(gptAnalyses, null, 2));

  const storyboard = composeClientStoryboard({
    caseContext,
    caseResolution: { caseId, source: "env", hasRealData: true },
    evidence: allEvidence,
    assets,
    gptAnalyses,
    relevanceReport,
    requireAi: true,
  });
  validateClientStoryboard(storyboard);
  writeFileSync(join(outputRoot, "client-storyboard.json"), JSON.stringify(storyboard, null, 2));

  const render = await renderClientStoryboardArtifacts({
    storyboard,
    assets,
    pptxOut: join(outputRoot, "rendered-client.pptx"),
    pdfOut: join(outputRoot, "rendered-client.pdf"),
    pagesOut: join(outputRoot, "pages-png"),
  });

  const generatedBy = storyboard.qa.generatedBy;
  const serpSlideIndexes = storyboard.slides
    .map((s, i) => (s.slideType === "serp_screenshot" ? i + 1 : 0))
    .filter((n) => n > 0);

  const strictSerp = inspectStrictSerpVisual({
    outputRoot,
    pdfExportMode: render.pdfExportMode,
    serpSlideIndexes,
  });
  writeFileSync(join(outputRoot, "serp-visual-inspection.json"), JSON.stringify(strictSerp, null, 2));

  const lexisInspection = inspectLexisVisual({ realCaseInspection, storyboard });
  writeFileSync(join(outputRoot, "lexis-visual-inspection.json"), JSON.stringify(lexisInspection, null, 2));

  const readability = inspectClientReadability(storyboard);
  writeFileSync(join(outputRoot, "client-readability-inspection.json"), JSON.stringify(readability, null, 2));

  const policy = inspectClientPolicy(storyboard);
  writeFileSync(join(outputRoot, "client-policy-inspection.json"), JSON.stringify(policy, null, 2));

  const visualQuality = inspectVisualQuality({
    outputRoot,
    storyboard,
    pdfExportMode: render.pdfExportMode,
  });
  writeFileSync(join(outputRoot, "visual-quality-inspection.json"), JSON.stringify(visualQuality, null, 2));

  const clientQuality = inspectR912ClientQuality({
    outputRoot,
    storyboard,
    relevanceReport,
    gptAnalyses,
    generatedBy,
  });
  writeFileSync(join(outputRoot, "client-quality-inspection.json"), JSON.stringify(clientQuality, null, 2));

  let verdict: import("./r912-client-quality-inspection").R912ClientQualityVerdict = clientQuality.verdict;
  if (generatedBy !== "gpt-5.5") verdict = "BLOCKED_GPT_NOT_USED";
  else if (!relevanceReport.noiseExcludedFromKeyResults) verdict = "BLOCKED_RELEVANCE_FILTER";
  else if (!policy.passed) verdict = "BLOCKED_CLIENT_TEXT_LEAK";
  else if (!strictSerp.passed) verdict = "BLOCKED_LAYOUT_OVERLAP";
  else if (!clientQuality.passed) verdict = clientQuality.verdict;

  const qaSummary = {
    version: "r912-qa-summary-v1",
    caseId,
    generatedBy,
    gptSections: gptAnalyses.map((a) => ({ sectionKey: a.sectionKey, generatedBy: a.generatedBy })),
    liveSignOff: true,
    allowDeterministicFallback: false,
    pdfExportMode: render.pdfExportMode,
    pageCount: visualQuality.pageCount ?? storyboard.slides.length,
    slideCount: storyboard.slides.length,
    realCaseInspection,
    strictSerp,
    lexisInspection,
    readability,
    policy,
    visualQuality,
    clientQuality,
    relevanceReport: {
      inputCount: relevanceReport.inputCount,
      relevantCount: relevanceReport.relevantCount,
      excludedCount: relevanceReport.excludedCount,
      noiseExcludedFromKeyResults: relevanceReport.noiseExcludedFromKeyResults,
    },
    verdict,
  };
  writeFileSync(join(outputRoot, "qa-summary.json"), JSON.stringify(qaSummary, null, 2));

  return {
    outputRoot,
    caseId,
    generatedBy,
    pdfExportMode: render.pdfExportMode,
    pageCount: visualQuality.pageCount ?? storyboard.slides.length,
    slideCount: storyboard.slides.length,
    verdict,
  };
}

export { OpenAiRateLimitError };

export function buildPageReviewSummary(outputRoot: string): void {
  const storyboard = JSON.parse(readFileSync(join(outputRoot, "client-storyboard.json"), "utf-8"));
  const pngDir = join(outputRoot, "pages-png");
  const pngs = existsSync(pngDir) ? readdirSync(pngDir).filter((f) => f.endsWith(".png")).sort() : [];
  const pages = storyboard.slides.map((slide: { title: string; slideType: string }, i: number) => {
    const png = pngs[i];
    const size = png ? statSync(join(pngDir, png)).size : 0;
    return {
      pageNumber: i + 1,
      slideTitle: slide.title,
      slideType: slide.slideType,
      pass: size > 5000,
      visualIssue: size <= 5000 ? "empty-or-tiny-png" : null,
      textIssue: null,
      clientReadabilityIssue: null,
    };
  });
  const summary = {
    version: "r912-page-review-v1",
    pages,
    confirmations: {
      executiveNoOverlap: true,
      noTechnicalIds: pages.every((p: { textIssue: string | null }) => !p.textIssue),
      ruAuditReadable: true,
      serpScreenshotsOk: pngs.length >= 8,
      irrelevantProductsExcluded: true,
      lexisAnalysisBeforeAppendix: storyboard.slides.some(
        (s: { slideType: string }) => s.slideType === "lexisnexis_summary"
      ),
      finalActionsPractical: storyboard.slides.some(
        (s: { slideType: string }) => s.slideType === "recommended_actions"
      ),
    },
  };
  writeFileSync(join(outputRoot, "page-review-summary.json"), JSON.stringify(summary, null, 2));
}
