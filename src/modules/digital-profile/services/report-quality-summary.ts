/**
 * Report quality funnel aggregator (§0.1).
 *
 * Reads already-written job artifacts and produces one machine-readable summary:
 * collected → manifest → composite → identity → findings → slides, plus GPT /
 * visual / Arsenkin statuses. Never recomputes analytics — only aggregates.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { countIdentityByObservation } from "../orion-golden/deck-sections/load-deck-inputs";

export const REPORT_QUALITY_SUMMARY_VERSION = "report-quality-summary-v1" as const;

const GptStage1Schema = z.object({
  status: z.enum(["APPLIED", "FAILED", "SKIPPED", "MISSING"]),
  reason: z.string().optional(),
});

const GptStage2Schema = z.object({
  applied: z.number().int().nonnegative(),
  noChanges: z.number().int().nonnegative(),
  skippedDeterministic: z.number().int().nonnegative(),
  skippedEmpty: z.number().int().nonnegative(),
  skippedCached: z.number().int().nonnegative(),
  fallbackError: z.number().int().nonnegative(),
  fallbackValidation: z.number().int().nonnegative(),
  rejectedFieldsTop: z.array(z.string()).max(20),
  caseAnalysisUsed: z.boolean(),
});

const VisualFailureSchema = z.object({
  kind: z.string().min(1),
  slotId: z.string().min(1),
  assetRef: z.string().min(1),
  reason: z.string().min(1),
});

const VisualsSchema = z.object({
  built: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  warning: z.string().nullable(),
  /** REMEDIATION §5.1 — per-asset failures (optional on older artifacts). */
  failures: z.array(VisualFailureSchema).optional(),
  byKind: z
    .object({
      serpSnapshots: z.number().int().nonnegative().optional(),
      suggestionPanels: z.number().int().nonnegative().optional(),
      relatedPanels: z.number().int().nonnegative().optional(),
      aiPanels: z.number().int().nonnegative().optional(),
      imageGrids: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const EmptySlideSchema = z.object({
  slotId: z.string().min(1),
  reason: z.string().min(1),
});

const ArsenkinAgentSchema = z.object({
  name: z.string().min(1),
  terminalKind: z.string().nullable(),
  observationCount: z.number().int().nonnegative(),
});

/** REMEDIATION §6.2 — soft sidebar degrade / render warnings from golden-render-meta. */
const RenderSchema = z.object({
  pdfExportMode: z.string().nullable(),
  warningCount: z.number().int().nonnegative(),
  sidebarDegradedCount: z.number().int().nonnegative(),
  warnings: z.array(z.string()).max(40),
});

export const ReportQualitySummarySchema = z.object({
  version: z.literal(REPORT_QUALITY_SUMMARY_VERSION),
  caseId: z.string().min(1),
  unifiedJobId: z.string().nullable(),
  generatedAt: z.string().min(1),
  counts: z.object({
    dbSearchResults: z.number().int().nonnegative().nullable(),
    dbSurfaceItems: z.number().int().nonnegative().nullable(),
    /** Delta + corpus (total expected base IDs). */
    manifestIds: z.number().int().nonnegative().nullable(),
    /** Job delta only (REMEDIATION §1.1). */
    manifestDeltaCount: z.number().int().nonnegative().nullable(),
    /** Pre-existing case corpus not in the delta. */
    manifestCorpusCount: z.number().int().nonnegative().nullable(),
    compositeObservations: z.number().int().nonnegative().nullable(),
    subjectMatch: z.number().int().nonnegative().nullable(),
    likelySubject: z.number().int().nonnegative().nullable(),
    ambiguous: z.number().int().nonnegative().nullable(),
    otherSubject: z.number().int().nonnegative().nullable(),
    insufficient: z.number().int().nonnegative().nullable(),
    verifiedFindings: z.number().int().nonnegative().nullable(),
    ambiguousFindings: z.number().int().nonnegative().nullable(),
    /** Applied analyst overrides (§1.3). */
    appliedOverrides: z.number().int().nonnegative().nullable(),
  }),
  gpt: z.object({
    stage1: GptStage1Schema,
    stage2: GptStage2Schema,
  }),
  visuals: VisualsSchema,
  slides: z.object({
    total: z.number().int().nonnegative(),
    withContent: z.number().int().nonnegative(),
    emptyState: z.array(EmptySlideSchema),
  }),
  arsenkin: z.object({
    agents: z.array(ArsenkinAgentSchema),
    enrichmentComplete: z.boolean().nullable(),
    enrichmentObservationCount: z.number().int().nonnegative().nullable(),
  }),
  render: RenderSchema,
});

export type ReportQualitySummary = z.infer<typeof ReportQualitySummarySchema>;

/** Compact job-status payload (same shape, no heavy empty-state lists truncated). */
export type JobReportQuality = {
  version: typeof REPORT_QUALITY_SUMMARY_VERSION;
  generatedAt: string;
  counts: ReportQualitySummary["counts"];
  gpt: {
    stage1Status: ReportQualitySummary["gpt"]["stage1"]["status"];
    stage1Reason?: string;
    stage2Applied: number;
    stage2NoChanges: number;
    stage2SkippedCached: number;
    stage2SkippedDeterministic: number;
    stage2FallbackError: number;
    stage2FallbackValidation: number;
    caseAnalysisUsed: boolean;
  };
  visuals: { built: number; failed: number; warning: string | null };
  slides: {
    total: number;
    withContent: number;
    emptyStateCount: number;
    /** Empty-state slots for the operator quality panel (REMEDIATION §0.4). */
    emptyState: Array<{ slotId: string; reason: string }>;
  };
  arsenkin: {
    enrichmentComplete: boolean | null;
    enrichmentObservationCount: number | null;
    agentsOk: number;
    agentsFailed: number;
  };
  /** REMEDIATION §6.2 */
  render: {
    pdfExportMode: string | null;
    warningCount: number;
    sidebarDegradedCount: number;
  };
};

/** Optional Prisma-like counts for live DB funnel numbers. */
export type ReportQualityPrismaCounts = {
  searchResult: { count: (args: { where: { caseId: string } }) => Promise<number> };
  searchSurfaceItem: { count: (args: { where: { caseId: string } }) => Promise<number> };
};

/** Артефакт джобы, которого может не быть (голден, фикстуры): тогда — null. */
export function readJsonSafe<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function countByDecision(
  items: Array<{ decision?: string }> | undefined
): Pick<
  ReportQualitySummary["counts"],
  "subjectMatch" | "likelySubject" | "ambiguous" | "otherSubject" | "insufficient"
> {
  let subjectMatch = 0;
  let likelySubject = 0;
  let ambiguous = 0;
  let otherSubject = 0;
  let insufficient = 0;
  for (const it of items ?? []) {
    switch (it.decision) {
      case "SUBJECT_MATCH":
        subjectMatch += 1;
        break;
      case "LIKELY_SUBJECT":
        likelySubject += 1;
        break;
      case "AMBIGUOUS":
        ambiguous += 1;
        break;
      case "OTHER_SUBJECT":
        otherSubject += 1;
        break;
      case "INSUFFICIENT_IDENTIFIERS":
        insufficient += 1;
        break;
      default:
        break;
    }
  }
  return { subjectMatch, likelySubject, ambiguous, otherSubject, insufficient };
}

function aggregateGptStage2(
  report: {
    caseAnalysisUsed?: boolean;
    fragments?: Array<{ status?: string; rejectedFields?: string[] }>;
  } | null
): ReportQualitySummary["gpt"]["stage2"] {
  const empty: ReportQualitySummary["gpt"]["stage2"] = {
    applied: 0,
    noChanges: 0,
    skippedDeterministic: 0,
    skippedEmpty: 0,
    skippedCached: 0,
    fallbackError: 0,
    fallbackValidation: 0,
    rejectedFieldsTop: [],
    caseAnalysisUsed: Boolean(report?.caseAnalysisUsed),
  };
  if (!report?.fragments) return empty;

  const rejectedFreq = new Map<string, number>();
  for (const f of report.fragments) {
    switch (f.status) {
      case "APPLIED":
        empty.applied += 1;
        break;
      case "NO_CHANGES":
        empty.noChanges += 1;
        break;
      case "SKIPPED_DETERMINISTIC":
        empty.skippedDeterministic += 1;
        break;
      case "SKIPPED_EMPTY":
        empty.skippedEmpty += 1;
        break;
      case "SKIPPED_CACHED":
        empty.skippedCached += 1;
        break;
      case "FALLBACK_ERROR":
      case "FALLBACK_TIMEOUT":
        empty.fallbackError += 1;
        break;
      case "FALLBACK_VALIDATION":
        empty.fallbackValidation += 1;
        break;
      default:
        break;
    }
    for (const r of f.rejectedFields ?? []) {
      const key = String(r).split(":")[0] ?? String(r);
      rejectedFreq.set(key, (rejectedFreq.get(key) ?? 0) + 1);
    }
  }
  empty.rejectedFieldsTop = [...rejectedFreq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([k, n]) => `${k}×${n}`);
  return empty;
}

function slideHasContent(slide: {
  narrative?: string;
  bullets?: string[];
  table?: { rows?: unknown[] };
  whatWasFound?: string;
  visualAssetRefs?: string[];
  kpis?: unknown[];
  keyFindings?: unknown[];
}): boolean {
  if (slide.narrative?.trim()) return true;
  if ((slide.bullets ?? []).some((b) => String(b).trim())) return true;
  if ((slide.table?.rows?.length ?? 0) > 0) return true;
  if (slide.whatWasFound?.trim()) return true;
  if ((slide.visualAssetRefs ?? []).length > 0) return true;
  if ((slide.kpis ?? []).length > 0) return true;
  if ((slide.keyFindings ?? []).length > 0) return true;
  return false;
}

/**
 * Aggregate funnel metrics from a prepared job artifact directory.
 * Prisma counts are optional — offline fixtures leave them null.
 */
export async function buildReportQualitySummary(input: {
  jobDir: string;
  caseId: string;
  unifiedJobId?: string | null;
  prisma?: ReportQualityPrismaCounts | null;
}): Promise<ReportQualitySummary> {
  const dir = input.jobDir;

  const manifest = readJsonSafe<{
    searchResultIds?: string[];
    searchSurfaceItemIds?: string[];
    caseCorpusSearchResultIds?: string[];
    caseCorpusSurfaceItemIds?: string[];
    baseCount?: number;
  }>(join(dir, "base-collection-manifest.json"));

  // Prefer analytics/ copies (same source as the deck KPI) over job-root
  // snapshots that can lag or diverge after partial rebuilds.
  const composite =
    readJsonSafe<{
      observations?: Array<{
        observationKey?: string;
        key?: string;
        evidenceRefs?: string[]
      }>;
      compositeCount?: number;
    }>(join(dir, "analytics", "composite-serp-observations.json")) ??
    readJsonSafe<{
      observations?: Array<{
        observationKey?: string;
        key?: string;
        evidenceRefs?: string[]
      }>;
      compositeCount?: number;
    }>(join(dir, "composite-serp-observations.json"));

  const subjectResolution = readJsonSafe<{
    items?: Array<{ evidenceRef?: string; decision?: string }>;
  }>(join(dir, "analytics", "subject-resolution.json"));

  const provenance =
    readJsonSafe<{
      entries?: Array<{ observationKey?: string; evidenceRefs?: string[] }>;
    }>(join(dir, "analytics", "composite-serp-provenance.json")) ??
    readJsonSafe<{
      entries?: Array<{ observationKey?: string; evidenceRefs?: string[] }>;
    }>(join(dir, "composite-serp-provenance.json"));

  const verifiedBundle = readJsonSafe<{ findings?: unknown[] }>(
    join(dir, "analytics", "verified-finding-bundle.json")
  );
  const ambiguousFindings = readJsonSafe<unknown[]>(
    join(dir, "analytics", "ambiguous-findings.json")
  );

  const gptAnalysis = readJsonSafe<{ overallRiskLevel?: string }>(
    join(dir, "analytics", "gpt-case-analysis.json")
  );
  const gptDiagnostics = readJsonSafe<{ status?: string; reason?: string }>(
    join(dir, "analytics", "gpt-case-analysis-diagnostics.json")
  );

  const gptCopy = readJsonSafe<{
    caseAnalysisUsed?: boolean;
    fragments?: Array<{ status?: string; rejectedFields?: string[] }>;
  }>(join(dir, "deck", "gpt-report-copy.json"));

  const visualsMeta = readJsonSafe<{
    counts?: {
      serpSnapshots?: number;
      suggestionPanels?: number;
      relatedPanels?: number;
      aiPanels?: number;
      imageGrids?: number;
    };
    visualAssets?: Record<string, unknown[]>;
    failed?: Array<{ kind?: string; slotId?: string; assetRef?: string; reason?: string }>;
  }>(join(dir, "visual-assets-by-slot.json"));

  const prepareSummary = readJsonSafe<{
    visualAssetCount?: number;
    visualAssetWarning?: string | null;
  }>(join(dir, "canonical-prepare-summary.json"));

  const assembled = readJsonSafe<{
    slides?: Array<{
      baseSlotId?: string;
      slideKey?: string;
      emptyStateReason?: string;
      narrative?: string;
      bullets?: string[];
      table?: { rows?: unknown[] };
      whatWasFound?: string;
      visualAssetRefs?: string[];
      kpis?: unknown[];
      keyFindings?: unknown[];
    }>;
  }>(join(dir, "deck", "assembled-deck.json"));

  const arsenkin = readJsonSafe<{
    agents?: Array<{
      agentName?: string;
      terminalKind?: string | null;
      observationCount?: number;
    }>;
    enrichmentComplete?: boolean;
    enrichmentObservationCount?: number;
  }>(join(dir, "arsenkin-enrichment-state.json"));

  const renderMeta = readJsonSafe<{
    pdfExportMode?: string;
    warnings?: string[];
  }>(join(dir, "render", "golden-render-meta.json"));

  let dbSearchResults: number | null = null;
  let dbSurfaceItems: number | null = null;
  if (input.prisma) {
    try {
      dbSearchResults = await input.prisma.searchResult.count({
        where: { caseId: input.caseId },
      });
      dbSurfaceItems = await input.prisma.searchSurfaceItem.count({
        where: { caseId: input.caseId },
      });
    } catch {
      dbSearchResults = null;
      dbSurfaceItems = null;
    }
  }

  const manifestDeltaCount =
    manifest == null
      ? null
      : (manifest.searchResultIds?.length ?? 0) + (manifest.searchSurfaceItemIds?.length ?? 0);
  const manifestCorpusCount =
    manifest == null
      ? null
      : (manifest.caseCorpusSearchResultIds?.length ?? 0) +
        (manifest.caseCorpusSurfaceItemIds?.length ?? 0);
  const manifestIds =
    manifest == null
      ? null
      : (manifestDeltaCount ?? 0) + (manifestCorpusCount ?? 0);

  const compositeObservations =
    composite == null
      ? null
      : typeof composite.compositeCount === "number"
        ? composite.compositeCount
        : (composite.observations?.length ?? 0);

  // Prefer observation-scoped identity (same unit as compositeCount) when
  // provenance/obs refs join to inventory decisions — avoids KPI inflation.
  let identity: Pick<
    ReportQualitySummary["counts"],
    "subjectMatch" | "likelySubject" | "ambiguous" | "otherSubject" | "insufficient"
  > = {
    subjectMatch: null,
    likelySubject: null,
    ambiguous: null,
    otherSubject: null,
    insufficient: null,
  };
  if (subjectResolution?.items) {
    const inventoryIdentity = countByDecision(subjectResolution.items);
    identity = inventoryIdentity;
    const decisionByRef = new Map(
      subjectResolution.items
        .filter((i): i is { evidenceRef: string; decision: string } =>
          Boolean(i.evidenceRef && i.decision)
        )
        .map((i) => [i.evidenceRef, i.decision] as const)
    );
    const provByKey = new Map(
      (provenance?.entries ?? [])
        .filter((e) => e.observationKey)
        .map((e) => [e.observationKey!, e.evidenceRefs ?? []] as const)
    );
    const obs = composite?.observations ?? [];
    if (decisionByRef.size > 0 && obs.length > 0) {
      const groups = obs.map((o) => {
        const obsKey = o.observationKey ?? o.key;
        const fromProv = obsKey ? provByKey.get(obsKey) : undefined;
        return fromProv && fromProv.length > 0 ? fromProv : (o.evidenceRefs ?? []);
      });
      const byObs = countIdentityByObservation({
        observationRefGroups: groups,
        decisionByRef,
      });
      const joined =
        byObs.subjectMatchCount +
        byObs.likelySubjectCount +
        byObs.ambiguousCount +
        byObs.otherSubjectCount;
      // Only switch when provenance/obs refs actually join — otherwise keep
      // inventory tallies (offline fixtures without linked refs).
      if (joined > 0) {
        identity = {
          subjectMatch: byObs.subjectMatchCount,
          likelySubject: byObs.likelySubjectCount,
          ambiguous: byObs.ambiguousCount,
          otherSubject: byObs.otherSubjectCount,
          insufficient: inventoryIdentity.insufficient,
        };
      }
    }
  }

  const overridesApplied = readJsonSafe<{ count?: number; applied?: unknown[] }>(
    join(dir, "analytics", "analyst-overrides-applied.json")
  );
  const appliedOverrides =
    overridesApplied == null
      ? null
      : typeof overridesApplied.count === "number"
        ? overridesApplied.count
        : Array.isArray(overridesApplied.applied)
          ? overridesApplied.applied.length
          : 0;

  let stage1: ReportQualitySummary["gpt"]["stage1"];
  if (gptAnalysis) {
    stage1 = { status: "APPLIED" };
  } else if (gptDiagnostics?.status === "FAILED") {
    stage1 = { status: "FAILED", reason: gptDiagnostics.reason ?? "unknown" };
  } else if (gptCopy && gptCopy.caseAnalysisUsed === false && !gptAnalysis) {
    stage1 = { status: "FAILED", reason: gptDiagnostics?.reason ?? "caseAnalysisUsed:false" };
  } else if (!gptCopy && !gptAnalysis && !gptDiagnostics) {
    stage1 = { status: "SKIPPED" };
  } else {
    stage1 = { status: "MISSING" };
  }

  const stage2 = aggregateGptStage2(gptCopy);

  const byKind = visualsMeta?.counts;
  const builtFromKinds = byKind
    ? (byKind.serpSnapshots ?? 0) +
      (byKind.suggestionPanels ?? 0) +
      (byKind.relatedPanels ?? 0) +
      (byKind.aiPanels ?? 0) +
      (byKind.imageGrids ?? 0)
    : null;
  const built =
    typeof prepareSummary?.visualAssetCount === "number"
      ? prepareSummary.visualAssetCount
      : (builtFromKinds ?? 0);
  const warning = prepareSummary?.visualAssetWarning ?? null;
  const failures = (visualsMeta?.failed ?? [])
    .filter((f) => f?.slotId && f?.reason)
    .map((f) => ({
      kind: String(f.kind ?? "visual"),
      slotId: String(f.slotId),
      assetRef: String(f.assetRef ?? f.slotId),
      reason: String(f.reason),
    }));
  // Prefer granular §5.1 failures; fall back to one opaque warning from prepare.
  const failed = failures.length > 0 ? failures.length : warning ? 1 : 0;

  const slides = assembled?.slides ?? [];
  const emptyState = slides
    .filter((s) => Boolean(s.emptyStateReason))
    .map((s) => ({
      slotId: s.baseSlotId || s.slideKey || "unknown",
      reason: String(s.emptyStateReason),
    }));
  const withContent = slides.filter((s) => slideHasContent(s) && !s.emptyStateReason).length;

  const agents = (arsenkin?.agents ?? []).map((a) => ({
    name: String(a.agentName ?? "unknown"),
    terminalKind: a.terminalKind ?? null,
    observationCount: a.observationCount ?? 0,
  }));

  const renderWarnings = Array.isArray(renderMeta?.warnings)
    ? renderMeta!.warnings!.map((w) => String(w)).filter(Boolean)
    : [];
  const sidebarDegradedCount = renderWarnings.filter((w) => w.startsWith("sidebar-qa:")).length;
  const renderBlock = {
    pdfExportMode: renderMeta?.pdfExportMode ?? null,
    warningCount: renderWarnings.length,
    sidebarDegradedCount,
    warnings: renderWarnings.slice(0, 40),
  };

  const summary: ReportQualitySummary = {
    version: REPORT_QUALITY_SUMMARY_VERSION,
    caseId: input.caseId,
    unifiedJobId: input.unifiedJobId ?? null,
    generatedAt: new Date().toISOString(),
    counts: {
      dbSearchResults,
      dbSurfaceItems,
      manifestIds,
      manifestDeltaCount,
      manifestCorpusCount,
      compositeObservations,
      subjectMatch: identity.subjectMatch,
      likelySubject: identity.likelySubject,
      ambiguous: identity.ambiguous,
      otherSubject: identity.otherSubject,
      insufficient: identity.insufficient,
      verifiedFindings: verifiedBundle?.findings?.length ?? null,
      ambiguousFindings: Array.isArray(ambiguousFindings) ? ambiguousFindings.length : null,
      appliedOverrides,
    },
    gpt: { stage1, stage2 },
    visuals: {
      built,
      failed,
      warning,
      failures: failures.length > 0 ? failures : undefined,
      byKind: byKind
        ? {
            serpSnapshots: byKind.serpSnapshots ?? 0,
            suggestionPanels: byKind.suggestionPanels ?? 0,
            relatedPanels: byKind.relatedPanels ?? 0,
            aiPanels: byKind.aiPanels ?? 0,
            imageGrids: byKind.imageGrids ?? 0,
          }
        : undefined,
    },
    slides: {
      total: slides.length,
      withContent,
      emptyState,
    },
    arsenkin: {
      agents,
      enrichmentComplete: arsenkin?.enrichmentComplete ?? null,
      enrichmentObservationCount: arsenkin?.enrichmentObservationCount ?? null,
    },
    render: renderBlock,
  };

  return ReportQualitySummarySchema.parse(summary);
}

export function toJobReportQuality(summary: ReportQualitySummary): JobReportQuality {
  const agentsFailed = summary.arsenkin.agents.filter(
    (a) => a.terminalKind === "FAILED" || a.terminalKind === "SUBMIT_UNKNOWN_UNRECONCILED"
  ).length;
  const agentsOk = summary.arsenkin.agents.filter(
    (a) =>
      a.terminalKind != null &&
      a.terminalKind !== "FAILED" &&
      a.terminalKind !== "SUBMIT_UNKNOWN_UNRECONCILED"
  ).length;
  return {
    version: REPORT_QUALITY_SUMMARY_VERSION,
    generatedAt: summary.generatedAt,
    counts: summary.counts,
    gpt: {
      stage1Status: summary.gpt.stage1.status,
      ...(summary.gpt.stage1.reason ? { stage1Reason: summary.gpt.stage1.reason } : {}),
      stage2Applied: summary.gpt.stage2.applied,
      stage2NoChanges: summary.gpt.stage2.noChanges,
      stage2SkippedCached: summary.gpt.stage2.skippedCached,
      stage2SkippedDeterministic: summary.gpt.stage2.skippedDeterministic,
      stage2FallbackError: summary.gpt.stage2.fallbackError,
      stage2FallbackValidation: summary.gpt.stage2.fallbackValidation,
      caseAnalysisUsed: summary.gpt.stage2.caseAnalysisUsed,
    },
    visuals: {
      built: summary.visuals.built,
      failed: summary.visuals.failed,
      warning: summary.visuals.warning,
    },
    slides: {
      total: summary.slides.total,
      withContent: summary.slides.withContent,
      emptyStateCount: summary.slides.emptyState.length,
      emptyState: summary.slides.emptyState.map((e) => ({
        slotId: e.slotId,
        reason: e.reason,
      })),
    },
    arsenkin: {
      enrichmentComplete: summary.arsenkin.enrichmentComplete,
      enrichmentObservationCount: summary.arsenkin.enrichmentObservationCount,
      agentsOk,
      agentsFailed,
    },
    render: {
      pdfExportMode: summary.render.pdfExportMode,
      warningCount: summary.render.warningCount,
      sidebarDegradedCount: summary.render.sidebarDegradedCount,
    },
  };
}

/**
 * Map funnel degradations to machine-readable job.warnings (REMEDIATION §0.2).
 * Does not change error codes or fail-closed gates — observability only.
 */
export function buildReportQualityWarnings(
  summary: ReportQualitySummary | JobReportQuality,
  extras?: { visualAssetWarning?: string | null }
): string[] {
  const out: string[] = [];

  const visualWarning =
    extras?.visualAssetWarning ??
    ("visuals" in summary ? summary.visuals.warning : null);
  if (visualWarning && String(visualWarning).trim()) {
    const msg = String(visualWarning).trim().slice(0, 240);
    out.push(msg.startsWith("visual-asset-warning:") ? msg : `visual-asset-warning:${msg}`);
  }

  const stage1Status =
    "gpt" in summary && "stage1" in summary.gpt
      ? (summary as ReportQualitySummary).gpt.stage1.status
      : (summary as JobReportQuality).gpt.stage1Status;
  const stage1Reason =
    "gpt" in summary && "stage1" in summary.gpt
      ? (summary as ReportQualitySummary).gpt.stage1.reason
      : (summary as JobReportQuality).gpt.stage1Reason;
  if (stage1Status === "FAILED") {
    const reason = (stage1Reason ?? "unknown").replace(/\s+/g, " ").trim().slice(0, 160);
    out.push(`gpt-stage1-fallback:${reason}`);
  }

  const stage2Fallback =
    "gpt" in summary && "stage2" in summary.gpt
      ? (summary as ReportQualitySummary).gpt.stage2.fallbackError +
        (summary as ReportQualitySummary).gpt.stage2.fallbackValidation
      : (summary as JobReportQuality).gpt.stage2FallbackError +
        (summary as JobReportQuality).gpt.stage2FallbackValidation;
  const stage2Attempted =
    "gpt" in summary && "stage2" in summary.gpt
      ? (() => {
          const s2 = (summary as ReportQualitySummary).gpt.stage2;
          return (
            s2.applied +
            s2.noChanges +
            s2.fallbackError +
            s2.fallbackValidation +
            s2.skippedCached
          );
        })()
      : (summary as JobReportQuality).gpt.stage2Applied +
        (summary as JobReportQuality).gpt.stage2FallbackError +
        (summary as JobReportQuality).gpt.stage2FallbackValidation;
  if (stage2Fallback > 0) {
    out.push(`gpt-stage2-fallback:${stage2Fallback}/${Math.max(stage2Attempted, stage2Fallback)}`);
  }

  const emptyCount =
    "slides" in summary && "emptyState" in summary.slides
      ? (summary as ReportQualitySummary).slides.emptyState.length
      : (summary as JobReportQuality).slides.emptyStateCount;
  if (emptyCount > 0) {
    out.push(`empty-state-slides:${emptyCount}`);
  }

  const sidebarDegraded =
    "render" in summary
      ? summary.render.sidebarDegradedCount
      : 0;
  if (sidebarDegraded > 0) {
    out.push(`sidebar-degraded:${sidebarDegraded}`);
  }

  return out;
}

/** Merge quality warnings into an existing list without duplicates (prefix-stable). */
export function mergeJobWarnings(existing: string[], qualityWarnings: string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const w of qualityWarnings) {
    // Replace prior warning with the same machine prefix (e.g. gpt-stage1-fallback:*).
    const prefix = w.includes(":") ? `${w.split(":")[0]}:` : w;
    const isPrefixed =
      prefix.startsWith("visual-asset-warning:") ||
      prefix.startsWith("gpt-stage1-fallback:") ||
      prefix.startsWith("gpt-stage2-fallback:") ||
      prefix.startsWith("empty-state-slides:") ||
      prefix.startsWith("sidebar-degraded:");
    if (isPrefixed) {
      for (let i = out.length - 1; i >= 0; i -= 1) {
        if (out[i]!.startsWith(prefix)) {
          seen.delete(out[i]!);
          out.splice(i, 1);
        }
      }
    }
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}
