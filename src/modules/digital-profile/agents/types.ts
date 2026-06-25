/**
 * Agent layer types (Stage G).
 *
 * Reuses the canonical Agent interface from the module's `types.ts` and adds the
 * metadata the registry / admin UI need (displayName, description, enabled).
 * Mock agents and (later) real agents implement the SAME `CaseAgent` shape and
 * write to the SAME `dp_*` tables, so swapping mock for real is isolated.
 */

import type {
  Agent,
  AgentContext,
  AgentNameValue,
  AgentRunResult,
  SavedEvidenceSummary,
} from "../types";

export type { Agent, AgentContext, AgentRunResult, SavedEvidenceSummary };

/** Static metadata describing an agent (for the registry + UI). */
export interface AgentDefinition {
  readonly name: AgentNameValue;
  readonly displayName: string;
  readonly description: string;
  readonly enabled: boolean;
}

/** A runnable agent with its descriptive metadata. */
export interface CaseAgent extends Agent, AgentDefinition {}

/** Outcome of a full audit (not a DB enum — lives in API/audit metadata). */
export type FullAuditOutcome = "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED";

export interface FullAuditResult {
  outcome: FullAuditOutcome;
  runs: AgentRunResult[];
}

/** Marker stored on agent-created rows so re-runs can be made idempotent. */
export function ownerMarker(name: AgentNameValue): string {
  return `mock:${name}`;
}
