/**
 * REMEDIATION §4.3 — «Дожать GPT-копирайт» for a unified job.
 *
 * Retries only FALLBACK_* stage-2 fragments from persisted section packs,
 * reassembles the deck and runs one render. Never starts base collection and
 * never creates Arsenkin submissions.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConflictError, NotFoundError, ValidationError } from "../http/errors";
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
} from "./unified-collection-types";
import type { CompositeMergeResult } from "./composite-serp-merge";
import { loadPreviousPacks } from "../orion-golden/deck-sections/run-deck-build";

export type UnifiedGptCopyRetryEligibility = {
  gptCopyRetryAllowed: boolean;
  gptCopyRetryBlockerReason: string | null;
  fallbackFragmentCount: number;
};

export type UnifiedGptCopyRetryAudit = {
  version: "unified-gpt-copy-retry-audit-v1";
  requestedAt: string;
  requestedBy: string;
  previousStage: string;
  previousCompletedAt: string | null;
  fallbackFragmentCount: number;
};

export type RetryUnifiedGptCopyResult = {
  accepted: true;
  jobId: string;
  unifiedJobId: string;
  stage: string;
  status: string;
  resumeCheckpoint: "GPT_COPY";
  fallbackFragmentCount: number;
};

export type RetryUnifiedGptCopyDeps = {
  autoSchedule?: boolean;
  now?: () => Date;
};

function leaseIsActive(job: UnifiedCollectionJob, now: Date): boolean {
  if (!job.leaseOwnerId || !job.leaseUntil) return false;
  const until = Date.parse(job.leaseUntil);
  return Number.isFinite(until) && until > now.getTime();
}

function countFallbackFragments(caseId: string, unifiedJobId: string): number {
  const reportPath = join(
    unifiedArtifactsDir(caseId, unifiedJobId),
    "deck",
    "gpt-report-copy.json"
  );
  if (!existsSync(reportPath)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(reportPath, "utf8")) as {
      fragments?: Array<{ status?: string; fragmentKey?: string }>;
    };
    return (parsed.fragments ?? []).filter((f) =>
      String(f.status ?? "").startsWith("FALLBACK_")
    ).length;
  } catch {
    return 0;
  }
}

function countFallbackPackStamps(caseId: string, unifiedJobId: string): number {
  const deckRoot = join(unifiedArtifactsDir(caseId, unifiedJobId), "deck");
  if (!existsSync(deckRoot)) return 0;
  const packs = loadPreviousPacks(deckRoot);
  let n = 0;
  for (const pack of packs.values()) {
    if (pack.gptCopy?.lastStatus?.startsWith("FALLBACK_")) n += 1;
  }
  return n;
}

/**
 * Pure eligibility for selective GPT stage-2 retry. Server-side only.
 * Allowed for REPORT_READY / COMPLETED_PARTIAL and FAILED_RETRYABLE when the
 * failure is render-related (packs already exist).
 */
export function evaluateUnifiedGptCopyRetryEligibility(input: {
  caseId: string;
  job: UnifiedCollectionJob | null;
  requestedJobId?: string | null;
  now?: Date;
  ignoreLease?: boolean;
}): UnifiedGptCopyRetryEligibility {
  const now = input.now ?? new Date();
  const job = input.job;
  if (!job) {
    return {
      gptCopyRetryAllowed: false,
      gptCopyRetryBlockerReason: "JOB_NOT_FOUND",
      fallbackFragmentCount: 0,
    };
  }
  if (job.caseId !== input.caseId) {
    return {
      gptCopyRetryAllowed: false,
      gptCopyRetryBlockerReason: "FOREIGN_CASE",
      fallbackFragmentCount: 0,
    };
  }
  const requested = String(input.requestedJobId ?? "").trim();
  if (requested && requested !== job.jobId && requested !== job.unifiedJobId) {
    return {
      gptCopyRetryAllowed: false,
      gptCopyRetryBlockerReason: "JOB_ID_MISMATCH",
      fallbackFragmentCount: 0,
    };
  }

  const completed =
    (job.stage === "REPORT_READY" || job.stage === "COMPLETED_PARTIAL") &&
    job.status === "COMPLETED";
  const renderRetryable =
    job.stage === "FAILED_RETRYABLE" &&
    (job.resumeCheckpoint === "RENDER" ||
      job.lastErrorCode === "RENDER_FAILED" ||
      /render failed/i.test(job.lastError ?? ""));
  if (!completed && !renderRetryable) {
    return {
      gptCopyRetryAllowed: false,
      gptCopyRetryBlockerReason: "JOB_NOT_ELIGIBLE",
      fallbackFragmentCount: 0,
    };
  }
  if (!input.ignoreLease && leaseIsActive(job, now)) {
    return {
      gptCopyRetryAllowed: false,
      gptCopyRetryBlockerReason: "ACTIVE_LEASE",
      fallbackFragmentCount: 0,
    };
  }

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
  if (!manifest || !binding || !merge) {
    return {
      gptCopyRetryAllowed: false,
      gptCopyRetryBlockerReason: "RETRY_INPUTS_MISSING",
      fallbackFragmentCount: 0,
    };
  }

  const fromReport = countFallbackFragments(job.caseId, job.unifiedJobId);
  const fromPacks =
    fromReport > 0 ? 0 : countFallbackPackStamps(job.caseId, job.unifiedJobId);
  const fallbackFragmentCount = fromReport > 0 ? fromReport : fromPacks;
  if (fallbackFragmentCount <= 0) {
    return {
      gptCopyRetryAllowed: false,
      gptCopyRetryBlockerReason: "NO_FALLBACK_FRAGMENTS",
      fallbackFragmentCount: 0,
    };
  }

  return {
    gptCopyRetryAllowed: true,
    gptCopyRetryBlockerReason: null,
    fallbackFragmentCount,
  };
}

async function scheduleRetryTick(
  caseId: string,
  deps: RetryUnifiedGptCopyDeps | undefined
): Promise<void> {
  if (deps?.autoSchedule === false) return;
  const { scheduleUnifiedTick } = await import("./unified-orion-collection-orchestrator");
  scheduleUnifiedTick(caseId, deps as Parameters<typeof scheduleUnifiedTick>[1]);
}

export async function retryUnifiedGptCopy(input: {
  caseId: string;
  jobId: string;
  actorId: string;
  deps?: RetryUnifiedGptCopyDeps;
}): Promise<RetryUnifiedGptCopyResult> {
  const jobId = String(input.jobId ?? "").trim();
  if (!jobId) throw new ValidationError("jobId is required");

  const nowFn = input.deps?.now ?? (() => new Date());
  const job0 = loadUnifiedCollectionJob(input.caseId);
  if (!job0) throw new NotFoundError("unified collection job not found");
  if (job0.jobId !== jobId && job0.unifiedJobId !== jobId) {
    throw new NotFoundError("jobId does not belong to this case");
  }

  const elig = evaluateUnifiedGptCopyRetryEligibility({
    caseId: input.caseId,
    job: job0,
    requestedJobId: jobId,
    now: nowFn(),
  });
  if (!elig.gptCopyRetryAllowed) {
    throw new ConflictError(elig.gptCopyRetryBlockerReason ?? "gpt-copy retry not allowed");
  }

  const ownerId = `unified-gpt-copy-${process.pid}-${randomUUID().slice(0, 6)}`;
  const claimed = claimUnifiedJobLease({
    caseId: input.caseId,
    ownerId,
    leaseMs: 120_000,
    now: nowFn(),
  });
  if (!claimed) throw new ConflictError("ACTIVE_LEASE");

  try {
    const job = loadUnifiedCollectionJob(input.caseId);
    if (!job || (job.jobId !== jobId && job.unifiedJobId !== jobId)) {
      throw new NotFoundError("unified collection job not found");
    }
    const elig2 = evaluateUnifiedGptCopyRetryEligibility({
      caseId: input.caseId,
      job,
      requestedJobId: jobId,
      now: nowFn(),
      ignoreLease: true,
    });
    if (!elig2.gptCopyRetryAllowed) {
      throw new ConflictError(
        elig2.gptCopyRetryBlockerReason ?? "gpt-copy retry not allowed"
      );
    }

    const audit: UnifiedGptCopyRetryAudit = {
      version: "unified-gpt-copy-retry-audit-v1",
      requestedAt: nowFn().toISOString(),
      requestedBy: input.actorId,
      previousStage: job.stage,
      previousCompletedAt: job.completedAt,
      fallbackFragmentCount: elig2.fallbackFragmentCount,
    };
    writeUnifiedArtifact(
      job.caseId,
      job.unifiedJobId,
      "unified-gpt-copy-retry-audit.json",
      audit
    );

    const patched =
      patchUnifiedCollectionJob(job.caseId, {
        stage: "ORION_PREPARE",
        status: "WAITING",
        progress: 0.7,
        resumeCheckpoint: "GPT_COPY",
        lastError: null,
        lastErrorCode: null,
        completedAt: null,
        pollAttempt: 0,
        nextPollAt: null,
        warnings: [
          ...job.warnings.filter((w) => !/gpt-copy-retry-accepted/i.test(w)),
          "gpt-copy-retry-accepted",
        ],
      }) ?? job;

    return {
      accepted: true,
      jobId: patched.jobId,
      unifiedJobId: patched.unifiedJobId,
      stage: patched.stage,
      status: patched.status,
      resumeCheckpoint: "GPT_COPY" as const,
      fallbackFragmentCount: elig2.fallbackFragmentCount,
    };
  } finally {
    releaseUnifiedJobLease(input.caseId, ownerId);
    await scheduleRetryTick(input.caseId, input.deps);
  }
}
