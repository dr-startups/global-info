import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DpRole } from "../auth/roles";
import { can } from "../auth/roles";
import { digitalProfileConfig } from "../config";
import { ForbiddenError, NotFoundError, ValidationError } from "../http/errors";
import { verifySignedToken } from "../storage/signed-url";
import { runOrionClassicAuditRender } from "../orion-golden/classic/run-orion-classic-audit-render";
import { loadPostReviewClientContent } from "../orion-golden/classic/run-orion-classic-audit-render";
import { persistRegeneratedClientContent } from "../orion-golden/services/admin-review-workflow-service";
import { saveFile } from "../storage/private-store";
import { buildStorageKey } from "../storage/keys";
import { createSignedToken } from "../storage/signed-url";

export type OrionClassicAuditArtifactKind = "client_pdf" | "client_pptx";

interface OrionClassicAuditArtifactRecord {
  storageKey: string;
  sizeBytes: number;
  sha256: string;
  mimeType: string;
  fileName: string;
}

interface OrionClassicAuditRunRecord {
  caseId: string;
  runId: string;
  reportMode: "classic_orion_audit_r10_11";
  status: "completed" | "failed" | "running";
  createdAt: string;
  completedAt: string | null;
  outputRoot: string;
  slideCount: number;
  pageCount: number;
  verdict: string;
  clientPolicyStatus: string;
  warnings: string[];
  artifacts: Partial<Record<OrionClassicAuditArtifactKind, OrionClassicAuditArtifactRecord>>;
}

interface ArtifactSummary {
  available: boolean;
  downloadUrl: string | null;
}

export interface OrionClassicAuditReportSummary {
  ok: boolean;
  uiEnabled: boolean;
  reportMode: "classic_orion_audit_r10_11";
  status: "completed" | "failed" | "running" | "empty";
  runId: string | null;
  createdAt: string | null;
  completedAt: string | null;
  slideCount: number;
  pageCount: number;
  verdict: string | null;
  clientPolicyStatus: string | null;
  artifacts: {
    clientPdf: ArtifactSummary;
    clientPptx: ArtifactSummary;
  };
  warnings: string[];
}

const UI_ROOT = join(process.cwd(), "storage", "digital-profile", "orion-classic-audit-ui");

const ARTIFACT_META: Record<
  OrionClassicAuditArtifactKind,
  { sourceFile: string; mimeType: string; fileName: string }
> = {
  client_pdf: {
    sourceFile: "rendered-client.pdf",
    mimeType: "application/pdf",
    fileName: "orion-classic-audit.pdf",
  },
  client_pptx: {
    sourceFile: "rendered-client.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    fileName: "orion-classic-audit.pptx",
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

export function isOrionClassicAuditUiEnabled(): boolean {
  return digitalProfileConfig.orionGoldenEnabled;
}

function artifactDownloadUrl(
  caseId: string,
  runId: string,
  artifact: OrionClassicAuditArtifactKind,
  storageKey: string
): string {
  const { token } = createSignedToken(storageKey);
  const query = new URLSearchParams({ runId, artifact, token });
  return `/api/digital-profile/cases/${caseId}/orion-golden/report/download?${query.toString()}`;
}

function toPublicSummary(record: OrionClassicAuditRunRecord | null): OrionClassicAuditReportSummary {
  if (!record) {
    return {
      ok: true,
      uiEnabled: isOrionClassicAuditUiEnabled(),
      reportMode: "classic_orion_audit_r10_11",
      status: "empty",
      runId: null,
      createdAt: null,
      completedAt: null,
      slideCount: 0,
      pageCount: 0,
      verdict: null,
      clientPolicyStatus: null,
      artifacts: {
        clientPdf: { available: false, downloadUrl: null },
        clientPptx: { available: false, downloadUrl: null },
      },
      warnings: [],
    };
  }

  const artifact = (kind: OrionClassicAuditArtifactKind): ArtifactSummary => {
    const item = record.artifacts[kind];
    if (!item) return { available: false, downloadUrl: null };
    return {
      available: true,
      downloadUrl: artifactDownloadUrl(record.caseId, record.runId, kind, item.storageKey),
    };
  };

  return {
    ok: record.status === "completed",
    uiEnabled: isOrionClassicAuditUiEnabled(),
    reportMode: record.reportMode,
    status: record.status,
    runId: record.runId,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    slideCount: record.slideCount,
    pageCount: record.pageCount,
    verdict: record.verdict,
    clientPolicyStatus: record.clientPolicyStatus,
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
): Promise<Partial<Record<OrionClassicAuditArtifactKind, OrionClassicAuditArtifactRecord>>> {
  const out: Partial<Record<OrionClassicAuditArtifactKind, OrionClassicAuditArtifactRecord>> = {};
  for (const [kind, meta] of Object.entries(ARTIFACT_META) as Array<
    [OrionClassicAuditArtifactKind, (typeof ARTIFACT_META)[OrionClassicAuditArtifactKind]]
  >) {
    const sourcePath = join(outputRoot, meta.sourceFile);
    if (!existsSync(sourcePath)) continue;
    const file = readFileSync(sourcePath);
    const exportId = `orion-classic-audit-${runId}`;
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

function persistRunRecord(record: OrionClassicAuditRunRecord): void {
  writeJson(runRecordPath(record.caseId, record.runId), record);
  writeJson(latestPointerPath(record.caseId), {
    runId: record.runId,
    updatedAt: record.completedAt ?? record.createdAt,
  });
}

export function getLatestOrionClassicAuditRunRecord(
  caseId: string
): OrionClassicAuditRunRecord | null {
  const latest = readJson<{ runId?: string }>(latestPointerPath(caseId));
  if (!latest?.runId) return null;
  return readJson<OrionClassicAuditRunRecord>(runRecordPath(caseId, latest.runId));
}

export function getOrionClassicAuditSummary(caseId: string): OrionClassicAuditReportSummary {
  return toPublicSummary(getLatestOrionClassicAuditRunRecord(caseId));
}

export function resolveOrionClassicAuditArtifactForDownload(input: {
  caseId: string;
  role: DpRole;
  runId: string;
  artifact: string;
  token: string;
}): OrionClassicAuditArtifactRecord {
  const artifact = input.artifact as OrionClassicAuditArtifactKind;
  if (!Object.hasOwn(ARTIFACT_META, artifact)) {
    throw new ValidationError("Unknown classic audit artifact.");
  }
  if (!can(input.role, "report.downloadClient")) {
    throw new ForbiddenError("Classic audit artifact download is forbidden.");
  }
  const record = readJson<OrionClassicAuditRunRecord>(runRecordPath(input.caseId, input.runId));
  if (!record) throw new NotFoundError("Classic audit run not found.");
  const meta = record.artifacts[artifact];
  if (!meta) throw new NotFoundError("Classic audit artifact not found.");
  if (!verifySignedToken(meta.storageKey, input.token)) {
    throw new NotFoundError("Classic audit artifact not found.");
  }
  return meta;
}

async function executeClassicAuditReport(input: {
  caseId: string;
  uiRunId: string;
  runOutputRoot: string;
  createdAt: string;
  regenerateContent?: boolean;
}): Promise<OrionClassicAuditRunRecord> {
  if (input.regenerateContent) {
    persistRegeneratedClientContent(input.caseId);
  }

  let clientContent;
  try {
    clientContent = loadPostReviewClientContent(input.caseId);
  } catch {
    throw new ValidationError(
      "Post-review client content missing. Complete manual review and regenerate content first."
    );
  }

  const result = await runOrionClassicAuditRender({
    caseId: input.caseId,
    outputRoot: input.runOutputRoot,
    clientContent,
  });

  // Persist downloadable artifacts even on soft FAIL (e.g. page-range QA), so the client can review the PDF.
  const artifacts = await persistArtifacts(input.caseId, input.uiRunId, input.runOutputRoot);
  const hasArtifacts = Boolean(artifacts.client_pdf || artifacts.client_pptx);
  const softFailWithArtifacts = result.verdict !== "PASS" && hasArtifacts;

  const record: OrionClassicAuditRunRecord = {
    caseId: input.caseId,
    runId: input.uiRunId,
    reportMode: "classic_orion_audit_r10_11",
    status: result.verdict === "PASS" || softFailWithArtifacts ? "completed" : "failed",
    createdAt: input.createdAt,
    completedAt: new Date().toISOString(),
    outputRoot: input.runOutputRoot,
    slideCount: result.slideCount,
    pageCount: result.pageCount,
    verdict: result.verdict,
    clientPolicyStatus: result.clientPolicyStatus,
    warnings: result.warnings,
    artifacts,
  };

  persistRunRecord(record);
  console.log(
    `[orion-classic-audit] done caseId=${input.caseId} verdict=${result.verdict} pages=${result.pageCount} artifacts=${hasArtifacts}`
  );
  return record;
}

/**
 * Enqueue classic ORION audit render. Returns immediately with status=running; poll GET until settled.
 */
export function enqueueOrionClassicAuditReport(input: {
  caseId: string;
  regenerateContent?: boolean;
}): OrionClassicAuditReportSummary {
  if (!digitalProfileConfig.orionGoldenEnabled) {
    throw new ForbiddenError("ORION Golden is disabled.");
  }

  const existing = getLatestOrionClassicAuditRunRecord(input.caseId);
  if (existing?.status === "running") {
    return toPublicSummary(existing);
  }

  const uiRunId = `classic-${Date.now()}`;
  const createdAt = new Date().toISOString();
  const runOutputRoot = join(caseDir(input.caseId), "runs", uiRunId, "output");
  ensureDir(runOutputRoot);

  const running: OrionClassicAuditRunRecord = {
    caseId: input.caseId,
    runId: uiRunId,
    reportMode: "classic_orion_audit_r10_11",
    status: "running",
    createdAt,
    completedAt: null,
    outputRoot: runOutputRoot,
    slideCount: 0,
    pageCount: 0,
    verdict: "PENDING",
    clientPolicyStatus: "PENDING",
    warnings: ["Job started — poll status; render may take several minutes."],
    artifacts: {},
  };
  persistRunRecord(running);
  console.log(`[orion-classic-audit] enqueued caseId=${input.caseId} runId=${uiRunId}`);

  setImmediate(() => {
    void executeClassicAuditReport({
      caseId: input.caseId,
      uiRunId,
      runOutputRoot,
      createdAt,
      regenerateContent: input.regenerateContent,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : "classic-audit-render-failed";
      console.error(`[orion-classic-audit] failed caseId=${input.caseId}: ${message}`);
      const failed: OrionClassicAuditRunRecord = {
        ...running,
        status: "failed",
        completedAt: new Date().toISOString(),
        verdict: "FAIL",
        clientPolicyStatus: "FAIL",
        warnings: [message],
      };
      persistRunRecord(failed);
    });
  });

  return toPublicSummary(running);
}
