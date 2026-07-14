/**
 * Capability boundary for paid Arsenkin live calls.
 * Token alone is never sufficient — an installed LiveExecutionAuthorization is required.
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

type ActiveLiveSession = {
  auth: LiveExecutionAuthorization;
  budget: LiveAuthBudgetState;
  countedHashes: Set<string>;
};

let active: ActiveLiveSession | null = null;

export function getActiveLiveAuthorization(): LiveExecutionAuthorization | null {
  return active?.auth ?? null;
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

/** Defense-in-depth for any Arsenkin HTTP when live session is expected. */
export function assertLiveNetworkAllowed(kind: string): void {
  if (!active) {
    throw new Error(`arsenkin-live-network-blocked:no-authorization:${kind}`);
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
