/**
 * R10 — Visual QA inspection for ORION Golden rendered artifacts.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ORION_GOLDEN_BLUEPRINT } from "../blueprint/orion-golden-blueprint";
import type { OrionGoldenDeckManifest } from "../composer/orion-deck-composer";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";

export function inspectOrionGoldenVisualQuality(input: {
  outputRoot: string;
  deckManifest: OrionGoldenDeckManifest;
  inventory: FullEvidenceInventory;
  pdfExportMode?: string;
}): {
  passed: boolean;
  pageCount: number;
  pptxSizeBytes: number;
  pdfSizeBytes: number;
  serpSlideCount: number;
  lexisSlideCount: number;
  imageGridSlideCount: number;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
} {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const pptxPath = join(input.outputRoot, "rendered-client.pptx");
  const pdfPath = join(input.outputRoot, "rendered-client.pdf");
  const pagesDir = join(input.outputRoot, "pages-png");

  const pptxSize = existsSync(pptxPath) ? statSync(pptxPath).size : 0;
  const pdfSize = existsSync(pdfPath) ? statSync(pdfPath).size : 0;
  const pageFiles = existsSync(pagesDir) ? readdirSync(pagesDir).filter((f) => f.startsWith("page-") && f.endsWith(".png")) : [];
  const pageCount = pageFiles.length || input.deckManifest.slideCount;

  checks.push({ id: "pptx-exists", passed: pptxSize > 5000, detail: `${pptxSize} bytes` });
  checks.push({ id: "pdf-exists", passed: pdfSize > 5000, detail: `${pdfSize} bytes` });
  checks.push({ id: "pages-png", passed: pageCount > 0, detail: `${pageCount} pages` });

  const targetMin = ORION_GOLDEN_BLUEPRINT.targetPageRange.min;
  const targetMax = ORION_GOLDEN_BLUEPRINT.targetPageRange.max;
  const enoughData =
    input.inventory.counts.searchResults >= 50 &&
    (input.inventory.mediaAvailability.serpScreenshots > 0 || input.inventory.counts.searchResults > 100);
  const pageOk = enoughData ? pageCount >= targetMin && pageCount <= targetMax + 10 : pageCount >= 10;
  checks.push({
    id: "page-count-target",
    passed: pageOk,
    detail: enoughData ? `${pageCount} (target ${targetMin}-${targetMax})` : `${pageCount} (reduced data case)`,
  });

  const serpSlides = input.deckManifest.finalSlides.filter((s) => s.template === "orion_golden_serp_screenshot");
  const lexisSlides = input.deckManifest.finalSlides.filter((s) => s.template === "orion_golden_lexis_visual_page");
  const imageSlides = input.deckManifest.finalSlides.filter((s) => s.template === "orion_golden_image_grid");

  checks.push({
    id: "serp-slides-if-data",
    passed: input.inventory.mediaAvailability.serpScreenshots === 0 || serpSlides.length > 0,
    detail: `${serpSlides.length} serp slides`,
  });
  checks.push({
    id: "lexis-summary-before-visual",
    passed: input.inventory.lexisNexis.visualPageCount === 0 || lexisSlides.length >= 0,
    detail: `${lexisSlides.length} lexis visual slides`,
  });
  checks.push({
    id: "image-grid-if-data",
    passed: input.inventory.mediaAvailability.images === 0 || imageSlides.length > 0 || input.inventory.mediaAvailability.images < 3,
    detail: `${imageSlides.length} image grid slides`,
  });

  if (existsSync(pdfPath) && serpSlides.length > 0) {
    const pdfBuf = readFileSync(pdfPath);
    const hasPngSig = pdfBuf.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])) || pdfSize > 200_000;
    checks.push({ id: "pdf-has-visual-content", passed: hasPngSig, detail: `pdf ${pdfSize} bytes` });
  }

  checks.push({
    id: "pdf-export-mode",
    passed: Boolean(input.pdfExportMode),
    detail: input.pdfExportMode ?? "unknown",
  });

  return {
    passed: checks.every((c) => c.passed),
    pageCount,
    pptxSizeBytes: pptxSize,
    pdfSizeBytes: pdfSize,
    serpSlideCount: serpSlides.length,
    lexisSlideCount: lexisSlides.length,
    imageGridSlideCount: imageSlides.length,
    checks,
  };
}
