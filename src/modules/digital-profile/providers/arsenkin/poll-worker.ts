/**
 * Poll worker: set → check → get for Arsenkin ProviderTasks.
 * Idempotent by requestHash; safe to resume.
 */

import { ArsenkinRequestError, type ArsenkinClient } from "./client";
import { acquireArsenkinAccountSlot } from "./account-rate-limit";
import { hashProviderRequest, type ProviderTaskStore } from "./provider-task-store";
import type { ArsenkinSetTaskRequest, ProviderTaskRecord } from "./types";

export type EnsureArsenkinTaskInput = {
  toolName: string;
  data: Record<string, unknown>;
  caseId?: string | null;
  reportRunId: string;
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
  if (!row.externalTaskId) {
    const limitsBefore = await availableLimits(client, store);
    row = await store.updateState(row.id, {
      state: "SUBMITTING",
      limitsBefore,
      errorCode: null,
    });
    try {
      const set = await accountRequest(store, () => client.setTask(requestJson));
      row = await store.markExternalId(row.id, String(set.task_id));
      row = await store.updateState(row.id, {
        state: "RUNNING",
        submittedAt: new Date(),
        limitsBefore,
        nextPollAt: new Date(),
      });
    } catch (error) {
      const requestError = error instanceof ArsenkinRequestError ? error : null;
      if (requestError?.options.uncertain) {
        return store.updateState(row.id, {
          state: "SUBMIT_UNKNOWN",
          errorCode: "submit_unknown",
          nextPollAt: null,
        });
      }
      const status = requestError?.options.status;
      return store.updateState(row.id, {
        state: status && status !== 429 && status >= 400 && status < 500 ? "FAILED" : "RATE_LIMITED",
        errorCode: status ? `http_${status}` : "submit_failed",
        nextPollAt: status === 429 ? new Date(Date.now() + 5_000) : null,
        completedAt: status && status !== 429 ? new Date() : null,
      });
    }
  }
  return row;
}

export async function pollArsenkinTask(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  row: ProviderTaskRecord
): Promise<ProviderTaskRecord> {
  if (row.nextPollAt && row.nextPollAt.getTime() > Date.now()) return row;
  if (!row.externalTaskId) {
    if (row.state === "SUBMIT_UNKNOWN" || row.state === "SUBMITTING") return row;
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
  return store.updateState(row.id, {
    state: "DONE",
    attempts: row.attempts + 1,
    responseJson: got.raw,
    completedAt,
    latencyMs: row.submittedAt ? Math.max(0, completedAt.getTime() - row.submittedAt.getTime()) : null,
    limitsAfter,
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
