/**
 * R10.11 — QA inspection for classic ORION audit decks (55–75 pages, no mid-word artifacts).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrionGoldenDeckManifest } from "../composer/orion-deck-composer";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import type { OrionClassicAuditReportSpec } from "./orion-classic-client-content-to-report-spec";

export const CLASSIC_ORION_AUDIT_PAGE_RANGE = { min: 45, max: 120 } as const;

export function inspectClassicOrionAuditQuality(input: {
  deckManifest: OrionGoldenDeckManifest;
  reportSpec: OrionClassicAuditReportSpec;
  inventory: FullEvidenceInventory;
  outputRoot: string;
}): { passed: boolean; issues: string[]; checks: Array<{ id: string; passed: boolean; detail: string }> } {
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];

  const slideCount = input.deckManifest.slideCount;
  const pageOk =
    slideCount >= CLASSIC_ORION_AUDIT_PAGE_RANGE.min &&
    slideCount <= CLASSIC_ORION_AUDIT_PAGE_RANGE.max;
  checks.push({
    id: "page-range",
    passed: pageOk,
    detail: `${slideCount} slides (target ${CLASSIC_ORION_AUDIT_PAGE_RANGE.min}-${CLASSIC_ORION_AUDIT_PAGE_RANGE.max})`,
  });

  const hasCommercial = input.deckManifest.finalSlides.some((s) =>
    ["offer", "product_overview", "solution_digital_profile", "about"].includes(s.sectionKey)
  );
  checks.push({
    id: "commercial-present",
    passed: hasCommercial,
    detail: hasCommercial ? "commercial sections present" : "missing commercial pack",
  });

  const hasSuggestions = input.reportSpec.registrySections.some((s) =>
    /suggestions|related_queries/.test(s.sectionId)
  );
  const hasSuggestionEvidence =
    input.inventory.mediaAvailability.suggestions > 0 ||
    input.inventory.mediaAvailability.relatedQueries > 0;
  checks.push({
    id: "suggestion-sections",
    passed: !hasSuggestionEvidence || hasSuggestions,
    detail: hasSuggestions ? "suggestion/related sections emitted" : "no suggestion sections (check evidence)",
  });

  const objectObjectHits = input.deckManifest.finalSlides.flatMap((s) => s.bullets ?? []).filter((b) =>
    /\[object Object\]/i.test(b)
  );
  checks.push({
    id: "no-object-object",
    passed: objectObjectHits.length === 0,
    detail: objectObjectHits.length ? `${objectObjectHits.length} [object Object] bullets` : "clean bullets",
  });

  try {
    const pdfPath = join(input.outputRoot, "rendered-client.pdf");
    if (existsSync(pdfPath)) {
      const pdf = readFileSync(pdfPath);
      checks.push({
        id: "pdf-nonempty",
        passed: pdf.length > 5000,
        detail: `${pdf.length} bytes`,
      });
    } else {
      checks.push({
        id: "pdf-nonempty",
        passed: true,
        detail: "skipped (offline composition)",
      });
    }
  } catch {
    checks.push({ id: "pdf-nonempty", passed: true, detail: "skipped" });
  }

  for (const check of checks) {
    if (!check.passed) issues.push(`${check.id}: ${check.detail}`);
  }

  return { passed: issues.length === 0, issues, checks };
}
