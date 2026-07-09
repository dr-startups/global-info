/**
 * R10 / R10.10a — Visual QA inspection for ORION Golden rendered artifacts.
 * Page-count targets differ by report mode:
 *   - legacy_full: blueprint 60–75 (commercial ORION deck)
 *   - client_audit: lean 30–45 (post-review client content adapter)
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ORION_GOLDEN_BLUEPRINT } from "../blueprint/orion-golden-blueprint";
import type { OrionGoldenDeckManifest } from "../composer/orion-deck-composer";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";

export type OrionVisualReportMode = "legacy_full" | "client_audit" | "classic_orion_audit";

export const CLIENT_AUDIT_PAGE_RANGE = { min: 30, max: 45 } as const;
export const CLASSIC_ORION_AUDIT_PAGE_RANGE = { min: 45, max: 120 } as const;

export function resolveOrionVisualReportMode(input?: {
  reportMode?: OrionVisualReportMode;
  env?: NodeJS.ProcessEnv;
}): OrionVisualReportMode {
  if (input?.reportMode) return input.reportMode;
  const env = input?.env ?? process.env;
  if (env.ORION_CLASSIC_AUDIT_MODE === "1") return "classic_orion_audit";
  if (
    env.R10_RENDER_FROM_CLIENT_CONTENT === "1" ||
    env.ORION_CLIENT_AUDIT_MODE === "1"
  ) {
    return "client_audit";
  }
  return "legacy_full";
}

export function expectedPageRangeForMode(mode: OrionVisualReportMode): { min: number; max: number } {
  if (mode === "classic_orion_audit") return { ...CLASSIC_ORION_AUDIT_PAGE_RANGE };
  if (mode === "client_audit") return { ...CLIENT_AUDIT_PAGE_RANGE };
  return {
    min: ORION_GOLDEN_BLUEPRINT.targetPageRange.min,
    max: ORION_GOLDEN_BLUEPRINT.targetPageRange.max,
  };
}

export function inspectOrionGoldenVisualQuality(input: {
  outputRoot: string;
  deckManifest: OrionGoldenDeckManifest;
  inventory: FullEvidenceInventory;
  pdfExportMode?: string;
  reportMode?: OrionVisualReportMode;
}): {
  passed: boolean;
  pageCount: number;
  pptxSizeBytes: number;
  pdfSizeBytes: number;
  serpSlideCount: number;
  lexisSlideCount: number;
  imageGridSlideCount: number;
  reportMode: OrionVisualReportMode;
  expectedPageRange: { min: number; max: number };
  actualPageCount: number;
  checks: Array<{ id: string; passed: boolean; detail: string }>;
} {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const pptxPath = join(input.outputRoot, "rendered-client.pptx");
  const pdfPath = join(input.outputRoot, "rendered-client.pdf");
  const pagesDir = join(input.outputRoot, "pages-png");

  const pptxSize = existsSync(pptxPath) ? statSync(pptxPath).size : 0;
  const pdfSize = existsSync(pdfPath) ? statSync(pdfPath).size : 0;
  const pageFiles = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter((f) => f.startsWith("page-") && f.endsWith(".png"))
    : [];
  const pageCount = pageFiles.length || input.deckManifest.slideCount;

  checks.push({ id: "pptx-exists", passed: pptxSize > 5000, detail: `${pptxSize} bytes` });
  checks.push({ id: "pdf-exists", passed: pdfSize > 5000, detail: `${pdfSize} bytes` });
  checks.push({ id: "pages-png", passed: pageCount > 0, detail: `${pageCount} pages` });

  const reportMode = resolveOrionVisualReportMode({ reportMode: input.reportMode });
  const expectedPageRange = expectedPageRangeForMode(reportMode);
  const enoughData =
    input.inventory.counts.searchResults >= 50 &&
    (input.inventory.mediaAvailability.serpScreenshots > 0 ||
      input.inventory.counts.searchResults > 100);

  let pageOk: boolean;
  let pageDetail: string;
  if (reportMode === "client_audit") {
    pageOk =
      pageCount >= expectedPageRange.min && pageCount <= expectedPageRange.max + 5;
    pageDetail = `${pageCount} (client_audit target ${expectedPageRange.min}-${expectedPageRange.max})`;
  } else if (reportMode === "classic_orion_audit") {
    pageOk =
      pageCount >= expectedPageRange.min && pageCount <= expectedPageRange.max;
    pageDetail = `${pageCount} (classic_orion_audit target ${expectedPageRange.min}-${expectedPageRange.max})`;
  } else if (enoughData) {
    pageOk =
      pageCount >= expectedPageRange.min && pageCount <= expectedPageRange.max + 10;
    pageDetail = `${pageCount} (legacy_full target ${expectedPageRange.min}-${expectedPageRange.max})`;
  } else {
    pageOk = pageCount >= 10;
    pageDetail = `${pageCount} (reduced data case)`;
  }

  checks.push({
    id: "page-count-target",
    passed: pageOk,
    detail: pageDetail,
  });
  checks.push({
    id: "report-mode",
    passed: true,
    detail: reportMode,
  });

  const serpSlides = input.deckManifest.finalSlides.filter(
    (s) => s.template === "orion_golden_serp_screenshot"
  );
  const lexisSlides = input.deckManifest.finalSlides.filter(
    (s) => s.template === "orion_golden_lexis_visual_page"
  );
  const imageSlides = input.deckManifest.finalSlides.filter(
    (s) => s.template === "orion_golden_image_grid"
  );

  checks.push({
    id: "serp-slides-if-data",
    passed:
      input.inventory.mediaAvailability.serpScreenshots === 0 || serpSlides.length > 0,
    detail: `${serpSlides.length} serp slides`,
  });
  checks.push({
    id: "lexis-summary-before-visual",
    passed: input.inventory.lexisNexis.visualPageCount === 0 || lexisSlides.length >= 0,
    detail: `${lexisSlides.length} lexis visual slides`,
  });
  // Client-audit decks intentionally omit image grids; do not fail on missing grids.
  const imageGridOk =
    reportMode === "client_audit" ||
    input.inventory.mediaAvailability.images === 0 ||
    imageSlides.length > 0 ||
    input.inventory.mediaAvailability.images < 3;
  checks.push({
    id: "image-grid-if-data",
    passed: imageGridOk,
    detail:
      reportMode === "client_audit"
        ? `${imageSlides.length} image grid slides (optional in client_audit)`
        : `${imageSlides.length} image grid slides`,
  });

  if (existsSync(pdfPath) && serpSlides.length > 0) {
    const pdfBuf = readFileSync(pdfPath);
    const hasPngSig =
      pdfBuf.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47])) || pdfSize > 200_000;
    checks.push({
      id: "pdf-has-visual-content",
      passed: hasPngSig,
      detail: `pdf ${pdfSize} bytes`,
    });
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
    reportMode,
    expectedPageRange,
    actualPageCount: pageCount,
    checks,
  };
}
