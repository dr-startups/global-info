/**
 * R10.11 — Classic ORION audit render pipeline (post-review content → PDF/PPTX).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRealCaseContext } from "../../orion-section-pipeline/real-case-data-adapter";
import {
  ORION_GOLDEN_QA_STORAGE_ROOT,
  caseScopedArtifactRoot,
} from "../evidence/admin-review-decision-store";
import { buildFullEvidenceInventory } from "../evidence/full-evidence-inventory";
import type { OrionClientContent } from "../content/orion-client-content-builder";
import { inspectOrionGoldenClientPolicy } from "../qa/client-policy-inspection";
import { inspectOrionGoldenVisualQuality } from "../qa/visual-qa-inspection";
import { renderOrionGoldenArtifacts } from "../renderer/orion-golden-render-client";
import { buildOrionClassicAuditAssets } from "./orion-classic-asset-builder";
import { composeOrionClassicAuditDeck } from "./orion-classic-audit-deck-composer";
import { buildOrionClassicReportSpecFromClientContent } from "./orion-classic-client-content-to-report-spec";
import { inspectClassicOrionAuditQuality } from "./orion-classic-audit-quality-inspection";

function writeJson(path: string, payload: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function resolveClientContentPaths(caseId: string): string[] {
  const roots = [
    caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId),
    join(process.cwd(), "storage", "digital-profile", "qa-r10-orion-golden-parallel"),
    join(process.cwd(), "storage", "digital-profile", "qa-r10-7-real-subject-calibration"),
  ];
  return roots.map((root) => join(root, "orion-client-content.post-review.json"));
}

export function loadPostReviewClientContent(caseId: string): OrionClientContent {
  for (const path of resolveClientContentPaths(caseId)) {
    const data = readJson<OrionClientContent>(path);
    if (data?.caseId === caseId) return data;
  }
  throw new Error("post-review-client-content-missing");
}

export function shouldUseClassicOrionAuditMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORION_CLASSIC_AUDIT_MODE === "1";
}

export async function runOrionClassicAuditRender(options: {
  caseId: string;
  outputRoot: string;
  clientContent?: OrionClientContent;
}): Promise<{
  caseId: string;
  outputRoot: string;
  slideCount: number;
  pageCount: number;
  verdict: "PASS" | "FAIL";
  clientPolicyStatus: string;
  visualPassed: boolean;
  classicQaPassed: boolean;
  warnings: string[];
}> {
  const { caseId, outputRoot } = options;
  mkdirSync(outputRoot, { recursive: true });

  const clientContent = options.clientContent ?? loadPostReviewClientContent(caseId);
  const ctx = await loadRealCaseContext(caseId, { locale: "ru", buildFreshReportJson: false });
  const inventory = buildFullEvidenceInventory({
    caseId,
    reportRunId: clientContent.reportRunId,
    ctx,
  });
  const assets = await buildOrionClassicAuditAssets({ ctx });

  const reportSpec = buildOrionClassicReportSpecFromClientContent({
    clientContent,
    inventory,
    assets,
    inventoryCounts: inventory.counts,
    warnings: inventory.warnings,
  });
  const deckManifest = composeOrionClassicAuditDeck(reportSpec, assets);

  writeJson(join(outputRoot, "orion-classic-report-spec.json"), reportSpec);
  writeJson(join(outputRoot, "final-deck-manifest.json"), deckManifest);
  writeJson(join(outputRoot, "report-assets.json"), assets);

  const renderResult = await renderOrionGoldenArtifacts({
    reportSpec,
    deckManifest,
    assets,
    pptxOut: join(outputRoot, "rendered-client.pptx"),
    pdfOut: join(outputRoot, "rendered-client.pdf"),
    pagesOut: join(outputRoot, "pages-png"),
  });

  const clientPolicy = inspectOrionGoldenClientPolicy({ reportSpec, deckManifest });
  writeJson(join(outputRoot, "client-policy-inspection.json"), clientPolicy);

  const visual = inspectOrionGoldenVisualQuality({
    outputRoot,
    deckManifest,
    inventory,
    pdfExportMode: renderResult.pdfExportMode,
    reportMode: "classic_orion_audit",
  });
  writeJson(join(outputRoot, "visual-qa-inspection.json"), visual);

  const classicQa = inspectClassicOrionAuditQuality({
    deckManifest,
    reportSpec,
    inventory,
    outputRoot,
  });
  writeJson(join(outputRoot, "classic-audit-quality-inspection.json"), classicQa);

  const verdict =
    clientPolicy.passed && visual.passed && classicQa.passed ? "PASS" : "FAIL";

  // Metadata tags are not user-facing failures; surface real QA issues first.
  const metaNoise = new Set([
    "classic_orion_audit_mode",
    "commercial_pack_included",
    "client_audit_render_from_post_review_content",
    "commercial_sections_omitted",
    "r10_9a_visual_polish",
    "source:orion-client-content.post-review",
    "source:orion-client-content.pre-review",
  ]);
  const warnings = [
    ...(clientPolicy.issues ?? []),
    ...classicQa.issues,
    ...visual.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`),
    ...(reportSpec.qaMetadata.warnings ?? []).filter((w) => !metaNoise.has(w)),
  ];

  return {
    caseId,
    outputRoot,
    slideCount: deckManifest.slideCount,
    pageCount: visual.pageCount,
    verdict,
    clientPolicyStatus: clientPolicy.passed ? "PASS" : "FAIL",
    visualPassed: visual.passed,
    classicQaPassed: classicQa.passed,
    warnings,
  };
}
