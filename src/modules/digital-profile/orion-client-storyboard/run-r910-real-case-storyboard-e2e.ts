import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeOrionV2AiReadiness } from "../config";
import { OpenAiRateLimitError } from "../orion-report-spec/openai-rate-limit";
import { loadRealCaseContext } from "../orion-section-pipeline/real-case-data-adapter";
import { buildLexisReportAssets } from "./lexis-asset-builder";
import { inspectRealCaseData } from "./real-case-data-inspection";
import {
  inspectClientPolicy,
  inspectClientReadability,
  inspectLexisVisual,
  inspectMediaVisualStrict,
  inspectStrictSerpVisual,
  inspectVisualQuality,
} from "./r910-e2e-inspections";
import { runR99OrionClientStoryboard } from "./run-r99-orion-client-storyboard";

export const R910_OUTPUT_ROOT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-r9-10-real-case-storyboard-e2e"
);

export interface RunR910Options {
  caseId: string;
  outputRoot?: string;
}

export interface RunR910Result {
  outputRoot: string;
  caseId: string;
  realCaseInspection: ReturnType<typeof inspectRealCaseData>;
  generatedBy: "gpt-5.5" | "deterministic" | "mixed";
  pdfExportMode: string;
  pageCount: number;
  slideCount: number;
  verdict: string;
}

export async function runR910RealCaseStoryboardE2e(options: RunR910Options): Promise<RunR910Result> {
  const outputRoot = options.outputRoot ?? R910_OUTPUT_ROOT;
  mkdirSync(outputRoot, { recursive: true });

  const caseId = options.caseId.trim();
  if (!caseId) throw new Error("CASE_ID required");

  const caseContext = await loadRealCaseContext(caseId, { locale: "ru", buildFreshReportJson: true });
  const realCaseInspection = inspectRealCaseData(caseId, caseContext);
  writeFileSync(
    join(outputRoot, "real-case-data-inspection.json"),
    JSON.stringify(realCaseInspection, null, 2)
  );

  if (!realCaseInspection.passed) {
    const qaSummary = {
      version: "r910-qa-summary-v1",
      caseId,
      verdict: "BLOCKED_REAL_CASE_REQUIRED",
      realCaseInspection,
    };
    writeFileSync(join(outputRoot, "qa-summary.json"), JSON.stringify(qaSummary, null, 2));
    return {
      outputRoot,
      caseId,
      realCaseInspection,
      generatedBy: "deterministic",
      pdfExportMode: "unknown",
      pageCount: 0,
      slideCount: 0,
      verdict: "BLOCKED_REAL_CASE_REQUIRED",
    };
  }

  const readiness = describeOrionV2AiReadiness();
  if (!readiness.ready) {
    throw new Error("gpt55-required-but-unavailable");
  }

  const lexisAssets = await buildLexisReportAssets(caseContext);

  const base = await runR99OrionClientStoryboard({
    outputRoot,
    caseId,
    requireGpt: true,
    allowDeterministicFallback: false,
    liveSignOff: true,
    mergeAssets: lexisAssets,
    skipR98aAudit: true,
  });

  const { readFileSync } = await import("node:fs");
  const storyboard = JSON.parse(readFileSync(join(outputRoot, "client-storyboard.json"), "utf-8"));
  const assets = JSON.parse(readFileSync(join(outputRoot, "report-assets.json"), "utf-8")) as Array<{
    kind: string;
    status: string;
    imageData?: string;
  }>;
  const gptAnalyses = JSON.parse(readFileSync(join(outputRoot, "gpt-section-analyses.json"), "utf-8"));

  const generatedBy = base.generatedBy;
  const serpSlideIndexes = storyboard.slides
    .map((s: { slideType: string }, i: number) => (s.slideType === "serp_screenshot" ? i + 1 : 0))
    .filter((n: number) => n > 0);

  const strictSerp = inspectStrictSerpVisual({
    outputRoot,
    pdfExportMode: base.pdfExportMode,
    serpSlideIndexes,
  });
  writeFileSync(join(outputRoot, "serp-visual-inspection.json"), JSON.stringify(strictSerp, null, 2));

  const mediaInspection = inspectMediaVisualStrict({
    storyboard,
    assets,
    realCaseInspection,
  });
  writeFileSync(join(outputRoot, "media-visual-inspection.json"), JSON.stringify(mediaInspection, null, 2));

  const lexisInspection = inspectLexisVisual({ realCaseInspection, storyboard });
  writeFileSync(join(outputRoot, "lexis-visual-inspection.json"), JSON.stringify(lexisInspection, null, 2));

  const readability = inspectClientReadability(storyboard);
  writeFileSync(join(outputRoot, "client-readability-inspection.json"), JSON.stringify(readability, null, 2));

  const policy = inspectClientPolicy(storyboard);
  writeFileSync(join(outputRoot, "client-policy-inspection.json"), JSON.stringify(policy, null, 2));

  const visualQuality = inspectVisualQuality({
    outputRoot,
    storyboard,
    pdfExportMode: base.pdfExportMode,
  });
  writeFileSync(join(outputRoot, "visual-quality-inspection.json"), JSON.stringify(visualQuality, null, 2));

  let verdict = "PASS";
  if (generatedBy !== "gpt-5.5") verdict = "BLOCKED";
  if (!strictSerp.passed) verdict = "BLOCKED_SERP_VISUAL_PDF_EXPORT";
  if (!readability.passed || !policy.passed) verdict = "BLOCKED_CLIENT_TEXT";
  if (!visualQuality.passed) verdict = "BLOCKED_VISUAL_QUALITY";
  if (!mediaInspection.passed) verdict = "BLOCKED_VISUAL_QUALITY";
  if (!lexisInspection.passed && realCaseInspection.lexisNexis.uploadExists) {
    verdict = "BLOCKED_VISUAL_QUALITY";
  }

  const qaSummary = {
    version: "r910-qa-summary-v1",
    caseId,
    generatedBy,
    gptSections: (gptAnalyses as Array<{ sectionKey: string; generatedBy: string }>).map((a) => ({
      sectionKey: a.sectionKey,
      generatedBy: a.generatedBy,
    })),
    liveSignOff: true,
    allowDeterministicFallback: false,
    pdfExportMode: base.pdfExportMode,
    pageCount: base.pageCount,
    slideCount: base.slideCount,
    realCaseInspection,
    strictSerp,
    mediaInspection,
    lexisInspection,
    readability,
    policy,
    visualQuality,
    verdict,
  };
  writeFileSync(join(outputRoot, "qa-summary.json"), JSON.stringify(qaSummary, null, 2));

  return {
    outputRoot,
    caseId,
    realCaseInspection,
    generatedBy,
    pdfExportMode: base.pdfExportMode,
    pageCount: base.pageCount,
    slideCount: base.slideCount,
    verdict,
  };
}

export { OpenAiRateLimitError };
