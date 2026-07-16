/**
 * Poll worker: set → check → get for Arsenkin ProviderTasks.
 * Exactly-once best-effort submit via claimForSubmission; poll never touches QUEUED
 * or RATE_LIMITED-without-externalTaskId (submit-retry state).
 */

import { randomUUID } from "node:crypto";
import { ArsenkinRequestError, type ArsenkinClient } from "./client";
import { acquireArsenkinAccountSlot } from "./account-rate-limit";
import { computeLimitsSpent } from "./cost";
import { hashProviderRequest, type ProviderTaskStore } from "./provider-task-store";
import { buildSubmitFailureDiagnostics } from "./submit-failure-diagnostics";
import type { ArsenkinSetTaskRequest, ProviderTaskRecord } from "./types";

export type EnsureArsenkinTaskInput = {
  toolName: string;
  data: Record<string, unknown>;
  caseId?: string | null;
  reportRunId: string;
  /** Optional submit worker id for CAS ownership. */
  workerId?: string;
  submitLeaseMs?: number;
  /** Max /set attempts for RATE_LIMITED-without-externalTaskId. Default 5. */
  maxSubmitRetries?: number;
};

export function maxArsenkinSubmitRetries(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(1, Number(env.ARSENKIN_MAX_SUBMIT_RETRIES ?? 5) || 5);
}

/** RATE_LIMITED without externalTaskId is a submit-retry state, never a poll state. */
export function isSubmitRetryRateLimited(row: ProviderTaskRecord): boolean {
  return row.state === "RATE_LIMITED" && !row.externalTaskId;
}

async function accountRequest<T>(store: ProviderTaskStore, fn: () => Promise<T>): Promise<T> {
  if (!store.isPersistent) return fn();
  const lease = await acquireArsenkinAccountSlot();
  try {
    return await fn();
  } finally {
    await lease.release();
  }
}

async function availableLimits(client: ArsenkinClient, store: ProviderTaskStore): Promise<number | null> {
  try {
    return (await accountRequest(store, () => client.getLimits())).limitsLeft ?? null;
  } catch {
    return null;
  }
}

function submitFailedState(
  error: unknown,
  attempts: number
): {
  state: ProviderTaskRecord["state"];
  errorCode: string;
  nextPollAt: Date | null;
  completedAt: Date | null;
  attempts: number;
} {
  const requestError = error instanceof ArsenkinRequestError ? error : null;
  const status = requestError?.options.status;
  if (requestError?.options.uncertain || (status != null && status >= 500)) {
    return {
      state: "SUBMIT_UNKNOWN",
      errorCode: status ? `http_${status}` : "submit_unknown",
      nextPollAt: null,
      completedAt: null,
      attempts,
    };
  }
  if (status === 429) {
    return {
      state: "RATE_LIMITED",
      errorCode: "http_429",
      nextPollAt: new Date(Date.now() + 5_000),
      completedAt: null,
      attempts: attempts + 1,
    };
  }
  if (status != null && status >= 400 && status < 500) {
    return {
      state: "FAILED",
      errorCode: `http_${status}`,
      nextPollAt: null,
      completedAt: new Date(),
      attempts: attempts + 1,
    };
  }
  return {
    state: "SUBMIT_UNKNOWN",
    errorCode: "submit_unknown",
    nextPollAt: null,
    completedAt: null,
    attempts,
  };
}

/**
 * Ensure a ProviderTask exists and has been submitted at most once per claim.
 * Never calls /set for SUBMITTING or SUBMIT_UNKNOWN.
 * RATE_LIMITED without externalTaskId waits until nextPollAt, then CAS re-submit.
 */
export async function ensureArsenkinTask(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  input: EnsureArsenkinTaskInput
): Promise<ProviderTaskRecord> {
  const requestJson: ArsenkinSetTaskRequest = {
    tools_name: input.toolName,
    data: input.data,
  };
  const requestHash = hashProviderRequest(requestJson);
  const maxRetries = input.maxSubmitRetries ?? maxArsenkinSubmitRetries();
  let row = await store.findByRequestHash(input.reportRunId, requestHash);
  if (!row) {
    row = await store.upsertPending({
      caseId: input.caseId,
      reportRunId: input.reportRunId,
      toolName: input.toolName,
      requestJson: requestJson as unknown as Record<string, unknown>,
      requestHash,
    });
  }
  if (row.state === "DONE" && row.responseJson) return row;
  const now = new Date();
  // Soft-retry Arsenkin /set HTTP 5xx when no externalTaskId yet (uncertain submit).
  // Avoids terminal SUBMIT_UNKNOWN on transient API 500 (e.g. suggest).
  if (row.state === "SUBMIT_UNKNOWN") {
    const err = String(row.errorCode ?? "");
    const canSoftRetry =
      !row.externalTaskId &&
      /^http_5\d\d$/i.test(err) &&
      row.attempts < maxRetries;
    if (!canSoftRetry) return row;
    row = await store.updateState(row.id, {
      state: "QUEUED",
      errorCode: null,
      nextPollAt: now,
      completedAt: null,
      lockedBy: null,
      lockedAt: null,
      leaseUntil: null,
      attempts: row.attempts + 1,
    });
  }
  if (row.externalTaskId) return row;

  if (row.state === "SUBMITTING") {
    const leaseExpired = !row.leaseUntil || row.leaseUntil.getTime() <= now.getTime();
    if (leaseExpired) {
      return store.updateState(row.id, {
        state: "SUBMIT_UNKNOWN",
        errorCode: "submit_lease_expired",
        nextPollAt: null,
        lockedBy: null,
        lockedAt: null,
        leaseUntil: null,
      });
    }
    return row;
  }

  if (isSubmitRetryRateLimited(row)) {
    if (row.attempts >= maxRetries) {
      return store.updateState(row.id, {
        state: "FAILED",
        errorCode: "submit_retry_exhausted",
        nextPollAt: null,
        completedAt: new Date(),
      });
    }
    if (row.nextPollAt && row.nextPollAt.getTime() > now.getTime()) {
      // Honour backoff — never /set before nextPollAt.
      return row;
    }
    // Safe re-queue for CAS submit (no prior externalTaskId).
    row = await store.updateState(row.id, {
      state: "QUEUED",
      nextPollAt: now,
      lockedBy: null,
      lockedAt: null,
      leaseUntil: null,
    });
  }

  if (row.state !== "QUEUED") {
    return row;
  }

  const workerId = input.workerId ?? `arsenkin-submit-${process.pid}-${randomUUID().slice(0, 8)}`;
  const claimed = await store.claimForSubmission(
    row.id,
    workerId,
    input.submitLeaseMs ?? 60_000,
    now
  );
  if (!claimed) {
    return (await store.findById(row.id)) ?? row;
  }

  const limitsBefore = await availableLimits(client, store);
  try {
    await store.updateState(
      claimed.id,
      { state: "SUBMITTING", limitsBefore, errorCode: null },
      { ownerId: workerId, expectStates: ["SUBMITTING"] }
    );
    const data = requestJson.data ?? {};
    const queries = Array.isArray(data.queries) ? data.queries : [];
    const setStarted = Date.now();
    console.info(
      JSON.stringify({
        event: "arsenkin_set_attempt",
        reportRunId: input.reportRunId,
        providerTaskId: claimed.id,
        requestHash,
        toolName: input.toolName,
        engine: data.se ?? null,
        region: data.region ?? null,
        queryCount: queries.length,
        attempt: claimed.attempts + 1,
      })
    );
    const set = await accountRequest(store, () => client.setTask(requestJson));
    console.info(
      JSON.stringify({
        event: "arsenkin_set_ok",
        reportRunId: input.reportRunId,
        providerTaskId: claimed.id,
        requestHash,
        toolName: input.toolName,
        externalTaskId: String(set.task_id),
        elapsedMs: Date.now() - setStarted,
      })
    );
    row = await store.markExternalId(claimed.id, String(set.task_id), { ownerId: workerId });
    return store.updateState(
      claimed.id,
      {
        state: "RUNNING",
        submittedAt: new Date(),
        limitsBefore,
        nextPollAt: new Date(),
        errorCode: null,
      },
      { ownerId: workerId }
    );
  } catch (error) {
    const failed = submitFailedState(error, claimed.attempts);
    const diagnostics = buildSubmitFailureDiagnostics(error);
    console.info(
      JSON.stringify({
        event: "arsenkin_set_failed",
        reportRunId: input.reportRunId,
        providerTaskId: claimed.id,
        requestHash,
        toolName: input.toolName,
        attempt: claimed.attempts + 1,
        state: failed.state,
        errorCode: failed.errorCode,
        httpStatus: (diagnostics._submitDiagnostics as { httpStatus?: number | null } | undefined)
          ?.httpStatus,
        responseBody: (diagnostics._submitDiagnostics as { responseBody?: unknown } | undefined)
          ?.responseBody,
      })
    );
    return store.updateState(
      claimed.id,
      {
        state: failed.state,
        errorCode: failed.errorCode,
        nextPollAt: failed.nextPollAt,
        completedAt: failed.completedAt,
        attempts: failed.attempts,
        limitsBefore,
        lockedBy: null,
        lockedAt: null,
        leaseUntil: null,
        responseJson: diagnostics,
      },
      { ownerId: workerId }
    );
  }
}

export async function pollArsenkinTask(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  row: ProviderTaskRecord
): Promise<ProviderTaskRecord> {
  if (row.nextPollAt && row.nextPollAt.getTime() > Date.now()) return row;
  if (
    row.state === "QUEUED" ||
    row.state === "SUBMITTING" ||
    row.state === "SUBMIT_UNKNOWN" ||
    isSubmitRetryRateLimited(row)
  ) {
    // Never mark submit-retry RATE_LIMITED as missing_external_task_id.
    return row;
  }
  if (!row.externalTaskId) {
    return store.updateState(row.id, {
      state: "FAILED",
      errorCode: "missing_external_task_id",
      completedAt: new Date(),
    });
  }
  const externalTaskId = row.externalTaskId;
  const check = await accountRequest(store, () => client.checkTask(externalTaskId));
  if (check.state === "RATE_LIMITED") {
    return store.updateState(row.id, {
      state: "RATE_LIMITED",
      attempts: row.attempts + 1,
      nextPollAt: new Date(Date.now() + 5_000),
      errorCode: "429",
    });
  }
  if (check.state === "FAILED" || check.state === "CANCELLED") {
    return store.updateState(row.id, {
      state: check.state,
      attempts: row.attempts + 1,
      errorCode: check.state.toLowerCase(),
      responseJson: check.raw,
      completedAt: new Date(),
    });
  }
  if (check.state !== "DONE") {
    return store.updateState(row.id, {
      state: check.state,
      attempts: row.attempts + 1,
      nextPollAt: new Date(Date.now() + 2_000),
    });
  }
  const got = await accountRequest(store, () => client.getTask(externalTaskId));
  const completedAt = new Date();
  const limitsAfter = await availableLimits(client, store);
  const limitsSpent = computeLimitsSpent(row.limitsBefore, limitsAfter);
  return store.updateState(row.id, {
    state: "DONE",
    attempts: row.attempts + 1,
    responseJson: got.raw,
    completedAt,
    latencyMs: row.submittedAt ? Math.max(0, completedAt.getTime() - row.submittedAt.getTime()) : null,
    limitsAfter,
    limitsSpent,
    nextPollAt: null,
    errorCode: null,
  });
}

/**
 * Wait until DONE/FAILED/CANCELLED, or terminal SUBMIT_UNKNOWN after soft-retries exhausted.
 * RATE_LIMITED without externalTaskId waits for nextPollAt then re-enters ensure (never poll).
 * Transient /set HTTP 5xx (SUBMIT_UNKNOWN http_5xx, no externalTaskId) is soft-retried via ensure.
 */
export async function waitForArsenkinTaskCompletion(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  input: EnsureArsenkinTaskInput,
  waitTimeoutMs: number
): Promise<ProviderTaskRecord> {
  const maxRetries = input.maxSubmitRetries ?? maxArsenkinSubmitRetries();
  let row = await ensureArsenkinTask(client, store, input);
  const started = Date.now();
  while (row.state !== "DONE" && row.state !== "FAILED" && row.state !== "CANCELLED") {
    if (Date.now() - started > waitTimeoutMs) {
      throw new Error(`Arsenkin task timeout tool=${input.toolName} id=${row.externalTaskId}`);
    }
    if (row.state === "SUBMIT_UNKNOWN") {
      const err = String(row.errorCode ?? "");
      const canSoftRetry =
        !row.externalTaskId &&
        /^http_5\d\d$/i.test(err) &&
        row.attempts < maxRetries;
      if (!canSoftRetry) break;
      await new Promise((r) => setTimeout(r, 1_500));
      row = await ensureArsenkinTask(client, store, input);
      continue;
    }
    if (row.state === "SUBMITTING" || row.state === "QUEUED" || isSubmitRetryRateLimited(row)) {
      if (isSubmitRetryRateLimited(row) && row.nextPollAt && row.nextPollAt.getTime() > Date.now()) {
        const waitMs = Math.min(1_500, Math.max(50, row.nextPollAt.getTime() - Date.now()));
        await new Promise((r) => setTimeout(r, waitMs));
      } else {
        await new Promise((r) => setTimeout(r, 500));
      }
      row = await ensureArsenkinTask(client, store, input);
      continue;
    }
    row = await pollArsenkinTask(client, store, row);
    if (row.state !== "DONE") {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return row;
}

export async function runDueArsenkinPolls(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  options?: { limit?: number; workerId?: string; leaseMs?: number }
): Promise<ProviderTaskRecord[]> {
  const now = new Date();
  const due = await store.claimDue(
    options?.workerId ?? `arsenkin-poll-${process.pid}`,
    now,
    options?.limit ?? 10,
    options?.leaseMs ?? 30_000
  );
  const out: ProviderTaskRecord[] = [];
  for (const row of due) {
    try {
      out.push(await pollArsenkinTask(client, store, row));
    } finally {
      await store.releaseLease(row.id);
    }
  }
  return out;
}
