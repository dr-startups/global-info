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
import { composeOrionFirst36CeoDeck } from "./orion-first36-deck-composer";
import { buildOrionClassicReportSpecFromClientContent } from "./orion-classic-client-content-to-report-spec";
import { buildOrionThemeSet } from "./orion-classic-theme-set";
import { inspectClassicOrionAuditQuality } from "./orion-classic-audit-quality-inspection";
import { isClientProductionFinalize, isFirst36CeoMode } from "./orion-classic-live-serp-assets";
import { evaluateClassicProviderSerpGate } from "./orion-classic-provider-serp-assets";
import { mergeRunScopedSerpObservations } from "./merge-run-scoped-serp-observations";
import type { ExecutiveSynthesisOutput } from "../gpt/orion-executive-synthesis-from-sections";
import type { SectionDerivedRiskMatrix } from "../sections/orion-risk-matrix-from-sections";

export class OrionClassicVisualGateError extends Error {
  readonly blockedSections: Array<{ sectionKey: string; reason: string }>;
  constructor(blockedSections: Array<{ sectionKey: string; reason: string }>) {
    super(
      `REQUIRED_VISUAL_ASSET_MISSING: ${blockedSections.map((b) => b.sectionKey).join(", ")}`
    );
    this.name = "OrionClassicVisualGateError";
    this.blockedSections = blockedSections;
  }
}

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
  readiness: "INTERNAL_PREVIEW" | "CEO_READY";
  ceoReady: boolean;
  warnings: string[];
}> {
  const { caseId, outputRoot } = options;
  mkdirSync(outputRoot, { recursive: true });

  const clientContent = options.clientContent ?? loadPostReviewClientContent(caseId);
  const ctx = await loadRealCaseContext(caseId, { locale: "ru", buildFreshReportJson: false });
  const baseInventory = buildFullEvidenceInventory({
    caseId,
    reportRunId: clientContent.reportRunId,
    ctx,
  });
  const runScoped = await mergeRunScopedSerpObservations({
    inventory: baseInventory,
    auditRunId: clientContent.reportRunId,
  });
  const inventory = runScoped.inventory;
  writeJson(join(outputRoot, "run-scoped-serp-merge.json"), {
    auditRunId: clientContent.reportRunId,
    usedRunScoped: runScoped.usedRunScoped,
    observationCount: runScoped.observationCount,
    duplicateKeys: runScoped.duplicateKeys.slice(0, 20),
    warnings: runScoped.warnings,
  });
  const clientFinalize = isClientProductionFinalize();
  const first36CeoMode = isFirst36CeoMode();
  const includeCommercial = !first36CeoMode;
  const assets = await buildOrionClassicAuditAssets({
    ctx,
    reportRunId: clientContent.reportRunId,
    audience: clientFinalize ? "client" : "internal_preview",
    allowSyntheticSerp: !clientFinalize,
  });
  console.info("[serp-capture] classic audit assets", {
    caseId,
    reportRunId: clientContent.reportRunId,
    first36CeoMode,
    includeCommercial,
    liveCount: assets.filter((a) => a.kind === "live_serp").length,
    syntheticCount: assets.filter((a) => a.kind === "synthetic_serp").length,
    capturedCount: assets.filter((a) => a.kind === "captured_serp").length,
    providerCount: assets.filter(
      (a) =>
        a.evidenceRefs.some((r) => r.startsWith("serp_observation:")) ||
        /provider_serp|serper_organic|yandex_organic/i.test(a.assetRef)
    ).length,
  });

  // Client reports must not omit required SERP visuals or replace them with text pages.
  if (clientFinalize) {
    const gate = evaluateClassicProviderSerpGate({
      assets,
      requireRu: true,
      requireUae: true,
    });
    if (!gate.allowed) {
      writeJson(join(outputRoot, "visual-asset-gate.json"), gate);
      throw new OrionClassicVisualGateError(gate.blockedSections);
    }
  }

  const roots = [
    caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId),
    join(process.cwd(), "storage", "digital-profile", "qa-r10-orion-golden-parallel"),
  ];
  let executiveSynthesis: ExecutiveSynthesisOutput | null = null;
  let riskMatrix: SectionDerivedRiskMatrix | null = null;
  for (const root of roots) {
    executiveSynthesis =
      executiveSynthesis ?? readJson<ExecutiveSynthesisOutput>(join(root, "executive-synthesis.output.json"));
    riskMatrix =
      riskMatrix ?? readJson<SectionDerivedRiskMatrix>(join(root, "risk-matrix.section-derived.json"));
  }

  const themeSet = buildOrionThemeSet({
    inventory,
    subjectName: clientContent.subject.displayName,
    caseId,
    clientContent,
    executiveSynthesis,
  });
  writeJson(join(outputRoot, "orion-theme-set.json"), themeSet);

  const reportSpec = buildOrionClassicReportSpecFromClientContent({
    clientContent,
    inventory,
    assets,
    inventoryCounts: inventory.counts,
    warnings: inventory.warnings,
    executiveSynthesis,
    riskMatrix,
    includeCommercial,
  });
  const deckManifest = first36CeoMode
    ? composeOrionFirst36CeoDeck(reportSpec, assets, { themeSet })
    : composeOrionClassicAuditDeck(reportSpec, assets, { includeCommercial });

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
    first36CeoMode,
  });
  writeJson(join(outputRoot, "visual-qa-inspection.json"), visual);

  const classicQa = inspectClassicOrionAuditQuality({
    deckManifest,
    reportSpec,
    inventory,
    outputRoot,
    assets,
    clientProductionFinalize: clientFinalize,
    first36CeoMode,
  });
  writeJson(join(outputRoot, "classic-audit-quality-inspection.json"), classicQa);

  const verdict =
    clientPolicy.passed && visual.passed && classicQa.passed ? "PASS" : "FAIL";
  const ceoReady = Boolean(classicQa.ceoReady);
  const readiness = ceoReady ? "CEO_READY" : "INTERNAL_PREVIEW";

  if (verdict === "FAIL") {
    const failedVisual = visual.checks.filter((c) => !c.passed).map((c) => `${c.id}:${c.detail}`);
    console.warn("[orion-classic-audit] QA FAIL detail", {
      caseId,
      clientPolicy: clientPolicy.passed ? "PASS" : clientPolicy.issues.slice(0, 8),
      visualFailed: failedVisual.slice(0, 8),
      classicQaFailed: classicQa.issues.slice(0, 8),
      pageCount: visual.pageCount,
      reportMode: visual.reportMode,
      readiness,
    });
  }

  // Metadata tags are not user-facing failures; surface real QA issues first.
  const metaNoise = new Set([
    "classic_orion_audit_mode",
    "commercial_pack_included",
    "client_audit_render_from_post_review_content",
    "commercial_sections_omitted",
    "first36_ceo_mode",
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
    readiness,
    ceoReady,
    warnings,
  };
}
