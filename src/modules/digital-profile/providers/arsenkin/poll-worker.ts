/**
 * Poll worker: set → check → get for Arsenkin ProviderTasks.
 * Idempotent by requestHash; safe to resume.
 */

import type { ArsenkinClient } from "./client";
import { hashProviderRequest, type ProviderTaskStore } from "./provider-task-store";
import type { ArsenkinSetTaskRequest, ProviderTaskRecord } from "./types";

export type EnsureArsenkinTaskInput = {
  toolName: string;
  data: Record<string, unknown>;
  caseId?: string | null;
  reportRunId?: string | null;
};

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
  let row = await store.findByRequestHash(requestHash);
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
  if (!row.externalTaskId) {
    const set = await client.setTask(requestJson);
    row = await store.markExternalId(row.id, String(set.task_id));
  }
  return row;
}

export async function pollArsenkinTask(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  row: ProviderTaskRecord
): Promise<ProviderTaskRecord> {
  if (!row.externalTaskId) {
    return store.updateState(row.id, {
      state: "FAILED",
      errorCode: "missing_external_task_id",
      completedAt: new Date(),
    });
  }
  const check = await client.checkTask(row.externalTaskId);
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
  const got = await client.getTask(row.externalTaskId);
  return store.updateState(row.id, {
    state: "DONE",
    attempts: row.attempts + 1,
    responseJson: got.raw,
    completedAt: new Date(),
    nextPollAt: null,
    errorCode: null,
  });
}

export async function runDueArsenkinPolls(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  options?: { limit?: number }
): Promise<ProviderTaskRecord[]> {
  const due = await store.listDue(new Date(), options?.limit ?? 10);
  const out: ProviderTaskRecord[] = [];
  for (const row of due) {
    out.push(await pollArsenkinTask(client, store, row));
  }
  return out;
}
