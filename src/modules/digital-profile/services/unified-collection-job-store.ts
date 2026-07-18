/**
 * Durable file-backed unified collection job store.
 * Atomic rename, lease/owner, version, unique active caseId, bounded resume.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  emptyCoverage,
  type UnifiedCollectionJob,
  type UnifiedCollectionStage,
} from "./unified-collection-types";
import { writeJsonAtomic } from "../providers/arsenkin/arsenkin-db-readiness";

const ACTIVE_STAGES = new Set<UnifiedCollectionStage>([
  "BASE_COLLECTION",
  "ARSENKIN_ENRICHMENT",
  "COMPOSITE_MERGE",
  "ORION_PREPARE",
  "CLIENT_CONTENT",
]);

function rootDir(): string {
  return join(process.cwd(), "storage", "digital-profile", "unified-orion-collection");
}

export function unifiedJobDir(caseId: string): string {
  return join(rootDir(), caseId);
}

export function unifiedJobPath(caseId: string): string {
  return join(unifiedJobDir(caseId), "job.json");
}

export function unifiedArtifactsDir(caseId: string, unifiedJobId: string): string {
  return join(unifiedJobDir(caseId), unifiedJobId);
}

function readJobRaw(caseId: string): UnifiedCollectionJob | null {
  const path = unifiedJobPath(caseId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as UnifiedCollectionJob;
  } catch {
    return null;
  }
}

export function loadUnifiedCollectionJob(caseId: string): UnifiedCollectionJob | null {
  return readJobRaw(caseId);
}

export function saveUnifiedCollectionJob(job: UnifiedCollectionJob): void {
  const path = unifiedJobPath(job.caseId);
  mkdirSync(dirname(path), { recursive: true });
  const next: UnifiedCollectionJob = {
    ...job,
    versionNum: (job.versionNum ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path, next);
}

export function findOrCreateUnifiedCollectionJob(input: {
  caseId: string;
  requestedBy: string;
  arsenkinMode?: "full-first36";
  /** When true, always create a new job (paid recollection confirmation path). */
  forceNew?: boolean;
}): { job: UnifiedCollectionJob; created: boolean } {
  const existing = loadUnifiedCollectionJob(input.caseId);
  if (
    !input.forceNew &&
    existing &&
    !existing.cancelRequested &&
    (ACTIVE_STAGES.has(existing.stage) ||
      existing.stage === "FAILED_RETRYABLE" ||
      existing.status === "RUNNING" ||
      existing.status === "WAITING")
  ) {
    // Reuse in-flight / retryable jobs — never spawn a second base collection.
    return { job: existing, created: false };
  }

  const now = new Date().toISOString();
  const unifiedJobId = `unified-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const job: UnifiedCollectionJob = {
    version: "unified-orion-collection-job-v1",
    jobId: unifiedJobId,
    unifiedJobId,
    caseId: input.caseId,
    stage: "BASE_COLLECTION",
    status: "RUNNING",
    progress: 0,
    versionNum: 0,
    leaseOwnerId: null,
    leaseUntil: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    requestedBy: input.requestedBy,
    arsenkinMode: input.arsenkinMode ?? "full-first36",
    baseReportRunId: null,
    arsenkinReportRunId: null,
    compositeDatasetId: null,
    actualProviders: [],
    coverage: emptyCoverage(),
    warnings: [],
    lastError: null,
    lastErrorCode: null,
    artifactPaths: {},
    reportLinks: {},
    cancelRequested: false,
  };
  mkdirSync(unifiedArtifactsDir(input.caseId, unifiedJobId), { recursive: true });
  saveUnifiedCollectionJob(job);
  return { job: loadUnifiedCollectionJob(input.caseId)!, created: true };
}

export function patchUnifiedCollectionJob(
  caseId: string,
  patch: Partial<UnifiedCollectionJob>
): UnifiedCollectionJob | null {
  const cur = loadUnifiedCollectionJob(caseId);
  if (!cur) return null;
  const next = { ...cur, ...patch, caseId: cur.caseId, jobId: cur.jobId, unifiedJobId: cur.unifiedJobId };
  saveUnifiedCollectionJob(next);
  return loadUnifiedCollectionJob(caseId);
}

export function claimUnifiedJobLease(input: {
  caseId: string;
  ownerId: string;
  leaseMs?: number;
  now?: Date;
}): UnifiedCollectionJob | null {
  const job = loadUnifiedCollectionJob(input.caseId);
  if (!job) return null;
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? 90_000;
  if (job.leaseOwnerId && job.leaseUntil) {
    const until = Date.parse(job.leaseUntil);
    if (Number.isFinite(until) && until > now.getTime() && job.leaseOwnerId !== input.ownerId) {
      return null;
    }
  }
  return patchUnifiedCollectionJob(input.caseId, {
    leaseOwnerId: input.ownerId,
    leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
  });
}

export function releaseUnifiedJobLease(caseId: string, ownerId: string): void {
  const job = loadUnifiedCollectionJob(caseId);
  if (!job || job.leaseOwnerId !== ownerId) return;
  patchUnifiedCollectionJob(caseId, { leaseOwnerId: null, leaseUntil: null });
}

/** Bounded restart recovery: only active/waiting jobs, not terminal. */
export function listResumableUnifiedJobs(): Array<{ caseId: string; stage: UnifiedCollectionStage }> {
  const root = rootDir();
  if (!existsSync(root)) return [];
  const out: Array<{ caseId: string; stage: UnifiedCollectionStage }> = [];
  for (const caseId of readdirSync(root)) {
    const job = loadUnifiedCollectionJob(caseId);
    if (!job) continue;
    if (job.status === "COMPLETED" || job.status === "CANCELLED") continue;
    if (job.stage === "REPORT_READY" || job.stage === "COMPLETED_PARTIAL" || job.stage === "FAILED_TERMINAL") {
      continue;
    }
    // FAILED_RETRYABLE waits for explicit recovery — never auto-pump
    // (status may still be WAITING; stage is the source of truth).
    if (job.stage === "FAILED_RETRYABLE") continue;
    // Active pipeline stages only (do not re-collect base).
    if (ACTIVE_STAGES.has(job.stage) && (job.status === "WAITING" || job.status === "RUNNING")) {
      out.push({ caseId, stage: job.stage });
    }
  }
  return out;
}

/** Test helper: wipe job file. */
export function deleteUnifiedCollectionJobForTests(caseId: string): void {
  const path = unifiedJobPath(caseId);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}

export function writeUnifiedArtifact(caseId: string, unifiedJobId: string, name: string, payload: unknown): string {
  const dir = unifiedArtifactsDir(caseId, unifiedJobId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeJsonAtomic(path, payload);
  return path;
}

export function readUnifiedArtifact<T>(caseId: string, unifiedJobId: string, name: string): T | null {
  const path = join(unifiedArtifactsDir(caseId, unifiedJobId), name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

// silence unused import of renameSync if writeJsonAtomic handles it
void renameSync;
void writeFileSync;
