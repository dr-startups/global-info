/**
 * Canonical ORION Golden prepare adapter (B-2B).
 *
 * Converted from the legacy runR10 content-brain into a lineage-safe canonical
 * adapter. It requires an explicit caseId + jobId and runs the canonical
 * job-scoped prepare (CompositeDataset -> SubjectResolution -> SurfaceAnalysis ->
 * VerifiedFindingBundle -> ExecutiveSummary -> SectionPacks -> DeckAssembler ->
 * one render) ONLY against artifacts recorded on that unified job. Missing or
 * foreign lineage fails closed. There is NO path to the legacy composer.
 *
 * Async job (POST returns immediately with status=running; poll GET until settled).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { digitalProfileConfig } from "../config";
import { ForbiddenError, ValidationError } from "../http/errors";
import {
  loadUnifiedCollectionJob,
  readUnifiedArtifact,
  unifiedArtifactsDir,
} from "./unified-collection-job-store";
import type { CompositeMergeResult } from "./composite-serp-merge";
import type { ReportDataBinding } from "./unified-collection-types";
import {
  runCanonicalReportPrepare,
  CanonicalPrepareBlockedError,
} from "./canonical-report-prepare";

export type OrionGoldenPrepareSummary = {
  ok: boolean;
  caseId: string;
  jobId: string | null;
  status: "completed" | "failed" | "running" | "empty";
  runId: string | null;
  verdict: string | null;
  artifactRoot: string | null;
  pdf: string | null;
  pptx: string | null;
  pageCount: number;
  queueReady: boolean;
  createdAt: string | null;
  completedAt: string | null;
  warnings: string[];
};

interface PrepareRunRecord {
  caseId: string;
  jobId: string;
  runId: string;
  status: "completed" | "failed" | "running";
  createdAt: string;
  completedAt: string | null;
  outputRoot: string;
  verdict: string;
  pdf: string | null;
  pptx: string | null;
  pageCount: number;
  queueReady: boolean;
  warnings: string[];
}

const UI_ROOT = join(process.cwd(), "storage", "digital-profile", "orion-golden-prepare-ui");

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJson(path: string, payload: unknown): void {
  ensureDir(join(path, ".."));
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function caseDir(caseId: string): string {
  return join(UI_ROOT, "cases", caseId);
}

function runRecordPath(caseId: string, runId: string): string {
  return join(caseDir(caseId), "runs", `${runId}.json`);
}

function latestPointerPath(caseId: string): string {
  return join(caseDir(caseId), "latest.json");
}

function toSummary(record: PrepareRunRecord | null, caseId?: string): OrionGoldenPrepareSummary {
  if (!record) {
    return {
      ok: true,
      caseId: caseId ?? "",
      jobId: null,
      status: "empty",
      runId: null,
      verdict: null,
      artifactRoot: null,
      pdf: null,
      pptx: null,
      pageCount: 0,
      queueReady: false,
      createdAt: null,
      completedAt: null,
      warnings: [],
    };
  }
  return {
    ok: record.status === "completed" && record.queueReady,
    caseId: record.caseId,
    jobId: record.jobId,
    status: record.status,
    runId: record.runId,
    verdict: record.verdict,
    artifactRoot: record.outputRoot,
    pdf: record.pdf,
    pptx: record.pptx,
    pageCount: record.pageCount,
    queueReady: record.queueReady,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    warnings: record.warnings,
  };
}

function getLatestPrepareRun(caseId: string): PrepareRunRecord | null {
  const latest = readJson<{ runId?: string }>(latestPointerPath(caseId));
  if (!latest?.runId) return null;
  return readJson<PrepareRunRecord>(runRecordPath(caseId, latest.runId));
}

export function getOrionGoldenPrepareSummary(caseId: string): OrionGoldenPrepareSummary {
  return toSummary(getLatestPrepareRun(caseId), caseId);
}

function persistRun(record: PrepareRunRecord): void {
  writeJson(runRecordPath(record.caseId, record.runId), record);
  writeJson(latestPointerPath(record.caseId), {
    runId: record.runId,
    updatedAt: record.completedAt ?? record.createdAt,
  });
}

/**
 * Validate that the requested job belongs to the case and carries the required
 * canonical binding + composite merge artifacts. Fails closed otherwise.
 */
async function resolveValidatedJobLineage(caseId: string, jobId: string): Promise<{
  artifactsDir: string;
  binding: ReportDataBinding;
  merge: CompositeMergeResult;
}> {
  if (!jobId.trim()) throw new ValidationError("jobId is required");
  const job = await loadUnifiedCollectionJob(caseId);
  if (!job) throw new ValidationError("no unified job for case — run the unified audit first");
  if (job.unifiedJobId !== jobId && job.jobId !== jobId) {
    throw new ValidationError("FOREIGN_JOB_LINEAGE: jobId does not match the case job");
  }
  const binding = await readUnifiedArtifact<ReportDataBinding>(caseId, job.unifiedJobId, "report-data-binding.json");
  const merge = await readUnifiedArtifact<CompositeMergeResult>(
    caseId,
    job.unifiedJobId,
    "composite-serp-observations.json"
  );
  if (!binding || !merge) {
    throw new ValidationError("PREPARE_INPUT_MISSING: canonical binding/composite artifacts are not present on the job");
  }
  if (binding.caseId !== caseId || (binding.unifiedJobId && binding.unifiedJobId !== job.unifiedJobId)) {
    throw new ValidationError("FOREIGN_ARTIFACT: binding lineage does not match case/job");
  }
  return { artifactsDir: unifiedArtifactsDir(caseId, job.unifiedJobId), binding, merge };
}

async function executePrepare(input: {
  caseId: string;
  jobId: string;
  uiRunId: string;
  createdAt: string;
}): Promise<PrepareRunRecord> {
  const { artifactsDir, binding, merge } = await resolveValidatedJobLineage(input.caseId, input.jobId);
  console.log(
    `[orion-golden-prepare] canonical start caseId=${input.caseId} jobId=${input.jobId} dir=${artifactsDir}`
  );
  try {
    const res = await runCanonicalReportPrepare({
      caseId: input.caseId,
      unifiedJobId: input.jobId,
      artifactsDir,
      binding,
      merge,
      subjectProfile: null,
    });
    const completed: PrepareRunRecord = {
      caseId: input.caseId,
      jobId: input.jobId,
      runId: input.uiRunId,
      status: "completed",
      createdAt: input.createdAt,
      completedAt: new Date().toISOString(),
      outputRoot: artifactsDir,
      verdict: "PASS",
      pdf: res.pdf ?? null,
      pptx: res.pptx ?? null,
      pageCount: res.pageCount,
      queueReady: true,
      warnings: res.requiredSectionsFailed.length
        ? [`required sections failed: ${res.requiredSectionsFailed.join(", ")}`]
        : [],
    };
    persistRun(completed);
    console.log(
      `[orion-golden-prepare] canonical done caseId=${input.caseId} pages=${res.pageCount}`
    );
    return completed;
  } catch (err) {
    const code = err instanceof CanonicalPrepareBlockedError ? err.code : "CANONICAL_PREPARE_FAILED";
    const message = err instanceof Error ? err.message : String(err);
    const failed: PrepareRunRecord = {
      caseId: input.caseId,
      jobId: input.jobId,
      runId: input.uiRunId,
      status: "failed",
      createdAt: input.createdAt,
      completedAt: new Date().toISOString(),
      outputRoot: artifactsDir,
      verdict: code,
      pdf: null,
      pptx: null,
      pageCount: 0,
      queueReady: false,
      warnings: [message],
    };
    persistRun(failed);
    throw err;
  }
}

/**
 * Enqueue canonical Golden prepare for a validated case+job. Returns immediately
 * with status=running. Fails closed synchronously on missing/foreign lineage.
 */
export async function enqueueOrionGoldenPrepare(
  caseId: string,
  jobId: string
): Promise<OrionGoldenPrepareSummary> {
  if (!digitalProfileConfig.orionGoldenEnabled) {
    throw new ForbiddenError("ORION Golden is disabled.");
  }
  // Fail-closed lineage validation before enqueueing any work.
  const { artifactsDir } = await resolveValidatedJobLineage(caseId, jobId);

  const existing = getLatestPrepareRun(caseId);
  if (existing?.status === "running") {
    const createdMs = new Date(existing.createdAt).getTime();
    const ageMs = Date.now() - createdMs;
    const processBootMs = Date.now() - process.uptime() * 1000;
    const stale =
      !Number.isFinite(createdMs) || ageMs > 15 * 60 * 1000 || createdMs < processBootMs - 3_000;
    if (!stale) return toSummary(existing, caseId);
    persistRun({
      ...existing,
      status: "failed",
      completedAt: new Date().toISOString(),
      verdict: "FAIL",
      warnings: ["Предыдущая подготовка прервалась. Запущена новая.", ...(existing.warnings ?? [])],
    });
  }

  const uiRunId = `prepare-${Date.now()}`;
  const createdAt = new Date().toISOString();
  const running: PrepareRunRecord = {
    caseId,
    jobId,
    runId: uiRunId,
    status: "running",
    createdAt,
    completedAt: null,
    outputRoot: artifactsDir,
    verdict: "PENDING",
    pdf: null,
    pptx: null,
    pageCount: 0,
    queueReady: false,
    warnings: ["Job started — poll status; canonical prepare may take a few minutes."],
  };
  persistRun(running);

  setImmediate(() => {
    void executePrepare({ caseId, jobId, uiRunId, createdAt }).catch((err) => {
      console.error(
        `[orion-golden-prepare] failed caseId=${caseId}: ${err instanceof Error ? err.message : err}`
      );
    });
  });

  return toSummary(running, caseId);
}
