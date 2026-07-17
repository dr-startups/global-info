/**
 * Staff recovery for a failed unified ORION collection job.
 * Rebinds baseReportRunId from an existing base-collection-manifest and
 * resumes at ARSENKIN_ENRICHMENT — never re-runs Yandex/Google/Serper/Wikipedia.
 */

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors";
import { ensurePersistedUnifiedBaseReportRun } from "./unified-base-report-run";
import {
  claimUnifiedJobLease,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  readUnifiedArtifact,
  releaseUnifiedJobLease,
  unifiedArtifactsDir,
  writeUnifiedArtifact,
} from "./unified-collection-job-store";
import type {
  BaseCollectionManifest,
  ReportDataBinding,
  UnifiedCollectionJob,
  UnifiedCollectionStage,
} from "./unified-collection-types";
import { loadReusableAssembledDeck } from "./canonical-report-prepare";

export type UnifiedRecoveryAudit = {
  recoveredFromStatus: string;
  recoveredFromStage: UnifiedCollectionStage | string;
  recoveryRequestedAt: string;
  recoveryRequestedBy: string;
  recoveryReason: string;
  previousLastError: string | null;
  previousLastErrorCode: string | null;
};

export type UnifiedRecoveryEligibility = {
  recoveryAllowed: boolean;
  recoveryBlockerReason: string | null;
  recoveryReason: string | null;
};

const ACTIVE_STAGES = new Set<UnifiedCollectionStage>([
  "BASE_COLLECTION",
  "ARSENKIN_ENRICHMENT",
  "COMPOSITE_MERGE",
  "ORION_PREPARE",
  "CLIENT_CONTENT",
]);

function leaseIsActive(job: UnifiedCollectionJob, now: Date): boolean {
  if (!job.leaseOwnerId || !job.leaseUntil) return false;
  const until = Date.parse(job.leaseUntil);
  return Number.isFinite(until) && until > now.getTime();
}

function manifestHasBaseObservations(manifest: BaseCollectionManifest | null | undefined): boolean {
  if (!manifest) return false;
  if (manifest.caseId && manifest.unifiedJobId) {
    /* lineage fields present */
  } else {
    return false;
  }
  const idCount =
    (manifest.searchResultIds?.length ?? 0) + (manifest.searchSurfaceItemIds?.length ?? 0);
  return (manifest.baseCount ?? 0) > 0 || idCount > 0;
}

function hasHistoricalNoBaseReportDefect(job: UnifiedCollectionJob): boolean {
  const blob = [...(job.warnings ?? []), job.lastErrorCode ?? "", job.lastError ?? ""].join("\n");
  return (
    /arsenkin-skipped:no-baseReportRunId/i.test(blob) ||
    /arsenkin-blocked:no-baseReportRunId/i.test(blob) ||
    /BASE_REPORT_RUN_MISSING/i.test(blob)
  );
}

/**
 * Pure eligibility. Does not mutate storage. Server is the source of truth —
 * never trust a client recoveryAllowed flag.
 */
export function evaluateUnifiedCollectionRecoveryEligibility(input: {
  caseId: string;
  job: UnifiedCollectionJob | null;
  /** When set, must match the loaded job's jobId/unifiedJobId. */
  requestedJobId?: string | null;
  manifest?: BaseCollectionManifest | null;
  now?: Date;
  /** When set, an active lease owned by this id is ignored (caller holds it). */
  leaseOwnerId?: string | null;
  /** Skip lease gate entirely (internal re-check after claim). */
  ignoreLease?: boolean;
}): UnifiedRecoveryEligibility {
  const now = input.now ?? new Date();
  const job = input.job;
  if (!job) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "JOB_NOT_FOUND",
      recoveryReason: null,
    };
  }
  if (job.caseId !== input.caseId) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "FOREIGN_CASE",
      recoveryReason: null,
    };
  }
  const requested = String(input.requestedJobId ?? "").trim();
  if (requested && requested !== job.jobId && requested !== job.unifiedJobId) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "JOB_ID_MISMATCH",
      recoveryReason: null,
    };
  }
  if (job.stage === "REPORT_READY" || job.stage === "COMPLETED_PARTIAL" || job.status === "COMPLETED") {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "JOB_ALREADY_COMPLETED",
      recoveryReason: null,
    };
  }
  if (job.stage === "CANCELLED" || job.status === "CANCELLED") {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "JOB_CANCELLED",
      recoveryReason: null,
    };
  }
  if (!input.ignoreLease && leaseIsActive(job, now)) {
    const ownLease =
      input.leaseOwnerId && job.leaseOwnerId && job.leaseOwnerId === input.leaseOwnerId;
    if (!ownLease) {
      return {
        recoveryAllowed: false,
        recoveryBlockerReason: "ACTIVE_LEASE",
        recoveryReason: null,
      };
    }
  }
  if (ACTIVE_STAGES.has(job.stage) && job.status === "RUNNING") {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "JOB_ALREADY_RUNNING",
      recoveryReason: null,
    };
  }

  const manifest =
    input.manifest !== undefined
      ? input.manifest
      : readUnifiedArtifact<BaseCollectionManifest>(
          job.caseId,
          job.unifiedJobId,
          "base-collection-manifest.json"
        );

  if (!manifest) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "BASE_MANIFEST_MISSING",
      recoveryReason: null,
    };
  }
  if (manifest.caseId !== job.caseId || manifest.unifiedJobId !== job.unifiedJobId) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "MANIFEST_LINEAGE_MISMATCH",
      recoveryReason: null,
    };
  }
  if (!manifestHasBaseObservations(manifest)) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "BASE_MANIFEST_EMPTY_OR_CORRUPT",
      recoveryReason: null,
    };
  }

  // Idempotent in-flight recovery checkpoint (same job, already rebound).
  if (
    (job.stage === "ARSENKIN_ENRICHMENT" || job.stage === "ORION_PREPARE") &&
    (job.status === "WAITING" || job.status === "RUNNING") &&
    Boolean(job.baseReportRunId) &&
    Boolean(job.recoveryAudit)
  ) {
    return {
      recoveryAllowed: true,
      recoveryBlockerReason: null,
      recoveryReason:
        job.resumeCheckpoint === "RENDER" || job.stage === "ORION_PREPARE"
          ? "IDEMPOTENT_RENDER_RESUME"
          : "IDEMPOTENT_RESUME",
    };
  }

  const enrichmentCount = job.enrichmentRunIds?.length ?? 0;
  const isRenderFailure =
    job.resumeCheckpoint === "RENDER" ||
    job.lastErrorCode === "RENDER_FAILED" ||
    /render failed/i.test(job.lastError ?? "");

  if (job.stage === "FAILED_RETRYABLE" && isRenderFailure) {
    if (!job.baseReportRunId || enrichmentCount < 5 || !job.compositeDatasetId) {
      return {
        recoveryAllowed: false,
        recoveryBlockerReason: "RENDER_RESUME_PRECONDITIONS_MISSING",
        recoveryReason: null,
      };
    }
    return {
      recoveryAllowed: true,
      recoveryBlockerReason: null,
      recoveryReason: "RENDER_RESUME",
    };
  }

  if (job.stage === "FAILED_RETRYABLE") {
    return {
      recoveryAllowed: true,
      recoveryBlockerReason: null,
      recoveryReason: "FAILED_RETRYABLE_RESUME",
    };
  }

  if (job.stage === "FAILED_TERMINAL") {
    const missingBaseId = !String(job.baseReportRunId ?? "").trim();
    const historical = hasHistoricalNoBaseReportDefect(job);
    if (missingBaseId && historical) {
      return {
        recoveryAllowed: true,
        recoveryBlockerReason: null,
        recoveryReason: "HISTORICAL_NO_BASE_REPORT_RUN",
      };
    }
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "FAILED_TERMINAL_NOT_RECOVERABLE",
      recoveryReason: null,
    };
  }

  return {
    recoveryAllowed: false,
    recoveryBlockerReason: `STAGE_NOT_RECOVERABLE:${job.stage}`,
    recoveryReason: null,
  };
}

export type RecoverUnifiedCollectionResult = {
  accepted: true;
  jobId: string;
  unifiedJobId: string;
  stage: string;
  status: string;
  baseReportRunId: string;
  recoveryReason: string;
  createdBaseReportRun: boolean;
  idempotent: boolean;
};

export type RecoverUnifiedCollectionDeps = {
  prisma?: PrismaClient | null;
  /** Override persist helper (offline fake prisma). */
  ensureBaseReportRun?: typeof ensurePersistedUnifiedBaseReportRun;
  /** When true, skip real prisma and allow fixture-scoped base id. */
  fixtureBaseRows?: unknown[] | null;
  /** Forwarded to scheduleUnifiedTick after recovery. */
  autoSchedule?: boolean;
  runFullAudit?: never;
  runArsenkinEnrichment?: (job: UnifiedCollectionJob) => Promise<unknown>;
  runPrepare?: (input: unknown) => Promise<unknown>;
  subjectProfile?: unknown;
  renderDeck?: unknown;
  allowMockReport?: boolean;
  now?: () => Date;
};

async function scheduleRecoverTick(
  caseId: string,
  deps: RecoverUnifiedCollectionDeps | undefined
): Promise<void> {
  if (deps?.autoSchedule === false) return;
  const { scheduleUnifiedTick } = await import("./unified-orion-collection-orchestrator");
  scheduleUnifiedTick(caseId, deps as Parameters<typeof scheduleUnifiedTick>[1]);
}

/**
 * Atomically recover the same jobId: persist base OrionReportRun from the
 * existing manifest, checkpoint at ARSENKIN_ENRICHMENT, schedule tick.
 * Never calls runFullAudit / base providers.
 */
export async function recoverUnifiedOrionCollectionJob(input: {
  caseId: string;
  jobId: string;
  actorId: string;
  deps?: RecoverUnifiedCollectionDeps;
}): Promise<RecoverUnifiedCollectionResult> {
  const jobId = String(input.jobId ?? "").trim();
  if (!jobId) throw new ValidationError("jobId is required");

  const nowFn = input.deps?.now ?? (() => new Date());
  const job0 = loadUnifiedCollectionJob(input.caseId);
  if (!job0) throw new NotFoundError("unified collection job not found");
  if (job0.jobId !== jobId && job0.unifiedJobId !== jobId) {
    throw new NotFoundError("jobId does not belong to this case");
  }

  const manifest0 = readUnifiedArtifact<BaseCollectionManifest>(
    job0.caseId,
    job0.unifiedJobId,
    "base-collection-manifest.json"
  );
  const elig = evaluateUnifiedCollectionRecoveryEligibility({
    caseId: input.caseId,
    job: job0,
    requestedJobId: jobId,
    manifest: manifest0,
    now: nowFn(),
  });
  if (!elig.recoveryAllowed) {
    throw new ConflictError(elig.recoveryBlockerReason ?? "recovery not allowed");
  }

  // Idempotent: already rebound / already at render or arsenkin checkpoint.
  if (
    elig.recoveryReason === "IDEMPOTENT_RESUME" ||
    elig.recoveryReason === "IDEMPOTENT_RENDER_RESUME" ||
    (job0.baseReportRunId &&
      (job0.enrichmentRunIds?.length ?? 0) >= 5 &&
      ACTIVE_STAGES.has(job0.stage))
  ) {
    await scheduleRecoverTick(input.caseId, input.deps);
    return {
      accepted: true,
      jobId: job0.jobId,
      unifiedJobId: job0.unifiedJobId,
      stage: job0.stage,
      status: job0.status,
      baseReportRunId: String(job0.baseReportRunId),
      recoveryReason: elig.recoveryReason ?? "IDEMPOTENT_RESUME",
      createdBaseReportRun: false,
      idempotent: true,
    };
  }

  const ownerId = `unified-recover-${process.pid}-${randomUUID().slice(0, 6)}`;
  const claimed = claimUnifiedJobLease({
    caseId: input.caseId,
    ownerId,
    leaseMs: 120_000,
    now: nowFn(),
  });
  if (!claimed) {
    throw new ConflictError("ACTIVE_LEASE");
  }

  try {
    // Re-check after lease (fail-closed race).
    const job = loadUnifiedCollectionJob(input.caseId);
    if (!job || (job.jobId !== jobId && job.unifiedJobId !== jobId)) {
      throw new NotFoundError("unified collection job not found");
    }
    const manifest = readUnifiedArtifact<BaseCollectionManifest>(
      job.caseId,
      job.unifiedJobId,
      "base-collection-manifest.json"
    );
    const elig2 = evaluateUnifiedCollectionRecoveryEligibility({
      caseId: input.caseId,
      job,
      requestedJobId: jobId,
      manifest,
      now: nowFn(),
      leaseOwnerId: ownerId,
      ignoreLease: true,
    });
    if (!elig2.recoveryAllowed || !manifest) {
      throw new ConflictError(elig2.recoveryBlockerReason ?? "recovery not allowed");
    }

    let prisma: PrismaClient | null = input.deps?.prisma ?? null;
    if (!prisma && !input.deps?.ensureBaseReportRun && !input.deps?.fixtureBaseRows) {
      try {
        prisma = (await import("@/server/prisma/client")).prisma;
      } catch {
        prisma = null;
      }
    }

    const renderResume = elig2.recoveryReason === "RENDER_RESUME";
    const ensure = input.deps?.ensureBaseReportRun ?? ensurePersistedUnifiedBaseReportRun;
    let baseReportRunId: string;
    let createdBaseReportRun = false;

    if (renderResume && job.baseReportRunId) {
      // Render checkpoint: reuse existing persisted base run — never recollect.
      baseReportRunId = job.baseReportRunId;
      createdBaseReportRun = false;
    } else if (input.deps?.ensureBaseReportRun || prisma) {
      if (!prisma && !input.deps?.ensureBaseReportRun) {
        throw new ConflictError("BASE_REPORT_RUN_PERSIST_UNAVAILABLE");
      }
      const ensured = await ensure({
        prisma: prisma as PrismaClient,
        caseId: job.caseId,
        unifiedJobId: job.unifiedJobId,
        existingBaseReportRunId: job.baseReportRunId ?? manifest.baseReportRunId,
      });
      baseReportRunId = ensured.baseReportRunId;
      createdBaseReportRun = ensured.created;
    } else if (input.deps?.fixtureBaseRows) {
      baseReportRunId =
        job.baseReportRunId ??
        manifest.baseReportRunId ??
        `fixture-base-${job.unifiedJobId}`;
      createdBaseReportRun = !job.baseReportRunId && !manifest.baseReportRunId;
    } else if (job.baseReportRunId) {
      baseReportRunId = job.baseReportRunId;
      createdBaseReportRun = false;
    } else {
      throw new ConflictError("BASE_REPORT_RUN_PERSIST_UNAVAILABLE");
    }

    if (!renderResume) {
      const nextManifest: BaseCollectionManifest = { ...manifest, baseReportRunId };
      writeUnifiedArtifact(
        job.caseId,
        job.unifiedJobId,
        "base-collection-manifest.json",
        nextManifest
      );

      const existingBinding = readUnifiedArtifact<ReportDataBinding>(
        job.caseId,
        job.unifiedJobId,
        "report-data-binding.json"
      );
      if (existingBinding) {
        writeUnifiedArtifact(job.caseId, job.unifiedJobId, "report-data-binding.json", {
          ...existingBinding,
          baseReportRunId,
        });
      }
    }

    const recoveryAudit: UnifiedRecoveryAudit = {
      recoveredFromStatus: job.status,
      recoveredFromStage: job.stage,
      recoveryRequestedAt: nowFn().toISOString(),
      recoveryRequestedBy: input.actorId,
      recoveryReason: elig2.recoveryReason ?? "RECOVERY",
      previousLastError: job.lastError,
      previousLastErrorCode: job.lastErrorCode,
    };

    const nextStage = renderResume ? "ORION_PREPARE" : "ARSENKIN_ENRICHMENT";
    const resumeCheckpoint = renderResume ? "RENDER" : "ARSENKIN_ENRICHMENT";
    const artifactsDir = unifiedArtifactsDir(job.caseId, job.unifiedJobId);
    if (renderResume) {
      const binding = readUnifiedArtifact<ReportDataBinding>(
        job.caseId,
        job.unifiedJobId,
        "report-data-binding.json"
      );
      const reusable = binding
        ? loadReusableAssembledDeck({
            artifactsDir,
            caseId: job.caseId,
            expectedDatasetId: binding.compositeDatasetId,
          })
        : null;
      writeUnifiedArtifact(job.caseId, job.unifiedJobId, "render-checkpoint.json", {
        version: "render-checkpoint-v1",
        stage: "RENDER",
        status: reusable ? "READY" : "NEEDS_ASSEMBLY",
        assemblyHash: reusable?.assemblyHash ?? null,
        caseId: job.caseId,
        unifiedJobId: job.unifiedJobId,
        updatedAt: nowFn().toISOString(),
      });
    }

    const patched =
      patchUnifiedCollectionJob(job.caseId, {
        stage: nextStage,
        status: "WAITING",
        baseReportRunId,
        resumeCheckpoint,
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        recoveryAudit,
        warnings: [
          ...job.warnings.filter((w) => !/recovery-accepted/i.test(w)),
          `recovery-accepted:${elig2.recoveryReason}`,
          renderResume ? "bounded-resume:from-render" : "bounded-resume:from-arsenkin",
        ],
      }) ?? job;

    writeUnifiedArtifact(job.caseId, job.unifiedJobId, "unified-recovery-audit.json", recoveryAudit);

    return {
      accepted: true,
      jobId: patched.jobId,
      unifiedJobId: patched.unifiedJobId,
      stage: nextStage,
      status: "WAITING",
      baseReportRunId,
      recoveryReason: elig2.recoveryReason ?? "RECOVERY",
      createdBaseReportRun,
      idempotent: false,
    };
  } finally {
    releaseUnifiedJobLease(input.caseId, ownerId);
    await scheduleRecoverTick(input.caseId, input.deps);
  }
}

/** Attach server-calculated recovery fields for GET status. */
export function withUnifiedRecoveryStatusFields(job: UnifiedCollectionJob | null): {
  recoveryAllowed: boolean;
  recoveryBlockerReason: string | null;
  recoveryReason: string | null;
} {
  if (!job) {
    return {
      recoveryAllowed: false,
      recoveryBlockerReason: "JOB_NOT_FOUND",
      recoveryReason: null,
    };
  }
  const elig = evaluateUnifiedCollectionRecoveryEligibility({
    caseId: job.caseId,
    job,
  });
  return {
    recoveryAllowed: elig.recoveryAllowed,
    recoveryBlockerReason: elig.recoveryBlockerReason,
    recoveryReason: elig.recoveryReason,
  };
}
