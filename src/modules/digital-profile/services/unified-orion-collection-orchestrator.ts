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
import { assertPreRenderDataGates } from "./pre-render-data-gates";
import {
  runCanonicalReportPrepare,
  CanonicalPrepareBlockedError,
} from "./canonical-report-prepare";
import type { DeckRenderAdapter } from "./render-deck-artifacts";
import { resolveJobSubjectProfile } from "./job-subject-profile";
import {
  bootstrapSubjectProfileFromCollection,
  type CaseSubjectRef,
} from "./job-subject-profile-bootstrap";
import type { ClassifierSubjectProfile } from "../orion-golden/analytics/subject-resolution-classifier";
import { invalidateDownstreamAfterEnrichmentIngest } from "./unified-downstream-invalidation";
import { normalizeArsenkinEnrichmentState } from "./arsenkin-enrichment-state";
import type { FullAuditResultDTO } from "./agent-run-service";
import { ensurePersistedUnifiedBaseReportRun } from "./unified-base-report-run";
import { ARSENKIN_REAL_AGENT_NAMES } from "../agents/real/real-arsenkin-agents";
import { evaluateUnifiedCollectionRecoveryEligibility } from "./unified-collection-recovery";
import { ConflictError } from "../http/errors";
import type { ArsenkinEnrichmentState, ArsenkinAgentProgress } from "./arsenkin-enrichment-state";
import {
  legacyEnrichmentResultToTick,
  offlineSyntheticCompleteTick,
  runDurableArsenkinEnrichmentTick,
  type EnrichmentPollTaskSnap,
} from "./arsenkin-enrichment-tick";
import { buildBaseObservationCoverage } from "./base-observation-coverage";

/** Bounded delay before re-scheduling a WAITING Arsenkin ingest tick. */
export function computeUnifiedPollDelayMs(job: UnifiedCollectionJob, now = Date.now()): number {
  if (job.nextPollAt) {
    const due = Date.parse(job.nextPollAt);
    if (!Number.isNaN(due)) return Math.max(50, due - now);
  }
  const attempt = Math.max(0, Number(job.pollAttempt ?? 0));
  return Math.min(30_000, Math.max(50, 2_000 * 2 ** Math.min(attempt, 4)));
}

/** Fail-closed ceiling for durable Arsenkin poll/ingest ticks (stops lease churn). */
export const MAX_ARSENKIN_INGEST_POLL_ATTEMPTS = 40;

function logUnifiedTickError(input: {
  caseId: string;
  jobId?: string | null;
  providerTaskId?: string | null;
  externalTaskId?: string | null;
  agentName?: string | null;
  errorCode: string;
  error: unknown;
}): void {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  console.error(
    JSON.stringify({
      event: "unified_tick_error",
      caseId: input.caseId,
      jobId: input.jobId ?? null,
      providerTaskId: input.providerTaskId ?? null,
      externalTaskId: input.externalTaskId ?? null,
      agentName: input.agentName ?? null,
      errorCode: input.errorCode,
      message: message.slice(0, 500),
    })
  );
}

function extractTickErrorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return String((err as { code: string }).code);
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/ARSENKIN_SCHEMA_INVALID/i.test(msg)) return "ARSENKIN_SCHEMA_INVALID";
  if (/ARSENKIN_POLL/i.test(msg)) return "ARSENKIN_POLL_FAILED";
  return "UNIFIED_TICK_FAILED";
}

/**
 * Persist tick/poll failures so lease churn cannot continue without pollAttempt/nextPollAt.
 * Never swallows — caller logs via logUnifiedTickError first.
 */
export function persistUnifiedTickFailure(
  caseId: string,
  err: unknown,
  extras?: {
    providerTaskId?: string | null;
    externalTaskId?: string | null;
    agentName?: string | null;
    now?: Date;
  }
): UnifiedCollectionJob | null {
  const job = loadUnifiedCollectionJob(caseId);
  if (!job) return null;
  const errorCode = extractTickErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  logUnifiedTickError({
    caseId,
    jobId: job.jobId,
    providerTaskId: extras?.providerTaskId,
    externalTaskId: extras?.externalTaskId,
    agentName: extras?.agentName,
    errorCode,
    error: err,
  });
  const attempt = Math.max(0, Number(job.pollAttempt ?? 0)) + 1;
  const nowMs = (extras?.now ?? new Date()).getTime();
  const backoffMs = Math.min(30_000, Math.max(2_000, 2_000 * 2 ** Math.min(attempt, 4)));
  const nextPollAt = new Date(nowMs + backoffMs).toISOString();
  if (attempt >= MAX_ARSENKIN_INGEST_POLL_ATTEMPTS) {
    return failRetryable(
      job,
      "ARSENKIN_POLL_ATTEMPTS_EXCEEDED",
      message.slice(0, 500),
      [
        "ARSENKIN_RESULT_INGEST",
        `pollAttempt:${attempt}`,
        errorCode,
        extras?.externalTaskId ? `externalTaskId:${extras.externalTaskId}` : "",
        extras?.providerTaskId ? `providerTaskId:${extras.providerTaskId}` : "",
        extras?.agentName ? `agentName:${extras.agentName}` : "",
      ].filter(Boolean)
    );
  }
  return (
    patchUnifiedCollectionJob(caseId, {
      stage: "ARSENKIN_ENRICHMENT",
      status: "WAITING",
      resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
      pollAttempt: attempt,
      nextPollAt,
      lastError: message.slice(0, 500),
      lastErrorCode: errorCode,
      warnings: [
        ...job.warnings,
        `unified-tick-error:${errorCode}`,
        extras?.externalTaskId ? `externalTaskId:${extras.externalTaskId}` : "",
        extras?.agentName ? `agentName:${extras.agentName}` : "",
      ].filter(Boolean),
      completedAt: null,
    }) ?? job
  );
}

export type UnifiedOrchestratorDeps = {
  prisma?: PrismaClient | null;
  runFullAudit?: (caseId: string, actorId: string) => Promise<FullAuditResultDTO>;
  /** Offline: ProviderTasks for durable enrichment poll/ingest. */
  listEnrichmentProviderTasks?: (enrichmentRunIds: string[]) => Promise<EnrichmentPollTaskSnap[]>;
  /** Offline: poll adapter (never /set). */
  pollEnrichmentTask?: (task: EnrichmentPollTaskSnap) => Promise<EnrichmentPollTaskSnap>;
  /**
   * Arsenkin enrichment tick (may be incomplete). Prefer enrichmentComplete flag.
   * Schedule-only (enrichmentRunIds length 5) is NOT completion.
   */
  runArsenkinEnrichment?: (job: UnifiedCollectionJob) => Promise<{
    arsenkinReportRunId: string | null;
    enrichmentRunIds?: string[];
    coverage?: SurfaceCoverageBreakdown;
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
      externalTaskId?: string | null;
      caseAgent?: string;
      tool?: string | null;
      enrichmentRunId?: string;
      unifiedJobId?: string;
      sourceUrlOrQuery?: string | null;
      resultHash?: string | null;
    }>;
    warnings?: string[];
    partial?: boolean;
    enrichmentComplete?: boolean;
    agents?: ArsenkinAgentProgress[];
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
    contactSheet?: string;
    assemblyCount?: number;
    renderCount?: number;
  }>;
  /** Subject identity for canonical prepare (production resolves from the case). */
  subjectProfile?: ClassifierSubjectProfile | null;
  /** Case subject for the automatic profile bootstrap (offline tests inject it). */
  caseSubject?: CaseSubjectRef | null;
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
/** True when a job retains stages/artifacts that must not be silently recollected. */
export function unifiedJobHasPreservedStages(job: UnifiedCollectionJob | null | undefined): boolean {
  if (!job) return false;
  if (job.stage === "REPORT_READY" || job.stage === "COMPLETED_PARTIAL") return true;
  if (job.baseReportRunId || (job.enrichmentRunIds?.length ?? 0) > 0 || job.compositeDatasetId) {
    return true;
  }
  return Object.keys(job.artifactPaths ?? {}).length > 0;
}

function resumeFromRetryableCheckpoint(job: UnifiedCollectionJob): UnifiedCollectionJob {
  const renderResume =
    job.resumeCheckpoint === "RENDER" ||
    job.lastErrorCode === "RENDER_FAILED" ||
    /render failed/i.test(job.lastError ?? "");

  const enrichmentComplete = Boolean(job.arsenkinEnrichmentState?.enrichmentComplete);
  const ingestResume =
    job.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" ||
    ((job.enrichmentRunIds?.length ?? 0) >= ARSENKIN_REAL_AGENT_NAMES.length &&
      !enrichmentComplete &&
      Boolean(job.baseReportRunId));

  if (
    renderResume &&
    job.baseReportRunId &&
    (job.enrichmentRunIds?.length ?? 0) >= 5 &&
    enrichmentComplete
  ) {
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

  if (hasBase && ingestResume) {
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "ARSENKIN_ENRICHMENT",
        status: "RUNNING",
        resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
        baseReportRunId: job.baseReportRunId ?? manifest!.baseReportRunId,
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        warnings: [...job.warnings, "bounded-resume:from-arsenkin-ingest"],
      }) ?? job
    );
  }

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
      : code === "PRE_RENDER_DATA_GATE_FAILED" ||
          extraWarnings.some((w) => /PRE_RENDER_DATA_GATE/i.test(w))
        ? ("PRE_RENDER_DATA_GATE" as const)
        : code === "ARSENKIN_ENRICHMENT_INCOMPLETE" ||
            code === "ARSENKIN_ENRICHMENT_FAILED" ||
            code === "ARSENKIN_SUBMIT_UNKNOWN" ||
            code === "ARSENKIN_SCHEMA_INVALID" ||
            code === "ARSENKIN_POLL_ATTEMPTS_EXCEEDED" ||
            code === "UNIFIED_TICK_FAILED" ||
            code === "EXTERNAL_TASK_HASH_CONFLICT" ||
            extraWarnings.some((w) => /arsenkin-ingest|ARSENKIN_RESULT_INGEST/i.test(w))
          ? ("ARSENKIN_RESULT_INGEST" as const)
          : job.resumeCheckpoint ?? null;
  return (
    patchUnifiedCollectionJob(job.caseId, {
      stage: "FAILED_RETRYABLE",
      status: "WAITING",
      lastError: message,
      lastErrorCode: code,
      resumeCheckpoint,
      // Preserve enrichment progress for UI + exact resume (never wipe on fail).
      arsenkinEnrichmentState: job.arsenkinEnrichmentState ?? undefined,
      enrichmentRunIds: job.enrichmentRunIds,
      baseReportRunId: job.baseReportRunId,
      warnings: [...job.warnings, ...extraWarnings, code],
      completedAt: new Date().toISOString(),
    }) ?? job
  );
}

export async function startUnifiedOrionCollection(input: {
  caseId: string;
  requestedBy?: string;
  arsenkinMode?: "full-first36";
  /** Explicit paid recollection — required to supersede a job with preserved stages. */
  confirmPaidRecollection?: boolean;
  deps?: UnifiedOrchestratorDeps;
}): Promise<{ accepted: true; jobId: string; unifiedJobId: string; created: boolean; stage: string }> {
  const existing = loadUnifiedCollectionJob(input.caseId);
  if (existing) {
    const elig = evaluateUnifiedCollectionRecoveryEligibility({
      caseId: input.caseId,
      job: existing,
    });
    // Durable post-submit / ingest wait: always resume the same job (never 409 / new collection).
    const inFlightArsenkinIngest =
      existing.stage === "ARSENKIN_ENRICHMENT" &&
      (existing.status === "WAITING" || existing.status === "RUNNING") &&
      existing.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" &&
      (existing.enrichmentRunIds?.length ?? 0) >= ARSENKIN_REAL_AGENT_NAMES.length;
    // In-flight WAITING/RUNNING ingest or idempotent resume → reuse, do not 409.
    if (
      inFlightArsenkinIngest ||
      (elig.recoveryAllowed &&
        (existing.status === "WAITING" || existing.status === "RUNNING") &&
        (elig.recoveryReason === "ARSENKIN_INGEST_RESUME" ||
          elig.recoveryReason === "IDEMPOTENT_RESUME" ||
          elig.recoveryReason === "IDEMPOTENT_RENDER_RESUME"))
    ) {
      if (input.deps?.autoSchedule !== false) {
        scheduleUnifiedTick(input.caseId, input.deps);
      }
      return {
        accepted: true,
        jobId: existing.jobId,
        unifiedJobId: existing.unifiedJobId,
        created: false,
        stage: existing.stage,
      };
    }
    if (elig.recoveryAllowed) {
      throw new ConflictError(
        `recoverable unified job ${existing.jobId}; use POST /unified-collection/recover (${elig.recoveryReason})`
      );
    }
    if (unifiedJobHasPreservedStages(existing) && !input.confirmPaidRecollection) {
      throw new ConflictError(
        `unified job ${existing.jobId} has preserved stages/artifacts (${existing.stage}); ` +
          `use recovery or confirmPaidRecollection for a new paid collection`
      );
    }
  }

  const { job, created } = findOrCreateUnifiedCollectionJob({
    caseId: input.caseId,
    requestedBy: input.requestedBy ?? "system",
    arsenkinMode: input.arsenkinMode ?? "full-first36",
    forceNew: Boolean(input.confirmPaidRecollection && existing && unifiedJobHasPreservedStages(existing)),
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
      .catch((err) => {
        // Never silent — persist pollAttempt/nextPollAt/error so lease churn stops.
        persistUnifiedTickFailure(caseId, err, { now: deps.now?.() });
      })
      .finally(() => {
        ticking.delete(caseId);
        const job = loadUnifiedCollectionJob(caseId);
        const keepPolling =
          job &&
          job.stage !== "REPORT_READY" &&
          job.stage !== "COMPLETED_PARTIAL" &&
          job.stage !== "FAILED_TERMINAL" &&
          job.stage !== "FAILED_RETRYABLE" &&
          job.stage !== "CANCELLED" &&
          (job.status === "RUNNING" ||
            (job.status === "WAITING" &&
              job.stage === "ARSENKIN_ENRICHMENT" &&
              job.resumeCheckpoint === "ARSENKIN_RESULT_INGEST"));
        if (keepPolling && job) {
          const delayMs = computeUnifiedPollDelayMs(job, deps.now?.().getTime() ?? Date.now());
          setTimeout(() => scheduleUnifiedTick(caseId, deps), delayMs);
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

/**
 * Periodic pump for persisted WAITING unified jobs (durable across HTTP end).
 * Idempotent with scheduleUnifiedTick's in-process guard + job lease.
 */
export function pumpResumableUnifiedCollections(deps: UnifiedOrchestratorDeps = {}): number {
  const jobs = listResumableUnifiedJobs();
  for (const { caseId } of jobs) {
    scheduleUnifiedTick(caseId, deps);
  }
  return jobs.length;
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

    try {
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
          // Explicit recovery only — background pump must not auto-lift FAILED_RETRYABLE.
          break;
        default:
          break;
      }
    } catch (err) {
      // Persist + stop silent lease churn; do not rethrow (scheduler catch is backup).
      persistUnifiedTickFailure(caseId, err, { now: deps.now?.() });
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

  const networkOff = String(process.env.NETWORK_CALLS ?? "") === "0";
  const hasOfflinePollDeps = Boolean(
    deps.listEnrichmentProviderTasks || deps.pollEnrichmentTask
  );
  const resumeIngest =
    job.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" &&
    (job.enrichmentRunIds?.length ?? 0) >= ARSENKIN_REAL_AGENT_NAMES.length;

  // Atomically persist pollAttempt + nextPollAt BEFORE HTTP poll (lease already held).
  // Prevents lease churn with missing poll progress when the tick throws mid-flight.
  if (resumeIngest) {
    const attempt = Math.max(0, Number(job.pollAttempt ?? 0)) + 1;
    if (attempt > MAX_ARSENKIN_INGEST_POLL_ATTEMPTS) {
      return failRetryable(
        job,
        "ARSENKIN_POLL_ATTEMPTS_EXCEEDED",
        `Arsenkin durable poll exceeded ${MAX_ARSENKIN_INGEST_POLL_ATTEMPTS} attempts`,
        ["ARSENKIN_RESULT_INGEST", `pollAttempt:${attempt}`]
      );
    }
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    const backoffMs = Math.min(30_000, Math.max(2_000, 2_000 * 2 ** Math.min(attempt - 1, 4)));
    job =
      patchUnifiedCollectionJob(job.caseId, {
        stage: "ARSENKIN_ENRICHMENT",
        status: "WAITING",
        resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
        pollAttempt: attempt,
        nextPollAt: new Date(nowMs + backoffMs).toISOString(),
        lastError: null,
        lastErrorCode: null,
      }) ?? job;
  }

  let tick;

  if (deps.runArsenkinEnrichment) {
    const raw = await deps.runArsenkinEnrichment(job);
    tick = legacyEnrichmentResultToTick(job, raw);
  } else if (networkOff && !hasOfflinePollDeps && !resumeIngest) {
    // Offline happy-path: honest EMPTY_VALID for all five — no live submits.
    // WAITING ingest resume / injected poll deps use the durable poll path instead.
    tick = offlineSyntheticCompleteTick(job);
  } else {
    tick = await runDurableArsenkinEnrichmentTick({
      job,
      prisma: deps.prisma,
      offlineEmptyValid: networkOff && !hasOfflinePollDeps && !resumeIngest,
      listProviderTasks: deps.listEnrichmentProviderTasks,
      pollTask: deps.pollEnrichmentTask,
      now: deps.now,
      scheduleIfMissing:
        (job.enrichmentRunIds?.length ?? 0) >= ARSENKIN_REAL_AGENT_NAMES.length
          ? undefined
          : async () => {
              const { startArsenkinCaseAgentDurable } = await import("./arsenkin-case-agent-execution");
              const { getAgent } = await import("../agents/registry");
              const enrichmentRunIds: string[] = [];
              const warnings: string[] = [];
              for (const agentName of ARSENKIN_REAL_AGENT_NAMES) {
                const agent = getAgent(agentName);
                const tools =
                  agent && "tools" in agent && Array.isArray((agent as { tools?: string[] }).tools)
                    ? ((agent as { tools: import("../providers/arsenkin/flags").ArsenkinToolName[] })
                        .tools)
                    : [];
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
                enrichmentRunIds,
                arsenkinReportRunId: enrichmentRunIds[0] ?? null,
                warnings,
              };
            },
    });
  }

  const state: ArsenkinEnrichmentState = normalizeArsenkinEnrichmentState(tick.state, {
    caseId: job.caseId,
    unifiedJobId: job.unifiedJobId,
  });
  const enrichmentRunIds = tick.enrichmentRunIds;
  const planned = FIRST36_PLANNED_SUPPORTED_SURFACES.length;
  const coverage: SurfaceCoverageBreakdown = {
    ...emptyCoverage(planned),
    inFlight: state.pendingAgents.length,
    measured: state.enrichmentObservationCount > 0 ? Math.min(planned, state.completedAgents.length) : 0,
    noResults: state.agents.filter((a) => a.terminalKind === "EMPTY_VALID" || a.terminalKind === "NO_RESULTS")
      .length,
    failedRetryable: state.failedAgents.length,
    progressRatio: state.completedAgents.length / ARSENKIN_REAL_AGENT_NAMES.length,
  };

  writeUnifiedArtifact(job.caseId, job.unifiedJobId, "arsenkin-enrichment-state.json", state);
  // Keep job-scoped enrichment state even when failing closed (UI + exact resume).
  job =
    patchUnifiedCollectionJob(job.caseId, {
      arsenkinEnrichmentState: state,
      enrichmentRunIds,
      arsenkinReportRunId: tick.arsenkinReportRunId,
    }) ?? job;

  if (tick.blockPipeline) {
    return failRetryable(
      job,
      tick.blockCode ?? "ARSENKIN_ENRICHMENT_FAILED",
      tick.blockMessage ?? "Arsenkin enrichment failed",
      [...tick.warnings, "ARSENKIN_RESULT_INGEST"]
    );
  }

  if (tick.waiting || !state.enrichmentComplete) {
    // Persist partial observations + durable nextPollAt (restart-safe).
    const obsPath = writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "arsenkin-enrichment-observations.json",
      {
        observations: tick.observations,
        arsenkinReportRunId: tick.arsenkinReportRunId,
        enrichmentRunIds,
        enrichmentComplete: false,
        state,
        ingestedResultHashes: state.ingestedResultHashes,
      }
    );
    const nextPollAt =
      tick.nextPollAt ??
      job.nextPollAt ??
      new Date(
        (deps.now?.() ?? new Date()).getTime() +
          Math.min(30_000, Math.max(2_000, 2_000 * 2 ** Math.min(Number(job.pollAttempt ?? 0), 4)))
      ).toISOString();
    return (
      patchUnifiedCollectionJob(job.caseId, {
        stage: "ARSENKIN_ENRICHMENT",
        status: "WAITING",
        progress: stageProgress("ARSENKIN_ENRICHMENT"),
        arsenkinReportRunId: tick.arsenkinReportRunId,
        enrichmentRunIds,
        arsenkinEnrichmentState: state,
        resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
        nextPollAt,
        // pollAttempt already bumped pre-poll when resumeIngest; keep monotonic progress.
        pollAttempt: Math.max(0, Number(job.pollAttempt ?? 0)),
        coverage: { ...coverage, progressRatio: computeCoverageProgress(coverage) },
        warnings: [...job.warnings, ...tick.warnings, "arsenkin-awaiting-ingest"],
        artifactPaths: { ...job.artifactPaths, arsenkinObservations: obsPath },
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
      }) ?? job
    );
  }

  // Complete — invalidate stale downstream if prior composite/render existed, then advance.
  const priorComposite = job.compositeDatasetId;
  const priorLinks = job.reportLinks;
  const staleCompositeOnDisk = Boolean(
    readUnifiedArtifact(job.caseId, job.unifiedJobId, "composite-serp-observations.json") ||
      readUnifiedArtifact(job.caseId, job.unifiedJobId, "assembled-deck.json") ||
      readUnifiedArtifact(job.caseId, job.unifiedJobId, "downstream-invalidation.json")
  );
  let invalidationWarnings: string[] = [];
  if (priorComposite || priorLinks?.pdf || priorLinks?.pptx || staleCompositeOnDisk) {
    const inv = invalidateDownstreamAfterEnrichmentIngest({
      job,
      reason: "arsenkin-observations-ingested",
      previousCompositeDatasetId: priorComposite,
    });
    invalidationWarnings = inv.jobPatch.warnings ?? [];
  }

  const obsPath = writeUnifiedArtifact(
    job.caseId,
    job.unifiedJobId,
    "arsenkin-enrichment-observations.json",
    {
      observations: tick.observations,
      arsenkinReportRunId: tick.arsenkinReportRunId,
      enrichmentRunIds,
      enrichmentComplete: true,
      state,
      ingestedResultHashes: state.ingestedResultHashes,
    }
  );

  return (
    patchUnifiedCollectionJob(job.caseId, {
      stage: "COMPOSITE_MERGE",
      status: "RUNNING",
      progress: stageProgress("COMPOSITE_MERGE"),
      arsenkinReportRunId: tick.arsenkinReportRunId,
      enrichmentRunIds,
      arsenkinEnrichmentState: state,
      resumeCheckpoint: null,
      nextPollAt: null,
      pollAttempt: 0,
      coverage: { ...coverage, progressRatio: computeCoverageProgress(coverage) },
      warnings: [
        ...(invalidationWarnings.length > 0 ? invalidationWarnings : job.warnings),
        ...tick.warnings,
      ],
      artifactPaths: { ...job.artifactPaths, arsenkinObservations: obsPath },
      ...(priorComposite || priorLinks?.pdf || priorLinks?.pptx
        ? {
            compositeDatasetId: null as string | null,
            reportLinks: {} as { pdf?: string; pptx?: string; contactSheet?: string },
          }
        : {}),
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

  const enrichmentComplete =
    Boolean(job.arsenkinEnrichmentState?.enrichmentComplete) ||
    Boolean((enrichment as { enrichmentComplete?: boolean } | null)?.enrichmentComplete);
  if (!enrichmentComplete) {
    return failRetryable(
      job,
      "ARSENKIN_ENRICHMENT_INCOMPLETE",
      "composite refused: Arsenkin enrichmentComplete=false (schedule≠complete)",
      ["ARSENKIN_RESULT_INGEST", "composite-blocked:enrichment-incomplete"]
    );
  }

  const enrichmentRunIds =
    enrichment?.enrichmentRunIds && enrichment.enrichmentRunIds.length > 0
      ? enrichment.enrichmentRunIds
      : job.enrichmentRunIds && job.enrichmentRunIds.length > 0
        ? job.enrichmentRunIds
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

  if (merge.providerCounts.composite === 0 && manifest.baseCount > 0) {
    return failRetryable(
      job,
      "COMPOSITE_BASE_EMPTY",
      "composite merge produced zero observations from a non-empty base manifest",
      ["composite-shrunk-base"]
    );
  }

  const coverageProbe = buildBaseObservationCoverage({ manifest, merge });
  writeUnifiedArtifact(job.caseId, job.unifiedJobId, "base-observation-coverage.json", coverageProbe);
  if (!coverageProbe.allBaseObservationsTraceable) {
    return failRetryable(
      job,
      "BASE_OBSERVATION_COVERAGE_FAILED",
      `missing base ids: ${coverageProbe.missingBaseObservationIds.join(",")}`,
      ["composite-coverage-incomplete"]
    );
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
  // prepare is fully job-scoped. Order: injected (tests) → case-owned artifact
  // → automatic bootstrap from the case subject + the just-collected data.
  // Only when even the bootstrap cannot resolve a subject does prepare later
  // fail closed with SUBJECT_PROFILE_MISSING.
  let subjectProfile = await resolveJobSubjectProfile({
    caseId: job.caseId,
    injected: deps.subjectProfile ?? null,
  });
  if (!subjectProfile) {
    const bootstrap = await bootstrapSubjectProfileFromCollection({
      caseId: job.caseId,
      baseReportRunId,
      enrichmentRunId: enrichmentRunIds[0] ?? null,
      observations: merge.observations,
      subject: deps.caseSubject ?? null,
      prisma,
    });
    subjectProfile = bootstrap?.profile ?? null;
  }
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

  const enrichmentState =
    job.arsenkinEnrichmentState ??
    readUnifiedArtifact<ArsenkinEnrichmentState>(
      job.caseId,
      job.unifiedJobId,
      "arsenkin-enrichment-state.json"
    );

  // PRE_RENDER_DATA_GATE — never call expensive HTTP render without data readiness.
  // RENDER-only resume already passed data gates; skip re-checking enrichment ingest.
  if (!resumeFromRender) {
    const preGate = assertPreRenderDataGates({
      binding,
      manifest,
      merge,
      enrichmentState,
      realCollectionSufficient: manifest.realCollectionSufficient,
      allowMockReport: deps.allowMockReport,
    });
    if (preGate.coverage) {
      writeUnifiedArtifact(
        job.caseId,
        job.unifiedJobId,
        "base-observation-coverage.json",
        preGate.coverage
      );
    }
    if (!preGate.ok) {
      const errText = preGate.errors.join("; ");
      const ingestIncomplete = /enrichment/i.test(errText);
      const mockInsufficient = /real collection insufficient/i.test(errText);
      // Mock/fallback base is terminal (cannot unlock REPORT_READY by retry alone).
      if (mockInsufficient) {
        return (
          patchUnifiedCollectionJob(job.caseId, {
            stage: "FAILED_TERMINAL",
            status: "FAILED",
            lastError: errText,
            lastErrorCode: preGate.code,
            completedAt: new Date().toISOString(),
            warnings: [...job.warnings, "PRE_RENDER_DATA_GATE_FAILED", "NO_RENDER_BEFORE_DATA_GATE"],
          }) ?? job
        );
      }
      return failRetryable(job, "PRE_RENDER_DATA_GATE_FAILED", errText, [
        ingestIncomplete ? "ARSENKIN_RESULT_INGEST" : "PRE_RENDER_DATA_GATE",
        "NO_RENDER_BEFORE_DATA_GATE",
        "HTTP_RENDER_CALLS_ON_FAILED_GATE_ZERO",
      ]);
    }
  }

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
        contactSheet: res.contactSheet,
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
    skipBaseCoverage: resumeFromRender,
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
      reportLinks: {
        pdf: prepared.pdf,
        pptx: prepared.pptx,
        ...(prepared.contactSheet ? { contactSheet: prepared.contactSheet } : {}),
      },
    }) ?? job
  );
}

export function getUnifiedCollectionStatus(caseId: string): UnifiedCollectionJob | null {
  return loadUnifiedCollectionJob(caseId);
}
