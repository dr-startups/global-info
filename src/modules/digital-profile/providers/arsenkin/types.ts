/**
 * ARSENKIN TOOLS protocol types (set / check / get / limits).
 */

import type { ArsenkinToolName } from "./flags";

export type ArsenkinTaskState =
  | "QUEUED"
  | "SUBMITTING"
  | "SUBMIT_UNKNOWN"
  | "RUNNING"
  | "DONE"
  | "FAILED"
  | "RATE_LIMITED"
  | "CANCELLED";

export type ArsenkinSetTaskRequest = {
  tools_name: ArsenkinToolName | string;
  data: Record<string, unknown>;
};

export type ArsenkinSetTaskResponse = {
  task_id: string | number;
  raw: Record<string, unknown>;
};

export type ArsenkinCheckTaskResponse = {
  task_id: string;
  state: ArsenkinTaskState;
  /** Provider-specific status payload when present. */
  statusPayload: Record<string, unknown>;
  raw: Record<string, unknown>;
};

export type ArsenkinGetTaskResponse = {
  task_id: string;
  code?: string;
  result: unknown;
  raw: Record<string, unknown>;
};

export type ArsenkinLimitsResponse = {
  limitsTotal?: number;
  limitsSpent?: number;
  limitsLeft?: number;
  raw: Record<string, unknown>;
};

export type ArsenkinHttpError = {
  status: number;
  code?: string;
  message: string;
  retryAfterMs?: number;
  raw?: unknown;
  /** The request may have reached the provider, so set must not be retried. */
  uncertain?: boolean;
};

export type ArsenkinClientOptions = {
  baseUrl?: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Soft rate limit (requests / minute). Default 30. */
  requestsPerMinute?: number;
  /** Max retries on 429 / transient network. Default 4. */
  maxRetries?: number;
  /** Per-request AbortSignal timeout (ms). Default 25000 (< account lease). */
  httpTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Test/fixture clients only. Production/env clients must leave this false
   * so every HTTP call requires an installed LiveExecutionAuthorization.
   */
  skipLiveAuthorizationCheck?: boolean;
};

export type ProviderTaskRecord = {
  id: string;
  caseId?: string | null;
  reportRunId?: string | null;
  provider: "arsenkin";
  toolName: string;
  externalTaskId: string | null;
  requestHash: string;
  state: ArsenkinTaskState;
  attempts: number;
  nextPollAt: Date | null;
  errorCode: string | null;
  limitsSpent: number | null;
  lockedBy: string | null;
  lockedAt: Date | null;
  leaseUntil: Date | null;
  submittedAt: Date | null;
  latencyMs: number | null;
  limitsBefore: number | null;
  limitsAfter: number | null;
  requestJson: Record<string, unknown>;
  responseJson: Record<string, unknown> | null;
  createdAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
};
