/**
 * Poll worker: set → check → get for Arsenkin ProviderTasks.
 * Exactly-once best-effort submit via claimForSubmission; poll never touches QUEUED.
 */

import { randomUUID } from "node:crypto";
import { ArsenkinRequestError, type ArsenkinClient } from "./client";
import { acquireArsenkinAccountSlot } from "./account-rate-limit";
import { computeLimitsSpent } from "./cost";
import { hashProviderRequest, type ProviderTaskStore } from "./provider-task-store";
import type { ArsenkinSetTaskRequest, ProviderTaskRecord } from "./types";

export type EnsureArsenkinTaskInput = {
  toolName: string;
  data: Record<string, unknown>;
  caseId?: string | null;
  reportRunId: string;
  /** Optional submit worker id for CAS ownership. */
  workerId?: string;
  submitLeaseMs?: number;
};

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

function submitFailedState(error: unknown): {
  state: ProviderTaskRecord["state"];
  errorCode: string;
  nextPollAt: Date | null;
  completedAt: Date | null;
} {
  const requestError = error instanceof ArsenkinRequestError ? error : null;
  const status = requestError?.options.status;
  if (requestError?.options.uncertain || (status != null && status >= 500)) {
    return {
      state: "SUBMIT_UNKNOWN",
      errorCode: status ? `http_${status}` : "submit_unknown",
      nextPollAt: null,
      completedAt: null,
    };
  }
  if (status === 429) {
    return {
      state: "RATE_LIMITED",
      errorCode: "http_429",
      nextPollAt: new Date(Date.now() + 5_000),
      completedAt: null,
    };
  }
  if (status != null && status >= 400 && status < 500) {
    return {
      state: "FAILED",
      errorCode: `http_${status}`,
      nextPollAt: null,
      completedAt: new Date(),
    };
  }
  return {
    state: "SUBMIT_UNKNOWN",
    errorCode: "submit_unknown",
    nextPollAt: null,
    completedAt: null,
  };
}

/**
 * Ensure a ProviderTask exists and has been submitted at most once.
 * Never calls /set for SUBMITTING or SUBMIT_UNKNOWN.
 * Expired SUBMITTING without externalTaskId becomes SUBMIT_UNKNOWN.
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
  if (row.state === "SUBMIT_UNKNOWN") return row;
  if (row.externalTaskId) return row;

  const now = new Date();
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
    // Another worker owns an active submit lease — never re-POST /set.
    return row;
  }

  if (row.state !== "QUEUED" && row.state !== "RATE_LIMITED") {
    // FAILED/CANCELLED/etc. — do not submit again.
    return row;
  }

  // RATE_LIMITED without externalTaskId means a prior /set was rejected with 429 before task id.
  // Re-queue into QUEUED so claimForSubmission can run again (safe: no prior POST success).
  if (row.state === "RATE_LIMITED") {
    row = await store.updateState(row.id, {
      state: "QUEUED",
      errorCode: null,
      nextPollAt: now,
      lockedBy: null,
      lockedAt: null,
      leaseUntil: null,
    });
  }

  const workerId = input.workerId ?? `arsenkin-submit-${process.pid}-${randomUUID().slice(0, 8)}`;
  const claimed = await store.claimForSubmission(
    row.id,
    workerId,
    input.submitLeaseMs ?? 60_000,
    now
  );
  if (!claimed) {
    // Lost the race — return current row without calling /set.
    return (await store.findById(row.id)) ?? row;
  }

  const limitsBefore = await availableLimits(client, store);
  try {
    await store.updateState(
      claimed.id,
      { state: "SUBMITTING", limitsBefore, errorCode: null },
      { ownerId: workerId, expectStates: ["SUBMITTING"] }
    );
    const set = await accountRequest(store, () => client.setTask(requestJson));
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
    const failed = submitFailedState(error);
    return store.updateState(
      claimed.id,
      {
        state: failed.state,
        errorCode: failed.errorCode,
        nextPollAt: failed.nextPollAt,
        completedAt: failed.completedAt,
        limitsBefore,
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
  if (row.state === "QUEUED" || row.state === "SUBMITTING" || row.state === "SUBMIT_UNKNOWN") {
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
