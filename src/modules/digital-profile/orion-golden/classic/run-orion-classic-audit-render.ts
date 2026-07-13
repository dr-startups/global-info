/**
 * R10.11 — Classic ORION audit render pipeline (post-review content → PDF/PPTX).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRealCaseContext } from "../../orion-section-pipeline/real-case-data-adapter";
import { prisma } from "@/server/prisma/client";
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
import { isArsenkinRequired } from "../../providers/arsenkin";
import type { ExecutiveSynthesisOutput } from "../gpt/orion-executive-synthesis-from-sections";
import type { SectionDerivedRiskMatrix } from "../sections/orion-risk-matrix-from-sections";
import { generateFirst36GeometryArtifacts } from "./generate-first36-geometry-artifacts";
import {
  inspectFirst36Acceptance,
  requiredVisualAssetRefsFromRegistry,
} from "./first36-acceptance-gate";

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
  /** Override post-review reportRunId for clean canary runs. */
  reportRunIdOverride?: string;
}): Promise<{
  caseId: string;
  outputRoot: string;
  slideCount: number;
  pageCount: number;
  verdict: "PASS" | "FAIL";
  clientPolicyStatus: string;
  visualPassed: boolean;
  classicQaPassed: boolean;
  /** Intermediate classic QA readiness (not final CEO gate). */
  renderQaReady: boolean;
  readiness: "INTERNAL_PREVIEW" | "CEO_READY";
  ceoReady: boolean;
  acceptance?: { passed: boolean; ceoReady: boolean; issueCount: number; issues: Array<{ code: string; detail: string }> };
  warnings: string[];
  reportRunId?: string;
}> {
  const { caseId, outputRoot } = options;
  mkdirSync(outputRoot, { recursive: true });

  const loaded = options.clientContent ?? loadPostReviewClientContent(caseId);
  const clientContentSourceReportRunId = String(loaded.reportRunId ?? "").trim() || null;
  const clientContent: OrionClientContent = options.reportRunIdOverride
    ? { ...loaded, reportRunId: options.reportRunIdOverride }
    : loaded;
  writeJson(join(outputRoot, "client-content-binding.json"), {
    sourceReportRunId: clientContentSourceReportRunId,
    effectiveReportRunId: clientContent.reportRunId,
    overridden: Boolean(options.reportRunIdOverride),
  });
  const ctx = await loadRealCaseContext(caseId, { locale: "ru", buildFreshReportJson: false });
  const first36CeoModeEarly = isFirst36CeoMode();
  if (first36CeoModeEarly) {
    try {
      const { enrichReportRunWithArsenkin } = await import("./enrich-report-run-with-arsenkin");
      const { transliterateRuToEn } = await import("../../search-surfaces/orion-query-plan");
      const name = String(ctx.subject?.fullName ?? "").trim();
      const aliases = (ctx.subject?.aliases ?? []).map((a) => String(a).trim()).filter(Boolean);
      const ruQueries = name
        ? [name, [...name.split(/\s+/)].reverse().join(" "), ...aliases.slice(0, 2)].filter(Boolean)
        : aliases.slice(0, 3);
      const latin =
        name && /[А-Яа-яЁё]/.test(name) ? transliterateRuToEn(name) : name || aliases[0] || "";
      const uaeQueries = latin
        ? [latin, [...latin.split(/\s+/)].reverse().join(" ")].filter(Boolean)
        : [];
      const arsenkinEnrich = await enrichReportRunWithArsenkin({
        caseId,
        auditRunId: clientContent.reportRunId,
        queriesRu: [...new Set(ruQueries)].slice(0, 3),
        queriesUae: [...new Set(uaeQueries)].slice(0, 2),
      });
      writeJson(join(outputRoot, "arsenkin-enrich.json"), arsenkinEnrich);
      console.info("[arsenkin] enrich", arsenkinEnrich);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeJson(join(outputRoot, "arsenkin-enrich.json"), {
        skipped: true,
        blocked: isArsenkinRequired(),
        reason: message,
      });
      console.warn("[arsenkin] enrich failed", message);
      if (isArsenkinRequired()) throw err;
    }
  }
  const surfaceCoverage = await prisma.surfaceCollectionCoverage.findMany({
    where: { reportRunId: clientContent.reportRunId, provider: "arsenkin" },
    orderBy: { capturedAt: "asc" },
  });
  writeJson(join(outputRoot, "surface-coverage.json"), {
    reportRunId: clientContent.reportRunId,
    rows: surfaceCoverage,
  });
  writeJson(
    join(outputRoot, "provider-tasks.json"),
    (
      await prisma.providerTask.findMany({
        where: { reportRunId: clientContent.reportRunId, provider: "arsenkin" },
        orderBy: { createdAt: "asc" },
      })
    ).map((task) => ({
      ...task,
      costStatus: task.limitsSpent == null ? "UNKNOWN" : "KNOWN",
    }))
  );
  writeJson(
    join(outputRoot, "serp-observations-provenance.json"),
    await prisma.serpObservation.findMany({
      where: { auditRunId: clientContent.reportRunId, provider: "arsenkin" },
      select: {
        id: true,
        auditRunId: true,
        provider: true,
        providerTaskId: true,
        surface: true,
        engine: true,
        region: true,
      },
      orderBy: { createdAt: "asc" },
    })
  );
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
  const first36CeoMode = first36CeoModeEarly;
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

  const renderQaReady = Boolean(classicQa.ceoReady && clientFinalize);

  let geometryOk = true;
  let geometryReport: {
    overlaps?: unknown[];
    overflow?: unknown[];
    blank?: unknown[];
    inspectorError?: string | null;
  } | null = null;
  let geometryPresent = false;
  if (first36CeoMode) {
    const geometry = await generateFirst36GeometryArtifacts(outputRoot);
    geometryReport = geometry.report;
    geometryPresent = true;
    geometryOk = geometry.ok;
    writeJson(join(outputRoot, "geometry-artifacts.json"), {
      ok: geometry.ok,
      geometryPath: geometry.geometryPath,
      contactSheetPath: geometry.contactSheetPath,
      inspectorError: geometry.report.inspectorError ?? null,
    });
    if (!geometryOk && clientFinalize) {
      // Honest finalize: inspector failure / missing PNG blocks CEO path.
      writeJson(join(outputRoot, "geometry-finalize-block.json"), {
        blocked: true,
        reason: geometry.report.inspectorError ?? "geometry_issues",
      });
    }
  }

  const providerTasks = readJson<Array<{ reportRunId?: string; state?: string; id?: string }>>(
    join(outputRoot, "provider-tasks.json")
  );
  const observations = readJson<
    Array<{ auditRunId?: string; provider?: string; providerTaskId?: string | null }>
  >(join(outputRoot, "serp-observations-provenance.json"));
  const coverageSummary = readJson<{
    reportRunId?: string;
    rows?: Array<Record<string, unknown>>;
  }>(join(outputRoot, "surface-coverage.json"));
  const enrich = readJson<{
    skipped?: boolean;
    mode?: string;
    blocked?: boolean;
    reason?: string;
    linkedObservations?: number;
    totalObservations?: number;
    linkedCoverage?: number;
    totalCoverage?: number;
  }>(join(outputRoot, "arsenkin-enrich.json"));
  const clientBinding = readJson<{ sourceReportRunId?: string; effectiveReportRunId?: string }>(
    join(outputRoot, "client-content-binding.json")
  );
  const assetList = assets.map((a) => ({
    assetRef: a.assetRef,
    status: String((a as { status?: string }).status ?? "ready"),
    evidenceRefs: Array.isArray(a.evidenceRefs) ? a.evidenceRefs.map(String) : [],
  }));

  const acceptance = inspectFirst36Acceptance({
    slideCount: deckManifest.slideCount,
    slides: (deckManifest.finalSlides ?? []).map((s) => ({
      pageNumber: Number(s.pageNumber ?? 0),
      title: String(s.title ?? ""),
      narrative: s.narrative ? String(s.narrative) : undefined,
      bullets: Array.isArray(s.bullets) ? s.bullets.map(String) : undefined,
      template: s.template ? String(s.template) : undefined,
      table: s.table as { headers?: string[]; rows?: string[][] } | undefined,
      clientTakeaway: s.clientTakeaway ? String(s.clientTakeaway) : undefined,
      visualAnalysis: s.visualAnalysis as
        | {
            whatIsVisible?: string;
            whyItMatters?: string;
            clientMeaning?: string;
            headlineConclusion?: string;
          }
        | undefined,
      statusBadge: s.statusBadge as { label?: string } | undefined,
      assetRefs: Array.isArray(s.assetRefs) ? s.assetRefs.map(String) : undefined,
      evidenceRefs: Array.isArray(s.evidenceRefs) ? s.evidenceRefs.map(String) : undefined,
      factualClaims: (s as { factualClaims?: Array<{ text?: string; evidenceRefs?: string[] }> })
        .factualClaims,
    })),
    themeSet: themeSet as {
      ru?: { linksTotal?: number; linksAdverse?: number; wikipediaStatus?: string };
      uae?: { linksTotal?: number; linksAdverse?: number; wikipediaStatus?: string };
    },
    runScopedMerge: {
      usedRunScoped: runScoped.usedRunScoped,
      duplicateKeys: runScoped.duplicateKeys,
      observationCount: runScoped.observationCount,
    },
    assets: assetList,
    requiredVisualAssetRefs: requiredVisualAssetRefsFromRegistry(assetList),
    paths: {
      pptx: join(outputRoot, "rendered-client.pptx"),
      pdf: join(outputRoot, "rendered-client.pdf"),
      pagesPngDir: join(outputRoot, "pages-png"),
    },
    arsenkinRequired: isArsenkinRequired(),
    arsenkinEnrich: enrich ?? undefined,
    coverageSummary: coverageSummary as {
      reportRunId?: string;
      rows?: Array<{
        reportRunId?: string;
        tool?: string;
        engine?: string;
        region?: string;
        surface?: string;
        status?: string;
        providerTaskId?: string | null;
      }>;
    },
    expectedRunId: clientContent.reportRunId,
    geometryReport: geometryReport ?? undefined,
    geometryReportPresent: geometryPresent,
    providerTasks: providerTasks ?? undefined,
    observations: observations ?? undefined,
    provenanceSummary: enrich
      ? {
          linkedObservations: enrich.linkedObservations,
          totalObservations: enrich.totalObservations,
          linkedCoverage: enrich.linkedCoverage,
          totalCoverage: enrich.totalCoverage,
        }
      : undefined,
    clientContentSourceReportRunId: clientBinding?.sourceReportRunId ?? null,
    clientFinalize: clientFinalize && geometryOk,
  });
  writeJson(join(outputRoot, "first36-acceptance.json"), acceptance);

  // Final verdict/readiness/ceoReady come only from First36 acceptance.
  const foreignClient =
    Boolean(clientBinding?.sourceReportRunId) &&
    clientBinding!.sourceReportRunId !== clientContent.reportRunId;
  const ceoReady = Boolean(acceptance.ceoReady && !foreignClient);
  const readiness = ceoReady ? "CEO_READY" : "INTERNAL_PREVIEW";
  const verdict =
    acceptance.passed && clientPolicy.passed && visual.passed && classicQa.passed ? "PASS" : "FAIL";

  if (verdict === "FAIL") {
    const failedVisual = visual.checks.filter((c) => !c.passed).map((c) => `${c.id}:${c.detail}`);
    console.warn("[orion-classic-audit] QA FAIL detail", {
      caseId,
      clientPolicy: clientPolicy.passed ? "PASS" : clientPolicy.issues.slice(0, 8),
      visualFailed: failedVisual.slice(0, 8),
      classicQaFailed: classicQa.issues.slice(0, 8),
      acceptanceIssues: acceptance.issues.slice(0, 12),
      pageCount: visual.pageCount,
      reportMode: visual.reportMode,
      renderQaReady,
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
    ...acceptance.issues.map((i) => `${i.code}: ${i.detail}`),
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
    renderQaReady,
    readiness,
    ceoReady,
    acceptance: {
      passed: acceptance.passed,
      ceoReady: acceptance.ceoReady,
      issueCount: acceptance.issues.length,
      issues: acceptance.issues.map((i) => ({ code: i.code, detail: i.detail })),
    },
    warnings,
    reportRunId: clientContent.reportRunId,
  };
}
