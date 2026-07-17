/**
 * Arsenkin enrichment state contract for unified collection.
 * scheduledAgents ≠ completedAgents ≠ ingestedAgents.
 * Persists exactly-once ingestion dedupe (full resultHash).
 */

import { createHash } from "node:crypto";
import { ARSENKIN_REAL_AGENT_NAMES } from "../agents/real/real-arsenkin-agents";

export const ARSENKIN_ENRICHMENT_STATE_VERSION = "arsenkin-enrichment-state-v1" as const;

export type ArsenkinAgentTerminalKind =
  | "SUCCESS"
  | "PARTIAL_SUCCESS"
  | "NO_RESULTS"
  | "EMPTY_VALID"
  | "REUSED"
  | "FAILED"
  | "SUBMIT_UNKNOWN_UNRECONCILED";

export type ArsenkinAgentProgress = {
  agentName: string;
  enrichmentRunId: string | null;
  scheduled: boolean;
  terminal: boolean;
  terminalKind: ArsenkinAgentTerminalKind | null;
  ingested: boolean;
  pendingTaskCount: number;
  doneTaskCount: number;
  submitUnknownCount: number;
  observationCount: number;
  errorCode?: string | null;
};

export type ArsenkinEnrichmentState = {
  version: typeof ARSENKIN_ENRICHMENT_STATE_VERSION;
  unifiedJobId: string;
  caseId: string;
  scheduledAgents: string[];
  completedAgents: string[];
  failedAgents: string[];
  pendingAgents: string[];
  ingestedAgents: string[];
  enrichmentObservationCount: number;
  enrichmentComplete: boolean;
  agents: ArsenkinAgentProgress[];
  updatedAt: string;
  /** Full sha256 hex digests of ingested result payloads (never truncated). */
  ingestedResultHashes: string[];
  /** Optional mapping resultHash → observation ids for forensic lineage. */
  resultHashToObservationIds: Record<string, string[]>;
  /** externalTaskId → last ingested resultHash (conflict if payload changes). */
  externalTaskIdToResultHash: Record<string, string>;
};

export type ArsenkinIngestedObservation = {
  region?: string;
  engine?: string;
  query?: string;
  url?: string;
  title?: string;
  snippet?: string;
  suggestion?: string;
  question?: string;
  kind?: "organic" | "suggestion" | "paa" | "other";
  providerTaskId?: string | null;
  riskLabel?: string | null;
  /** Provenance required for ingested rows. */
  externalTaskId?: string | null;
  caseAgent?: string;
  tool?: string | null;
  enrichmentRunId?: string;
  unifiedJobId?: string;
  sourceUrlOrQuery?: string | null;
  /** Full sha256 hex — never truncated. */
  resultHash?: string | null;
  provider?: string | null;
};

export type ArsenkinEnrichmentTickResult = {
  state: ArsenkinEnrichmentState;
  observations: ArsenkinIngestedObservation[];
  enrichmentRunIds: string[];
  arsenkinReportRunId: string | null;
  coverageMeasured?: number;
  warnings: string[];
  /** When true, fail-closed (do not advance to composite). */
  blockPipeline: boolean;
  blockCode?: string;
  blockMessage?: string;
  /** Stay on ARSENKIN_ENRICHMENT waiting for next tick. */
  waiting: boolean;
  /** Earliest ProviderTask.nextPollAt (or computed backoff) while waiting. */
  nextPollAt?: string | null;
};

export function emptyArsenkinEnrichmentState(input: {
  caseId: string;
  unifiedJobId: string;
  now?: string;
}): ArsenkinEnrichmentState {
  return {
    version: ARSENKIN_ENRICHMENT_STATE_VERSION,
    unifiedJobId: input.unifiedJobId,
    caseId: input.caseId,
    scheduledAgents: [],
    completedAgents: [],
    failedAgents: [],
    pendingAgents: [...ARSENKIN_REAL_AGENT_NAMES],
    ingestedAgents: [],
    enrichmentObservationCount: 0,
    enrichmentComplete: false,
    agents: ARSENKIN_REAL_AGENT_NAMES.map((agentName) => ({
      agentName,
      enrichmentRunId: null,
      scheduled: false,
      terminal: false,
      terminalKind: null,
      ingested: false,
      pendingTaskCount: 0,
      doneTaskCount: 0,
      submitUnknownCount: 0,
      observationCount: 0,
    })),
    updatedAt: input.now ?? new Date().toISOString(),
    ingestedResultHashes: [],
    resultHashToObservationIds: {},
    externalTaskIdToResultHash: {},
  };
}

/** Full sha256 hex (64 chars). Truncation is forbidden for persisted dedupe. */
export function hashArsenkinResultPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

/**
 * Backward-compatible normalize for jobs persisted before dedupe fields existed.
 */
export function normalizeArsenkinEnrichmentState(
  raw: Partial<ArsenkinEnrichmentState> | null | undefined,
  fallback: { caseId: string; unifiedJobId: string }
): ArsenkinEnrichmentState {
  const base = emptyArsenkinEnrichmentState(fallback);
  if (!raw || typeof raw !== "object") return base;
  return {
    ...base,
    ...raw,
    version: ARSENKIN_ENRICHMENT_STATE_VERSION,
    caseId: String(raw.caseId ?? fallback.caseId),
    unifiedJobId: String(raw.unifiedJobId ?? fallback.unifiedJobId),
    scheduledAgents: Array.isArray(raw.scheduledAgents) ? raw.scheduledAgents : base.scheduledAgents,
    completedAgents: Array.isArray(raw.completedAgents) ? raw.completedAgents : base.completedAgents,
    failedAgents: Array.isArray(raw.failedAgents) ? raw.failedAgents : base.failedAgents,
    pendingAgents: Array.isArray(raw.pendingAgents) ? raw.pendingAgents : base.pendingAgents,
    ingestedAgents: Array.isArray(raw.ingestedAgents) ? raw.ingestedAgents : base.ingestedAgents,
    agents: Array.isArray(raw.agents) && raw.agents.length > 0 ? raw.agents : base.agents,
    enrichmentObservationCount: Number(raw.enrichmentObservationCount ?? 0),
    enrichmentComplete: Boolean(raw.enrichmentComplete),
    updatedAt: String(raw.updatedAt ?? base.updatedAt),
    ingestedResultHashes: Array.isArray(raw.ingestedResultHashes) ? [...raw.ingestedResultHashes] : [],
    resultHashToObservationIds:
      raw.resultHashToObservationIds && typeof raw.resultHashToObservationIds === "object"
        ? { ...raw.resultHashToObservationIds }
        : {},
    externalTaskIdToResultHash:
      raw.externalTaskIdToResultHash && typeof raw.externalTaskIdToResultHash === "object"
        ? { ...raw.externalTaskIdToResultHash }
        : {},
  };
}

/**
 * Build enrichment state from per-agent snapshots (tests + live poller).
 * enrichmentComplete requires all five agents terminal + ingested (or EMPTY_VALID).
 */
export function buildArsenkinEnrichmentState(input: {
  caseId: string;
  unifiedJobId: string;
  agents: ArsenkinAgentProgress[];
  now?: string;
  ingestedResultHashes?: string[];
  resultHashToObservationIds?: Record<string, string[]>;
  externalTaskIdToResultHash?: Record<string, string>;
}): ArsenkinEnrichmentState {
  const byName = new Map(input.agents.map((a) => [a.agentName, a]));
  const agents = ARSENKIN_REAL_AGENT_NAMES.map((name) => {
    return (
      byName.get(name) ?? {
        agentName: name,
        enrichmentRunId: null,
        scheduled: false,
        terminal: false,
        terminalKind: null,
        ingested: false,
        pendingTaskCount: 0,
        doneTaskCount: 0,
        submitUnknownCount: 0,
        observationCount: 0,
      }
    );
  });

  const scheduledAgents = agents.filter((a) => a.scheduled).map((a) => a.agentName);
  const completedAgents = agents
    .filter(
      (a) =>
        a.terminal &&
        a.terminalKind != null &&
        a.terminalKind !== "FAILED" &&
        a.terminalKind !== "SUBMIT_UNKNOWN_UNRECONCILED"
    )
    .map((a) => a.agentName);
  const failedAgents = agents
    .filter(
      (a) =>
        a.terminalKind === "FAILED" || a.terminalKind === "SUBMIT_UNKNOWN_UNRECONCILED"
    )
    .map((a) => a.agentName);
  const pendingAgents = agents.filter((a) => !a.terminal).map((a) => a.agentName);
  const ingestedAgents = agents.filter((a) => a.ingested).map((a) => a.agentName);
  const enrichmentObservationCount = agents.reduce((n, a) => n + a.observationCount, 0);

  const allTerminal = agents.every((a) => a.terminal);
  const noneFailed = failedAgents.length === 0;
  const allIngested = agents.every((a) => a.ingested);
  const enrichmentComplete = allTerminal && noneFailed && allIngested;

  return {
    version: ARSENKIN_ENRICHMENT_STATE_VERSION,
    unifiedJobId: input.unifiedJobId,
    caseId: input.caseId,
    scheduledAgents,
    completedAgents,
    failedAgents,
    pendingAgents,
    ingestedAgents,
    enrichmentObservationCount,
    enrichmentComplete,
    agents,
    updatedAt: input.now ?? new Date().toISOString(),
    ingestedResultHashes: input.ingestedResultHashes ?? [],
    resultHashToObservationIds: input.resultHashToObservationIds ?? {},
    externalTaskIdToResultHash: input.externalTaskIdToResultHash ?? {},
  };
}

/** True when schedule-only (length===5) must NOT be treated as complete. */
export function isScheduleOnlyEnrichment(state: ArsenkinEnrichmentState | null | undefined): boolean {
  if (!state) return true;
  return state.scheduledAgents.length >= 5 && !state.enrichmentComplete;
}

export function assertEnrichmentReadyForComposite(state: ArsenkinEnrichmentState): {
  ok: boolean;
  code: string | null;
  errors: string[];
} {
  const errors: string[] = [];
  if (state.scheduledAgents.length < ARSENKIN_REAL_AGENT_NAMES.length) {
    errors.push(
      `scheduledAgents ${state.scheduledAgents.length} < ${ARSENKIN_REAL_AGENT_NAMES.length}`
    );
  }
  if (state.pendingAgents.length > 0) {
    errors.push(`pendingAgents: ${state.pendingAgents.join(",")}`);
  }
  if (state.failedAgents.length > 0) {
    errors.push(`failedAgents: ${state.failedAgents.join(",")}`);
  }
  if (state.ingestedAgents.length < ARSENKIN_REAL_AGENT_NAMES.length) {
    errors.push(
      `ingestedAgents ${state.ingestedAgents.length} < ${ARSENKIN_REAL_AGENT_NAMES.length}`
    );
  }
  if (!state.enrichmentComplete) {
    errors.push("enrichmentComplete=false");
  }
  return {
    ok: errors.length === 0,
    code: errors.length === 0 ? null : "ARSENKIN_ENRICHMENT_INCOMPLETE",
    errors,
  };
}
