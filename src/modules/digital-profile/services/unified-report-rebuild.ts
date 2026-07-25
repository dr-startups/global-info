/**
 * Explicit "Пересобрать отчёт" for a COMPLETED unified job.
 * Re-runs analytics → deck assembly → render from the job's persisted composite
 * dataset (same jobId). Refreshes the job-scoped subject identity profile from
 * the case-owned artifact so profile edits (contextIdentifiers, namesake fixes)
 * take effect. NEVER calls base providers and NEVER creates Arsenkin
 * submissions — zero paid collection.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors";
import {
  claimUnifiedJobLease,
  loadUnifiedCollectionJob,
  readUnifiedArtifact,
  patchUnifiedCollectionJob,
  releaseUnifiedJobLease,
  unifiedArtifactsDir,
  writeUnifiedArtifact,
} from "./unified-collection-job-store";
import type {
  BaseCollectionManifest,
  ReportDataBinding,
  UnifiedCollectionJob,
} from "./unified-collection-types";
import type { CompositeMergeResult } from "./composite-serp-merge";
import { resolveJobSubjectProfile } from "./job-subject-profile";
import type { ClassifierSubjectProfile } from "../orion-golden/analytics/subject-resolution-classifier";
import { stripGptCopyFromSectionPacksOnDisk } from "../orion-golden/deck-sections/run-deck-build";

export type UnifiedReportRebuildEligibility = {
  rebuildAllowed: boolean;
  rebuildBlockerReason: string | null;
};

export type UnifiedReportRebuildAudit = {
  version: "unified-report-rebuild-audit-v1";
  rebuildRequestedAt: string;
  rebuildRequestedBy: string;
  previousStage: string;
  previousCompletedAt: string | null;
  subjectProfileRefreshed: boolean;
  /** State to put the job back into when the rebuild fails. */
  restoreSnapshot?: {
    stage: string;
    status: string;
    progress: number;
    completedAt: string | null;
    reportLinks: Record<string, string>;
  };
};

export type RebuildUnifiedReportResult = {
  accepted: true;
  jobId: string;
  unifiedJobId: string;
  stage: string;
  status: string;
  subjectProfileRefreshed: boolean;
};

export type RebuildUnifiedReportDeps = {
  /** Forwarded to scheduleUnifiedTick after the rebuild transition. */
  autoSchedule?: boolean;
  subjectProfile?: ClassifierSubjectProfile | null;
  renderDeck?: unknown;
  runPrepare?: (input: unknown) => Promise<unknown>;
  allowMockReport?: boolean;
  now?: () => Date;
};

function leaseIsActive(job: UnifiedCollectionJob, now: Date): boolean {
  if (!job.leaseOwnerId || !job.leaseUntil) return false;
  const until = Date.parse(job.leaseUntil);
  return Number.isFinite(until) && until > now.getTime();
}

/**
 * Pure eligibility for report rebuild. Server-side only — never trust a client
 * flag. Rebuild is offered exclusively for jobs that already completed a render
 * (failed jobs go through recovery instead) and whose prepare inputs
 * (manifest + binding + composite) are present with matching lineage.
 */
export async function evaluateUnifiedReportRebuildEligibility(input: {
  caseId: string;
  job: UnifiedCollectionJob | null;
  requestedJobId?: string | null;
  now?: Date;
  /** Skip lease gate (internal re-check after claim). */
  ignoreLease?: boolean;
}): Promise<UnifiedReportRebuildEligibility> {
  const now = input.now ?? new Date();
  const job = input.job;
  if (!job) return { rebuildAllowed: false, rebuildBlockerReason: "JOB_NOT_FOUND" };
  if (job.caseId !== input.caseId) {
    return { rebuildAllowed: false, rebuildBlockerReason: "FOREIGN_CASE" };
  }
  const requested = String(input.requestedJobId ?? "").trim();
  if (requested && requested !== job.jobId && requested !== job.unifiedJobId) {
    return { rebuildAllowed: false, rebuildBlockerReason: "JOB_ID_MISMATCH" };
  }
  const completed =
    (job.stage === "REPORT_READY" || job.stage === "COMPLETED_PARTIAL") &&
    job.status === "COMPLETED";
  if (!completed) {
    return { rebuildAllowed: false, rebuildBlockerReason: "JOB_NOT_COMPLETED" };
  }
  if (!input.ignoreLease && leaseIsActive(job, now)) {
    return { rebuildAllowed: false, rebuildBlockerReason: "ACTIVE_LEASE" };
  }

  const manifest = await readUnifiedArtifact<BaseCollectionManifest>(
    job.caseId,
    job.unifiedJobId,
    "base-collection-manifest.json"
  );
  const binding = await readUnifiedArtifact<ReportDataBinding>(
    job.caseId,
    job.unifiedJobId,
    "report-data-binding.json"
  );
  const merge = await readUnifiedArtifact<CompositeMergeResult>(
    job.caseId,
    job.unifiedJobId,
    "composite-serp-observations.json"
  );
  if (!manifest || !binding || !merge) {
    return { rebuildAllowed: false, rebuildBlockerReason: "REBUILD_INPUTS_MISSING" };
  }
  if (
    binding.caseId !== job.caseId ||
    binding.unifiedJobId !== job.unifiedJobId ||
    binding.compositeDatasetId !== merge.compositeDatasetId ||
    (merge.provenance?.unifiedJobId && merge.provenance.unifiedJobId !== job.unifiedJobId)
  ) {
    return { rebuildAllowed: false, rebuildBlockerReason: "REBUILD_LINEAGE_MISMATCH" };
  }

  return { rebuildAllowed: true, rebuildBlockerReason: null };
}

async function scheduleRebuildTick(
  caseId: string,
  deps: RebuildUnifiedReportDeps | undefined
): Promise<void> {
  if (deps?.autoSchedule === false) return;
  const { scheduleUnifiedTick } = await import("./unified-orion-collection-orchestrator");
  scheduleUnifiedTick(caseId, deps as Parameters<typeof scheduleUnifiedTick>[1]);
}

/**
 * Atomically transition the same jobId back to COMPOSITE_MERGE (full rebuild,
 * not render-only resume): the tick re-merges the composite from the persisted
 * base manifest + already-ingested Arsenkin observations (refreshing surface
 * hints, region normalization and the case-corpus image supplement), then runs
 * analytics/assembly and exactly one render. Zero base/Arsenkin provider calls.
 */
export async function rebuildUnifiedReport(input: {
  caseId: string;
  jobId: string;
  actorId: string;
  deps?: RebuildUnifiedReportDeps;
}): Promise<RebuildUnifiedReportResult> {
  const jobId = String(input.jobId ?? "").trim();
  if (!jobId) throw new ValidationError("jobId is required");

  const nowFn = input.deps?.now ?? (() => new Date());
  const job0 = await loadUnifiedCollectionJob(input.caseId);
  if (!job0) throw new NotFoundError("unified collection job not found");
  if (job0.jobId !== jobId && job0.unifiedJobId !== jobId) {
    throw new NotFoundError("jobId does not belong to this case");
  }

  const elig = await evaluateUnifiedReportRebuildEligibility({
    caseId: input.caseId,
    job: job0,
    requestedJobId: jobId,
    now: nowFn(),
  });
  if (!elig.rebuildAllowed) {
    throw new ConflictError(elig.rebuildBlockerReason ?? "rebuild not allowed");
  }

  const ownerId = `unified-rebuild-${process.pid}-${randomUUID().slice(0, 6)}`;
  const claimed = await claimUnifiedJobLease({
    caseId: input.caseId,
    ownerId,
    leaseMs: 120_000,
    now: nowFn(),
  });
  if (!claimed) throw new ConflictError("ACTIVE_LEASE");

  try {
    // Re-check after lease (fail-closed race).
    const job = await loadUnifiedCollectionJob(input.caseId);
    if (!job || (job.jobId !== jobId && job.unifiedJobId !== jobId)) {
      throw new NotFoundError("unified collection job not found");
    }
    const elig2 = await evaluateUnifiedReportRebuildEligibility({
      caseId: input.caseId,
      job,
      requestedJobId: jobId,
      now: nowFn(),
      ignoreLease: true,
    });
    if (!elig2.rebuildAllowed) {
      throw new ConflictError(elig2.rebuildBlockerReason ?? "rebuild not allowed");
    }

    // Refresh the job-scoped subject identity from the case-owned artifact so
    // an updated profile (contextIdentifiers, cleaned negative signals) is
    // picked up by the canonical prepare. Absent profile keeps the existing
    // job copy; prepare still fails closed if none exists.
    const refreshedProfile = await resolveJobSubjectProfile({
      caseId: job.caseId,
      injected: input.deps?.subjectProfile ?? null,
    });
    if (refreshedProfile) {
      await writeUnifiedArtifact(
        job.caseId,
        job.unifiedJobId,
        "subject-identity-profile.json",
        refreshedProfile
      );
    }

    // Snapshot enough to put the job back exactly as it was. Rebuilding report
    // text must never be able to destroy the result of a successful paid
    // collection: a failed attempt used to leave the job FAILED_TERMINAL, which
    // both /rebuild-report and /recover then refuse (step 08.0-ter).
    const audit: UnifiedReportRebuildAudit = {
      version: "unified-report-rebuild-audit-v1",
      rebuildRequestedAt: nowFn().toISOString(),
      rebuildRequestedBy: input.actorId,
      previousStage: job.stage,
      previousCompletedAt: job.completedAt,
      subjectProfileRefreshed: Boolean(refreshedProfile),
      restoreSnapshot: {
        stage: job.stage,
        status: job.status,
        progress: job.progress,
        completedAt: job.completedAt ?? null,
        reportLinks: job.reportLinks ?? {},
      },
    };
    await writeUnifiedArtifact(job.caseId, job.unifiedJobId, "unified-rebuild-audit.json", audit);
    // Defense in depth: full prepare always forceRefresh-es stage 2, but also
    // strip on-disk gptCopy + audit marker so a partial deploy cannot revive
    // SKIPPED_CACHED (live symptom: применено 0 · кэш N).
    const deckDir = join(unifiedArtifactsDir(job.caseId, job.unifiedJobId), "deck");
    const strippedGptCopy = stripGptCopyFromSectionPacksOnDisk(deckDir);
    await writeUnifiedArtifact(job.caseId, job.unifiedJobId, "force-gpt-copy.json", {
      version: "force-gpt-copy-v1",
      requestedAt: nowFn().toISOString(),
      requestedBy: input.actorId,
      reason: "unified-report-rebuild",
      strippedGptCopy,
    });

    const patched =
      await patchUnifiedCollectionJob(job.caseId, {
        stage: "COMPOSITE_MERGE",
        status: "WAITING",
        progress: 0.55,
        // Full rebuild: composite re-merge + analytics + assembly re-run.
        resumeCheckpoint: null,
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        reportLinks: {},
        pollAttempt: 0,
        nextPollAt: null,
        warnings: [
          ...job.warnings.filter((w) => !/report-rebuild-accepted/i.test(w)),
          "report-rebuild-accepted",
        ],
      }) ?? job;

    return {
      accepted: true,
      jobId: patched.jobId,
      unifiedJobId: patched.unifiedJobId,
      stage: patched.stage,
      status: patched.status,
      subjectProfileRefreshed: Boolean(refreshedProfile),
    };
  } finally {
    await releaseUnifiedJobLease(input.caseId, ownerId);
    await scheduleRebuildTick(input.caseId, input.deps);
  }
}
