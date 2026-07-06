import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientStoryboard } from "./types";
import type { RealCaseDataInspection } from "./real-case-data-inspection";
import {
  inspectClientPolicy,
  inspectClientReadability,
  inspectLexisVisual,
  inspectStrictSerpVisual,
} from "./r910-e2e-inspections";

export const R911_OUTPUT_ROOT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-r9-11-orion-visual-polish"
);

const R910_BASELINE_ROOT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-r9-10-real-case-storyboard-e2e"
);

export interface R911PolishInspection {
  version: string;
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; detail?: string }>;
  baselineComparison: {
    r910PageCount: number;
    r911PageCount: number;
    r910AvgPngBytes: number;
    r911AvgPngBytes: number;
    r910PdfBytes: number;
    r911PdfBytes: number;
    densityImproved: boolean;
  };
  verdict: string;
}

function avgPngBytes(root: string): number {
  const dir = join(root, "pages-png");
  if (!existsSync(dir)) return 0;
  const pngs = readdirSync(dir).filter((f) => f.endsWith(".png"));
  if (pngs.length === 0) return 0;
  const total = pngs.reduce((sum, f) => sum + statSync(join(dir, f)).size, 0);
  return Math.round(total / pngs.length);
}

function slideByType(storyboard: ClientStoryboard, type: string) {
  return storyboard.slides.filter((s) => s.slideType === type);
}

export function inspectR911VisualPolish(input: {
  outputRoot: string;
  storyboard: ClientStoryboard;
  realCaseInspection: RealCaseDataInspection;
  pdfExportMode: string;
}): R911PolishInspection {
  const checks: R911PolishInspection["checks"] = [];
  const pdfPath = join(input.outputRoot, "rendered-client.pdf");
  const pptxPath = join(input.outputRoot, "rendered-client.pptx");
  const pngDir = join(input.outputRoot, "pages-png");
  const pdfSize = existsSync(pdfPath) ? statSync(pdfPath).size : 0;
  const pptxSize = existsSync(pptxPath) ? statSync(pptxPath).size : 0;
  const pngs = existsSync(pngDir) ? readdirSync(pngDir).filter((f) => f.endsWith(".png")) : [];

  checks.push({ id: "pdf-exists", passed: pdfSize > 0, detail: String(pdfSize) });
  checks.push({ id: "pptx-exists", passed: pptxSize > 0, detail: String(pptxSize) });
  checks.push({ id: "png-pages", passed: pngs.length >= 8, detail: String(pngs.length) });

  const serpIndexes = input.storyboard.slides
    .map((s, i) => (s.slideType === "serp_screenshot" ? i + 1 : 0))
    .filter((n) => n > 0);
  const serp = inspectStrictSerpVisual({
    outputRoot: input.outputRoot,
    pdfExportMode: input.pdfExportMode,
    serpSlideIndexes: serpIndexes,
  });
  checks.push({ id: "serp-pptx", passed: serp.pptxHasEmbeddedImages, detail: serp.details.join(";") });
  checks.push({ id: "serp-pdf", passed: serp.pdfHasSerpPixels, detail: input.pdfExportMode });
  checks.push({ id: "pdf-libreoffice", passed: input.pdfExportMode === "libreoffice", detail: input.pdfExportMode });

  const lexis = inspectLexisVisual({ realCaseInspection: input.realCaseInspection, storyboard: input.storyboard });
  checks.push({
    id: "lexis-visual",
    passed: lexis.passed,
    detail: `visualSlides=${lexis.visualSlidesCount}`,
  });

  const policy = inspectClientPolicy(input.storyboard);
  checks.push({ id: "client-policy", passed: policy.passed, detail: policy.issues.join(",") || "0" });

  const readability = inspectClientReadability(input.storyboard);
  checks.push({ id: "client-readability", passed: readability.passed, detail: readability.issues.join(",") || "0" });

  checks.push({
    id: "no-hostile-text",
    passed: policy.passed && readability.passed,
    detail: policy.issues.concat(readability.issues).join(",") || "0",
  });
  const clientPayload = input.storyboard.slides
    .flatMap((s) => [s.title, s.subtitle ?? "", s.clientTakeaway])
    .join("\n");
  checks.push({
    id: "no-fixture-labels",
    passed: !/ivan petrov|example\.com|qa-r98a-fixture/i.test(clientPayload),
  });

  const exec = input.storyboard.slides.find((s) => s.slideType === "executive_summary");
  checks.push({
    id: "exec-risk-badge",
    passed: Boolean(exec?.riskLevel && exec.riskLevel !== "unknown"),
    detail: exec?.riskLevel,
  });
  checks.push({
    id: "exec-metrics",
    passed: (exec?.metrics?.length ?? 0) >= 2,
    detail: String(exec?.metrics?.length ?? 0),
  });
  checks.push({
    id: "exec-main-conclusion",
    passed: Boolean(exec?.clientTakeaway?.trim()),
  });
  checks.push({
    id: "exec-next-actions",
    passed: (exec?.recommendedActions?.length ?? 0) >= 1 || (exec?.findings?.length ?? 0) >= 1,
  });

  const ru = input.storyboard.slides.find((s) => s.slideType === "region_summary");
  checks.push({
    id: "ru-audit-cards",
    passed: (ru?.findings?.length ?? 0) >= 2 && Boolean(ru?.clientTakeaway?.trim()),
    detail: String(ru?.findings?.length ?? 0),
  });

  const searchOverview = input.storyboard.slides.find((s) => s.slideType === "search_overview");
  const serpSlides = slideByType(input.storyboard, "serp_screenshot");
  checks.push({
    id: "search-serp-visual",
    passed: serpSlides.length >= 1,
    detail: String(serpSlides.length),
  });
  checks.push({
    id: "search-explanation",
    passed: Boolean(searchOverview?.clientTakeaway?.trim()),
  });

  const lexisSummary = input.storyboard.slides.find((s) => s.slideType === "lexisnexis_summary");
  checks.push({
    id: "lexis-intro",
    passed: Boolean(lexisSummary) && (lexisSummary?.metrics?.length ?? 0) >= 2,
    detail: String(lexisSummary?.metrics?.length ?? 0),
  });
  checks.push({
    id: "lexis-framed-pages",
    passed: slideByType(input.storyboard, "lexisnexis_visual_page").length >= 1,
    detail: String(slideByType(input.storyboard, "lexisnexis_visual_page").length),
  });

  const actions = input.storyboard.slides.find((s) => s.slideType === "recommended_actions");
  checks.push({
    id: "action-slide",
    passed: (actions?.recommendedActions?.length ?? 0) >= 3,
    detail: String(actions?.recommendedActions?.length ?? 0),
  });

  checks.push({
    id: "footer-page-count",
    passed: pngs.length === input.storyboard.slides.length,
    detail: `${pngs.length}/${input.storyboard.slides.length}`,
  });

  let sparseOnlyDivider = true;
  let maxBulletsOk = true;
  for (const slide of input.storyboard.slides) {
    const bullets =
      slide.findings.length + slide.recommendedActions.length + slide.evidenceRefs.length;
    const density =
      (slide.clientTakeaway?.length ?? 0) + bullets * 40 + slide.assetRefs.length * 80;
    if (bullets > 5) maxBulletsOk = false;
    if (
      density < 60 &&
      !["cover", "global_toc", "serp_screenshot", "lexisnexis_visual_page"].includes(slide.slideType)
    ) {
      sparseOnlyDivider = false;
    }
  }
  checks.push({ id: "max-bullets-per-slide", passed: maxBulletsOk });
  checks.push({ id: "no-unintentional-sparse", passed: sparseOnlyDivider });

  const r910Avg = avgPngBytes(R910_BASELINE_ROOT);
  const r911Avg = avgPngBytes(input.outputRoot);
  const r910Pages = existsSync(join(R910_BASELINE_ROOT, "pages-png"))
    ? readdirSync(join(R910_BASELINE_ROOT, "pages-png")).filter((f) => f.endsWith(".png")).length
    : 0;
  const r910PdfPath = join(R910_BASELINE_ROOT, "rendered-client.pdf");
  const r910PdfBytes = existsSync(r910PdfPath) ? statSync(r910PdfPath).size : 0;
  const densityImproved =
    pngs.length >= r910Pages && (r910PdfBytes === 0 || pdfSize >= Math.floor(r910PdfBytes * 0.98));
  checks.push({
    id: "density-vs-r910b",
    passed: densityImproved,
    detail: `r910Pdf=${r910PdfBytes} r911Pdf=${pdfSize} r910PngAvg=${r910Avg} r911PngAvg=${r911Avg}`,
  });

  const passed = checks.every((c) => c.passed);
  return {
    version: "r911-visual-polish-inspection-v1",
    passed,
    checks,
    baselineComparison: {
      r910PageCount: r910Pages,
      r911PageCount: pngs.length,
      r910AvgPngBytes: r910Avg,
      r911AvgPngBytes: r911Avg,
      r910PdfBytes,
      r911PdfBytes: pdfSize,
      densityImproved,
    },
    verdict: passed ? "PASS" : "BLOCKED_VISUAL_QUALITY",
  };
}

export async function runR911OrionVisualPolish(options: {
  caseId: string;
  outputRoot?: string;
}): Promise<{
  outputRoot: string;
  caseId: string;
  generatedBy: string;
  pdfExportMode: string;
  pageCount: number;
  slideCount: number;
  polishInspection: R911PolishInspection;
  verdict: string;
}> {
  const { runR910RealCaseStoryboardE2e } = await import("./run-r910-real-case-storyboard-e2e");
  const outputRoot = options.outputRoot ?? R911_OUTPUT_ROOT;
  const base = await runR910RealCaseStoryboardE2e({ caseId: options.caseId, outputRoot });

  const storyboard = JSON.parse(
    readFileSync(join(outputRoot, "client-storyboard.json"), "utf-8")
  ) as ClientStoryboard;

  const polishInspection = inspectR911VisualPolish({
    outputRoot,
    storyboard,
    realCaseInspection: base.realCaseInspection,
    pdfExportMode: base.pdfExportMode,
  });

  writeFileSync(
    join(outputRoot, "r911-visual-polish-inspection.json"),
    JSON.stringify(polishInspection, null, 2)
  );

  let verdict = base.verdict;
  if (base.verdict === "PASS" && !polishInspection.passed) {
    verdict = "BLOCKED_VISUAL_QUALITY";
  }

  const qaPath = join(outputRoot, "qa-summary.json");
  if (existsSync(qaPath)) {
    const qa = JSON.parse(readFileSync(qaPath, "utf-8")) as Record<string, unknown>;
    qa.version = "r911-qa-summary-v1";
    qa.r911PolishInspection = polishInspection;
    qa.verdict = verdict;
    writeFileSync(qaPath, JSON.stringify(qa, null, 2));
  }

  return {
    outputRoot,
    caseId: options.caseId,
    generatedBy: base.generatedBy,
    pdfExportMode: base.pdfExportMode,
    pageCount: base.pageCount,
    slideCount: base.slideCount,
    polishInspection,
    verdict,
  };
}
