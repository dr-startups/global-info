/**
 * Unified collection job store (REMEDIATION §9.4).
 *
 * Modes via UNIFIED_COLLECTION_JOB_STORE=file|db (default / unset = file).
 * File mode: job.json + artifacts on disk (offline smokes / CI).
 * DB mode: Prisma UnifiedCollectionJobRecord with atomic lease CAS; artifacts stay on disk.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  emptyCoverage,
  type UnifiedCollectionJob,
  type UnifiedCollectionStage,
} from "./unified-collection-types";
import { writeJsonAtomic } from "../providers/arsenkin/arsenkin-db-readiness";
import { caseStatusForStage } from "./unified-case-status-sync";

const ACTIVE_STAGES = new Set<UnifiedCollectionStage>([
  "BASE_COLLECTION",
  "ARSENKIN_ENRICHMENT",
  "COMPOSITE_MERGE",
  "ORION_PREPARE",
  "CLIENT_CONTENT",
]);

export type UnifiedCollectionJobStoreMode = "file" | "db";

export function getUnifiedCollectionJobStoreMode(): UnifiedCollectionJobStoreMode {
  const raw = String(process.env.UNIFIED_COLLECTION_JOB_STORE ?? "")
    .trim()
    .toLowerCase();
  return raw === "db" ? "db" : "file";
}

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

export function artifactStorageKey(caseId: string, unifiedJobId: string, name: string): string {
  return `unified-orion-collection/${caseId}/${unifiedJobId}/${name}`;
}

type JobPayloadJson = Omit<
  UnifiedCollectionJob,
  | "jobId"
  | "unifiedJobId"
  | "caseId"
  | "stage"
  | "status"
  | "progress"
  | "versionNum"
  | "leaseOwnerId"
  | "leaseUntil"
  | "createdAt"
  | "updatedAt"
  | "startedAt"
  | "completedAt"
  | "requestedBy"
  | "arsenkinMode"
  | "baseReportRunId"
  | "arsenkinReportRunId"
  | "compositeDatasetId"
  | "cancelRequested"
  | "resumeCheckpoint"
  | "nextPollAt"
  | "pollAttempt"
  | "artifactPaths"
  | "reportLinks"
>;

type ArtifactKeyMap = Record<string, string>;
type ReportLinkKeyMap = { pdf?: string; pptx?: string; contactSheet?: string };

type DbRow = {
  caseId: string;
  jobId: string;
  unifiedJobId: string;
  stage: string;
  status: string;
  progress: number;
  versionNum: number;
  leaseOwnerId: string | null;
  leaseUntil: Date | null;
  requestedBy: string;
  arsenkinMode: string | null;
  baseReportRunId: string | null;
  arsenkinReportRunId: string | null;
  compositeDatasetId: string | null;
  cancelRequested: boolean;
  resumeCheckpoint: string | null;
  nextPollAt: Date | null;
  pollAttempt: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  payloadJson: Prisma.JsonValue;
  artifactKeys: Prisma.JsonValue;
  reportLinkKeys: Prisma.JsonValue;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function splitJob(job: UnifiedCollectionJob): {
  payload: JobPayloadJson;
  artifactKeys: ArtifactKeyMap;
  reportLinkKeys: ReportLinkKeyMap;
} {
  const {
    jobId: _jobId,
    unifiedJobId: _unifiedJobId,
    caseId: _caseId,
    stage: _stage,
    status: _status,
    progress: _progress,
    versionNum: _versionNum,
    leaseOwnerId: _leaseOwnerId,
    leaseUntil: _leaseUntil,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    startedAt: _startedAt,
    completedAt: _completedAt,
    requestedBy: _requestedBy,
    arsenkinMode: _arsenkinMode,
    baseReportRunId: _baseReportRunId,
    arsenkinReportRunId: _arsenkinReportRunId,
    compositeDatasetId: _compositeDatasetId,
    cancelRequested: _cancelRequested,
    resumeCheckpoint: _resumeCheckpoint,
    nextPollAt: _nextPollAt,
    pollAttempt: _pollAttempt,
    artifactPaths,
    reportLinks,
    ...payload
  } = job;
  return {
    payload: payload as JobPayloadJson,
    artifactKeys: { ...(artifactPaths ?? {}) },
    reportLinkKeys: { ...(reportLinks ?? {}) },
  };
}

function rowToJob(row: DbRow): UnifiedCollectionJob {
  const payload = asRecord(row.payloadJson);
  const artifactKeys = asRecord(row.artifactKeys) as ArtifactKeyMap;
  const reportLinkKeys = asRecord(row.reportLinkKeys) as ReportLinkKeyMap;
  return {
    ...(payload as JobPayloadJson),
    version: (payload.version as UnifiedCollectionJob["version"]) ?? "unified-orion-collection-job-v1",
    jobId: row.jobId,
    unifiedJobId: row.unifiedJobId,
    caseId: row.caseId,
    stage: row.stage as UnifiedCollectionStage,
    status: row.status as UnifiedCollectionJob["status"],
    progress: row.progress,
    versionNum: row.versionNum,
    leaseOwnerId: row.leaseOwnerId,
    leaseUntil: row.leaseUntil ? row.leaseUntil.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    requestedBy: row.requestedBy,
    arsenkinMode: (row.arsenkinMode as UnifiedCollectionJob["arsenkinMode"]) ?? "full-first36",
    baseReportRunId: row.baseReportRunId,
    arsenkinReportRunId: row.arsenkinReportRunId,
    compositeDatasetId: row.compositeDatasetId,
    cancelRequested: row.cancelRequested,
    resumeCheckpoint: (row.resumeCheckpoint as UnifiedCollectionJob["resumeCheckpoint"]) ?? null,
    nextPollAt: row.nextPollAt ? row.nextPollAt.toISOString() : null,
    pollAttempt: row.pollAttempt ?? undefined,
    artifactPaths: artifactKeys,
    reportLinks: reportLinkKeys,
    actualProviders: (payload.actualProviders as UnifiedCollectionJob["actualProviders"]) ?? [],
    coverage: (payload.coverage as UnifiedCollectionJob["coverage"]) ?? null,
    warnings: (payload.warnings as string[]) ?? [],
    lastError: (payload.lastError as string | null) ?? null,
    lastErrorCode: (payload.lastErrorCode as string | null) ?? null,
  };
}

function parseIso(value: string | null | undefined): Date | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

async function getPrisma(): Promise<PrismaClient> {
  const { prisma } = await import("@/server/prisma/client");
  return prisma;
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

function writeJobFile(job: UnifiedCollectionJob): UnifiedCollectionJob {
  const path = unifiedJobPath(job.caseId);
  mkdirSync(dirname(path), { recursive: true });
  const next: UnifiedCollectionJob = {
    ...job,
    versionNum: (job.versionNum ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(path, next);
  return next;
}

function isResumableJob(job: UnifiedCollectionJob): boolean {
  if (job.status === "COMPLETED" || job.status === "CANCELLED") return false;
  if (job.stage === "REPORT_READY" || job.stage === "COMPLETED_PARTIAL" || job.stage === "FAILED_TERMINAL") {
    return false;
  }
  if (job.stage === "FAILED_RETRYABLE") return false;
  return ACTIVE_STAGES.has(job.stage) && (job.status === "WAITING" || job.status === "RUNNING");
}

// ---------------------------------------------------------------------------
// File mode
// ---------------------------------------------------------------------------

async function fileLoad(caseId: string): Promise<UnifiedCollectionJob | null> {
  return readJobRaw(caseId);
}

async function fileSave(job: UnifiedCollectionJob): Promise<UnifiedCollectionJob> {
  const existing = readJobRaw(job.caseId);
  if (existing && existing.versionNum !== (job.versionNum ?? 0)) {
    // One retry: reload and re-apply with latest versionNum if caller raced.
    const retried = { ...job, versionNum: existing.versionNum };
    return writeJobFile(retried);
  }
  return writeJobFile(job);
}

async function fileFindOrCreate(input: {
  caseId: string;
  requestedBy: string;
  arsenkinMode?: "full-first36";
  forceNew?: boolean;
}): Promise<{ job: UnifiedCollectionJob; created: boolean }> {
  const existing = await fileLoad(input.caseId);
  if (
    !input.forceNew &&
    existing &&
    !existing.cancelRequested &&
    (ACTIVE_STAGES.has(existing.stage) ||
      existing.stage === "FAILED_RETRYABLE" ||
      existing.status === "RUNNING" ||
      existing.status === "WAITING")
  ) {
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
  const saved = await fileSave(job);
  return { job: saved, created: true };
}

async function filePatch(
  caseId: string,
  patch: Partial<UnifiedCollectionJob>
): Promise<UnifiedCollectionJob | null> {
  const cur = await fileLoad(caseId);
  if (!cur) return null;
  const next = { ...cur, ...patch, caseId: cur.caseId, jobId: cur.jobId, unifiedJobId: cur.unifiedJobId };
  return fileSave(next);
}

async function fileClaim(input: {
  caseId: string;
  ownerId: string;
  leaseMs?: number;
  now?: Date;
}): Promise<UnifiedCollectionJob | null> {
  const job = await fileLoad(input.caseId);
  if (!job) return null;
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? 90_000;
  if (job.leaseOwnerId && job.leaseUntil) {
    const until = Date.parse(job.leaseUntil);
    if (Number.isFinite(until) && until > now.getTime() && job.leaseOwnerId !== input.ownerId) {
      return null;
    }
  }
  return filePatch(input.caseId, {
    leaseOwnerId: input.ownerId,
    leaseUntil: new Date(now.getTime() + leaseMs).toISOString(),
  });
}

async function fileRelease(caseId: string, ownerId: string): Promise<void> {
  const job = await fileLoad(caseId);
  if (!job || job.leaseOwnerId !== ownerId) return;
  await filePatch(caseId, { leaseOwnerId: null, leaseUntil: null });
}

async function fileListResumable(): Promise<Array<{ caseId: string; stage: UnifiedCollectionStage }>> {
  const root = rootDir();
  if (!existsSync(root)) return [];
  const out: Array<{ caseId: string; stage: UnifiedCollectionStage }> = [];
  const { fixtureCaseIds } = await import("../workflow/fixture-cases");
  const fixtures = await fixtureCaseIds();
  for (const caseId of readdirSync(root)) {
    // Фикстуры не возобновляются — см. `dbListResumable`.
    if (fixtures.has(caseId)) continue;
    const job = await fileLoad(caseId);
    if (!job || !isResumableJob(job)) continue;
    out.push({ caseId, stage: job.stage });
  }
  return out;
}


async function fileDelete(caseId: string): Promise<void> {
  const path = unifiedJobPath(caseId);
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}

async function fileWriteArtifact(
  caseId: string,
  unifiedJobId: string,
  name: string,
  payload: unknown
): Promise<string> {
  const dir = unifiedArtifactsDir(caseId, unifiedJobId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeJsonAtomic(path, payload);
  return path;
}

async function fileReadArtifact<T>(
  caseId: string,
  unifiedJobId: string,
  name: string
): Promise<T | null> {
  const path = join(unifiedArtifactsDir(caseId, unifiedJobId), name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DB mode
// ---------------------------------------------------------------------------

async function dbBootstrapImport(caseId: string, prisma: PrismaClient): Promise<UnifiedCollectionJob | null> {
  const disk = readJobRaw(caseId);
  if (!disk) return null;
  const { payload, artifactKeys, reportLinkKeys } = splitJob(disk);
  try {
    const row = await prisma.unifiedCollectionJobRecord.create({
      data: {
        caseId: disk.caseId,
        jobId: disk.jobId,
        unifiedJobId: disk.unifiedJobId,
        stage: disk.stage,
        status: disk.status,
        progress: disk.progress ?? 0,
        versionNum: disk.versionNum ?? 0,
        leaseOwnerId: disk.leaseOwnerId,
        leaseUntil: parseIso(disk.leaseUntil),
        requestedBy: disk.requestedBy,
        arsenkinMode: disk.arsenkinMode,
        baseReportRunId: disk.baseReportRunId,
        arsenkinReportRunId: disk.arsenkinReportRunId,
        compositeDatasetId: disk.compositeDatasetId,
        cancelRequested: disk.cancelRequested ?? false,
        resumeCheckpoint: disk.resumeCheckpoint ?? null,
        nextPollAt: parseIso(disk.nextPollAt ?? null),
        pollAttempt: disk.pollAttempt ?? null,
        startedAt: parseIso(disk.startedAt),
        completedAt: parseIso(disk.completedAt),
        createdAt: parseIso(disk.createdAt) ?? new Date(),
        payloadJson: payload as unknown as Prisma.InputJsonValue,
        artifactKeys: artifactKeys as unknown as Prisma.InputJsonValue,
        reportLinkKeys: reportLinkKeys as unknown as Prisma.InputJsonValue,
      },
    });
    return rowToJob(row as unknown as DbRow);
  } catch {
    // Race / FK missing — fall through to null or re-read.
    const again = await prisma.unifiedCollectionJobRecord.findUnique({ where: { caseId } });
    return again ? rowToJob(again as unknown as DbRow) : null;
  }
}

async function dbLoad(caseId: string): Promise<UnifiedCollectionJob | null> {
  const prisma = await getPrisma();
  const row = await prisma.unifiedCollectionJobRecord.findUnique({ where: { caseId } });
  if (row) return rowToJob(row as unknown as DbRow);
  return dbBootstrapImport(caseId, prisma);
}

async function dbSaveOnce(job: UnifiedCollectionJob, expectedVersion: number): Promise<boolean> {
  const prisma = await getPrisma();
  const { payload, artifactKeys, reportLinkKeys } = splitJob(job);
  const nextVersion = expectedVersion + 1;
  const result = await prisma.unifiedCollectionJobRecord.updateMany({
    where: { caseId: job.caseId, versionNum: expectedVersion },
    data: {
      jobId: job.jobId,
      unifiedJobId: job.unifiedJobId,
      stage: job.stage,
      status: job.status,
      progress: job.progress ?? 0,
      versionNum: nextVersion,
      leaseOwnerId: job.leaseOwnerId,
      leaseUntil: parseIso(job.leaseUntil),
      requestedBy: job.requestedBy,
      arsenkinMode: job.arsenkinMode,
      baseReportRunId: job.baseReportRunId,
      arsenkinReportRunId: job.arsenkinReportRunId,
      compositeDatasetId: job.compositeDatasetId,
      cancelRequested: job.cancelRequested ?? false,
      resumeCheckpoint: job.resumeCheckpoint ?? null,
      nextPollAt: parseIso(job.nextPollAt ?? null),
      pollAttempt: job.pollAttempt ?? null,
      startedAt: parseIso(job.startedAt),
      completedAt: parseIso(job.completedAt),
      payloadJson: payload as unknown as Prisma.InputJsonValue,
      artifactKeys: artifactKeys as unknown as Prisma.InputJsonValue,
      reportLinkKeys: reportLinkKeys as unknown as Prisma.InputJsonValue,
    },
  });
  return result.count === 1;
}

async function dbSave(job: UnifiedCollectionJob): Promise<UnifiedCollectionJob> {
  const prisma = await getPrisma();
  const existing = await prisma.unifiedCollectionJobRecord.findUnique({ where: { caseId: job.caseId } });
  if (!existing) {
    const { payload, artifactKeys, reportLinkKeys } = splitJob(job);
    const created = await prisma.unifiedCollectionJobRecord.create({
      data: {
        caseId: job.caseId,
        jobId: job.jobId,
        unifiedJobId: job.unifiedJobId,
        stage: job.stage,
        status: job.status,
        progress: job.progress ?? 0,
        versionNum: (job.versionNum ?? 0) + 1,
        leaseOwnerId: job.leaseOwnerId,
        leaseUntil: parseIso(job.leaseUntil),
        requestedBy: job.requestedBy,
        arsenkinMode: job.arsenkinMode,
        baseReportRunId: job.baseReportRunId,
        arsenkinReportRunId: job.arsenkinReportRunId,
        compositeDatasetId: job.compositeDatasetId,
        cancelRequested: job.cancelRequested ?? false,
        resumeCheckpoint: job.resumeCheckpoint ?? null,
        nextPollAt: parseIso(job.nextPollAt ?? null),
        pollAttempt: job.pollAttempt ?? null,
        startedAt: parseIso(job.startedAt),
        completedAt: parseIso(job.completedAt),
        createdAt: parseIso(job.createdAt) ?? new Date(),
        payloadJson: payload as unknown as Prisma.InputJsonValue,
        artifactKeys: artifactKeys as unknown as Prisma.InputJsonValue,
        reportLinkKeys: reportLinkKeys as unknown as Prisma.InputJsonValue,
      },
    });
    // Keep file mirror for cutover/debug.
    writeJobFile({ ...job, versionNum: created.versionNum - 1 });
    return rowToJob(created as unknown as DbRow);
  }

  const expected = job.versionNum ?? existing.versionNum;
  let ok = await dbSaveOnce(job, expected);
  if (!ok) {
    const fresh = await prisma.unifiedCollectionJobRecord.findUnique({ where: { caseId: job.caseId } });
    if (!fresh) throw new Error(`unified-collection-job CAS failed: missing row ${job.caseId}`);
    ok = await dbSaveOnce({ ...job, versionNum: fresh.versionNum }, fresh.versionNum);
    if (!ok) {
      throw new Error(`unified-collection-job CAS failed after retry: caseId=${job.caseId}`);
    }
  }
  const saved = await prisma.unifiedCollectionJobRecord.findUniqueOrThrow({ where: { caseId: job.caseId } });
  const domain = rowToJob(saved as unknown as DbRow);
  // Mirror to disk (non-authoritative in db mode).
  try {
    const path = unifiedJobPath(job.caseId);
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, domain);
  } catch {
    /* ignore mirror failures */
  }
  return domain;
}

async function dbFindOrCreate(input: {
  caseId: string;
  requestedBy: string;
  arsenkinMode?: "full-first36";
  forceNew?: boolean;
}): Promise<{ job: UnifiedCollectionJob; created: boolean }> {
  const existing = await dbLoad(input.caseId);
  if (
    !input.forceNew &&
    existing &&
    !existing.cancelRequested &&
    (ACTIVE_STAGES.has(existing.stage) ||
      existing.stage === "FAILED_RETRYABLE" ||
      existing.status === "RUNNING" ||
      existing.status === "WAITING")
  ) {
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

  if (existing) {
    const saved = await dbSave(job);
    return { job: saved, created: true };
  }

  const prisma = await getPrisma();
  const { payload, artifactKeys, reportLinkKeys } = splitJob(job);
  try {
    const created = await prisma.unifiedCollectionJobRecord.create({
      data: {
        caseId: job.caseId,
        jobId: job.jobId,
        unifiedJobId: job.unifiedJobId,
        stage: job.stage,
        status: job.status,
        progress: 0,
        versionNum: 1,
        leaseOwnerId: null,
        leaseUntil: null,
        requestedBy: job.requestedBy,
        arsenkinMode: job.arsenkinMode,
        baseReportRunId: null,
        arsenkinReportRunId: null,
        compositeDatasetId: null,
        cancelRequested: false,
        resumeCheckpoint: null,
        nextPollAt: null,
        pollAttempt: null,
        startedAt: parseIso(job.startedAt),
        completedAt: null,
        createdAt: parseIso(job.createdAt) ?? new Date(),
        payloadJson: payload as unknown as Prisma.InputJsonValue,
        artifactKeys: artifactKeys as unknown as Prisma.InputJsonValue,
        reportLinkKeys: reportLinkKeys as unknown as Prisma.InputJsonValue,
      },
    });
    writeJobFile({ ...job, versionNum: 0 });
    return { job: rowToJob(created as unknown as DbRow), created: true };
  } catch {
    const again = await dbLoad(input.caseId);
    if (again) return { job: again, created: false };
    throw new Error(`failed to create unified collection job for case ${input.caseId}`);
  }
}

async function dbPatch(
  caseId: string,
  patch: Partial<UnifiedCollectionJob>
): Promise<UnifiedCollectionJob | null> {
  const cur = await dbLoad(caseId);
  if (!cur) return null;
  const next = { ...cur, ...patch, caseId: cur.caseId, jobId: cur.jobId, unifiedJobId: cur.unifiedJobId };
  return dbSave(next);
}

async function dbClaim(input: {
  caseId: string;
  ownerId: string;
  leaseMs?: number;
  now?: Date;
}): Promise<UnifiedCollectionJob | null> {
  const prisma = await getPrisma();
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? 90_000;
  const leaseUntil = new Date(now.getTime() + leaseMs);

  // Ensure row exists (bootstrap from disk if needed).
  const existing = await dbLoad(input.caseId);
  if (!existing) return null;

  const result = await prisma.unifiedCollectionJobRecord.updateMany({
    where: {
      caseId: input.caseId,
      OR: [
        { leaseOwnerId: null },
        { leaseUntil: null },
        { leaseUntil: { lte: now } },
        { leaseOwnerId: input.ownerId },
      ],
    },
    data: {
      leaseOwnerId: input.ownerId,
      leaseUntil,
      versionNum: { increment: 1 },
    },
  });
  if (result.count === 0) return null;
  return dbLoad(input.caseId);
}

async function dbRelease(caseId: string, ownerId: string): Promise<void> {
  const prisma = await getPrisma();
  await prisma.unifiedCollectionJobRecord.updateMany({
    where: { caseId, leaseOwnerId: ownerId },
    data: {
      leaseOwnerId: null,
      leaseUntil: null,
      versionNum: { increment: 1 },
    },
  });
}

async function dbListResumable(): Promise<Array<{ caseId: string; stage: UnifiedCollectionStage }>> {
  const prisma = await getPrisma();
  const rows = await prisma.unifiedCollectionJobRecord.findMany({
    where: {
      status: { in: ["WAITING", "RUNNING"] },
      stage: { in: [...ACTIVE_STAGES] },
      // Фикстурные кейсы не возобновляются. Смоки оставляют после себя джобы в
      // `ARSENKIN_ENRICHMENT/WAITING`, и подборка после деплоя принимала их за
      // работу, которую надо доделать: на стенде с настоящими ключами воркер
      // молча отправлял **платные** задачи Arsenkin по данным смока. Поймано на
      // живом стенде — две задачи за пять минут.
      case: { isFixture: false },
    },
    select: { caseId: true, stage: true },
  });
  return rows.map((r) => ({
    caseId: r.caseId,
    stage: r.stage as UnifiedCollectionStage,
  }));
}

async function dbDelete(caseId: string): Promise<void> {
  const prisma = await getPrisma();
  try {
    await prisma.unifiedCollectionJobRecord.deleteMany({ where: { caseId } });
  } catch {
    /* ignore */
  }
  await fileDelete(caseId);
}

async function dbWriteArtifact(
  caseId: string,
  unifiedJobId: string,
  name: string,
  payload: unknown
): Promise<string> {
  const dir = unifiedArtifactsDir(caseId, unifiedJobId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeJsonAtomic(path, payload);
  const key = artifactStorageKey(caseId, unifiedJobId, name);
  const job = await dbLoad(caseId);
  if (job && job.unifiedJobId === unifiedJobId) {
    await dbSave({
      ...job,
      artifactPaths: { ...job.artifactPaths, [name]: key },
    });
  }
  return path;
}

async function dbReadArtifact<T>(
  caseId: string,
  unifiedJobId: string,
  name: string
): Promise<T | null> {
  return fileReadArtifact<T>(caseId, unifiedJobId, name);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadUnifiedCollectionJob(caseId: string): Promise<UnifiedCollectionJob | null> {
  return getUnifiedCollectionJobStoreMode() === "db" ? dbLoad(caseId) : fileLoad(caseId);
}

export async function saveUnifiedCollectionJob(job: UnifiedCollectionJob): Promise<UnifiedCollectionJob> {
  return getUnifiedCollectionJobStoreMode() === "db" ? dbSave(job) : fileSave(job);
}

export async function findOrCreateUnifiedCollectionJob(input: {
  caseId: string;
  requestedBy: string;
  arsenkinMode?: "full-first36";
  /** When true, always create a new job (paid recollection confirmation path). */
  forceNew?: boolean;
}): Promise<{ job: UnifiedCollectionJob; created: boolean }> {
  return getUnifiedCollectionJobStoreMode() === "db" ? dbFindOrCreate(input) : fileFindOrCreate(input);
}

/**
 * Предупреждения прогона: список фактов, а не журнал (шаг 15, E9).
 *
 * Каждый тик дописывал свои строки к прежним, и к концу живого прогона их
 * набралось 368 — в основном дословные повторы `arsenkin-awaiting-ingest`.
 * Повтор одного и того же утверждения не добавляет сведений, а найти среди них
 * важное нельзя.
 *
 * Дубли схлопываются с сохранением **последнего** вхождения: порядок отражает
 * ход прогона, и свежая запись информативнее старой. Разные значения одного
 * префикса (`arsenkin-scheduled:AGENT_A` и `…_B`) — разные факты и остаются оба.
 */
export const MAX_JOB_WARNINGS = 200;

export function normalizeJobWarnings(
  warnings: readonly string[] | null | undefined,
  max: number = MAX_JOB_WARNINGS
): string[] {
  const list = (warnings ?? []).map((w) => String(w ?? "").trim()).filter(Boolean);
  const seen = new Set<string>();
  const deduped: string[] = [];
  // Идём с конца: так остаётся последнее вхождение каждой строки.
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const w = list[i]!;
    if (seen.has(w)) continue;
    seen.add(w);
    deduped.push(w);
  }
  deduped.reverse();
  return deduped.length > max ? deduped.slice(deduped.length - max) : deduped;
}

export async function patchUnifiedCollectionJob(
  caseId: string,
  patch: Partial<UnifiedCollectionJob>
): Promise<UnifiedCollectionJob | null> {
  // Нормализация на границе записи: иначе её обязан помнить каждый вызывающий,
  // а их десятки.
  const normalized: Partial<UnifiedCollectionJob> = patch.warnings
    ? { ...patch, warnings: normalizeJobWarnings(patch.warnings) }
    : patch;
  const job =
    getUnifiedCollectionJobStoreMode() === "db"
      ? await dbPatch(caseId, normalized)
      : await filePatch(caseId, normalized);
  if (job && patch.stage) await syncCaseStatusToStage(caseId, patch.stage);
  return job;
}

/**
 * Статус кейса следует за стадией прогона (шаг 11.3): иначе кейс с готовым
 * отчётом вечно значится черновиком, а рядом печатается второй, противоречащий
 * ему статус. Обновление вспомогательное — его неудача не должна ронять джобу.
 */
async function syncCaseStatusToStage(caseId: string, stage: UnifiedCollectionStage): Promise<void> {
  try {
    const prisma = await getPrisma();
    if (!prisma) return;
    const row = await prisma.case.findUnique({ where: { id: caseId }, select: { status: true } });
    if (!row) return;
    const next = caseStatusForStage(stage, row.status);
    if (!next) return;
    await prisma.case.update({
      where: { id: caseId },
      data: { status: next as never },
    });
  } catch {
    /* статус кейса — отображение, а не источник правды пайплайна */
  }
}

export async function claimUnifiedJobLease(input: {
  caseId: string;
  ownerId: string;
  leaseMs?: number;
  now?: Date;
}): Promise<UnifiedCollectionJob | null> {
  return getUnifiedCollectionJobStoreMode() === "db" ? dbClaim(input) : fileClaim(input);
}

export async function releaseUnifiedJobLease(caseId: string, ownerId: string): Promise<void> {
  if (getUnifiedCollectionJobStoreMode() === "db") {
    await dbRelease(caseId, ownerId);
    return;
  }
  await fileRelease(caseId, ownerId);
}

/** Bounded restart recovery: only active/waiting jobs, not terminal. */
export async function listResumableUnifiedJobs(): Promise<
  Array<{ caseId: string; stage: UnifiedCollectionStage }>
> {
  return getUnifiedCollectionJobStoreMode() === "db" ? dbListResumable() : fileListResumable();
}

/** Test helper: wipe job file (and DB row in db mode). */
export async function deleteUnifiedCollectionJobForTests(caseId: string): Promise<void> {
  if (getUnifiedCollectionJobStoreMode() === "db") {
    await dbDelete(caseId);
    return;
  }
  await fileDelete(caseId);
}

export async function writeUnifiedArtifact(
  caseId: string,
  unifiedJobId: string,
  name: string,
  payload: unknown
): Promise<string> {
  return getUnifiedCollectionJobStoreMode() === "db"
    ? dbWriteArtifact(caseId, unifiedJobId, name, payload)
    : fileWriteArtifact(caseId, unifiedJobId, name, payload);
}

export async function readUnifiedArtifact<T>(
  caseId: string,
  unifiedJobId: string,
  name: string
): Promise<T | null> {
  return getUnifiedCollectionJobStoreMode() === "db"
    ? dbReadArtifact<T>(caseId, unifiedJobId, name)
    : fileReadArtifact<T>(caseId, unifiedJobId, name);
}
