import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { FORBIDDEN_CLIENT_LABELS, scanStoryboardClientText } from "./schema";
import type { ClientStoryboard } from "./types";
import type { RealCaseDataInspection } from "./real-case-data-inspection";

const READABILITY_FORBIDDEN = [
  ...FORBIDDEN_CLIENT_LABELS,
  "row",
  "stage",
  "manifest",
  "generatedBy",
  "deterministic",
  "fixture",
  "preserved in evidence",
] as const;

export function inspectClientReadability(storyboard: ClientStoryboard): {
  passed: boolean;
  issues: string[];
  slidesWithoutTakeaway: string[];
  slidesWithTooManyBullets: string[];
} {
  const issues: string[] = [];
  const slidesWithoutTakeaway: string[] = [];
  const slidesWithTooManyBullets: string[] = [];
  const clientPayload = {
    subject: storyboard.subject,
    slides: storyboard.slides.map((s) => ({
      title: s.title,
      subtitle: s.subtitle,
      clientTakeaway: s.clientTakeaway,
      findings: s.findings,
      evidenceRefs: s.evidenceRefs,
      recommendedActions: s.recommendedActions,
      metrics: s.metrics,
    })),
  };
  const text = JSON.stringify(clientPayload);
  const lower = text.toLowerCase();

  for (const term of READABILITY_FORBIDDEN) {
    if (lower.includes(term.toLowerCase())) issues.push(`forbidden:${term}`);
  }

  for (const slide of storyboard.slides) {
    if (!slide.clientTakeaway?.trim()) slidesWithoutTakeaway.push(slide.slideId);
    const bulletCount =
      slide.findings.length + slide.recommendedActions.length + slide.evidenceRefs.length;
    if (bulletCount > 5) slidesWithTooManyBullets.push(slide.slideId);
    for (const f of slide.findings) {
      if ((f.summary?.length ?? 0) > 220) issues.push(`long-finding:${slide.slideId}`);
    }
  }

  const exec = storyboard.slides.find((s) => s.slideType === "executive_summary");
  if (exec && !exec.clientTakeaway.trim()) issues.push("executive-summary-missing-takeaway");

  return {
    passed:
      issues.length === 0 &&
      slidesWithoutTakeaway.length === 0 &&
      slidesWithTooManyBullets.length === 0,
    issues,
    slidesWithoutTakeaway,
    slidesWithTooManyBullets,
  };
}

export function inspectClientPolicy(storyboard: ClientStoryboard): { passed: boolean; issues: string[] } {
  const textParts: string[] = [];
  for (const slide of storyboard.slides) {
    textParts.push(slide.title, slide.subtitle ?? "", slide.clientTakeaway);
    for (const e of slide.evidenceRefs) textParts.push(e.label, e.summary, e.statusLabel);
    for (const f of slide.findings) textParts.push(f.headline, f.summary);
    for (const a of slide.recommendedActions) textParts.push(a.label);
  }
  const text = textParts.join("\n");
  const issues = scanStoryboardClientText(text);
  return { passed: issues.length === 0, issues };
}

export function inspectStrictSerpVisual(input: {
  outputRoot: string;
  pdfExportMode: string;
  serpSlideIndexes: number[];
}): {
  pptxHasEmbeddedImages: boolean;
  pdfHasSerpPixels: boolean;
  pdfExportMode: string;
  passed: boolean;
  details: string[];
} {
  const details: string[] = [];
  const pptxPath = join(input.outputRoot, "rendered-client.pptx");
  const pdfPath = join(input.outputRoot, "rendered-client.pdf");
  const pptxSize = existsSync(pptxPath) ? statSync(pptxPath).size : 0;
  const pdfSize = existsSync(pdfPath) ? statSync(pdfPath).size : 0;

  const pptxHasEmbeddedImages = pptxSize > 120_000;

  let pdfHasSerpPixels = false;
  const script = join(process.cwd(), "scripts", "inspect-storyboard-serp-pdf.py");
  if (existsSync(script) && existsSync(pdfPath)) {
    const proc = spawnSync("python", [script, pdfPath], { encoding: "utf-8" });
    if (proc.status === 0 && proc.stdout.trim()) {
      try {
        const parsed = JSON.parse(proc.stdout) as { serpPagesWithImages: number[]; hasSerpPixels: boolean };
        pdfHasSerpPixels = parsed.hasSerpPixels;
        details.push(`pdf-serp-pages-with-images=${parsed.serpPagesWithImages.join(",")}`);
      } catch {
        details.push("pdf-inspect-parse-failed");
      }
    }
  }

  if (!pdfHasSerpPixels && input.pdfExportMode === "libreoffice") {
    const pagesDir = join(input.outputRoot, "pages-png");
    if (existsSync(pagesDir)) {
      for (const idx of input.serpSlideIndexes) {
        const png = join(pagesDir, `page-${String(idx).padStart(2, "0")}.png`);
        if (existsSync(png) && statSync(png).size > 80_000) {
          pdfHasSerpPixels = true;
          details.push(`${png}: large raster`);
          break;
        }
      }
      if (!pdfHasSerpPixels && pdfSize > 100_000) {
        const pngs = readdirSync(pagesDir).filter((f) => f.endsWith(".png"));
        if (pngs.some((f) => statSync(join(pagesDir, f)).size > 80_000)) {
          pdfHasSerpPixels = true;
          details.push("pdf-raster-fallback:large-page-png-detected");
        }
      }
    }
  }

  if (input.pdfExportMode === "fitz-fallback") {
    details.push("pdf-export-mode=fitz-fallback (LibreOffice required for sign-off)");
  }

  details.push(`pptxBytes=${pptxSize}`, `pdfBytes=${pdfSize}`);

  const passed =
    pptxHasEmbeddedImages &&
    pdfHasSerpPixels &&
    input.pdfExportMode === "libreoffice";

  return {
    pptxHasEmbeddedImages,
    pdfHasSerpPixels,
    pdfExportMode: input.pdfExportMode,
    passed,
    details,
  };
}

export function inspectLexisVisual(input: {
  realCaseInspection: RealCaseDataInspection;
  storyboard: ClientStoryboard;
}): {
  lexisAvailable: boolean;
  summarySlidePresent: boolean;
  visualSlidesCount: number;
  passed: boolean;
  clientWording: string;
} {
  const lexis = input.realCaseInspection.lexisNexis;
  const summarySlidePresent = input.storyboard.slides.some(
    (s) => s.slideType === "lexisnexis_summary" || s.slideType === "compliance_summary"
  );
  const visualSlidesCount = input.storyboard.slides.filter(
    (s) => s.slideType === "lexisnexis_visual_page"
  ).length;

  const lexisAvailable = lexis.status === "ready" || lexis.status === "parsed_only";
  let passed = true;
  if (lexis.uploadExists && lexis.status === "uploaded") passed = false;
  if (lexisAvailable && !summarySlidePresent && lexis.parsedSignals > 0) passed = false;
  if (lexis.status === "ready" && visualSlidesCount === 0 && lexis.visualPageCount > 0) passed = false;
  if (!lexis.uploadExists && !lexisAvailable) passed = true;

  return {
    lexisAvailable,
    summarySlidePresent,
    visualSlidesCount,
    passed,
    clientWording: lexis.clientWording,
  };
}

export function inspectVisualQuality(input: {
  outputRoot: string;
  storyboard: ClientStoryboard;
  pdfExportMode: string;
}): {
  passed: boolean;
  pageCount: number;
  checks: Array<{ id: string; passed: boolean; detail?: string }>;
} {
  const pagesDir = join(input.outputRoot, "pages-png");
  const pngs = existsSync(pagesDir)
    ? readdirSync(pagesDir)
        .filter((f) => f.endsWith(".png"))
        .sort()
    : [];
  const pageCount = pngs.length;

  let sparseRun = 0;
  let maxSparse = 0;
  for (const slide of input.storyboard.slides) {
    const density =
      (slide.clientTakeaway?.length ?? 0) +
      slide.findings.length * 40 +
      slide.assetRefs.length * 50;
    if (density < 40 && !["cover", "global_toc"].includes(slide.slideType)) {
      sparseRun += 1;
      maxSparse = Math.max(maxSparse, sparseRun);
    } else sparseRun = 0;
  }

  const pdfSize = existsSync(join(input.outputRoot, "rendered-client.pdf"))
    ? statSync(join(input.outputRoot, "rendered-client.pdf")).size
    : 0;

  const checks = [
    { id: "page-count", passed: pageCount >= 8 && pageCount <= 45, detail: String(pageCount) },
    { id: "pdf-libreoffice", passed: input.pdfExportMode === "libreoffice", detail: input.pdfExportMode },
    { id: "pdf-not-tiny", passed: pdfSize > 50_000, detail: String(pdfSize) },
    { id: "no-sparse-run", passed: maxSparse <= 5, detail: String(maxSparse) },
    { id: "footer-pages-match", passed: pageCount === input.storyboard.slides.length, detail: `${pageCount}/${input.storyboard.slides.length}` },
  ];

  return { passed: checks.every((c) => c.passed), pageCount, checks };
}

export function inspectMediaVisualStrict(input: {
  storyboard: ClientStoryboard;
  assets: Array<{ kind: string; status: string; imageData?: string }>;
  realCaseInspection: RealCaseDataInspection;
}): {
  passed: boolean;
  imageGridOk: boolean;
  videoCardsOk: boolean;
  knowledgeOk: boolean;
  details: string[];
} {
  const hasSlide = (t: string) => input.storyboard.slides.some((s) => s.slideType === t);
  const assetReady = (k: string) =>
    input.assets.some((a) => a.kind === k && a.status === "ready" && Boolean(a.imageData));

  const { images, videos, knowledgePanels } = input.realCaseInspection.mediaAvailability;

  const imageGridOk = !hasSlide("image_grid") || images === 0 || assetReady("image_grid");
  const videoCardsOk = !hasSlide("video_cards") || videos === 0 || assetReady("video_cards");
  const knowledgeOk =
    !hasSlide("knowledge_panel") ||
    knowledgePanels === 0 ||
    assetReady("knowledge_panel") ||
    input.storyboard.slides.some((s) => s.slideType === "search_overview");

  return {
    passed: imageGridOk && videoCardsOk && knowledgeOk,
    imageGridOk,
    videoCardsOk,
    knowledgeOk,
    details: [`images=${images}`, `videos=${videos}`, `knowledge=${knowledgePanels}`],
  };
}
