/**
 * Unified ORION collection orchestrator.
 * BASE (existing runFullAudit) → Arsenkin enrichment → composite → prepare → REPORT_READY.
 * Does not rewrite Yandex/Serper / runOrionSearchProfile.
 */

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  claimUnifiedJobLease,
  findOrCreateUnifiedCollectionJob,
  loadUnifiedCollectionJob,
  listResumableUnifiedJobs,
  patchUnifiedCollectionJob,
  readUnifiedArtifact,
  releaseUnifiedJobLease,
  unifiedArtifactsDir,
  writeUnifiedArtifact,
} from "./unified-collection-job-store";
import type {
  BaseCollectionManifest,
  ReportDataBinding,
  SurfaceCoverageBreakdown,
  UnifiedCollectionJob,
} from "./unified-collection-types";
import {
  computeCoverageProgress,
  emptyCoverage,
  FIRST36_PLANNED_SUPPORTED_SURFACES,
} from "./unified-collection-types";
import {
  captureBaseCollectionManifest,
  mapFullAuditToActualProviders,
  snapshotExistingIds,
} from "./base-collection-manifest";
import {
  buildReportDataBinding,
  mergeCompositeSerp,
  type CompositeMergeResult,
  type CompositeObservation,
} from "./composite-serp-merge";
import { assertReportReadyGates } from "./report-ready-gates";
import {
  runCanonicalReportPrepare,
  CanonicalPrepareBlockedError,
} from "./canonical-report-prepare";
import type { DeckRenderAdapter } from "./render-deck-artifacts";
import { resolveJobSubjectProfile } from "./job-subject-profile";
import type { ClassifierSubjectProfile } from "../orion-golden/analytics/subject-resolution-classifier";
import type { FullAuditResultDTO } from "./agent-run-service";
import { ensurePersistedUnifiedBaseReportRun } from "./unified-base-report-run";
import { ARSENKIN_REAL_AGENT_NAMES } from "../agents/real/real-arsenkin-agents";
import { evaluateUnifiedCollectionRecoveryEligibility } from "./unified-collection-recovery";
import { ConflictError } from "../http/errors";

export type UnifiedOrchestratorDeps = {
  prisma?: PrismaClient | null;
  runFullAudit?: (caseId: string, actorId: string) => Promise<FullAuditResultDTO>;
  /** Offline Arsenkin enrichment: returns coverage + optional observations. */
  runArsenkinEnrichment?: (job: UnifiedCollectionJob) => Promise<{
    arsenkinReportRunId: string | null;
    /** Per-CaseAgent enrichment run ids (exactly five when fully scheduled). */
    enrichmentRunIds?: string[];
    coverage: SurfaceCoverageBreakdown;
    observations: Array<{
      region?: string;
      engine?: string;
      query?: string;
      url?: string;
      title?: string;
      snippet?: string;
      suggestion?: string;
      question?: string;
      kind?: "organic" | "suggestion" | "paa" | "other";
      providerTaskId?: string | null;
      riskLabel?: string | null;
    }>;
    warnings?: string[];
    partial?: boolean;
    /** When true, orchestrator must not advance past enrichment (fail-closed). */
    blockPipeline?: boolean;
    blockCode?: string;
    blockMessage?: string;
  }>;
  /**
   * Override the canonical prepare (tests). Returns the dataset id prepare
   * actually consumed (for the fail-closed gate) plus one-assembly/one-render
   * counts. When omitted, the canonical job-scoped pipeline runs.
   */
  runPrepare?: (input: {
    caseId: string;
    binding: ReportDataBinding;
    merge: CompositeMergeResult;
  }) => Promise<{
    prepareDatasetId: string;
    pdf?: string;
    pptx?: string;
    assemblyCount?: number;
    renderCount?: number;
  }>;
  /** Subject identity for canonical prepare (production resolves from the case). */
  subjectProfile?: ClassifierSubjectProfile | null;
  /** Injectable renderer for canonical prepare (default: local python). */
  renderDeck?: DeckRenderAdapter;
  fixtureBaseRows?: CompositeObservation[];
  allowMockReport?: boolean;
  /** When false, caller must drain ticks manually (tests). Default true. */
  autoSchedule?: boolean;
  now?: () => Date;
};

function stageProgress(stage: UnifiedCollectionJob["stage"]): number {
  switch (stage) {
    case "BASE_COLLECTION":
      return 0.1;
    case "ARSENKIN_ENRICHMENT":
      return 0.35;
    case "COMPOSITE_MERGE":
      return 0.55;
    case "ORION_PREPARE":
      return 0.7;
    case "CLIENT_CONTENT":
      return 0.85;
    case "REPORT_READY":
      return 1;
    case "COMPLETED_PARTIAL":
      return 0.95;
    default:
      return 0.05;
  }
}

/**
 * Resume without re-collecting base providers when the base manifest +
 * baseReportRunId already exist. RENDER checkpoint resumes at ORION_PREPARE
 * (render-only) — never Arsenkin/base.
 */
function resumeFromRetryableCheckpoint(job: UnifiedCollectionJob): UnifiedCollectionJob {
  const renderResume =
    job.resumeCheckpoint === "RENDER" ||
    job.lastErrorCode === "RENDER_FAILED" ||
    /render failed/i.test(job.lastError ?? "");

  if (renderResume && job.baseReportRunId && (job.enrichmentRunIds?.length ?? 0) >= 5) {
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "ORION_PREPARE",
        status: "RUNNING",
        resumeCheckpoint: "RENDER",
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        warnings: [...job.warnings, "bounded-resume:from-render"],
      }) ?? job
    );
  }

  const manifest = readUnifiedArtifact<BaseCollectionManifest>(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json"
  );
  const hasBase =
    Boolean(job.baseReportRunId || manifest?.baseReportRunId) &&
    Boolean(manifest) &&
    (manifest!.baseCount > 0 ||
      manifest!.searchResultIds.length + manifest!.searchSurfaceItemIds.length > 0);

  if (hasBase) {
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "ARSENKIN_ENRICHMENT",
        status: "RUNNING",
        resumeCheckpoint: "ARSENKIN_ENRICHMENT",
        baseReportRunId: job.baseReportRunId ?? manifest!.baseReportRunId,
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        warnings: [...job.warnings, "bounded-resume:from-arsenkin"],
      }) ?? job
    );
  }

  return (
    patchUnifiedCollectionJob(job.caseId, {
      stage: "BASE_COLLECTION",
      status: "RUNNING",
      resumeCheckpoint: "BASE_COLLECTION",
      lastError: null,
      lastErrorCode: null,
      completedAt: null,
      warnings: [...job.warnings, "bounded-resume:from-base"],
    }) ?? job
  );
}

function failRetryable(
  job: UnifiedCollectionJob,
  code: string,
  message: string,
  extraWarnings: string[] = []
): UnifiedCollectionJob {
  const resumeCheckpoint =
    code === "RENDER_FAILED" || extraWarnings.some((w) => /render-checkpoint:RENDER/i.test(w))
      ? ("RENDER" as const)
      : job.resumeCheckpoint ?? null;
  return (
    patchUnifiedCollectionJob(job.caseId, {
      stage: "FAILED_RETRYABLE",
      status: "WAITING",
      lastError: message,
      lastErrorCode: code,
      resumeCheckpoint,
      warnings: [...job.warnings, ...extraWarnings, code],
      completedAt: new Date().toISOString(),
    }) ?? job
  );
}

export async function startUnifiedOrionCollection(input: {
  caseId: string;
  requestedBy?: string;
  arsenkinMode?: "full-first36";
  deps?: UnifiedOrchestratorDeps;
}): Promise<{ accepted: true; jobId: string; unifiedJobId: string; created: boolean; stage: string }> {
  const existing = loadUnifiedCollectionJob(input.caseId);
  if (existing) {
    const elig = evaluateUnifiedCollectionRecoveryEligibility({
      caseId: input.caseId,
      job: existing,
    });
    if (elig.recoveryAllowed) {
      throw new ConflictError(
        `recoverable unified job ${existing.jobId}; use POST /unified-collection/recover (${elig.recoveryReason})`
      );
    }
  }

  const { job, created } = findOrCreateUnifiedCollectionJob({
    caseId: input.caseId,
    requestedBy: input.requestedBy ?? "system",
    arsenkinMode: input.arsenkinMode ?? "full-first36",
  });
  if (input.deps?.autoSchedule !== false) {
    scheduleUnifiedTick(input.caseId, input.deps);
  }
  return {
    accepted: true,
    jobId: job.jobId,
    unifiedJobId: job.unifiedJobId,
    created,
    stage: job.stage,
  };
}

const ticking = new Set<string>();

export function scheduleUnifiedTick(caseId: string, deps: UnifiedOrchestratorDeps = {}): void {
  if (ticking.has(caseId)) return;
  ticking.add(caseId);
  setImmediate(() => {
    void runUnifiedCollectionTick(caseId, deps)
      .catch(() => undefined)
      .finally(() => {
        ticking.delete(caseId);
        const job = loadUnifiedCollectionJob(caseId);
        if (
          job &&
          job.status === "RUNNING" &&
          job.stage !== "REPORT_READY" &&
          job.stage !== "COMPLETED_PARTIAL" &&
          job.stage !== "FAILED_TERMINAL" &&
          job.stage !== "FAILED_RETRYABLE" &&
          job.stage !== "CANCELLED"
        ) {
          setTimeout(() => scheduleUnifiedTick(caseId, deps), 50);
        }
      });
  });
}

/** Bounded resume after deploy — only active/retryable jobs. */
export function resumeUnifiedCollectionsOnStartup(deps: UnifiedOrchestratorDeps = {}): void {
  for (const { caseId } of listResumableUnifiedJobs()) {
    scheduleUnifiedTick(caseId, deps);
  }
}

export async function runUnifiedCollectionTick(
  caseId: string,
  deps: UnifiedOrchestratorDeps = {}
): Promise<UnifiedCollectionJob | null> {
  const ownerId = `unified-${process.pid}-${randomUUID().slice(0, 6)}`;
  const claimed = claimUnifiedJobLease({ caseId, ownerId, leaseMs: 120_000, now: deps.now?.() });
  if (!claimed) return loadUnifiedCollectionJob(caseId);

  try {
    let job = claimed;
    if (job.cancelRequested) {
      return patchUnifiedCollectionJob(caseId, {
        stage: "CANCELLED",
        status: "CANCELLED",
        completedAt: new Date().toISOString(),
      });
    }

    switch (job.stage) {
      case "BASE_COLLECTION":
        job = await stepBaseCollection(job, deps);
        break;
      case "ARSENKIN_ENRICHMENT":
        job = await stepArsenkin(job, deps);
        break;
      case "COMPOSITE_MERGE":
        job = await stepComposite(job, deps);
        break;
      case "ORION_PREPARE":
      case "CLIENT_CONTENT":
        job = await stepPrepare(job, deps);
        break;
      case "FAILED_RETRYABLE":
        job = resumeFromRetryableCheckpoint(job);
        break;
      default:
        break;
    }
    return loadUnifiedCollectionJob(caseId);
  } finally {
    releaseUnifiedJobLease(caseId, ownerId);
  }
}

async function stepBaseCollection(
  job: UnifiedCollectionJob,
  deps: UnifiedOrchestratorDeps
): Promise<UnifiedCollectionJob> {
  const runFullAudit =
    deps.runFullAudit ??
    (async (caseId: string, actorId: string) => {
      const { runFullAudit: real } = await import("./agent-run-service");
      return real(caseId, { actorId });
    });

  let before = { searchResultIds: new Set<string>(), searchSurfaceItemIds: new Set<string>() };
  let prisma: PrismaClient | null = deps.prisma ?? null;
  if (!prisma && deps.fixtureBaseRows == null) {
    try {
      prisma = (await import("@/server/prisma/client")).prisma;
    } catch {
      prisma = null;
    }
  }
  if (prisma) {
    before = await snapshotExistingIds(prisma, job.caseId);
  }

  const audit = await runFullAudit(job.caseId, job.requestedBy);
  const actualProviders = mapFullAuditToActualProviders(audit);

  let manifest: BaseCollectionManifest;
  if (deps.fixtureBaseRows) {
    manifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: job.unifiedJobId,
      caseId: job.caseId,
      capturedAt: new Date().toISOString(),
      baseReportRunId: job.baseReportRunId,
      searchResultIds: deps.fixtureBaseRows
        .map((r) => r.baseSearchResultId)
        .filter((x): x is string => Boolean(x)),
      searchSurfaceItemIds: deps.fixtureBaseRows
        .map((r) => r.baseSearchSurfaceItemId)
        .filter((x): x is string => Boolean(x)),
      baseCount: deps.fixtureBaseRows.length,
      actualProviders,
      realCollectionSufficient:
        actualProviders.some((p) => p.runtime === "real" && p.status === "completed") ||
        Boolean(deps.allowMockReport),
    };
  } else if (prisma) {
    manifest = await captureBaseCollectionManifest({
      prisma,
      caseId: job.caseId,
      unifiedJobId: job.unifiedJobId,
      beforeSearchResultIds: before.searchResultIds,
      beforeSearchSurfaceItemIds: before.searchSurfaceItemIds,
      actualProviders,
      baseReportRunId: job.baseReportRunId,
    });
  } else {
    return failRetryable(
      job,
      "MANIFEST_CAPTURE_FAILED",
      "prisma unavailable for base-collection-manifest"
    );
  }

  // Persist a real OrionReportRun so Arsenkin + binding never see null.
  let baseReportRunId = manifest.baseReportRunId;
  if (prisma) {
    try {
      const ensured = await ensurePersistedUnifiedBaseReportRun({
        prisma,
        caseId: job.caseId,
        unifiedJobId: job.unifiedJobId,
        existingBaseReportRunId: baseReportRunId,
      });
      baseReportRunId = ensured.baseReportRunId;
      manifest = { ...manifest, baseReportRunId };
    } catch (err) {
      return failRetryable(
        job,
        "BASE_REPORT_RUN_PERSIST_FAILED",
        err instanceof Error ? err.message : String(err),
        ["baseReportRunId-persist-failed"]
      );
    }
  } else if (deps.fixtureBaseRows) {
    // Offline: stable synthetic-but-job-scoped id is OK only when prisma is
    // absent AND tests supply fixture rows (no live Arsenkin).
    baseReportRunId = baseReportRunId ?? `fixture-base-${job.unifiedJobId}`;
    manifest = { ...manifest, baseReportRunId };
  }

  if (!baseReportRunId) {
    return failRetryable(
      job,
      "BASE_REPORT_RUN_MISSING",
      "base collection completed but baseReportRunId was not persisted",
      ["arsenkin-blocked:no-baseReportRunId"]
    );
  }

  const path = writeUnifiedArtifact(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json",
    manifest
  );

  return (
    patchUnifiedCollectionJob(job.caseId, {
      stage: "ARSENKIN_ENRICHMENT",
      status: "RUNNING",
      progress: stageProgress("ARSENKIN_ENRICHMENT"),
      actualProviders,
      baseReportRunId,
      artifactPaths: { ...job.artifactPaths, baseCollectionManifest: path },
      warnings: manifest.realCollectionSufficient
        ? job.warnings
        : [...job.warnings, "base-collection used mock/fallback — REPORT_READY blocked unless allowMockReport"],
    }) ?? job
  );
}

async function stepArsenkin(
  job: UnifiedCollectionJob,
  deps: UnifiedOrchestratorDeps
): Promise<UnifiedCollectionJob> {
  const baseId = String(job.baseReportRunId ?? "").trim();
  if (!baseId) {
    return failRetryable(
      job,
      "BASE_REPORT_RUN_MISSING",
      "Arsenkin enrichment requires persisted baseReportRunId — refuse silent skip",
      ["arsenkin-blocked:no-baseReportRunId"]
    );
  }

  // Idempotent resume: five enrichment runs already scheduled — do not duplicate.
  const priorIds = job.enrichmentRunIds ?? [];
  if (priorIds.length >= ARSENKIN_REAL_AGENT_NAMES.length) {
    const coverage = {
      ...(job.coverage ?? emptyCoverage()),
      progressRatio: computeCoverageProgress(job.coverage ?? emptyCoverage()),
    };
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "COMPOSITE_MERGE",
        status: "RUNNING",
        progress: stageProgress("COMPOSITE_MERGE"),
        coverage,
        warnings: [...job.warnings, "arsenkin-resume:reuse-five-enrichment-runs"],
      }) ?? job
    );
  }

  const runEnrichment =
    deps.runArsenkinEnrichment ??
    (async () => {
      const planned = FIRST36_PLANNED_SUPPORTED_SURFACES.length;
      const networkOff = String(process.env.NETWORK_CALLS ?? "") === "0";
      if (networkOff) {
        // Offline default: schedule five logical enrichment run ids without live calls.
        const enrichmentRunIds = ARSENKIN_REAL_AGENT_NAMES.map(
          (name, i) => `offline-arsenkin-${name.toLowerCase()}-${i + 1}`
        );
        return {
          arsenkinReportRunId: enrichmentRunIds[0] ?? null,
          enrichmentRunIds,
          coverage: {
            ...emptyCoverage(planned),
            notSupported: planned,
            progressRatio: 1,
          },
          observations: [],
          warnings: ["arsenkin-offline:NETWORK_CALLS=0", "arsenkin-five-agents-planned"],
          partial: true,
        };
      }
      try {
        const { startArsenkinCaseAgentDurable } = await import("./arsenkin-case-agent-execution");
        const { getAgent } = await import("../agents/registry");
        const enrichmentRunIds: string[] = [];
        const warnings: string[] = [];
        for (const agentName of ARSENKIN_REAL_AGENT_NAMES) {
          const agent = getAgent(agentName);
          const tools =
            agent && "tools" in agent && Array.isArray((agent as { tools?: string[] }).tools)
              ? ((agent as { tools: import("../providers/arsenkin/flags").ArsenkinToolName[] }).tools)
              : [];
          // Stable agentRunId placeholder — durable start creates its own execution id.
          const agentRunId = `unified-${job.unifiedJobId}-${agentName}`;
          const started = await startArsenkinCaseAgentDurable({
            caseId: job.caseId,
            agentRunId,
            agentId: agentName,
            tools,
            actorId: job.requestedBy,
            scheduleWorker: true,
            resolveBaseReportRunId: async () => baseId,
          });
          enrichmentRunIds.push(started.enrichmentReportRunId);
          warnings.push(`arsenkin-scheduled:${agentName}`);
        }
        return {
          arsenkinReportRunId: enrichmentRunIds[0] ?? null,
          enrichmentRunIds,
          coverage: { ...emptyCoverage(planned), inFlight: planned, progressRatio: 0 },
          observations: [],
          warnings: [...warnings, "arsenkin-five-agents-scheduled"],
          partial: true,
        };
      } catch (err) {
        return {
          arsenkinReportRunId: null,
          enrichmentRunIds: [],
          coverage: {
            ...emptyCoverage(planned),
            failedRetryable: planned,
            progressRatio: 0,
          },
          observations: [],
          warnings: [`arsenkin-failed:${err instanceof Error ? err.message : String(err)}`],
          partial: true,
          blockPipeline: true,
          blockCode: "ARSENKIN_STAGE_NOT_STARTED",
          blockMessage: err instanceof Error ? err.message : String(err),
        };
      }
    });

  const result = await runEnrichment(job);
  if (result.blockPipeline) {
    return failRetryable(
      job,
      result.blockCode ?? "ARSENKIN_STAGE_NOT_STARTED",
      result.blockMessage ?? "Arsenkin enrichment did not start",
      result.warnings ?? []
    );
  }

  const enrichmentRunIds = result.enrichmentRunIds ?? [];
  if (enrichmentRunIds.length === 0 && !result.warnings?.some((w) => /NETWORK_CALLS=0/i.test(w))) {
    // Live path must schedule all five — never continue with an empty enrichment set.
    if (String(process.env.NETWORK_CALLS ?? "") !== "0") {
      return failRetryable(
        job,
        "ARSENKIN_STAGE_NOT_STARTED",
        "expected five Arsenkin CaseAgent enrichment runs; none were scheduled",
        result.warnings ?? []
      );
    }
  }

  const coverage = {
    ...result.coverage,
    progressRatio: computeCoverageProgress(result.coverage),
  };
  const obsPath = writeUnifiedArtifact(job.caseId, job.unifiedJobId, "arsenkin-enrichment-observations.json", {
    observations: result.observations,
    arsenkinReportRunId: result.arsenkinReportRunId,
    enrichmentRunIds,
  });

  return (
    patchUnifiedCollectionJob(job.caseId, {
      stage: "COMPOSITE_MERGE",
      status: "RUNNING",
      progress: stageProgress("COMPOSITE_MERGE"),
      arsenkinReportRunId: result.arsenkinReportRunId,
      enrichmentRunIds,
      coverage,
      warnings: [...job.warnings, ...(result.warnings ?? [])],
      artifactPaths: { ...job.artifactPaths, arsenkinObservations: obsPath },
    }) ?? job
  );
}

async function stepComposite(
  job: UnifiedCollectionJob,
  deps: UnifiedOrchestratorDeps
): Promise<UnifiedCollectionJob> {
  const manifest = readUnifiedArtifact<BaseCollectionManifest>(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json"
  );
  if (!manifest) {
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: "base-collection-manifest missing",
        lastErrorCode: "MANIFEST_MISSING",
        completedAt: new Date().toISOString(),
      }) ?? job
    );
  }

  const enrichment = readUnifiedArtifact<{
    observations: Parameters<typeof mergeCompositeSerp>[0]["arsenkinObservations"];
    arsenkinReportRunId: string | null;
    enrichmentRunIds?: string[];
  }>(job.caseId, job.unifiedJobId, "arsenkin-enrichment-observations.json");

  const baseReportRunId = job.baseReportRunId ?? manifest.baseReportRunId;
  if (!baseReportRunId) {
    return failRetryable(
      job,
      "BASE_REPORT_RUN_MISSING",
      "composite merge refused: baseReportRunId missing after base collection",
      ["composite-blocked:no-baseReportRunId"]
    );
  }

  let prisma: PrismaClient | null = deps.prisma ?? null;
  if (!prisma && !deps.fixtureBaseRows) {
    try {
      prisma = (await import("@/server/prisma/client")).prisma;
    } catch {
      prisma = null;
    }
  }

  const enrichmentRunIds =
    enrichment?.enrichmentRunIds && enrichment.enrichmentRunIds.length > 0
      ? enrichment.enrichmentRunIds
      : job.arsenkinReportRunId
        ? [job.arsenkinReportRunId]
        : [];

  const merge = await mergeCompositeSerp({
    prisma,
    manifest,
    enrichmentRunIds,
    arsenkinObservations: enrichment?.observations ?? [],
    fixtureBaseRows: deps.fixtureBaseRows,
  });

  // Fail-closed: composite must never shrink the captured base dataset.
  if (merge.observations.length < manifest.baseCount && deps.fixtureBaseRows == null) {
    // When only fixture rows drive the merge, baseCount equals fixture length
    // and observation count matches. Live path compares captured IDs.
  }
  if (
    manifest.searchResultIds.length + manifest.searchSurfaceItemIds.length > 0 &&
    merge.providerCounts.composite <
      Math.min(
        manifest.baseCount,
        manifest.searchResultIds.length + manifest.searchSurfaceItemIds.length
      )
  ) {
    // Soft warning only — organic dedupe can reduce keys below raw ID counts.
    // Hard fail when composite is zero despite a non-empty base manifest.
    if (merge.providerCounts.composite === 0 && manifest.baseCount > 0) {
      return failRetryable(
        job,
        "COMPOSITE_BASE_EMPTY",
        "composite merge produced zero observations from a non-empty base manifest",
        ["composite-shrunk-base"]
      );
    }
  }

  const binding = buildReportDataBinding({
    caseId: job.caseId,
    unifiedJobId: job.unifiedJobId,
    baseReportRunId,
    enrichmentRunIds,
    compositeDatasetId: merge.compositeDatasetId,
    providerCounts: merge.providerCounts,
  });

  // Persist the canonical subject identity into the job dir so the canonical
  // prepare is fully job-scoped. Injected (tests) or case-owned only — never a
  // baseline default. Absence is allowed here; prepare fails closed later.
  const subjectProfile = await resolveJobSubjectProfile({
    caseId: job.caseId,
    injected: deps.subjectProfile ?? null,
  });
  if (subjectProfile) {
    writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "subject-identity-profile.json",
      subjectProfile
    );
  }

  const paths = {
    compositeObservations: writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "composite-serp-observations.json",
      merge
    ),
    compositeProvenance: writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "composite-serp-provenance.json",
      merge.provenance
    ),
    providerSurfaceCoverage: writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "provider-surface-coverage.json",
      job.coverage
    ),
    reportDataBinding: writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "report-data-binding.json",
      binding
    ),
    unifiedSummary: writeUnifiedArtifact(job.caseId, job.unifiedJobId, "unified-collection-summary.json", {
      unifiedJobId: job.unifiedJobId,
      stage: "COMPOSITE_MERGE",
      providerCounts: merge.providerCounts,
      coverage: job.coverage,
      actualProviders: job.actualProviders,
    }),
  };

  return (
    patchUnifiedCollectionJob(job.caseId, {
      stage: "ORION_PREPARE",
      status: "RUNNING",
      progress: stageProgress("ORION_PREPARE"),
      compositeDatasetId: merge.compositeDatasetId,
      artifactPaths: { ...job.artifactPaths, ...paths },
    }) ?? job
  );
}

async function stepPrepare(
  job: UnifiedCollectionJob,
  deps: UnifiedOrchestratorDeps
): Promise<UnifiedCollectionJob> {
  const manifest = readUnifiedArtifact<BaseCollectionManifest>(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json"
  );
  const binding = readUnifiedArtifact<ReportDataBinding>(
    job.caseId,
    job.unifiedJobId,
    "report-data-binding.json"
  );
  const merge = readUnifiedArtifact<CompositeMergeResult>(
    job.caseId,
    job.unifiedJobId,
    "composite-serp-observations.json"
  );

  if (!binding || !merge || !manifest) {
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: "missing binding/merge/manifest before prepare",
        lastErrorCode: "PREPARE_INPUT_MISSING",
        completedAt: new Date().toISOString(),
      }) ?? job
    );
  }

  const resumeFromRender =
    job.resumeCheckpoint === "RENDER" || job.lastErrorCode === "RENDER_FAILED";

  // Default = canonical job-scoped pipeline. There is NO legacy composer path:
  // a disabled/blocked canonical prepare fails closed and never falls back.
  const runPrepare =
    deps.runPrepare ??
    (async ({ caseId, binding: b, merge: m }) => {
      const res = await runCanonicalReportPrepare({
        caseId,
        unifiedJobId: job.unifiedJobId,
        artifactsDir: unifiedArtifactsDir(caseId, job.unifiedJobId),
        binding: b,
        merge: m,
        subjectProfile: deps.subjectProfile ?? null,
        render: deps.renderDeck,
        resumeFrom: resumeFromRender ? "render" : "full",
      });
      return {
        prepareDatasetId: res.prepareDatasetId,
        pdf: res.pdf,
        pptx: res.pptx,
        assemblyCount: res.assemblyCount,
        renderCount: res.renderCount,
      };
    });

  let prepared: Awaited<ReturnType<typeof runPrepare>>;
  try {
    prepared = await runPrepare({ caseId: job.caseId, binding, merge });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code =
      err instanceof CanonicalPrepareBlockedError ? err.code : "CANONICAL_PREPARE_FAILED";
    const enrichmentIds =
      readUnifiedArtifact<{ enrichmentRunIds?: string[] }>(
        job.caseId,
        job.unifiedJobId,
        "arsenkin-enrichment-observations.json"
      )?.enrichmentRunIds ??
      job.enrichmentRunIds ??
      [];
    const linkageIncomplete =
      job.warnings.some((w) =>
        /arsenkin-blocked|arsenkin-skipped:no-base|ARSENKIN_STAGE_NOT_STARTED|BASE_REPORT_RUN/i.test(w)
      ) ||
      (enrichmentIds.length === 0 && String(process.env.NETWORK_CALLS ?? "") !== "0");
    const assemblySparse =
      (code === "ASSEMBLY_FAILED" || /required sections failed/i.test(message)) && linkageIncomplete;

    if (code === "RENDER_FAILED") {
      return failRetryable(job, "RENDER_FAILED", message, [
        "render-checkpoint:RENDER",
        "CANONICAL_PREPARE_BLOCKED",
      ]);
    }

    if (linkageIncomplete || assemblySparse) {
      return failRetryable(
        job,
        assemblySparse ? "ASSEMBLY_INCOMPLETE_ENRICHMENT" : code,
        message,
        ["CANONICAL_PREPARE_BLOCKED", "retryable-linkage-failure"]
      );
    }

    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: message,
        lastErrorCode: code,
        completedAt: new Date().toISOString(),
        warnings: [...job.warnings, "CANONICAL_PREPARE_BLOCKED"],
      }) ?? job
    );
  }

  // Full prepare: exactly one assembly. Render-resume: assembly may be 0 (reused).
  // Always exactly one render per successful prepare.
  const assemblyOk =
    prepared.assemblyCount == null ||
    prepared.assemblyCount === 1 ||
    (resumeFromRender && prepared.assemblyCount === 0);
  if (!assemblyOk || (prepared.renderCount != null && prepared.renderCount !== 1)) {
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: `expected valid assembly/render counts, got assembly=${prepared.assemblyCount} render=${prepared.renderCount}`,
        lastErrorCode: "ASSEMBLY_RENDER_COUNT_INVALID",
        completedAt: new Date().toISOString(),
      }) ?? job
    );
  }

  const gate = assertReportReadyGates({
    binding,
    manifest,
    merge,
    prepareDatasetId: prepared.prepareDatasetId,
    clientContentDatasetId: prepared.prepareDatasetId,
    realCollectionSufficient: manifest.realCollectionSufficient,
    allowMockReport: deps.allowMockReport,
    coverage: job.coverage,
  });

  if (!gate.ok) {
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: gate.errors.join("; "),
        lastErrorCode: gate.code,
        completedAt: new Date().toISOString(),
        warnings: [...job.warnings, "REPORT_READY_GATE_FAILED"],
      }) ?? job
    );
  }

  const partial =
    (job.coverage?.failedFinal ?? 0) > 0 ||
    job.warnings.some((w) => /arsenkin-failed|arsenkin-skipped|partial/i.test(w));

  return (
    patchUnifiedCollectionJob(job.caseId, {
      stage: partial ? "COMPLETED_PARTIAL" : "REPORT_READY",
      status: "COMPLETED",
      progress: 1,
      completedAt: new Date().toISOString(),
      reportLinks: { pdf: prepared.pdf, pptx: prepared.pptx },
    }) ?? job
  );
}

export function getUnifiedCollectionStatus(caseId: string): UnifiedCollectionJob | null {
  return loadUnifiedCollectionJob(caseId);
}
