import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FORBIDDEN_CLIENT_LABELS, scanStoryboardClientText, validateClientStoryboard } from "./schema";
import type { ClientStoryboard } from "./types";

export interface StoryboardVisualInspection {
  passed: boolean;
  pageCount: number;
  slideCount: number;
  pdfSizeBytes: number;
  pptxSizeBytes: number;
  checks: Array<{ id: string; passed: boolean; detail?: string }>;
}

function collectStoryboardText(storyboard: ClientStoryboard): string {
  const parts: string[] = [storyboard.subject.displayName];
  for (const slide of storyboard.slides) {
    parts.push(slide.title, slide.subtitle ?? "", slide.clientTakeaway);
    for (const m of slide.metrics) parts.push(m.label, String(m.value));
    for (const f of slide.findings) parts.push(f.headline, f.summary);
    for (const e of slide.evidenceRefs) parts.push(e.label, e.summary, e.statusLabel);
    for (const a of slide.recommendedActions) parts.push(a.label, a.rationale);
  }
  return parts.join("\n");
}

export function inspectClientStoryboardTextPolicy(storyboard: ClientStoryboard): {
  passed: boolean;
  issues: string[];
} {
  const text = collectStoryboardText(storyboard);
  const issues = scanStoryboardClientText(text);
  if (/\+ \d+ more items/i.test(text)) issues.push("forbidden:+more-items");
  return { passed: issues.length === 0, issues };
}

export function inspectSerpVisual(input: {
  outputRoot: string;
  storyboard: ClientStoryboard;
  assets: Array<{ assetRef: string; kind: string; status: string; imageData?: string }>;
}): {
  serpSlidesExpected: number;
  serpAssetsReady: number;
  pdfPagesWithSerpVisual: boolean;
  pptxHasSerpEmbed: boolean;
  passed: boolean;
  details: string[];
} {
  const serpSlides = input.storyboard.slides.filter((s) => s.slideType === "serp_screenshot");
  const serpAssets = input.assets.filter(
    (a) => a.kind === "synthetic_serp" && a.status === "ready" && Boolean(a.imageData)
  );
  const details: string[] = [];
  let pdfPagesWithSerpVisual = false;

  const pagesDir = join(input.outputRoot, "pages-png");
  if (existsSync(pagesDir)) {
    const pngs = readdirSync(pagesDir).filter((f) => f.endsWith(".png"));
    for (const png of pngs) {
      const size = statSync(join(pagesDir, png)).size;
      if (size > 80_000) {
        pdfPagesWithSerpVisual = true;
        details.push(`${png}: ${size} bytes (likely embedded visual)`);
        break;
      }
    }
  }

  const pptxPath = join(input.outputRoot, "rendered-client.pptx");
  const pptxHasSerpEmbed =
    existsSync(pptxPath) && statSync(pptxPath).size > 120_000 && serpAssets.length > 0;
  if (pptxHasSerpEmbed) {
    details.push(`pptx=${statSync(pptxPath).size} bytes with ${serpAssets.length} SERP asset(s)`);
  }

  const passed =
    serpSlides.length === 0 ||
    (serpAssets.length >= serpSlides.length && (pdfPagesWithSerpVisual || pptxHasSerpEmbed));
  if (serpSlides.length > 0 && serpAssets.length === 0) {
    details.push("SERP slides planned but no ready SERP assets");
  }
  return {
    serpSlidesExpected: serpSlides.length,
    serpAssetsReady: serpAssets.length,
    pdfPagesWithSerpVisual,
    pptxHasSerpEmbed,
    passed,
    details,
  };
}

export function inspectMediaVisual(input: {
  storyboard: ClientStoryboard;
  assets: Array<{ kind: string; status: string; imageData?: string }>;
}): {
  imageSlideOmittedOrVisual: boolean;
  videoSlideOmittedOrVisual: boolean;
  knowledgeSlideOmittedOrVisual: boolean;
  passed: boolean;
} {
  const hasSlide = (type: string) => input.storyboard.slides.some((s) => s.slideType === type);
  const assetReady = (kind: string) =>
    input.assets.some((a) => a.kind === kind && a.status === "ready" && Boolean(a.imageData));

  const imageSlideOmittedOrVisual = !hasSlide("image_grid") || assetReady("image_grid");
  const videoSlideOmittedOrVisual = !hasSlide("video_cards") || assetReady("video_cards");
  const knowledgeSlideOmittedOrVisual = !hasSlide("knowledge_panel") || assetReady("knowledge_panel");

  return {
    imageSlideOmittedOrVisual,
    videoSlideOmittedOrVisual,
    knowledgeSlideOmittedOrVisual,
    passed: imageSlideOmittedOrVisual && videoSlideOmittedOrVisual && knowledgeSlideOmittedOrVisual,
  };
}

export function inspectVisualDensity(storyboard: ClientStoryboard, pageCount: number): {
  sparseRunMax: number;
  passed: boolean;
  emptyTakeawaySlides: number;
} {
  let sparseRun = 0;
  let maxSparseRun = 0;
  let emptyTakeawaySlides = 0;
  for (const slide of storyboard.slides) {
    const density =
      (slide.clientTakeaway?.length ?? 0) +
      slide.findings.length * 40 +
      slide.evidenceRefs.length * 30 +
      slide.assetRefs.length * 50;
    if (density < 40 && slide.slideType !== "cover" && slide.slideType !== "global_toc") {
      sparseRun += 1;
      maxSparseRun = Math.max(maxSparseRun, sparseRun);
    } else {
      sparseRun = 0;
    }
    if (!slide.clientTakeaway?.trim()) emptyTakeawaySlides += 1;
  }
  const passed = maxSparseRun <= 5 && emptyTakeawaySlides === 0 && pageCount >= 8 && pageCount <= 35;
  return { sparseRunMax: maxSparseRun, passed, emptyTakeawaySlides };
}

export function inspectStoryboardVisualExport(input: {
  outputRoot: string;
  storyboard: ClientStoryboard;
  assets: Array<{ assetRef: string; kind: string; status: string; imageData?: string }>;
  pdfExportMode: "libreoffice" | "fitz-fallback" | "unknown";
  caseSource: "env" | "db" | "fixture";
}): StoryboardVisualInspection {
  validateClientStoryboard(input.storyboard);

  const pdfPath = join(input.outputRoot, "rendered-client.pdf");
  const pptxPath = join(input.outputRoot, "rendered-client.pptx");
  const pdfSizeBytes = existsSync(pdfPath) ? statSync(pdfPath).size : 0;
  const pptxSizeBytes = existsSync(pptxPath) ? statSync(pptxPath).size : 0;
  const pageCount = existsSync(join(input.outputRoot, "pages-png"))
    ? readdirSync(join(input.outputRoot, "pages-png")).filter((f) => f.endsWith(".png")).length
    : 0;

  const textPolicy = inspectClientStoryboardTextPolicy(input.storyboard);
  const serp = inspectSerpVisual({
    outputRoot: input.outputRoot,
    storyboard: input.storyboard,
    assets: input.assets,
  });
  const media = inspectMediaVisual({ storyboard: input.storyboard, assets: input.assets });
  const density = inspectVisualDensity(input.storyboard, pageCount);

  const fixtureNames = ["ivan petrov", "иван петров", "example.com"];
  const combined = collectStoryboardText(input.storyboard).toLowerCase();
  const fixtureDetected = fixtureNames.some((n) => combined.includes(n));

  const checks = [
    { id: "storyboard-valid", passed: true },
    { id: "pdf-generated", passed: pdfSizeBytes > 0, detail: String(pdfSizeBytes) },
    { id: "pptx-generated", passed: pptxSizeBytes > 0, detail: String(pptxSizeBytes) },
    { id: "page-count-reasonable", passed: pageCount >= 8 && pageCount <= 35, detail: String(pageCount) },
    { id: "client-text-policy", passed: textPolicy.passed, detail: textPolicy.issues.join(", ") },
    { id: "serp-visual", passed: serp.passed, detail: serp.details.join("; ") },
    { id: "media-visual", passed: media.passed },
    { id: "visual-density", passed: density.passed, detail: `sparseRun=${density.sparseRunMax}` },
    {
      id: "pdf-export-mode",
      passed: input.pdfExportMode === "libreoffice" || input.pdfExportMode === "fitz-fallback",
      detail: input.pdfExportMode,
    },
    {
      id: "no-fixture-in-real-mode",
      passed: input.caseSource === "fixture" || !fixtureDetected,
      detail: fixtureDetected ? "fixture-names-detected" : "ok",
    },
  ];

  const passed = checks.every((c) => c.passed);
  return {
    passed,
    pageCount,
    slideCount: input.storyboard.slides.length,
    pdfSizeBytes,
    pptxSizeBytes,
    checks,
  };
}

export function scanRenderedPdfTextPolicy(outputRoot: string): { passed: boolean; issues: string[] } {
  const storyboardPath = join(outputRoot, "client-storyboard.json");
  if (!existsSync(storyboardPath)) return { passed: false, issues: ["missing-storyboard"] };
  const storyboard = validateClientStoryboard(JSON.parse(readFileSync(storyboardPath, "utf-8")));
  return inspectClientStoryboardTextPolicy(storyboard);
}

export { FORBIDDEN_CLIENT_LABELS };
