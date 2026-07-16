/**
 * Prepare ORION Golden content-brain artifacts for a case (manual-review queue, judgments, client content).
 * Async job (like storyboard): POST returns immediately with status=running; poll GET until settled.
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

function toSummary(record: PrepareRunRecord | null, caseId?: string): OrionGoldenPrepareSummary {
  if (!record) {
    return {
      ok: true,
      caseId: caseId ?? "",
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

function getLatestPrepareRun(caseId: string): PrepareRunRecord | null {
  const latest = readJson<{ runId?: string }>(latestPointerPath(caseId));
  if (!latest?.runId) return null;
  return readJson<PrepareRunRecord>(runRecordPath(caseId, latest.runId));
}

export function getOrionGoldenPrepareSummary(caseId: string): OrionGoldenPrepareSummary {
  const record = getLatestPrepareRun(caseId);
  if (record) return toSummary(record, caseId);

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
  return toSummary(null, caseId);
}

function persistRun(record: PrepareRunRecord): void {
  writeJson(runRecordPath(record.caseId, record.runId), record);
  writeJson(latestPointerPath(record.caseId), {
    runId: record.runId,
    updatedAt: record.completedAt ?? record.createdAt,
  });
}

async function executePrepare(input: {
  caseId: string;
  uiRunId: string;
  outputRoot: string;
  createdAt: string;
}): Promise<PrepareRunRecord> {
  console.log(
    `[orion-golden-prepare] start caseId=${input.caseId} runId=${input.uiRunId} root=${input.outputRoot}`
  );

  const prevContentBrain = process.env.R10_CONTENT_BRAIN_ONLY;
  const prevClassic = process.env.ORION_CLASSIC_AUDIT_MODE;
  const prevClientAudit = process.env.ORION_CLIENT_AUDIT_MODE;
  const prevRenderFromContent = process.env.R10_RENDER_FROM_CLIENT_CONTENT;
  const prevAutoAnalyst = process.env.ORION_GPT_AUTO_ANALYST;

  try {
    process.env.R10_CONTENT_BRAIN_ONLY = "1";
    delete process.env.ORION_CLASSIC_AUDIT_MODE;
    delete process.env.ORION_CLIENT_AUDIT_MODE;
    delete process.env.R10_RENDER_FROM_CLIENT_CONTENT;
    if (digitalProfileConfig.orionGptAutoAnalyst) {
      process.env.ORION_GPT_AUTO_ANALYST = "1";
    }

    const result = await runR10OrionGoldenE2e({
      caseId: input.caseId,
      outputRoot: input.outputRoot,
      requireAi: true,
    });

    const queuePath = join(input.outputRoot, "manual-review-queue.json");
    const queueReady = existsSync(queuePath);
    const queue = queueReady ? readJson<{ pendingCount?: number }>(queuePath) : null;
    const blocked =
      result.verdict === "BLOCKED" ||
      result.verdict === "BLOCKED_GPT" ||
      result.verdict === "BLOCKED_DATA_ROUTING";

    const completed: PrepareRunRecord = {
      caseId: input.caseId,
      runId: input.uiRunId,
      status: queueReady && !blocked ? "completed" : "failed",
      createdAt: input.createdAt,
      completedAt: new Date().toISOString(),
      outputRoot: input.outputRoot,
      verdict: result.verdict,
      pendingCount: queue?.pendingCount ?? 0,
      queueReady,
      warnings: queueReady
        ? []
        : ["manual-review-queue.json was not written — check AI/DB readiness"],
    };
    persistRun(completed);
    console.log(
      `[orion-golden-prepare] done caseId=${input.caseId} verdict=${result.verdict} queueReady=${queueReady} pending=${completed.pendingCount}`
    );
    try {
      const { writeReportEvidenceProvenance } = await import("./report-evidence-provenance");
      await writeReportEvidenceProvenance({
        caseId: input.caseId,
        phase: "ORION_PREPARE",
        trigger: `prepare:${result.verdict}:pending=${completed.pendingCount}`,
      });
    } catch (err) {
      console.error(
        "[orion-golden-prepare] provenance failed:",
        err instanceof Error ? err.message : err
      );
    }
    return completed;
  } finally {
    if (prevContentBrain === undefined) delete process.env.R10_CONTENT_BRAIN_ONLY;
    else process.env.R10_CONTENT_BRAIN_ONLY = prevContentBrain;
    if (prevClassic === undefined) delete process.env.ORION_CLASSIC_AUDIT_MODE;
    else process.env.ORION_CLASSIC_AUDIT_MODE = prevClassic;
    if (prevClientAudit === undefined) delete process.env.ORION_CLIENT_AUDIT_MODE;
    else process.env.ORION_CLIENT_AUDIT_MODE = prevClientAudit;
    if (prevRenderFromContent === undefined) delete process.env.R10_RENDER_FROM_CLIENT_CONTENT;
    else process.env.R10_RENDER_FROM_CLIENT_CONTENT = prevRenderFromContent;
    if (prevAutoAnalyst === undefined) delete process.env.ORION_GPT_AUTO_ANALYST;
    else process.env.ORION_GPT_AUTO_ANALYST = prevAutoAnalyst;
  }
}

/**
 * Enqueue Golden content-brain for a case. Returns immediately with status=running.
 */
export function enqueueOrionGoldenPrepare(caseId: string): OrionGoldenPrepareSummary {
  if (!digitalProfileConfig.orionGoldenEnabled) {
    throw new ForbiddenError("ORION Golden is disabled.");
  }

  const readiness = describeOrionV2AiReadiness();
  if (digitalProfileConfig.orionV2RequireAi && !readiness.ready) {
    throw new ValidationError(
      "Подготовка ORION Golden требует GPT-5.5. Добавьте OPENAI_API_KEY и включите AI analyst."
    );
  }

  const existing = getLatestPrepareRun(caseId);
  if (existing?.status === "running") {
    const createdMs = new Date(existing.createdAt).getTime();
    const ageMs = Date.now() - createdMs;
    const processBootMs = Date.now() - process.uptime() * 1000;
    const stale =
      !Number.isFinite(createdMs) ||
      ageMs > 15 * 60 * 1000 ||
      createdMs < processBootMs - 3_000;
    if (!stale) {
      console.log(`[orion-golden-prepare] already running caseId=${caseId} runId=${existing.runId}`);
      return toSummary(existing, caseId);
    }
    console.warn(
      `[orion-golden-prepare] stale running job — restarting caseId=${caseId} runId=${existing.runId}`
    );
    persistRun({
      ...existing,
      status: "failed",
      completedAt: new Date().toISOString(),
      verdict: "FAIL",
      warnings: [
        "Предыдущая подготовка прервалась (рестарт контейнера или таймаут). Запущена новая.",
        ...(existing.warnings ?? []),
      ],
    });
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
    warnings: ["Job started — poll status; content-brain may take several minutes."],
  };
  persistRun(running);
  console.log(`[orion-golden-prepare] enqueued caseId=${caseId} runId=${uiRunId}`);

  setImmediate(() => {
    void executePrepare({ caseId, uiRunId, outputRoot, createdAt }).catch((err) => {
      const message = err instanceof Error ? err.message : "orion-golden-prepare-failed";
      console.error(`[orion-golden-prepare] failed caseId=${caseId}: ${message}`);
      const failed: PrepareRunRecord = {
        ...running,
        status: "failed",
        completedAt: new Date().toISOString(),
        verdict: "FAIL",
        warnings: [message],
      };
      persistRun(failed);
    });
  });

  return toSummary(running, caseId);
}
