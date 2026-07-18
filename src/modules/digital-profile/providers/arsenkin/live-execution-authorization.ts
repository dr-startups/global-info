/**
 * Capability boundary for paid Arsenkin live calls.
 * Token alone is never sufficient — an installed LiveExecutionAuthorization is required.
 *
 * Separately: durable poll of already-submitted ProviderTasks may install a narrow
 * check/get-only scope via withExistingExternalTaskPollAuthorization (never /set).
 */

import { createHash } from "node:crypto";
import { hashProviderRequest } from "./provider-task-store";

export type LiveExecutionAuthorization = {
  reportRunId: string;
  confirmedPlanDigest: string;
  allowedRequestHashes: ReadonlySet<string>;
  maxNewTasks: number;
  maxEstimatedLimits: number;
  stage: string;
  liveConfirmed: true;
};

export type LiveAuthBudgetState = {
  createdNewTasks: number;
  estimatedLimitsSpent: number;
  countedRequestHashes: string[];
};

/** Narrow read-only poll of one already-paid external Arsenkin task. */
export type ExistingExternalTaskPollAuthorization = {
  caseId: string;
  unifiedJobId: string;
  enrichmentRunId: string;
  providerTaskId: string;
  externalTaskId: string;
  allowedOperations: ReadonlyArray<"check" | "get">;
  maxNewTasks: 0;
  /** Configured Arsenkin API base (no secrets). */
  expectedBaseUrl: string;
};

type ActiveLiveSession = {
  auth: LiveExecutionAuthorization;
  budget: LiveAuthBudgetState;
  countedHashes: Set<string>;
};

let active: ActiveLiveSession | null = null;
let activePoll: ExistingExternalTaskPollAuthorization | null = null;

export function getActiveLiveAuthorization(): LiveExecutionAuthorization | null {
  return active?.auth ?? null;
}

export function getActiveExistingTaskPollAuthorization(): ExistingExternalTaskPollAuthorization | null {
  return activePoll;
}

export function getActiveLiveBudget(): LiveAuthBudgetState | null {
  if (!active) return null;
  return {
    createdNewTasks: active.budget.createdNewTasks,
    estimatedLimitsSpent: active.budget.estimatedLimitsSpent,
    countedRequestHashes: [...active.budget.countedRequestHashes],
  };
}

/** Install authorization for the duration of fn (sync/async). */
export async function withLiveAuthorization<T>(
  auth: LiveExecutionAuthorization,
  fn: () => Promise<T>
): Promise<T> {
  if (!auth.liveConfirmed) {
    throw new Error("live-authorization-requires-liveConfirmed");
  }
  if (active) {
    throw new Error("live-authorization-already-active");
  }
  active = {
    auth,
    budget: { createdNewTasks: 0, estimatedLimitsSpent: 0, countedRequestHashes: [] },
    countedHashes: new Set(),
  };
  try {
    return await fn();
  } finally {
    active = null;
  }
}

export function buildLiveAuthorizationFromPlan(input: {
  reportRunId: string;
  planDigest: string;
  requestHashes: readonly string[];
  maxNewTasks: number;
  maxEstimatedLimits: number;
  stage: string;
}): LiveExecutionAuthorization {
  return {
    reportRunId: input.reportRunId,
    confirmedPlanDigest: input.planDigest,
    allowedRequestHashes: new Set(input.requestHashes),
    maxNewTasks: input.maxNewTasks,
    maxEstimatedLimits: input.maxEstimatedLimits,
    stage: input.stage,
    liveConfirmed: true,
  };
}

export function assertLiveSetAllowed(input: {
  reportRunId: string;
  requestJson: { tools_name: string; data: Record<string, unknown> };
  /** When true, this /set creates a new paid submit (not REUSE). */
  countsAsNewTask: boolean;
  estimatedLimits: number | null;
  allowUnknownCost?: boolean;
}): string {
  if (!active) {
    throw new Error("arsenkin-live-set-blocked:no-live-authorization");
  }
  const { auth, budget } = active;
  if (auth.reportRunId !== input.reportRunId) {
    throw new Error(
      `arsenkin-live-set-blocked:reportRunId-mismatch expected=${auth.reportRunId} got=${input.reportRunId}`
    );
  }
  const requestHash = hashProviderRequest(input.requestJson);
  if (!auth.allowedRequestHashes.has(requestHash)) {
    throw new Error(`arsenkin-live-set-blocked:request-hash-not-in-plan:${requestHash}`);
  }
  const alreadyCounted = active.countedHashes.has(requestHash);
  if (input.countsAsNewTask && !alreadyCounted) {
    if (budget.createdNewTasks + 1 > auth.maxNewTasks) {
      throw new Error(
        `arsenkin-live-set-blocked:max-new-tasks budget=${auth.maxNewTasks} next=${budget.createdNewTasks + 1}`
      );
    }
  }
  if (input.estimatedLimits == null) {
    if (!input.allowUnknownCost) {
      throw new Error("arsenkin-live-set-blocked:unknown-cost");
    }
  } else if (
    !alreadyCounted &&
    budget.estimatedLimitsSpent + input.estimatedLimits > auth.maxEstimatedLimits
  ) {
    throw new Error(
      `arsenkin-live-set-blocked:max-estimated-limits budget=${auth.maxEstimatedLimits} next=${
        budget.estimatedLimitsSpent + input.estimatedLimits
      }`
    );
  }

  if (!alreadyCounted) {
    active.countedHashes.add(requestHash);
    budget.countedRequestHashes.push(requestHash);
    if (input.countsAsNewTask) {
      budget.createdNewTasks += 1;
    }
    if (input.estimatedLimits != null) {
      budget.estimatedLimitsSpent += input.estimatedLimits;
    }
  }
  return requestHash;
}

/**
 * Defense-in-depth for Arsenkin HTTP.
 * - Full live session: any kind.
 * - Existing-task poll scope: only check/get for the authorized externalTaskId.
 * - /set never authorized by poll scope.
 */
export function assertLiveNetworkAllowed(
  kind: string,
  extras?: { taskId?: string | number | null; requestUrl?: string | null }
): void {
  if (active) return;

  if (kind === "check" || kind === "get") {
    if (!activePoll) {
      throw new Error(`arsenkin-live-network-blocked:no-authorization:${kind}`);
    }
    if (!activePoll.allowedOperations.includes(kind)) {
      throw new Error(`arsenkin-poll-auth-blocked:operation-not-allowed:${kind}`);
    }
    if (activePoll.maxNewTasks !== 0) {
      throw new Error("arsenkin-poll-auth-blocked:maxNewTasks-must-be-zero");
    }
    const taskId = String(extras?.taskId ?? "").trim();
    if (!taskId || taskId !== activePoll.externalTaskId) {
      throw new Error(
        `arsenkin-poll-auth-blocked:externalTaskId-mismatch expected=${activePoll.externalTaskId} got=${taskId || "empty"}`
      );
    }
    const url = String(extras?.requestUrl ?? "").trim();
    if (url) {
      const expected = activePoll.expectedBaseUrl.replace(/\/$/, "");
      if (!url.startsWith(expected + "/") && url !== expected) {
        throw new Error("arsenkin-poll-auth-blocked:base-url-mismatch");
      }
      if (url.includes("/set")) {
        throw new Error("arsenkin-poll-auth-blocked:set-not-allowed");
      }
    }
    return;
  }

  throw new Error(`arsenkin-live-network-blocked:no-authorization:${kind}`);
}

export type ExistingExternalTaskPollAuthInput = {
  caseId: string;
  unifiedJobId: string;
  enrichmentRunId: string;
  providerTaskId: string;
  externalTaskId: string;
  allowedOperations: ReadonlyArray<"check" | "get">;
  maxNewTasks: 0;
  expectedBaseUrl: string;
  /** Persisted ProviderTask row used to prove lineage (fail-closed). */
  providerTask: {
    id: string;
    caseId?: string | null;
    reportRunId?: string | null;
    externalTaskId?: string | null;
    submittedAt?: Date | string | null;
    state?: string | null;
  };
  /** Job enrichmentRunIds must include providerTask.reportRunId. */
  jobEnrichmentRunIds: readonly string[];
  jobCaseId: string;
  jobUnifiedJobId: string;
};

/**
 * Validate + install a check/get-only poll scope for one persisted ProviderTask.
 * Never authorizes /set. Foreign / arbitrary externalTaskId → fail-closed.
 */
export function assertExistingExternalTaskPollAuthorized(
  input: ExistingExternalTaskPollAuthInput
): ExistingExternalTaskPollAuthorization {
  const externalTaskId = String(input.externalTaskId ?? "").trim();
  const providerTaskId = String(input.providerTaskId ?? "").trim();
  const enrichmentRunId = String(input.enrichmentRunId ?? "").trim();
  const caseId = String(input.caseId ?? "").trim();
  const unifiedJobId = String(input.unifiedJobId ?? "").trim();

  if (!externalTaskId) {
    throw new Error("arsenkin-poll-auth-blocked:empty-externalTaskId");
  }
  if (!providerTaskId || !enrichmentRunId || !caseId || !unifiedJobId) {
    throw new Error("arsenkin-poll-auth-blocked:missing-lineage");
  }
  if (input.maxNewTasks !== 0) {
    throw new Error("arsenkin-poll-auth-blocked:maxNewTasks-must-be-zero");
  }
  const ops = [...input.allowedOperations];
  if (ops.length === 0 || ops.some((o) => o !== "check" && o !== "get")) {
    throw new Error("arsenkin-poll-auth-blocked:invalid-operations");
  }
  if (ops.includes("set" as never)) {
    throw new Error("arsenkin-poll-auth-blocked:set-not-allowed");
  }

  const row = input.providerTask;
  if (String(row.id ?? "").trim() !== providerTaskId) {
    throw new Error("arsenkin-poll-auth-blocked:providerTaskId-mismatch");
  }
  if (String(row.externalTaskId ?? "").trim() !== externalTaskId) {
    throw new Error("arsenkin-poll-auth-blocked:persisted-externalTaskId-mismatch");
  }
  if (String(row.reportRunId ?? "").trim() !== enrichmentRunId) {
    throw new Error("arsenkin-poll-auth-blocked:enrichmentRunId-mismatch");
  }
  if (caseId !== String(input.jobCaseId ?? "").trim()) {
    throw new Error("arsenkin-poll-auth-blocked:foreign-caseId");
  }
  if (unifiedJobId !== String(input.jobUnifiedJobId ?? "").trim()) {
    throw new Error("arsenkin-poll-auth-blocked:foreign-unifiedJobId");
  }
  if (row.caseId != null && String(row.caseId).trim() && String(row.caseId).trim() !== caseId) {
    throw new Error("arsenkin-poll-auth-blocked:foreign-providerTask-caseId");
  }
  if (!input.jobEnrichmentRunIds.map(String).includes(enrichmentRunId)) {
    throw new Error("arsenkin-poll-auth-blocked:enrichmentRunId-not-on-job");
  }
  if (!row.submittedAt) {
    throw new Error("arsenkin-poll-auth-blocked:not-submitted");
  }
  const expectedBase = String(input.expectedBaseUrl ?? "").trim().replace(/\/$/, "");
  if (!expectedBase || !/^https?:\/\//i.test(expectedBase)) {
    throw new Error("arsenkin-poll-auth-blocked:invalid-base-url");
  }

  return {
    caseId,
    unifiedJobId,
    enrichmentRunId,
    providerTaskId,
    externalTaskId,
    allowedOperations: ops as Array<"check" | "get">,
    maxNewTasks: 0,
    expectedBaseUrl: expectedBase,
  };
}

/** Install existing-task poll authorization for the duration of fn. */
export async function withExistingExternalTaskPollAuthorization<T>(
  input: ExistingExternalTaskPollAuthInput,
  fn: () => Promise<T>
): Promise<T> {
  if (activePoll) {
    throw new Error("arsenkin-poll-auth-already-active");
  }
  // Poll scope must not run nested inside a paid live-set session (keeps budgets honest).
  if (active) {
    throw new Error("arsenkin-poll-auth-blocked:live-session-active");
  }
  const auth = assertExistingExternalTaskPollAuthorized(input);
  activePoll = auth;
  try {
    return await fn();
  } finally {
    activePoll = null;
  }
}

export function digestBindingFingerprint(auth: LiveExecutionAuthorization): string {
  const hashes = [...auth.allowedRequestHashes].sort();
  return createHash("sha256")
    .update(
      JSON.stringify({
        reportRunId: auth.reportRunId,
        confirmedPlanDigest: auth.confirmedPlanDigest,
        hashes,
        maxNewTasks: auth.maxNewTasks,
        maxEstimatedLimits: auth.maxEstimatedLimits,
        stage: auth.stage,
      })
    )
    .digest("hex")
    .slice(0, 32);
}
