import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DpRole } from "../auth/roles";
import { can } from "../auth/roles";
import { describeOrionV2AiReadiness, digitalProfileConfig, type OrionV2AiReadiness } from "../config";
import { ForbiddenError, NotFoundError, ValidationError } from "../http/errors";
import {
  runExactOrionPipeline,
  type OrionAiEnforcementStatus,
  type OrionStoreMode,
} from "../orion-section-pipeline";
import {
  errorOrionPipeline,
  logOrionPipeline,
  warnOrionPipeline,
} from "../orion-section-pipeline/orion-pipeline-logger";
import { saveFile } from "../storage/private-store";
import { buildStorageKey } from "../storage/keys";
import { createSignedToken, verifySignedToken } from "../storage/signed-url";

export type OrionV2ArtifactKind =
  | "client_pdf"
  | "client_pptx"
  | "internal_draft_pdf"
  | "internal_draft_pptx";

type LexisStatus =
  | "not_uploaded"
  | "uploaded_parsed"
  | "visual_pages_ready"
  | "conversion_failed"
  | "requires_manual_review";

type Gpt55Status =
  | "used"
  | "skipped"
  | "deterministic_fallback"
  | "required_missing";

interface OrionV2ArtifactRecord {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  fileName: string;
}

interface OrionV2RunRecord {
  caseId: string;
  runId: string;
  reportMode: "orion_section_pipeline_v1";
  status: "completed" | "failed" | "running";
  storeMode: OrionStoreMode;
  createdAt: string;
  completedAt: string | null;
  outputRoot: string;
  pageCount: number;
  clientPageCount: number;
  lexisVisualPageCount: number;
  lexisStatus: LexisStatus;
  gpt55Status: Gpt55Status;
  deterministicFallbackUsed: boolean;
  gpt55ValidationRequested: boolean;
  aiRequired: boolean;
  aiReady: boolean;
  aiEnforcementStatus: OrionAiEnforcementStatus;
  clientPolicyStatus: string;
  warnings: string[];
  artifacts: Partial<Record<OrionV2ArtifactKind, OrionV2ArtifactRecord>>;
}

interface OrionV2ArtifactSummary {
  available: boolean;
  downloadUrl: string | null;
}

interface OrionV2ArtifactsResponse {
  clientPdf: OrionV2ArtifactSummary;
  clientPptx: OrionV2ArtifactSummary;
  internalDraftPdf?: OrionV2ArtifactSummary;
  internalDraftPptx?: OrionV2ArtifactSummary;
}

export interface OrionV2ReportSummary {
  ok: boolean;
  uiEnabled: boolean;
  reportMode: "orion_section_pipeline_v1";
  status: "completed" | "failed" | "running" | "empty";
  runId: string | null;
  storeMode: OrionStoreMode | null;
  createdAt: string | null;
  completedAt: string | null;
  pageCount: number;
  clientPageCount: number;
  lexisVisualPageCount: number;
  lexisStatus: LexisStatus | "unknown";
  gpt55Status: Gpt55Status | "unknown";
  deterministicFallbackUsed: boolean;
  aiRequired: boolean;
  aiReady: boolean;
  aiEnforcementStatus: OrionAiEnforcementStatus | "unknown";
  clientPolicyStatus: string | null;
  artifacts: OrionV2ArtifactsResponse;
  warnings: string[];
}

interface RunOrionV2Options {
  caseId: string;
  storeMode: OrionStoreMode;
  gpt55Validate: boolean;
  includeInternalArtifacts: boolean;
  /** R9.5c — user-facing runs require GPT-5.5; resolved by the caller. */
  requireAiAnalysis?: boolean;
  /** R9.5c — allow deterministic fallback only in explicit dev/test. */
  allowDeterministicFallback?: boolean;
  /** Internal: stable UI run id when resuming an async job. */
  uiRunId?: string;
  /** Internal: output directory when resuming an async job. */
  runOutputRoot?: string;
}

const ORION_V2_UI_ROOT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "orion-v2-ui-r95"
);

const ARTIFACT_META: Record<
  OrionV2ArtifactKind,
  { sourceFile: string; mimeType: string; fileName: string }
> = {
  client_pdf: {
    sourceFile: "final-report-v17-ru-client.pdf",
    mimeType: "application/pdf",
    fileName: "orion-v2-client-report.pdf",
  },
  client_pptx: {
    sourceFile: "final-report-v17-ru-client.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    fileName: "orion-v2-client-report.pptx",
  },
  internal_draft_pdf: {
    sourceFile: "final-report-v17-ru-internal-draft.pdf",
    mimeType: "application/pdf",
    fileName: "orion-v2-internal-draft.pdf",
  },
  internal_draft_pptx: {
    sourceFile: "final-report-v17-ru-internal-draft.pptx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    fileName: "orion-v2-internal-draft.pptx",
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
  return join(ORION_V2_UI_ROOT, "cases", caseId);
}

function runRecordPath(caseId: string, runId: string): string {
  return join(caseDir(caseId), "runs", `${runId}.json`);
}

function latestPointerPath(caseId: string): string {
  return join(caseDir(caseId), "latest.json");
}

function isWarningStatus(raw: unknown): boolean {
  const value = String(raw ?? "").toLowerCase();
  return value.includes("warning") || value.includes("failed");
}

function hasConversionIssue(doc: Record<string, unknown>): boolean {
  const status = String(doc.status ?? "").toLowerCase();
  if (status.includes("conversion")) return true;
  const notes = Array.isArray(doc.internalNotes) ? doc.internalNotes.map(String) : [];
  return notes.some((note) =>
    /docx|converter|pdf|renderer|soffice|libreoffice|fitz|png/i.test(note)
  );
}

function detectLexisStatus(outputRoot: string, visualPages: number): LexisStatus {
  const context = readJson<{
    lexis?: {
      uploadExists?: boolean;
      visualPageCount?: number;
      latestAny?: Record<string, unknown> | null;
      latestReady?: Record<string, unknown> | null;
    };
  }>(join(outputRoot, "real-case-context-inspection.json"));
  const lexis = context?.lexis;
  if (!lexis?.uploadExists) return "not_uploaded";
  const visualCount = Number(lexis.visualPageCount ?? visualPages ?? 0);
  if (visualCount > 0) return "visual_pages_ready";
  const latestAny = (lexis.latestAny ?? {}) as Record<string, unknown>;
  const parserStatus = ((latestAny.parsedAnalytics ?? {}) as Record<string, unknown>)
    .parserStatus;
  const docStatus = latestAny.status;
  if (hasConversionIssue(latestAny)) return "conversion_failed";
  if (!isWarningStatus(parserStatus) && !isWarningStatus(docStatus)) {
    return "uploaded_parsed";
  }
  return "requires_manual_review";
}

function buildRunWarnings(input: {
  pipelineWarnings: string[];
  aiEnforcement: {
    status: string;
    reason: string | null;
    deterministicRequiredStages: string[];
  };
  consistencyStatus: string;
  consistencyViolations: Array<{
    section?: string;
    microStage?: string;
    field?: string;
    expected?: string;
    actual?: string;
  }>;
}): string[] {
  const out: string[] = [];
  if (input.aiEnforcement.status === "BLOCKED") {
    out.push(
      input.aiEnforcement.reason ??
        "GPT-5.5 analysis missing for one or more required ORION stages."
    );
    if (input.aiEnforcement.deterministicRequiredStages.length > 0) {
      out.push(
        `Stages without GPT-5.5: ${input.aiEnforcement.deterministicRequiredStages.slice(0, 6).join(", ")}`
      );
    }
  }
  if (input.consistencyStatus !== "PASS") {
    out.push(`Consistency check: ${input.consistencyStatus}`);
    for (const violation of input.consistencyViolations.slice(0, 4)) {
      const label = [violation.section, violation.microStage, violation.field]
        .filter(Boolean)
        .join("/");
      const detail = violation.expected
        ? `expected ${violation.expected}, got ${violation.actual ?? "?"}`
        : violation.actual ?? "violation";
      out.push(label ? `${label}: ${detail}` : detail);
    }
  }
  for (const warning of normalizeWarnings(input.pipelineWarnings)) {
    if (!out.includes(warning)) out.push(warning);
  }
  return out.slice(0, 8);
}

function normalizeWarnings(warnings: string[]): string[] {
  return warnings.slice(0, 8).map((warning) => {
    const lower = warning.toLowerCase();
    if (lower.includes("r9-render-failed")) return "ORION v2 renderer did not complete.";
    if (lower.includes("real-case-adapter-unavailable")) {
      return "Real case data bridge reported unavailable context.";
    }
    if (lower.startsWith("search-provider-unavailable:")) {
      const provider = warning.split(":").slice(1).join(":") || "provider";
      return `Search provider unavailable (${provider}): using cached case data from DB. New Google/Serp searches require a topped-up API key.`;
    }
    return "Pipeline completed with non-blocking warning.";
  });
}

function artifactDownloadUrl(
  caseId: string,
  runId: string,
  artifact: OrionV2ArtifactKind,
  storageKey: string
): string {
  const { token } = createSignedToken(storageKey);
  const query = new URLSearchParams({
    runId,
    artifact,
    token,
  });
  return `/api/digital-profile/cases/${caseId}/report/orion-v2/download?${query.toString()}`;
}

function toPublicSummary(
  record: OrionV2RunRecord | null,
  includeInternalArtifacts: boolean
): OrionV2ReportSummary {
  const readiness = describeOrionV2AiReadiness();
  if (!record) {
    return {
      ok: true,
      uiEnabled: digitalProfileConfig.orionV2UiEnabled,
      reportMode: "orion_section_pipeline_v1",
      status: "empty",
      runId: null,
      storeMode: null,
      createdAt: null,
      completedAt: null,
      pageCount: 0,
      clientPageCount: 0,
      lexisVisualPageCount: 0,
      lexisStatus: "unknown",
      gpt55Status: "unknown",
      deterministicFallbackUsed: false,
      aiRequired: readiness.requireAi,
      aiReady: readiness.ready,
      aiEnforcementStatus: "unknown",
      clientPolicyStatus: null,
      artifacts: {
        clientPdf: { available: false, downloadUrl: null },
        clientPptx: { available: false, downloadUrl: null },
      },
      warnings: [],
    };
  }

  const artifact = (kind: OrionV2ArtifactKind): OrionV2ArtifactSummary => {
    const item = record.artifacts[kind];
    if (!item) return { available: false, downloadUrl: null };
    return {
      available: true,
      downloadUrl: artifactDownloadUrl(record.caseId, record.runId, kind, item.storageKey),
    };
  };

  const artifacts: OrionV2ArtifactsResponse = {
    clientPdf: artifact("client_pdf"),
    clientPptx: artifact("client_pptx"),
  };
  if (includeInternalArtifacts) {
    artifacts.internalDraftPdf = artifact("internal_draft_pdf");
    artifacts.internalDraftPptx = artifact("internal_draft_pptx");
  }

  return {
    ok: true,
    uiEnabled: digitalProfileConfig.orionV2UiEnabled,
    reportMode: record.reportMode,
    status: record.status,
    runId: record.runId,
    storeMode: record.storeMode,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    pageCount: record.pageCount,
    clientPageCount: record.clientPageCount,
    lexisVisualPageCount: record.lexisVisualPageCount,
    lexisStatus: record.lexisStatus,
    gpt55Status: record.gpt55Status,
    deterministicFallbackUsed: record.deterministicFallbackUsed,
    aiRequired: record.aiRequired,
    aiReady: record.aiReady,
    aiEnforcementStatus: record.aiEnforcementStatus,
    clientPolicyStatus: record.clientPolicyStatus,
    artifacts,
    warnings: record.warnings,
  };
}

async function persistArtifacts(
  caseId: string,
  runId: string,
  outputRoot: string
): Promise<Partial<Record<OrionV2ArtifactKind, OrionV2ArtifactRecord>>> {
  const out: Partial<Record<OrionV2ArtifactKind, OrionV2ArtifactRecord>> = {};
  for (const [kind, meta] of Object.entries(ARTIFACT_META) as Array<
    [OrionV2ArtifactKind, (typeof ARTIFACT_META)[OrionV2ArtifactKind]]
  >) {
    const sourcePath = join(outputRoot, "composed", meta.sourceFile);
    if (!existsSync(sourcePath)) continue;
    const file = readFileSync(sourcePath);
    const exportId = `orion-v2-${runId}`;
    const ext = meta.fileName.toLowerCase().endsWith(".pdf") ? "pdf" : "pptx";
    const storageKey = buildStorageKey.export(
      caseId,
      exportId,
      `${kind}.${ext}`
    );
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

function isAdminRole(role: DpRole): boolean {
  return role === "SUPER_ADMIN" || role === "ADMIN";
}

function sanitizeStoreMode(value: unknown): OrionStoreMode | null {
  if (value === "file" || value === "db") return value;
  return null;
}

export function isOrionV2UiEnabled(): boolean {
  return digitalProfileConfig.orionV2UiEnabled;
}

export function resolveOrionStoreMode(
  requested: unknown,
  role: DpRole
): OrionStoreMode {
  const defaultMode = digitalProfileConfig.orionPipelineStore;
  const requestedMode = sanitizeStoreMode(requested);
  if (!requestedMode) return defaultMode;
  if (!isAdminRole(role)) return defaultMode;
  return requestedMode;
}

export function resolveGpt55ValidationFlag(requested: unknown, role: DpRole): boolean {
  if (!isAdminRole(role)) return false;
  return requested === true;
}

/** Client-safe ORION v2 AI readiness (booleans only, no secrets). */
export function getOrionV2AiReadiness(): OrionV2AiReadiness {
  return describeOrionV2AiReadiness();
}

function buildRunningPlaceholder(
  options: RunOrionV2Options,
  uiRunId: string,
  runOutputRoot: string,
  createdAt: string
): OrionV2RunRecord {
  const readiness = describeOrionV2AiReadiness();
  return {
    caseId: options.caseId,
    runId: uiRunId,
    reportMode: "orion_section_pipeline_v1",
    status: "running",
    storeMode: options.storeMode,
    createdAt,
    completedAt: null,
    outputRoot: runOutputRoot,
    pageCount: 0,
    clientPageCount: 0,
    lexisVisualPageCount: 0,
    lexisStatus: "not_uploaded",
    gpt55Status: "skipped",
    deterministicFallbackUsed: false,
    gpt55ValidationRequested: options.gpt55Validate,
    aiRequired: options.requireAiAnalysis === true || readiness.requireAi,
    aiReady: readiness.ready,
    aiEnforcementStatus: "SKIPPED",
    clientPolicyStatus: "PENDING",
    warnings: [],
    artifacts: {},
  };
}

function persistRunRecord(record: OrionV2RunRecord): void {
  writeJson(runRecordPath(record.caseId, record.runId), record);
  writeJson(latestPointerPath(record.caseId), {
    runId: record.runId,
    updatedAt: record.completedAt ?? record.createdAt,
  });
}

/** Runs the full ORION v2 pipeline synchronously (QA/scripts). */
export async function runOrionV2Report(
  options: RunOrionV2Options
): Promise<OrionV2RunRecord> {
  return executeOrionV2Report(options);
}

/**
 * Starts ORION v2 generation in the background and returns immediately with
 * status `running`. Avoids HTTP gateway timeouts on long GPT-heavy runs.
 */
export function enqueueOrionV2Report(options: RunOrionV2Options): OrionV2RunRecord {
  const existing = getLatestOrionV2RunRecord(options.caseId);
  if (existing?.status === "running") {
    return existing;
  }

  const now = new Date();
  const ts = now.getTime();
  const uiRunId = `orion-v2-ui-${ts}`;
  const runOutputRoot = join(
    ORION_V2_UI_ROOT,
    "cases",
    options.caseId,
    "runs",
    `${ts}`
  );
  const createdAt = now.toISOString();
  const placeholder = buildRunningPlaceholder(options, uiRunId, runOutputRoot, createdAt);
  persistRunRecord(placeholder);
  logOrionPipeline("service", "enqueue", {
    caseId: options.caseId,
    runId: uiRunId,
    requireAi: options.requireAiAnalysis === true,
    gpt55Validate: options.gpt55Validate === true,
  });

  setImmediate(() => {
    void executeOrionV2Report({
      ...options,
      uiRunId,
      runOutputRoot,
    }).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const readiness = describeOrionV2AiReadiness();
      const failed: OrionV2RunRecord = {
        ...placeholder,
        status: "failed",
        completedAt: new Date().toISOString(),
        gpt55Status: readiness.ready ? "deterministic_fallback" : "required_missing",
        aiReady: readiness.ready,
        aiEnforcementStatus: "SKIPPED",
        clientPolicyStatus: "UNKNOWN",
        warnings: [`ORION v2 generation failed: ${errorMessage}`],
      };
      persistRunRecord(failed);
      errorOrionPipeline("service", "background-generation-failed", {
        caseId: options.caseId,
        runId: uiRunId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack?.split("\n").slice(0, 4).join(" | ") : undefined,
      });
    });
  });

  return placeholder;
}

async function executeOrionV2Report(
  options: RunOrionV2Options
): Promise<OrionV2RunRecord> {
  const now = new Date();
  const uiRunId = options.uiRunId ?? `orion-v2-ui-${now.getTime()}`;
  const runOutputRoot =
    options.runOutputRoot ??
    join(ORION_V2_UI_ROOT, "cases", options.caseId, "runs", `${now.getTime()}`);
  const requireAiAnalysis = options.requireAiAnalysis === true;
  const allowDeterministicFallback = options.allowDeterministicFallback === true;
  logOrionPipeline("service", "execute-start", {
    caseId: options.caseId,
    runId: uiRunId,
    requireAiAnalysis,
    allowDeterministicFallback,
    gpt55Validate: options.gpt55Validate === true,
  });
  // Required stages must attempt GPT even if the admin GPT toggle is off.
  const result = await runExactOrionPipeline(options.caseId, {
    outputRoot: runOutputRoot,
    useRealCaseData: true,
    r93Gpt55Validate: options.gpt55Validate || requireAiAnalysis,
    requireAiAnalysis,
    allowDeterministicFallback,
    storeMode: options.storeMode,
    locale: "ru",
  });
  const completedAt = new Date().toISOString();
  const aiEnforcement = result.aiEnforcement;
  const gpt55Used = result.analyses.filter((row) => row.generatedBy === "gpt-5.5")
    .length;
  const deterministicCount = result.analyses.filter(
    (row) => row.generatedBy !== "gpt-5.5"
  ).length;
  const deterministicFallbackUsed = deterministicCount > 0;
  const readiness = describeOrionV2AiReadiness();

  let gpt55Status: Gpt55Status;
  if (!readiness.ready) {
    gpt55Status = "required_missing";
  } else if (aiEnforcement.status === "BLOCKED") {
    gpt55Status = "deterministic_fallback";
  } else if (aiEnforcement.status === "PASS_WITH_DETERMINISTIC_FALLBACK") {
    gpt55Status = "deterministic_fallback";
  } else if (gpt55Used > 0) {
    gpt55Status = "used";
  } else if (options.gpt55Validate || requireAiAnalysis) {
    gpt55Status = "deterministic_fallback";
  } else {
    gpt55Status = "skipped";
  }

  const consistencyPass = result.consistencyInspection.status === "PASS";
  const blocked = aiEnforcement.status === "BLOCKED";
  const runStatus: OrionV2RunRecord["status"] =
    blocked || !consistencyPass ? "failed" : "completed";

  const pageCount = Number(result.compositionInspection.finalInternalPageCount ?? 0);
  const clientPageCount = Number(
    result.compositionInspection.finalClientPageCount ?? 0
  );
  const lexisVisualPageCount = Number(
    result.compositionInspection.lexisNexisVisualPageCount ?? 0
  );
  // Never expose downloadable client artifacts for an AI-blocked (incomplete) run.
  const artifacts = blocked
    ? {}
    : await persistArtifacts(options.caseId, uiRunId, runOutputRoot);

  const record: OrionV2RunRecord = {
    caseId: options.caseId,
    runId: uiRunId,
    reportMode: "orion_section_pipeline_v1",
    status: runStatus,
    storeMode: options.storeMode,
    createdAt: result.run.startedAt,
    completedAt,
    outputRoot: runOutputRoot,
    pageCount,
    clientPageCount,
    lexisVisualPageCount,
    lexisStatus: detectLexisStatus(runOutputRoot, lexisVisualPageCount),
    gpt55Status,
    deterministicFallbackUsed,
    gpt55ValidationRequested: options.gpt55Validate,
    aiRequired: requireAiAnalysis || readiness.requireAi,
    aiReady: readiness.ready,
    aiEnforcementStatus: aiEnforcement.status,
    clientPolicyStatus: String(result.consistencyInspection.status ?? "UNKNOWN"),
    warnings: buildRunWarnings({
      pipelineWarnings: result.run.warnings ?? [],
      aiEnforcement,
      consistencyStatus: String(result.consistencyInspection.status ?? "UNKNOWN"),
      consistencyViolations: result.consistencyInspection.violations ?? [],
    }),
    artifacts,
  };

  logOrionPipeline("service", "execute-finished", {
    caseId: options.caseId,
    runId: uiRunId,
    status: runStatus,
    aiEnforcementStatus: aiEnforcement.status,
    consistencyStatus: result.consistencyInspection.status,
    clientPageCount,
    blocked,
    artifactCount: Object.keys(artifacts).length,
  });
  if (runStatus === "failed") {
    warnOrionPipeline("service", "run-marked-failed", {
      caseId: options.caseId,
      runId: uiRunId,
      aiEnforcementStatus: aiEnforcement.status,
      consistencyStatus: result.consistencyInspection.status,
      warnings: record.warnings,
    });
  }

  persistRunRecord(record);
  return record;
}

export function getLatestOrionV2RunRecord(caseId: string): OrionV2RunRecord | null {
  const latest = readJson<{ runId?: string }>(latestPointerPath(caseId));
  if (!latest?.runId) return null;
  return readJson<OrionV2RunRecord>(runRecordPath(caseId, latest.runId));
}

export function getOrionV2Summary(
  caseId: string,
  role: DpRole
): OrionV2ReportSummary {
  const record = getLatestOrionV2RunRecord(caseId);
  return toPublicSummary(record, isAdminRole(role));
}

export function assertOrionArtifactAccess(
  role: DpRole,
  artifact: OrionV2ArtifactKind
): void {
  if (artifact === "internal_draft_pdf" || artifact === "internal_draft_pptx") {
    if (!can(role, "report.downloadInternal")) {
      throw new ForbiddenError("Internal ORION artifact download is forbidden.");
    }
    return;
  }
  if (!can(role, "report.downloadClient")) {
    throw new ForbiddenError("Client ORION artifact download is forbidden.");
  }
}

export function resolveOrionArtifactForDownload(input: {
  caseId: string;
  role: DpRole;
  runId: string;
  artifact: string;
  token: string;
}): OrionV2ArtifactRecord {
  const artifact = input.artifact as OrionV2ArtifactKind;
  if (!Object.hasOwn(ARTIFACT_META, artifact)) {
    throw new ValidationError("Unknown ORION v2 artifact.");
  }
  assertOrionArtifactAccess(input.role, artifact);
  const record = readJson<OrionV2RunRecord>(runRecordPath(input.caseId, input.runId));
  if (!record) throw new NotFoundError("ORION v2 run not found.");
  const meta = record.artifacts[artifact];
  if (!meta) throw new NotFoundError("ORION v2 artifact not found.");
  if (!verifySignedToken(meta.storageKey, input.token)) {
    throw new NotFoundError("ORION v2 artifact not found.");
  }
  return meta;
}

export function assertOrionUiFlagForRole(role: DpRole): void {
  if (digitalProfileConfig.orionV2UiEnabled) return;
  if (isAdminRole(role)) return;
  throw new ForbiddenError("ORION v2 UI is disabled.");
}

