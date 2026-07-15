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
import {
  assertSidebarClientPolicy,
  inspectSidebarClientPolicy,
} from "./sidebar-client-policy";
import { isArsenkinRequired } from "../../providers/arsenkin";
import {
  ArsenkinReportBindingError,
  arsenkinPostReviewContentPath,
  assertArsenkinTransferredClientContent,
  loadArsenkinReportBinding,
  resolveEffectiveReportRunIdForCase,
  saveArsenkinReportBinding,
} from "./arsenkin-report-binding";
import type { ExecutiveSynthesisOutput } from "../gpt/orion-executive-synthesis-from-sections";
import type { SectionDerivedRiskMatrix } from "../sections/orion-risk-matrix-from-sections";
import type { AdminReviewDecisionSet } from "../evidence/admin-review-decision";
import { generateFirst36GeometryArtifacts } from "./generate-first36-geometry-artifacts";
import {
  inspectFirst36Acceptance,
  requiredVisualAssetRefsFromRegistry,
} from "./first36-acceptance-gate";
import { inspectCrossSlideMetricConsistency } from "./cross-slide-metric-consistency";
import { inspectClientCopySlides } from "./client-copy-completeness";
import {
  buildAiAnswerObservations,
  evaluateAiAnswerObservation,
} from "./ai-answer-evaluation";

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

export class OrionClassicForeignClientContentError extends Error {
  readonly loadedReportRunId: string;
  readonly expectedReportRunId: string;
  constructor(loadedReportRunId: string, expectedReportRunId: string) {
    super(
      `foreign-client-content: loaded reportRunId=${loadedReportRunId} != expected=${expectedReportRunId}; rebuild with rebuildClientContentForReportRun`
    );
    this.name = "OrionClassicForeignClientContentError";
    this.loadedReportRunId = loadedReportRunId;
    this.expectedReportRunId = expectedReportRunId;
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

export function loadPostReviewClientContent(caseId: string, outputRoot?: string): OrionClientContent {
  const paths: string[] = [];
  // Canonical case-scoped content always first.
  paths.push(arsenkinPostReviewContentPath(caseId));
  if (outputRoot) {
    paths.push(join(outputRoot, "orion-client-content.post-review.json"));
  }
  paths.push(...resolveClientContentPaths(caseId));

  const resolved = resolveEffectiveReportRunIdForCase(caseId, "");
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const data = readJson<OrionClientContent>(path);
    if (!data || data.caseId !== caseId) continue;
    if (resolved.fromArsenkinBinding && data.reportRunId !== resolved.reportRunId) {
      // Skip stale source-run content when Arsenkin binding is active.
      continue;
    }
    return data;
  }
  throw new Error(
    resolved.fromArsenkinBinding
      ? `post-review-client-content-missing-or-stale:expected=${resolved.reportRunId}`
      : "post-review-client-content-missing"
  );
}

function resolveClientContentForRender(
  caseId: string,
  outputRoot: string,
  explicit?: OrionClientContent
): OrionClientContent {
  if (explicit) return explicit;
  return loadPostReviewClientContent(caseId, outputRoot);
}

function resolveAdminDecisionSet(
  caseId: string,
  outputRoot: string
): AdminReviewDecisionSet | null {
  const candidates = [
    join(outputRoot, "admin-review-decisions.json"),
    join(caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId), "admin-review-decisions.json"),
    join(
      process.cwd(),
      "storage",
      "digital-profile",
      "qa-r10-orion-golden-parallel",
      "admin-review-decisions.json"
    ),
  ];
  for (const path of candidates) {
    const data = readJson<AdminReviewDecisionSet>(path);
    if (data?.caseId === caseId && Array.isArray(data.decisions)) return data;
  }
  return null;
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

  const loaded = resolveClientContentForRender(caseId, outputRoot, options.clientContent);
  const arsenkinBinding = loadArsenkinReportBinding(caseId);
  const clientContentSourceReportRunId =
    arsenkinBinding &&
    (arsenkinBinding.status === "TRANSFERRED" || arsenkinBinding.status === "REPORT_BOUND")
      ? arsenkinBinding.sourceReportRunId
      : String(loaded.reportRunId ?? "").trim() || null;

  if (options.reportRunIdOverride) {
    const expectedRunId = options.reportRunIdOverride.trim();
    if (!expectedRunId) throw new Error("reportRunIdOverride-empty");
    if (loaded.reportRunId !== expectedRunId) {
      if (isClientProductionFinalize()) {
        throw new OrionClassicForeignClientContentError(String(loaded.reportRunId ?? ""), expectedRunId);
      }
      throw new OrionClassicForeignClientContentError(String(loaded.reportRunId ?? ""), expectedRunId);
    }
  }

  // Fail-closed: transferred Arsenkin cases must not render against the old ORION run.
  if (
    arsenkinBinding &&
    (arsenkinBinding.status === "TRANSFERRED" || arsenkinBinding.status === "REPORT_BOUND")
  ) {
    const [observationCount, providerTaskCount, coverageCount, suggestObs] = await Promise.all([
      prisma.serpObservation.count({
        where: { auditRunId: arsenkinBinding.effectiveReportRunId, provider: "arsenkin" },
      }),
      prisma.providerTask.count({
        where: { reportRunId: arsenkinBinding.effectiveReportRunId, provider: "arsenkin" },
      }),
      prisma.surfaceCollectionCoverage.count({
        where: { reportRunId: arsenkinBinding.effectiveReportRunId, provider: "arsenkin" },
      }),
      prisma.serpObservation.findMany({
        where: {
          auditRunId: arsenkinBinding.effectiveReportRunId,
          provider: "arsenkin",
          surface: "autocomplete",
          region: "RU",
        },
        select: { engine: true, providerTaskId: true },
        take: 50,
      }),
    ]);
    const gate = assertArsenkinTransferredClientContent({
      caseId,
      clientContentReportRunId: String(loaded.reportRunId ?? ""),
      binding: arsenkinBinding,
      observationCount,
      providerTaskCount,
      coverageCount,
      requireCanarySuggestions: arsenkinBinding.workflow === "suggest-canary",
      hasYandexRuAutocomplete: suggestObs.some(
        (o) => o.engine === "YANDEX" && Boolean(o.providerTaskId)
      ),
      hasGoogleRuAutocomplete: suggestObs.some(
        (o) => o.engine === "GOOGLE" && Boolean(o.providerTaskId)
      ),
    });
    if (!gate.ok) {
      writeJson(join(outputRoot, "arsenkin-render-binding-gate.json"), {
        blocked: true,
        issues: gate.issues,
        binding: arsenkinBinding,
      });
      throw new ArsenkinReportBindingError(gate.issues);
    }
  }

  const clientContent: OrionClientContent = loaded;
  writeJson(join(outputRoot, "client-content-binding.json"), {
    sourceReportRunId:
      arsenkinBinding &&
      (arsenkinBinding.status === "TRANSFERRED" || arsenkinBinding.status === "REPORT_BOUND")
        ? arsenkinBinding.sourceReportRunId
        : clientContentSourceReportRunId,
    effectiveReportRunId: clientContent.reportRunId,
    overridden: false,
  });
  const ctx = await loadRealCaseContext(caseId, { locale: "ru", buildFreshReportJson: false });
  const first36CeoModeEarly = isFirst36CeoMode();
  if (first36CeoModeEarly) {
    try {
      const { enrichReportRunWithArsenkin } = await import("./enrich-report-run-with-arsenkin");
      const { buildArsenkinSubjectQueryPlan } = await import("./arsenkin-subject-query-plan");
      const name = String(ctx.subject?.fullName ?? "").trim();
      const aliases = (ctx.subject?.aliases ?? []).map((a) => String(a).trim()).filter(Boolean);
      const queryPlan = buildArsenkinSubjectQueryPlan({ fullName: name, aliases });
      if (queryPlan.blockers.length) {
        throw new Error(`arsenkin-query-plan-blocked:${queryPlan.blockers.join(",")}`);
      }
      const arsenkinEnrich = await enrichReportRunWithArsenkin({
        caseId,
        auditRunId: clientContent.reportRunId,
        queriesRu: queryPlan.queriesRu.slice(0, 3),
        queriesUae: queryPlan.queriesUae.slice(0, 2),
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
  writeJson(join(outputRoot, "arsenkin-surface-coverage.json"), {
    reportRunId: clientContent.reportRunId,
    rows: surfaceCoverage,
  });
  const fullPlan =
    readJson<Record<string, unknown>>(join(outputRoot, "arsenkin-live-plan.json")) ??
    readJson<Record<string, unknown>>(
      join(caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId), "arsenkin-live-plan.json")
    ) ??
    {
      reportRunId: clientContent.reportRunId,
      warning: "arsenkin-live-plan.json missing in render artifacts",
    };
  writeJson(join(outputRoot, "arsenkin-full-first36-plan.json"), fullPlan);
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
  const arsenkinObservations = await prisma.serpObservation.findMany({
    where: { auditRunId: clientContent.reportRunId, provider: "arsenkin" },
    select: {
      id: true,
      auditRunId: true,
      provider: true,
      providerTaskId: true,
      surface: true,
      engine: true,
      region: true,
      queryText: true,
      providerStatus: true,
      title: true,
      snippet: true,
      url: true,
      domain: true,
      capturedAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  writeJson(
    join(outputRoot, "serp-observations-provenance.json"),
    arsenkinObservations.map((o) => ({
      id: o.id,
      auditRunId: o.auditRunId,
      provider: o.provider,
      providerTaskId: o.providerTaskId,
      surface: o.surface,
      engine: o.engine,
      region: o.region,
    }))
  );
  const aiObservationRows = arsenkinObservations
    .filter((o) => o.surface === "ai_answer")
    .map((o) => ({
      id: o.id,
      auditRunId: o.auditRunId,
      providerTaskId: o.providerTaskId,
      queryText: o.queryText,
      engine: o.engine,
      region: o.region,
      providerStatus: o.providerStatus,
      title: o.title,
      snippet: o.snippet,
      url: o.url,
      domain: o.domain,
      capturedAt: o.capturedAt.toISOString(),
    }));
  const aiAnswerObservations = buildAiAnswerObservations(aiObservationRows);
  writeJson(join(outputRoot, "ai-answer-observations.json"), aiAnswerObservations);
  const aiAnswerEvaluations = aiAnswerObservations
    .map((obs) =>
      evaluateAiAnswerObservation({
        subjectFullName: String(ctx.subject?.fullName ?? clientContent.subject.displayName ?? ""),
        aliases: (ctx.subject?.aliases ?? []).map((a) => String(a ?? "").trim()).filter(Boolean),
        observation: obs,
      })
    )
    .filter((x): x is NonNullable<typeof x> => Boolean(x));
  writeJson(join(outputRoot, "ai-answer-evaluations.json"), aiAnswerEvaluations);
  const baseInventory = buildFullEvidenceInventory({
    caseId,
    reportRunId: clientContent.reportRunId,
    ctx,
  });
  const runScoped = await mergeRunScopedSerpObservations({
    inventory: baseInventory,
    auditRunId: clientContent.reportRunId,
    caseId,
  });
  const inventory = runScoped.inventory;
  writeJson(join(outputRoot, "run-scoped-serp-merge.json"), {
    auditRunId: clientContent.reportRunId,
    usedRunScoped: runScoped.usedRunScoped,
    observationCount: runScoped.observationCount,
    duplicateKeys: runScoped.duplicateKeys.slice(0, 20),
    warnings: runScoped.warnings,
  });
  if (runScoped.compositeProvenance) {
    writeJson(join(outputRoot, "composite-serp-merge-provenance.json"), runScoped.compositeProvenance);
  }
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

  // Fail-closed BEFORE the HTTP renderer call: mirror the Python sidebar QA so
  // a client-policy violation surfaces here (with page/field/token) instead of
  // as an opaque "sidebar forbidden token" render failure with 0 pages.
  const sidebarViolations = inspectSidebarClientPolicy(deckManifest.finalSlides ?? []);
  writeJson(join(outputRoot, "sidebar-client-policy.json"), {
    passed: sidebarViolations.length === 0,
    violations: sidebarViolations,
  });
  assertSidebarClientPolicy(deckManifest.finalSlides ?? []);

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

  const assetList = assets.map((a) => ({
    assetRef: a.assetRef,
    status: String((a as { status?: string }).status ?? "ready"),
    evidenceRefs: Array.isArray(a.evidenceRefs) ? a.evidenceRefs.map(String) : [],
  }));

  let geometryOk = true;
  let geometryReport: {
    overlaps?: unknown[];
    overflow?: unknown[];
    blank?: unknown[];
    missingAssets?: unknown[];
    emptyContent?: unknown[];
    summary?: { issueCount?: number; severity?: string; pageCount?: number };
    inspectorError?: string | null;
  } | null = null;
  let geometryPresent = false;
  if (first36CeoMode) {
    const geometry = await generateFirst36GeometryArtifacts(outputRoot, {
      slides: (deckManifest.finalSlides ?? []).map((s) => ({
        pageNumber: Number(s.pageNumber ?? 0),
        slideKey: s.slideKey ? String(s.slideKey) : undefined,
        slotId: (s as { slotId?: string }).slotId
          ? String((s as { slotId?: string }).slotId)
          : s.slideKey
            ? String(s.slideKey)
            : undefined,
        title: s.title ? String(s.title) : undefined,
        narrative: s.narrative ? String(s.narrative) : undefined,
        bullets: Array.isArray(s.bullets) ? s.bullets.map(String) : undefined,
        clientTakeaway: s.clientTakeaway ? String(s.clientTakeaway) : undefined,
        assetRefs: Array.isArray(s.assetRefs) ? s.assetRefs.map(String) : undefined,
        requiredVisual: (s as { requiredVisual?: boolean }).requiredVisual,
      })),
      assets: assetList,
    });
    geometryReport = geometry.report;
    geometryPresent = true;
    geometryOk = geometry.ok;
    writeJson(join(outputRoot, "geometry-artifacts.json"), {
      ok: geometry.ok,
      geometryPath: geometry.geometryPath,
      contactSheetPath: geometry.contactSheetPath,
      inspectorError: geometry.report.inspectorError ?? null,
      summary: geometry.report.summary,
    });
    if (!geometryOk && clientFinalize) {
      writeJson(join(outputRoot, "geometry-finalize-block.json"), {
        blocked: true,
        reason: geometry.report.inspectorError ?? geometry.report.summary.severity,
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
  const adminDecisionSet = resolveAdminDecisionSet(caseId, outputRoot);

  const acceptance = inspectFirst36Acceptance({
    slideCount: deckManifest.totalSlideCount ?? deckManifest.slideCount,
    baseSlotCoverage: deckManifest.baseSlotCoverage,
    missingBaseSlots: deckManifest.missingBaseSlots,
    slides: (deckManifest.finalSlides ?? []).map((s) => ({
      pageNumber: Number(s.pageNumber ?? 0),
      title: String(s.title ?? ""),
      narrative: s.narrative ? String(s.narrative) : undefined,
      bullets: Array.isArray(s.bullets) ? s.bullets.map(String) : undefined,
      template: s.template ? String(s.template) : undefined,
      table: s.table as
        | {
            headers?: string[];
            rows?: string[][];
            groups?: Array<{ queryDisplay?: string; rowStart?: number; rowCount?: number }>;
          }
        | undefined,
      baseSlotId: (s as { baseSlotId?: string }).baseSlotId,
      baseSlotIndex: (s as { baseSlotIndex?: number }).baseSlotIndex,
      isContinuation: (s as { isContinuation?: boolean }).isContinuation,
      continuationOf: (s as { continuationOf?: string | null }).continuationOf,
      sectionId: (s as { sectionId?: string }).sectionId,
      searchCounters: (s as { searchCounters?: Record<string, number> }).searchCounters,
      imageCounters: (s as { imageCounters?: Record<string, number> }).imageCounters,
      totalPageCount: (s as { totalPageCount?: number }).totalPageCount,
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
    themeSet: themeSet as import("./orion-classic-theme-set").OrionThemeSet,
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
    compositeBinding: arsenkinBinding
      ? {
          sourceReportRunId: arsenkinBinding.sourceReportRunId,
          effectiveReportRunId: arsenkinBinding.effectiveReportRunId,
          enrichmentRunIds: [arsenkinBinding.effectiveReportRunId],
          compositeDigest: arsenkinBinding.compositeDigest,
        }
      : null,
    compositeMergeWarnings: runScoped.warnings,
    themeKpis: {
      ru: {
        linksTotal: themeSet.ru.linksTotal,
        linksAdversePct: themeSet.ru.linksAdversePct,
        overallBadge: themeSet.ru.overallBadge,
        overallRiskBadge: themeSet.ru.overallRiskBadge,
      },
      uae: {
        linksTotal: themeSet.uae.linksTotal,
        linksAdversePct: themeSet.uae.linksAdversePct,
        overallBadge: themeSet.uae.overallBadge,
        overallRiskBadge: themeSet.uae.overallRiskBadge,
      },
    },
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
    adminDecisionSet: adminDecisionSet
      ? {
          qaSampleOnly: adminDecisionSet.qaSampleOnly,
          decisions: adminDecisionSet.decisions.map((d) => ({
            reviewedBy: d.reviewedBy,
            reviewerNote: d.reviewerNote,
          })),
        }
      : undefined,
    clientFinalize: clientFinalize && geometryOk,
  });
  writeJson(join(outputRoot, "first36-acceptance.json"), acceptance);
  const metricConsistency = inspectCrossSlideMetricConsistency({
    themeSet,
    slides: deckManifest.finalSlides ?? [],
  });
  writeJson(join(outputRoot, "metric-consistency-report.json"), {
    passed: metricConsistency.length === 0,
    issues: metricConsistency,
  });
  writeJson(join(outputRoot, "cross-slide-metric-report.json"), {
    passed: metricConsistency.length === 0,
    issues: metricConsistency,
  });
  const clientCopyIssues = inspectClientCopySlides(deckManifest.finalSlides ?? []);
  writeJson(join(outputRoot, "client-copy-report.json"), {
    passed: clientCopyIssues.length === 0,
    issues: clientCopyIssues,
  });

  // Final verdict/readiness/ceoReady come only from First36 acceptance.
  // source != effective is valid for composite Arsenkin binding.
  const foreignClient =
    Boolean(clientBinding?.sourceReportRunId) &&
    clientBinding!.sourceReportRunId !== clientContent.reportRunId &&
    !(
      arsenkinBinding &&
      arsenkinBinding.sourceReportRunId === clientBinding?.sourceReportRunId &&
      arsenkinBinding.effectiveReportRunId === clientContent.reportRunId
    );
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

  if (
    arsenkinBinding &&
    (arsenkinBinding.status === "TRANSFERRED" || arsenkinBinding.status === "REPORT_BOUND") &&
    clientContent.reportRunId === arsenkinBinding.effectiveReportRunId
  ) {
    saveArsenkinReportBinding({
      ...arsenkinBinding,
      status: "REPORT_BOUND",
    });
  }

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
