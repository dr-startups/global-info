import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DpRole } from "../auth/roles";
import { can } from "../auth/roles";
import { describeOrionV2AiReadiness, digitalProfileConfig } from "../config";
import { ForbiddenError, NotFoundError, ValidationError } from "../http/errors";
import {
  OpenAiRateLimitError,
  runR912ClientQualityStoryboardE2e,
} from "../orion-client-storyboard/run-r912-real-case-storyboard-e2e";
import { saveFile } from "../storage/private-store";
import { buildStorageKey } from "../storage/keys";
import { createSignedToken, verifySignedToken } from "../storage/signed-url";

export type OrionClientStoryboardArtifactKind = "client_pdf" | "client_pptx";

type Gpt55Status = "used" | "required_missing" | "deterministic_fallback";

interface OrionClientStoryboardArtifactRecord {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  fileName: string;
}

interface OrionClientStoryboardRunRecord {
  caseId: string;
  runId: string;
  reportMode: "orion_client_storyboard_r912";
  status: "completed" | "failed" | "running";
  createdAt: string;
  completedAt: string | null;
  outputRoot: string;
  slideCount: number;
  gpt55Status: Gpt55Status;
  clientQualityVerdict: string;
  clientPolicyStatus: string;
  aiRequired: boolean;
  aiReady: boolean;
  warnings: string[];
  artifacts: Partial<Record<OrionClientStoryboardArtifactKind, OrionClientStoryboardArtifactRecord>>;
}

interface ArtifactSummary {
  available: boolean;
  downloadUrl: string | null;
}

export interface OrionClientStoryboardReportSummary {
  ok: boolean;
  uiEnabled: boolean;
  reportMode: "orion_client_storyboard_r912";
  status: "completed" | "failed" | "running" | "empty";
  runId: string | null;
  createdAt: string | null;
  completedAt: string | null;
  slideCount: number;
  gpt55Status: Gpt55Status | "unknown";
  clientQualityVerdict: string | null;
  clientPolicyStatus: string | null;
  aiRequired: boolean;
  aiReady: boolean;
  artifacts: {
    clientPdf: ArtifactSummary;
    clientPptx: ArtifactSummary;
  };
  warnings: string[];
}

const UI_ROOT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "orion-client-storyboard-ui-r912"
);

const ARTIFACT_META: Record<
  OrionClientStoryboardArtifactKind,
  { sourceFile: string; mimeType: string; fileName: string }
> = {
  client_pdf: {
    sourceFile: "rendered-client.pdf",
    mimeType: "application/pdf",
    fileName: "orion-client-storyboard.pdf",
  },
  client_pptx: {
    sourceFile: "rendered-client.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    fileName: "orion-client-storyboard.pptx",
  },
};

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

function isAdminRole(role: DpRole): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN";
}

export function isOrionClientStoryboardUiEnabled(): boolean {
  return digitalProfileConfig.orionClientStoryboardUiEnabled;
}

export function assertOrionClientStoryboardUiFlagForRole(role: DpRole): void {
  if (digitalProfileConfig.orionClientStoryboardUiEnabled) return;
  if (isAdminRole(role)) return;
  throw new ForbiddenError("ORION client storyboard UI is disabled.");
}

function artifactDownloadUrl(
  caseId: string,
  runId: string,
  artifact: OrionClientStoryboardArtifactKind,
  storageKey: string
): string {
  const { token } = createSignedToken(storageKey);
  const query = new URLSearchParams({ runId, artifact, token });
  return `/api/digital-profile/cases/${caseId}/report/orion-client-storyboard/download?${query.toString()}`;
}

function toPublicSummary(record: OrionClientStoryboardRunRecord | null): OrionClientStoryboardReportSummary {
  const readiness = describeOrionV2AiReadiness();
  if (!record) {
    return {
      ok: true,
      uiEnabled: digitalProfileConfig.orionClientStoryboardUiEnabled,
      reportMode: "orion_client_storyboard_r912",
      status: "empty",
      runId: null,
      createdAt: null,
      completedAt: null,
      slideCount: 0,
      gpt55Status: "unknown",
      clientQualityVerdict: null,
      clientPolicyStatus: null,
      aiRequired: readiness.requireAi,
      aiReady: readiness.ready,
      artifacts: {
        clientPdf: { available: false, downloadUrl: null },
        clientPptx: { available: false, downloadUrl: null },
      },
      warnings: [],
    };
  }

  const artifact = (kind: OrionClientStoryboardArtifactKind): ArtifactSummary => {
    const item = record.artifacts[kind];
    if (!item) return { available: false, downloadUrl: null };
    return {
      available: true,
      downloadUrl: artifactDownloadUrl(record.caseId, record.runId, kind, item.storageKey),
    };
  };

  return {
    ok: true,
    uiEnabled: digitalProfileConfig.orionClientStoryboardUiEnabled,
    reportMode: record.reportMode,
    status: record.status,
    runId: record.runId,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    slideCount: record.slideCount,
    gpt55Status: record.gpt55Status,
    clientQualityVerdict: record.clientQualityVerdict,
    clientPolicyStatus: record.clientPolicyStatus,
    aiRequired: record.aiRequired,
    aiReady: record.aiReady,
    artifacts: {
      clientPdf: artifact("client_pdf"),
      clientPptx: artifact("client_pptx"),
    },
    warnings: record.warnings,
  };
}

async function persistArtifacts(
  caseId: string,
  runId: string,
  outputRoot: string
): Promise<Partial<Record<OrionClientStoryboardArtifactKind, OrionClientStoryboardArtifactRecord>>> {
  const out: Partial<Record<OrionClientStoryboardArtifactKind, OrionClientStoryboardArtifactRecord>> = {};
  for (const [kind, meta] of Object.entries(ARTIFACT_META) as Array<
    [OrionClientStoryboardArtifactKind, (typeof ARTIFACT_META)[OrionClientStoryboardArtifactKind]]
  >) {
    const sourcePath = join(outputRoot, meta.sourceFile);
    if (!existsSync(sourcePath)) continue;
    const file = readFileSync(sourcePath);
    const exportId = `orion-client-storyboard-${runId}`;
    const ext = meta.fileName.toLowerCase().endsWith(".pdf") ? "pdf" : "pptx";
    const storageKey = buildStorageKey.export(caseId, exportId, `${kind}.${ext}`);
    const saved = await saveFile(storageKey, file);
    out[kind] = {
      storageKey: saved.storageKey,
      sizeBytes: saved.sizeBytes,
      sha256: saved.sha256,
      mimeType: meta.mimeType,
      fileName: meta.fileName,
    };
  }
  return out;
}

function buildRunningPlaceholder(
  caseId: string,
  uiRunId: string,
  runOutputRoot: string,
  createdAt: string
): OrionClientStoryboardRunRecord {
  const readiness = describeOrionV2AiReadiness();
  return {
    caseId,
    runId: uiRunId,
    reportMode: "orion_client_storyboard_r912",
    status: "running",
    createdAt,
    completedAt: null,
    outputRoot: runOutputRoot,
    slideCount: 0,
    gpt55Status: "used",
    clientQualityVerdict: "PENDING",
    clientPolicyStatus: "PENDING",
    aiRequired: readiness.requireAi,
    aiReady: readiness.ready,
    warnings: [],
    artifacts: {},
  };
}

function persistRunRecord(record: OrionClientStoryboardRunRecord): void {
  writeJson(runRecordPath(record.caseId, record.runId), record);
  writeJson(latestPointerPath(record.caseId), {
    runId: record.runId,
    updatedAt: record.completedAt ?? record.createdAt,
  });
}

export function getLatestOrionClientStoryboardRunRecord(
  caseId: string
): OrionClientStoryboardRunRecord | null {
  const latest = readJson<{ runId?: string }>(latestPointerPath(caseId));
  if (!latest?.runId) return null;
  return readJson<OrionClientStoryboardRunRecord>(runRecordPath(caseId, latest.runId));
}

export function getOrionClientStoryboardSummary(
  caseId: string
): OrionClientStoryboardReportSummary {
  return toPublicSummary(getLatestOrionClientStoryboardRunRecord(caseId));
}

async function executeOrionClientStoryboardReport(input: {
  caseId: string;
  uiRunId: string;
  runOutputRoot: string;
  createdAt: string;
}): Promise<OrionClientStoryboardRunRecord> {
  const readiness = describeOrionV2AiReadiness();
  const requireAi = digitalProfileConfig.orionV2RequireAi;
  if (requireAi && !readiness.ready) {
    throw new Error("gpt55-required-but-unavailable");
  }

  const result = await runR912ClientQualityStoryboardE2e({
    caseId: input.caseId,
    outputRoot: input.runOutputRoot,
  });

  const qa = readJson<{ verdict?: string; policy?: { passed?: boolean; issues?: string[] } }>(
    join(input.runOutputRoot, "qa-summary.json")
  );
  const clientQuality = readJson<{ verdict?: string }>(
    join(input.runOutputRoot, "client-quality-inspection.json")
  );
  const policy = readJson<{ passed?: boolean; issues?: string[] }>(
    join(input.runOutputRoot, "client-policy-inspection.json")
  );

  const verdict = result.verdict;
  const passed = verdict === "PASS";
  const gpt55Status: Gpt55Status =
    result.generatedBy === "gpt-5.5" ? "used" : requireAi ? "deterministic_fallback" : "used";

  const warnings: string[] = [];
  if (!passed) warnings.push(`Client storyboard QA verdict: ${verdict}`);
  if (policy && !policy.passed) {
    warnings.push(...(policy.issues ?? []).slice(0, 3).map((i) => `Client policy: ${i}`));
  }

  const artifacts = passed ? await persistArtifacts(input.caseId, input.uiRunId, input.runOutputRoot) : {};

  const record: OrionClientStoryboardRunRecord = {
    caseId: input.caseId,
    runId: input.uiRunId,
    reportMode: "orion_client_storyboard_r912",
    status: passed ? "completed" : "failed",
    createdAt: input.createdAt,
    completedAt: new Date().toISOString(),
    outputRoot: input.runOutputRoot,
    slideCount: result.slideCount,
    gpt55Status,
    clientQualityVerdict: clientQuality?.verdict ?? qa?.verdict ?? verdict,
    clientPolicyStatus: policy?.passed ? "PASS" : policy?.issues?.length ? "FAIL" : "UNKNOWN",
    aiRequired: requireAi,
    aiReady: readiness.ready,
    warnings: warnings.slice(0, 8),
    artifacts,
  };

  persistRunRecord(record);
  return record;
}

export function enqueueOrionClientStoryboardReport(caseId: string): OrionClientStoryboardRunRecord {
  const existing = getLatestOrionClientStoryboardRunRecord(caseId);
  if (existing?.status === "running") return existing;

  const now = new Date();
  const ts = now.getTime();
  const uiRunId = `orion-storyboard-ui-${ts}`;
  const runOutputRoot = join(UI_ROOT, "cases", caseId, "runs", `${ts}`);
  const createdAt = now.toISOString();
  const placeholder = buildRunningPlaceholder(caseId, uiRunId, runOutputRoot, createdAt);
  persistRunRecord(placeholder);

  setImmediate(() => {
    void executeOrionClientStoryboardReport({
      caseId,
      uiRunId,
      runOutputRoot,
      createdAt,
    }).catch((error) => {
      const readiness = describeOrionV2AiReadiness();
      const message = error instanceof Error ? error.message : String(error);
      const isRateLimit = error instanceof OpenAiRateLimitError;
      const failed: OrionClientStoryboardRunRecord = {
        ...placeholder,
        status: "failed",
        completedAt: new Date().toISOString(),
        gpt55Status: isRateLimit ? "required_missing" : readiness.ready ? "used" : "required_missing",
        clientQualityVerdict: isRateLimit ? "BLOCKED_OPENAI_RATE_LIMIT" : "BLOCKED",
        clientPolicyStatus: "UNKNOWN",
        warnings: [
          isRateLimit
            ? "OpenAI rate limit — повторите позже."
            : `Client storyboard generation failed: ${message}`,
        ],
      };
      persistRunRecord(failed);
    });
  });

  return placeholder;
}

export function resolveOrionClientStoryboardArtifactForDownload(input: {
  caseId: string;
  role: DpRole;
  runId: string;
  artifact: string;
  token: string;
}): OrionClientStoryboardArtifactRecord {
  const artifact = input.artifact as OrionClientStoryboardArtifactKind;
  if (!Object.hasOwn(ARTIFACT_META, artifact)) {
    throw new ValidationError("Unknown client storyboard artifact.");
  }
  if (!can(input.role, "report.downloadClient")) {
    throw new ForbiddenError("Client storyboard artifact download is forbidden.");
  }
  const record = readJson<OrionClientStoryboardRunRecord>(runRecordPath(input.caseId, input.runId));
  if (!record) throw new NotFoundError("Client storyboard run not found.");
  const meta = record.artifacts[artifact];
  if (!meta) throw new NotFoundError("Client storyboard artifact not found.");
  if (!verifySignedToken(meta.storageKey, input.token)) {
    throw new NotFoundError("Client storyboard artifact not found.");
  }
  return meta;
}
