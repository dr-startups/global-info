/**
 * Safe SUBMIT_UNKNOWN recovery: link existing Arsenkin task OR confirm-not-created + one /set.
 * Never auto-retries /set. Never silently maps SUBMIT_UNKNOWN → FAILED.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ArsenkinClient } from "./client";
import { ensureArsenkinTask, pollArsenkinTask } from "./poll-worker";
import type { ProviderTaskStore } from "./provider-task-store";
import { redactDeep } from "./redact";
import type { ProviderTaskRecord } from "./types";
import {
  appendArsenkinRecoveryDecision,
  findConfirmNotCreatedDecision,
  hasOpenSubmitUnknownRetry,
  loadArsenkinRecoveryDecisions,
  markConfirmRetryUsed,
} from "./recovery-decisions";
import { buildSubmitFailureDiagnostics } from "./submit-failure-diagnostics";

export { buildSubmitFailureDiagnostics };

export type SubmitUnknownCandidate = {
  providerTaskId: string;
  toolName: string;
  requestHash: string;
  state: string;
  errorCode: string | null;
  externalTaskId: string | null;
  createdAt: string;
  engine: string | null;
  region: string | null;
  query: string | null;
  queryCount: number;
  sanitizedRequest: Record<string, unknown>;
  httpStatus: number | null;
  sanitizedResponse: Record<string, unknown> | null;
  canLinkExisting: boolean;
  canConfirmNotCreated: boolean;
  canRetryAfterConfirm: boolean;
};

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function requestMeta(row: ProviderTaskRecord): {
  engine: string | null;
  region: string | null;
  query: string | null;
  queryCount: number;
} {
  const data = asObj(row.requestJson.data);
  const queries = Array.isArray(data.queries) ? (data.queries as unknown[]) : [];
  const se = data.se;
  let engine: string | null = null;
  if (typeof se === "number") {
    engine = se === 11 || se === 12 ? "GOOGLE" : se === 2 || se === 1 || se === 3 ? "YANDEX" : String(se);
  } else if (Array.isArray(se) && se.length > 1) {
    engine = "MIXED";
  } else if (Array.isArray(se) && se[0]) {
    const t = Number(asObj(se[0]).type ?? 0);
    engine = t === 11 || t === 12 ? "GOOGLE" : "YANDEX";
  }
  const region =
    data.region != null
      ? String(data.region)
      : Array.isArray(se) && se[0]
        ? String(asObj(se[0]).region ?? "")
        : null;
  return {
    engine,
    region,
    query: queries[0] != null ? String(queries[0]) : null,
    queryCount: queries.length,
  };
}

function diagnosticsOf(row: ProviderTaskRecord): {
  httpStatus: number | null;
  sanitizedResponse: Record<string, unknown> | null;
} {
  const resp = row.responseJson ? asObj(row.responseJson) : {};
  const diag = asObj(resp._submitDiagnostics ?? resp.diagnostics);
  const status =
    diag.httpStatus != null
      ? Number(diag.httpStatus)
      : row.errorCode?.startsWith("http_")
        ? Number(row.errorCode.replace("http_", ""))
        : null;
  const body = diag.responseBody ?? diag.raw ?? (Object.keys(resp).length ? resp : null);
  return {
    httpStatus: Number.isFinite(status) ? status : null,
    sanitizedResponse: body ? (redactDeep(asObj(body)) as Record<string, unknown>) : null,
  };
}

export function toSubmitUnknownCandidate(
  row: ProviderTaskRecord,
  outRoot: string
): SubmitUnknownCandidate | null {
  if (row.state !== "SUBMIT_UNKNOWN") return null;
  const meta = requestMeta(row);
  const diag = diagnosticsOf(row);
  const decisions = loadArsenkinRecoveryDecisions(outRoot);
  const confirm = findConfirmNotCreatedDecision(decisions, row.id);
  return {
    providerTaskId: row.id,
    toolName: row.toolName,
    requestHash: row.requestHash,
    state: row.state,
    errorCode: row.errorCode,
    externalTaskId: row.externalTaskId,
    createdAt: row.createdAt.toISOString(),
    engine: meta.engine,
    region: meta.region,
    query: meta.query,
    queryCount: meta.queryCount,
    sanitizedRequest: redactDeep(asObj(row.requestJson)) as Record<string, unknown>,
    httpStatus: diag.httpStatus,
    sanitizedResponse: diag.sanitizedResponse,
    canLinkExisting: !row.externalTaskId,
    canConfirmNotCreated: !confirm,
    canRetryAfterConfirm: hasOpenSubmitUnknownRetry(decisions, row.id),
  };
}

export async function linkExistingArsenkinTask(input: {
  client: ArsenkinClient;
  store: ProviderTaskStore;
  outRoot: string;
  caseId: string;
  reportRunId: string;
  providerTaskId: string;
  externalTaskId: string;
  actorId: string;
  evidenceNote?: string;
}): Promise<{ task: ProviderTaskRecord; checkState: string }> {
  const row = await input.store.findById(input.providerTaskId);
  if (!row) throw new Error(`provider-task-not-found:${input.providerTaskId}`);
  if (row.reportRunId !== input.reportRunId) throw new Error("reportRunId-mismatch");
  if (row.state !== "SUBMIT_UNKNOWN") throw new Error(`expected-SUBMIT_UNKNOWN:got=${row.state}`);
  if (row.externalTaskId) throw new Error("externalTaskId-already-set");

  const externalTaskId = String(input.externalTaskId).trim();
  if (!/^\d+$/.test(externalTaskId)) throw new Error("invalid-external-task-id");

  const check = await input.client.checkTask(externalTaskId);
  // Soft compatibility: tools_name in request vs check payload when present
  const checkTool = String(
    asObj(check.raw).tools_name ?? asObj(asObj(check.raw).request).tools_name ?? ""
  ).trim();
  if (checkTool && checkTool !== row.toolName) {
    throw new Error(`tool-mismatch:expected=${row.toolName}:got=${checkTool}`);
  }

  appendArsenkinRecoveryDecision(input.outRoot, {
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    decision: {
      kind: "LINK_EXISTING_TASK",
      reportRunId: input.reportRunId,
      providerTaskId: row.id,
      requestHash: row.requestHash,
      toolName: row.toolName,
      actorId: input.actorId,
      externalTaskId,
      evidenceNote: input.evidenceNote ?? "linked_existing_provider_task",
      metadata: { checkState: check.state },
    },
  });

  let next = await input.store.updateState(row.id, {
    state: "RUNNING",
    externalTaskId,
    errorCode: null,
    nextPollAt: new Date(),
    submittedAt: row.submittedAt ?? new Date(),
    responseJson: {
      ...(row.responseJson ?? {}),
      _recovery: {
        kind: "LINK_EXISTING_TASK",
        linkedAt: new Date().toISOString(),
        externalTaskId,
        priorErrorCode: row.errorCode,
      },
    },
  });

  if (check.state === "DONE") {
    next = await pollArsenkinTask(input.client, input.store, next);
  } else if (check.state === "FAILED" || check.state === "CANCELLED") {
    next = await input.store.updateState(next.id, {
      state: check.state,
      errorCode: check.state.toLowerCase(),
      responseJson: check.raw,
      completedAt: new Date(),
    });
  }

  return { task: next, checkState: check.state };
}

export async function confirmSubmitUnknownNotCreated(input: {
  outRoot: string;
  caseId: string;
  reportRunId: string;
  store: ProviderTaskStore;
  providerTaskId: string;
  actorId: string;
  reason: string;
  evidenceNote?: string;
}): Promise<{ decisionId: string }> {
  const reason = String(input.reason ?? "").trim();
  if (!reason) throw new Error("reason-required");
  const row = await input.store.findById(input.providerTaskId);
  if (!row) throw new Error(`provider-task-not-found:${input.providerTaskId}`);
  if (row.reportRunId !== input.reportRunId) throw new Error("reportRunId-mismatch");
  if (row.state !== "SUBMIT_UNKNOWN") throw new Error(`expected-SUBMIT_UNKNOWN:got=${row.state}`);
  if (row.externalTaskId) throw new Error("externalTaskId-present-cannot-confirm-not-created");

  const existing = findConfirmNotCreatedDecision(
    loadArsenkinRecoveryDecisions(input.outRoot),
    row.id
  );
  if (existing?.allowsOneRetry && !existing.retryUsed) {
    return { decisionId: existing.id };
  }
  if (existing?.retryUsed) {
    throw new Error("confirm-not-created-retry-already-used");
  }

  const set = appendArsenkinRecoveryDecision(input.outRoot, {
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    decision: {
      kind: "CONFIRM_NOT_CREATED",
      reportRunId: input.reportRunId,
      providerTaskId: row.id,
      requestHash: row.requestHash,
      toolName: row.toolName,
      actorId: input.actorId,
      reason,
      evidenceNote: input.evidenceNote ?? reason,
      allowsOneRetry: true,
      retryUsed: false,
    },
  });
  const last = set.decisions[set.decisions.length - 1]!;
  return { decisionId: last.id };
}

/**
 * After CONFIRM_NOT_CREATED, allow exactly one /set for this requestHash.
 * Preserves first http_500 diagnostics in responseJson.
 */
export async function retryUnconfirmedSubmitOnce(input: {
  client: ArsenkinClient;
  store: ProviderTaskStore;
  outRoot: string;
  caseId: string;
  reportRunId: string;
  providerTaskId: string;
  actorId: string;
}): Promise<ProviderTaskRecord> {
  const row = await input.store.findById(input.providerTaskId);
  if (!row) throw new Error(`provider-task-not-found:${input.providerTaskId}`);
  if (row.reportRunId !== input.reportRunId) throw new Error("reportRunId-mismatch");
  if (row.state !== "SUBMIT_UNKNOWN") throw new Error(`expected-SUBMIT_UNKNOWN:got=${row.state}`);
  if (row.externalTaskId) throw new Error("externalTaskId-present-retry-forbidden");

  const decisions = loadArsenkinRecoveryDecisions(input.outRoot);
  if (!hasOpenSubmitUnknownRetry(decisions, row.id)) {
    throw new Error("confirm-not-created-required-before-retry");
  }

  const priorDiagnostics = {
    firstErrorCode: row.errorCode,
    firstResponse: redactDeep(row.responseJson ?? {}),
    preservedAt: new Date().toISOString(),
  };

  // Mark retry used BEFORE /set to prevent double-click races.
  markConfirmRetryUsed(input.outRoot, row.id);
  appendArsenkinRecoveryDecision(input.outRoot, {
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    decision: {
      kind: "RETRY_UNCONFIRMED_SUBMIT",
      reportRunId: input.reportRunId,
      providerTaskId: row.id,
      requestHash: row.requestHash,
      toolName: row.toolName,
      actorId: input.actorId,
      reason: "manual_one_shot_retry_after_confirm_not_created",
      metadata: { attempt: row.attempts + 1 },
    },
  });

  await input.store.updateState(row.id, {
    state: "QUEUED",
    attempts: row.attempts + 1,
    errorCode: null,
    nextPollAt: new Date(),
    lockedBy: null,
    lockedAt: null,
    leaseUntil: null,
    responseJson: {
      ...(row.responseJson ?? {}),
      _priorSubmitFailure: priorDiagnostics,
      _recovery: { kind: "RETRY_UNCONFIRMED_SUBMIT", queuedAt: new Date().toISOString() },
    },
  });

  const data = asObj(row.requestJson.data);
  const toolName = String(row.requestJson.tools_name ?? row.toolName);
  return ensureArsenkinTask(input.client, input.store, {
    toolName,
    data,
    caseId: input.caseId,
    reportRunId: input.reportRunId,
  });
}

export function writeProviderTaskResultArtifact(
  outRoot: string,
  providerTaskId: string,
  payload: unknown
): string {
  mkdirSync(outRoot, { recursive: true });
  const path = join(outRoot, `provider-task-${providerTaskId}-result.json`);
  writeFileSync(path, JSON.stringify(redactDeep(payload), null, 2), "utf-8");
  return path;
}
