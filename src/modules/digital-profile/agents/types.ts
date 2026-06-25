/**
 * Agent layer types.
 *
 * An agent has two identifiers:
 *  - `name`: a unique slug used as the registry key, API path and UI id. It must
 *    be unique across agents (e.g. "WIKIPEDIA" for the mock, "REAL_WIKIPEDIA"
 *    for the real connector).
 *  - `agentName`: the AgentName DB enum stored on agent_runs. Several agents may
 *    map to the same enum value (mock + real Wikipedia both store WIKIPEDIA);
 *    per-agent history is disambiguated via agent_runs.input.agentId.
 *
 * Mock and real agents implement the SAME `CaseAgent` shape and write to the
 * SAME dp_* tables.
 */

import type {
  AgentContext,
  AgentNameValue,
  AgentRunResult,
  SavedEvidenceSummary,
} from "../types";

export type { AgentContext, AgentRunResult, SavedEvidenceSummary };

export type AgentKind = "MOCK" | "REAL";

export type AvailabilityStatus = "ENABLED" | "DISABLED" | "NOT_CONFIGURED";

export interface AgentAvailability {
  status: AvailabilityStatus;
  message?: string;
}

/** Static metadata describing an agent (for the registry + UI). */
export interface AgentMetadata {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly kind: AgentKind;
  /** DB enum stored on agent_runs.agentName. */
  readonly agentName: AgentNameValue;
}

/**
 * A runnable agent. Lifecycle: validateInput -> run -> normalizeOutput ->
 * saveEvidence (run orchestrates the lifecycle and returns an AgentRunResult).
 */
export interface CaseAgent extends AgentMetadata {
  validateInput(ctx: AgentContext): Promise<void>;
  run(ctx: AgentContext): Promise<AgentRunResult>;
  normalizeOutput(raw: unknown): Promise<unknown>;
  saveEvidence(ctx: AgentContext, normalized: unknown): Promise<SavedEvidenceSummary>;
  /** Config-derived availability (no network). */
  availability(): AgentAvailability;
}

/** Resolved definition for the registry/UI (availability evaluated). */
export interface AgentDefinition {
  name: string;
  displayName: string;
  description: string;
  kind: AgentKind;
  enabled: boolean;
  availability: AgentAvailability;
}

/** Outcome of a full audit (not a DB enum — lives in API/audit metadata). */
export type FullAuditOutcome = "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED";

export interface FullAuditResult {
  outcome: FullAuditOutcome;
  runs: AgentRunResult[];
}

/** Marker stored on agent-created rows so re-runs can be made idempotent. */
export function ownerMarker(name: string): string {
  return `mock:${name}`;
}
