/**
 * Prepare ORION Golden content-brain artifacts for a case (manual-review queue, judgments, client content).
 * Does not render PDF/PPTX.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describeOrionV2AiReadiness, digitalProfileConfig } from "../config";
import { ForbiddenError, ValidationError } from "../http/errors";
import {
  ORION_GOLDEN_QA_STORAGE_ROOT,
  caseScopedArtifactRoot,
} from "../orion-golden/evidence/admin-review-decision-store";
import { runR10OrionGoldenE2e } from "../orion-golden/run-r10-orion-golden-e2e";

export type OrionGoldenPrepareSummary = {
  ok: boolean;
  caseId: string;
  status: "completed" | "failed" | "running" | "empty";
  runId: string | null;
  verdict: string | null;
  artifactRoot: string | null;
  pendingCount: number;
  queueReady: boolean;
  createdAt: string | null;
  completedAt: string | null;
  warnings: string[];
};

interface PrepareRunRecord {
  caseId: string;
  runId: string;
  status: "completed" | "failed" | "running";
  createdAt: string;
  completedAt: string | null;
  outputRoot: string;
  verdict: string;
  pendingCount: number;
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

function toSummary(record: PrepareRunRecord | null): OrionGoldenPrepareSummary {
  if (!record) {
    return {
      ok: true,
      caseId: "",
      status: "empty",
      runId: null,
      verdict: null,
      artifactRoot: null,
      pendingCount: 0,
      queueReady: false,
      createdAt: null,
      completedAt: null,
      warnings: [],
    };
  }
  return {
    ok: record.status === "completed" && record.queueReady,
    caseId: record.caseId,
    status: record.status,
    runId: record.runId,
    verdict: record.verdict,
    artifactRoot: record.outputRoot,
    pendingCount: record.pendingCount,
    queueReady: record.queueReady,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    warnings: record.warnings,
  };
}

export function getOrionGoldenPrepareSummary(caseId: string): OrionGoldenPrepareSummary {
  const latest = readJson<{ runId?: string }>(latestPointerPath(caseId));
  if (!latest?.runId) {
    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
    const queuePath = join(caseRoot, "manual-review-queue.json");
    if (existsSync(queuePath)) {
      const queue = readJson<{ pendingCount?: number }>(queuePath);
      return {
        ok: true,
        caseId,
        status: "completed",
        runId: null,
        verdict: "ARTIFACTS_PRESENT",
        artifactRoot: caseRoot,
        pendingCount: queue?.pendingCount ?? 0,
        queueReady: true,
        createdAt: null,
        completedAt: null,
        warnings: [],
      };
    }
    return { ...toSummary(null), caseId };
  }
  const record = readJson<PrepareRunRecord>(runRecordPath(caseId, latest.runId));
  return toSummary(record);
}

function persistRun(record: PrepareRunRecord): void {
  writeJson(runRecordPath(record.caseId, record.runId), record);
  writeJson(latestPointerPath(record.caseId), {
    runId: record.runId,
    updatedAt: record.completedAt ?? record.createdAt,
  });
}

/**
 * Run Golden content-brain for a case and write artifacts where Manual Review can find them.
 */
export async function enqueueOrionGoldenPrepare(caseId: string): Promise<OrionGoldenPrepareSummary> {
  if (!digitalProfileConfig.orionGoldenEnabled) {
    throw new ForbiddenError("ORION Golden is disabled.");
  }

  const readiness = describeOrionV2AiReadiness();
  if (digitalProfileConfig.orionV2RequireAi && !readiness.ready) {
    throw new ValidationError(
      "Подготовка ORION Golden требует GPT-5.5. Добавьте OPENAI_API_KEY и включите AI analyst."
    );
  }

  const uiRunId = `prepare-${Date.now()}`;
  const createdAt = new Date().toISOString();
  const outputRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
  ensureDir(outputRoot);

  const running: PrepareRunRecord = {
    caseId,
    runId: uiRunId,
    status: "running",
    createdAt,
    completedAt: null,
    outputRoot,
    verdict: "PENDING",
    pendingCount: 0,
    queueReady: false,
    warnings: [],
  };
  persistRun(running);

  const prevContentBrain = process.env.R10_CONTENT_BRAIN_ONLY;
  const prevClassic = process.env.ORION_CLASSIC_AUDIT_MODE;
  const prevClientAudit = process.env.ORION_CLIENT_AUDIT_MODE;
  const prevRenderFromContent = process.env.R10_RENDER_FROM_CLIENT_CONTENT;

  try {
    process.env.R10_CONTENT_BRAIN_ONLY = "1";
    // Prepare must not render PDF/PPTX
    delete process.env.ORION_CLASSIC_AUDIT_MODE;
    delete process.env.ORION_CLIENT_AUDIT_MODE;
    delete process.env.R10_RENDER_FROM_CLIENT_CONTENT;

    const result = await runR10OrionGoldenE2e({
      caseId,
      outputRoot,
      requireAi: true,
    });

    const queuePath = join(outputRoot, "manual-review-queue.json");
    const queueReady = existsSync(queuePath);
    const queue = queueReady ? readJson<{ pendingCount?: number }>(queuePath) : null;
    const blocked =
      result.verdict === "BLOCKED" ||
      result.verdict === "BLOCKED_GPT" ||
      result.verdict === "BLOCKED_DATA_ROUTING";

    const completed: PrepareRunRecord = {
      caseId,
      runId: uiRunId,
      status: queueReady && !blocked ? "completed" : "failed",
      createdAt,
      completedAt: new Date().toISOString(),
      outputRoot,
      verdict: result.verdict,
      pendingCount: queue?.pendingCount ?? 0,
      queueReady,
      warnings: queueReady
        ? []
        : ["manual-review-queue.json was not written — check AI/DB readiness"],
    };
    persistRun(completed);
    return toSummary(completed);
  } catch (err) {
    const failed: PrepareRunRecord = {
      ...running,
      status: "failed",
      completedAt: new Date().toISOString(),
      verdict: "FAIL",
      warnings: [err instanceof Error ? err.message : "orion-golden-prepare-failed"],
    };
    persistRun(failed);
    throw err;
  } finally {
    if (prevContentBrain === undefined) delete process.env.R10_CONTENT_BRAIN_ONLY;
    else process.env.R10_CONTENT_BRAIN_ONLY = prevContentBrain;
    if (prevClassic === undefined) delete process.env.ORION_CLASSIC_AUDIT_MODE;
    else process.env.ORION_CLASSIC_AUDIT_MODE = prevClassic;
    if (prevClientAudit === undefined) delete process.env.ORION_CLIENT_AUDIT_MODE;
    else process.env.ORION_CLIENT_AUDIT_MODE = prevClientAudit;
    if (prevRenderFromContent === undefined) delete process.env.R10_RENDER_FROM_CLIENT_CONTENT;
    else process.env.R10_RENDER_FROM_CLIENT_CONTENT = prevRenderFromContent;
  }
}
