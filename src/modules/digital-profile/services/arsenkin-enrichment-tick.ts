/**
 * Durable Arsenkin enrichment tick for unified collection.
 * Schedules once, then polls/reconciles/ingests — never treats schedule as complete.
 */

import type { PrismaClient } from "@prisma/client";
import { ARSENKIN_REAL_AGENT_NAMES } from "../agents/real/real-arsenkin-agents";
import {
  buildArsenkinEnrichmentState,
  emptyArsenkinEnrichmentState,
  hashArsenkinResultPayload,
  isArsenkinClientEvidenceObservation,
  normalizeArsenkinEnrichmentState,
  type ArsenkinAgentProgress,
  type ArsenkinEnrichmentTickResult,
  type ArsenkinIngestedObservation,
  type ArsenkinAgentTerminalKind,
} from "./arsenkin-enrichment-state";
import { applyExactlyOnceIngest } from "./arsenkin-exactly-once-ingest";
import { adaptArsenkinToolResponse } from "./arsenkin-tool-adapters";
import type { UnifiedCollectionJob } from "./unified-collection-types";
import { emptyCoverage, FIRST36_PLANNED_SUPPORTED_SURFACES } from "./unified-collection-types";

const NON_TERMINAL_TASK = new Set([
  "QUEUED",
  "SUBMITTING",
  "RUNNING",
  "RATE_LIMITED",
  "WAITING",
  "POLLING",
  "SUBMITTED",
]);

/** Terminal submit failures that must never unlock composite/render. */
const TERMINAL_SUBMIT_FAILURE = new Set([
  "SUBMIT_UNKNOWN",
  "SUBMIT_REJECTED_RETRYABLE",
]);

type ProviderTaskSnap = {
  id: string;
  reportRunId: string;
  externalTaskId: string | null;
  toolName: string | null;
  state: string;
  responseJson?: unknown;
  requestJson?: unknown;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function agentNameFromEnrichmentRunId(runId: string): string | null {
  const lower = runId.toLowerCase();
  for (const name of ARSENKIN_REAL_AGENT_NAMES) {
    const slug = name.toLowerCase().replace(/_/g, "-");
    if (lower.includes(slug) || lower.includes(name.toLowerCase())) return name;
  }
  if (lower.includes("search-top")) return "ARSENKIN_SEARCH_TOP_REAL";
  if (lower.includes("suggestions")) return "ARSENKIN_SUGGESTIONS_REAL";
  if (lower.includes("-paa-") || lower.includes("paa-real")) return "ARSENKIN_PAA_REAL";
  if (lower.includes("ai-search")) return "ARSENKIN_AI_SEARCH_REAL";
  if (lower.includes("url-audit")) return "ARSENKIN_URL_AUDIT_REAL";
  return null;
}

type TaskAdaptOutcome =
  | { ok: true; emptyValid: boolean; observations: ArsenkinIngestedObservation[]; warnings: string[] }
  | { ok: false; code: string; message: string };

function observationsFromTask(
  task: ProviderTaskSnap,
  agentName: string,
  unifiedJobId: string
): TaskAdaptOutcome {
  const adapted = adaptArsenkinToolResponse({
    toolName: task.toolName,
    responseJson: task.responseJson,
    ctx: {
      caseAgent: agentName,
      toolName: String(task.toolName ?? ""),
      externalTaskId: task.externalTaskId,
      enrichmentRunId: task.reportRunId,
      unifiedJobId,
      providerTaskId: task.id,
    },
  });
  if (!adapted.ok) {
    return { ok: false, code: adapted.code, message: adapted.message };
  }
  return {
    ok: true,
    emptyValid: adapted.emptyValid,
    observations: adapted.observations.map((o) => ({
      ...o,
      provider: o.provider ?? "arsenkin",
      enrichmentRunId: task.reportRunId,
      unifiedJobId,
    })),
    warnings: adapted.warnings,
  };
}

function progressFromTasks(input: {
  agentName: string;
  enrichmentRunId: string;
  unifiedJobId: string;
  tasks: ProviderTaskSnap[];
  executionStatus?: string | null;
  executionPhase?: string | null;
  allowEmptyValid: boolean;
}): {
  progress: ArsenkinAgentProgress;
  observations: ArsenkinIngestedObservation[];
  schemaError: string | null;
  warnings: string[];
} {
  const tasks = input.tasks;
  const pending = tasks.filter((t) => NON_TERMINAL_TASK.has(String(t.state).toUpperCase()));
  const done = tasks.filter((t) => String(t.state).toUpperCase() === "DONE");
  const submitRejected = tasks.filter((t) =>
    TERMINAL_SUBMIT_FAILURE.has(String(t.state).toUpperCase())
  );
  const failed = tasks.filter((t) =>
    /FAIL|ERROR|TIMEOUT|CANCEL/i.test(String(t.state))
  );

  let terminal = false;
  let terminalKind: ArsenkinAgentTerminalKind | null = null;
  let ingested = false;
  let observations: ArsenkinIngestedObservation[] = [];
  let schemaError: string | null = null;
  const warnings: string[] = [];

  const execFailed =
    input.executionStatus === "FAILED" || input.executionPhase === "FAILED";
  const execFinalized =
    input.executionStatus === "FINALIZED" || input.executionPhase === "FINALIZED";

  // Prefer in-flight pollable work over fail-closed on sibling REJECTED/UNKNOWN rows
  // (targeted retry leaves prior rejected Google suggest while Yandex RUNNING).
  if (pending.length > 0) {
    terminal = false;
    terminalKind = null;
    if (submitRejected.length > 0) {
      warnings.push("submit-rejected-sibling-awaiting-pending");
    }
  } else if (submitRejected.length > 0 && done.length === 0 && !input.allowEmptyValid) {
    terminal = true;
    terminalKind = "SUBMIT_UNKNOWN_UNRECONCILED";
    const rejected = submitRejected[0]!;
    if (String(rejected.state).toUpperCase() === "SUBMIT_REJECTED_RETRYABLE") {
      warnings.push("SUBMIT_REJECTED_RETRYABLE:no-externalTaskId");
    }
  } else if (failed.length > 0 && done.length === 0) {
    terminal = true;
    terminalKind = "FAILED";
  } else if (execFailed && tasks.length === 0) {
    terminal = true;
    terminalKind = "FAILED";
  } else if (pending.length === 0 && (done.length > 0 || execFinalized || input.allowEmptyValid)) {
    terminal = true;
    let anyEmptyValid = false;
    let anyAdaptedOk = false;
    const schemaErrors: string[] = [];
    for (const t of done) {
      const adapted = observationsFromTask(t, input.agentName, input.unifiedJobId);
      if (!adapted.ok) {
        schemaErrors.push(adapted.message);
        warnings.push(`adapt-failed:${t.id}:${adapted.code}`);
        continue;
      }
      anyAdaptedOk = true;
      warnings.push(...adapted.warnings);
      if (adapted.emptyValid) anyEmptyValid = true;
      observations.push(
        ...adapted.observations.map((o) => ({ ...o, enrichmentRunId: input.enrichmentRunId }))
      );
    }
    if (done.length > 0 && !anyAdaptedOk && !input.allowEmptyValid) {
      schemaError = schemaErrors[0] ?? "ARSENKIN_SCHEMA_INVALID";
      terminalKind = "FAILED";
      ingested = false;
      observations = [];
    } else if (!schemaError) {
      const clientEvidenceCount = observations.filter(isArsenkinClientEvidenceObservation).length;
      if (clientEvidenceCount === 0) {
        terminalKind = "EMPTY_VALID";
      } else {
        terminalKind = "SUCCESS";
      }
      ingested = true;
      if (submitRejected.length > 0) {
        warnings.push("submit-rejected-sibling-ignored-after-done");
      }
    }
  } else if (!execFinalized && tasks.length === 0 && !input.allowEmptyValid) {
    terminal = false;
    terminalKind = null;
  }

  const clientEvidenceCount = observations.filter(isArsenkinClientEvidenceObservation).length;
  return {
    progress: {
      agentName: input.agentName,
      enrichmentRunId: input.enrichmentRunId,
      scheduled: true,
      terminal,
      terminalKind,
      ingested,
      pendingTaskCount: pending.length,
      doneTaskCount: done.length,
      submitUnknownCount: submitRejected.length,
      // KPI/subject metrics exclude URL_FETCH_STATUS diagnostics (still in observations[]).
      observationCount: clientEvidenceCount,
      errorCode:
        schemaError
          ? "ARSENKIN_SCHEMA_INVALID"
          : terminalKind === "FAILED"
            ? "ARSENKIN_AGENT_FAILED"
            : terminalKind === "SUBMIT_UNKNOWN_UNRECONCILED"
              ? "ARSENKIN_SUBMIT_UNKNOWN"
              : null,
    },
    observations,
    schemaError,
    warnings,
  };
}

/**
 * Offline / injectable enrichment tick result builder for tests.
 */
export function buildEnrichmentTickFromAgentSnapshots(input: {
  caseId: string;
  unifiedJobId: string;
  agents: ArsenkinAgentProgress[];
  observations?: ArsenkinIngestedObservation[];
  enrichmentRunIds?: string[];
}): ArsenkinEnrichmentTickResult {
  const state = buildArsenkinEnrichmentState({
    caseId: input.caseId,
    unifiedJobId: input.unifiedJobId,
    agents: input.agents,
  });
  const ready = state.enrichmentComplete;
  const failed = state.failedAgents.length > 0;
  return {
    state,
    observations: input.observations ?? [],
    enrichmentRunIds:
      input.enrichmentRunIds ??
      state.agents.map((a) => a.enrichmentRunId).filter((x): x is string => Boolean(x)),
    arsenkinReportRunId:
      state.agents.find((a) => a.enrichmentRunId)?.enrichmentRunId ?? null,
    warnings: failed
      ? [`arsenkin-failed:${state.failedAgents.join(",")}`]
      : ready
        ? ["arsenkin-enrichment-complete"]
        : ["arsenkin-enrichment-waiting"],
    blockPipeline: failed,
    blockCode: failed ? "ARSENKIN_ENRICHMENT_FAILED" : undefined,
    blockMessage: failed
      ? `Arsenkin agents failed: ${state.failedAgents.join(",")}`
      : undefined,
    waiting: !ready && !failed,
  };
}

/** Normalize legacy deps.runArsenkinEnrichment into tick result (complete when flagged). */
export function legacyEnrichmentResultToTick(
  job: UnifiedCollectionJob,
  result: {
    arsenkinReportRunId: string | null;
    enrichmentRunIds?: string[];
    observations: ArsenkinIngestedObservation[];
    warnings?: string[];
    partial?: boolean;
    blockPipeline?: boolean;
    blockCode?: string;
    blockMessage?: string;
    enrichmentComplete?: boolean;
    agents?: ArsenkinAgentProgress[];
  }
): ArsenkinEnrichmentTickResult {
  const enrichmentRunIds =
    result.enrichmentRunIds && result.enrichmentRunIds.length > 0
      ? result.enrichmentRunIds
      : ARSENKIN_REAL_AGENT_NAMES.map(
          (name, i) => result.arsenkinReportRunId ?? `legacy-arsenkin-${name.toLowerCase()}-${i + 1}`
        );

  let complete = false;
  if (result.enrichmentComplete === true) {
    complete = true;
  } else if (result.enrichmentComplete === false || result.blockPipeline) {
    complete = false;
  } else if (result.agents?.every((a) => a.ingested && a.terminal)) {
    complete = true;
  } else if (result.partial === true) {
    // Explicit hold / in-flight — do not advance (unless empty skip with no run id).
    complete = !result.arsenkinReportRunId && (result.observations?.length ?? 0) === 0;
  } else {
    // Legacy happy-path injectors omit enrichmentComplete and partial.
    complete = true;
  }

  const agents: ArsenkinAgentProgress[] =
    result.agents ??
    ARSENKIN_REAL_AGENT_NAMES.map((agentName, i) => ({
      agentName,
      enrichmentRunId: enrichmentRunIds[i] ?? null,
      scheduled: true,
      terminal: Boolean(complete || result.blockPipeline),
      terminalKind: result.blockPipeline
        ? ("FAILED" as const)
        : complete
          ? result.observations.length === 0
            ? ("EMPTY_VALID" as const)
            : ("SUCCESS" as const)
          : null,
      ingested: Boolean(complete),
      pendingTaskCount: complete || result.blockPipeline ? 0 : 1,
      doneTaskCount: complete ? 1 : 0,
      submitUnknownCount: 0,
      observationCount:
        complete && i === 0
          ? result.observations.length
          : complete
            ? 0
            : 0,
    }));

  // Distribute observation counts across agents for honesty when complete.
  if (!result.agents && complete) {
    const per = Math.floor(result.observations.length / Math.max(1, agents.length));
    agents.forEach((a, i) => {
      a.observationCount =
        i === agents.length - 1
          ? result.observations.length - per * (agents.length - 1)
          : per;
      a.ingested = true;
      a.terminal = true;
      a.terminalKind = a.observationCount > 0 ? "SUCCESS" : "EMPTY_VALID";
    });
  }

  const state = buildArsenkinEnrichmentState({
    caseId: job.caseId,
    unifiedJobId: job.unifiedJobId,
    agents,
  });

  // Force complete flag from legacy when injectors intend immediate advance.
  if (complete && !result.blockPipeline) {
    state.enrichmentComplete = true;
    state.pendingAgents = [];
    state.completedAgents = [...ARSENKIN_REAL_AGENT_NAMES];
    state.ingestedAgents = [...ARSENKIN_REAL_AGENT_NAMES];
    state.enrichmentObservationCount = result.observations.length;
  }

  return {
    state,
    observations: result.observations.map((o) => ({
      ...o,
      unifiedJobId: o.unifiedJobId ?? job.unifiedJobId,
      enrichmentRunId: o.enrichmentRunId ?? enrichmentRunIds[0],
      resultHash: o.resultHash ?? hashArsenkinResultPayload(o),
    })),
    enrichmentRunIds,
    arsenkinReportRunId: result.arsenkinReportRunId ?? enrichmentRunIds[0] ?? null,
    warnings: result.warnings ?? [],
    blockPipeline: Boolean(result.blockPipeline),
    blockCode: result.blockCode,
    blockMessage: result.blockMessage,
    waiting: !complete && !result.blockPipeline,
  };
}

/** Pollable ProviderTask states that already have an externalTaskId (never /set). */
const POLLABLE_WITH_EXTERNAL = new Set([
  "RUNNING",
  "SUBMITTED",
  "RATE_LIMITED",
  "WAITING",
  "POLLING",
]);

export type EnrichmentPollTaskSnap = ProviderTaskSnap & {
  nextPollAt?: Date | string | null;
  attempts?: number;
};

/**
 * Poll existing Arsenkin tasks that already have externalTaskId.
 * Never schedules /set. Injectable for NETWORK_CALLS=0 tests.
 */
export async function pollDueEnrichmentProviderTasks(input: {
  tasks: EnrichmentPollTaskSnap[];
  now?: Date;
  jobPollAttempt?: number | null;
  /**
   * Live adapter: check+get for one row. Must never call /set.
   * Offline tests inject a fake that flips RUNNING → DONE with responseJson.
   */
  pollTask: (task: EnrichmentPollTaskSnap) => Promise<EnrichmentPollTaskSnap>;
  /** Persist safe poll diagnostics (ProviderTask / artifact). Never swallow. */
  persistPollError?: (diag: ArsenkinPollErrorDiagnostic) => Promise<void> | void;
}): Promise<{
  tasks: EnrichmentPollTaskSnap[];
  polledExternalTaskIds: string[];
  earliestNextPollAt: Date | null;
  pollErrors: Array<ArsenkinPollErrorDiagnostic>;
}> {
  const now = input.now ?? new Date();
  const byId = new Map(input.tasks.map((t) => [t.id, { ...t }]));
  const polledExternalTaskIds: string[] = [];
  const pollErrors: ArsenkinPollErrorDiagnostic[] = [];
  let earliestNextPollAt: Date | null = null;

  for (const task of input.tasks) {
    const ext = String(task.externalTaskId ?? "").trim();
    if (!ext) continue;
    const state = String(task.state).toUpperCase();
    if (!POLLABLE_WITH_EXTERNAL.has(state)) continue;
    const dueAt = task.nextPollAt ? new Date(task.nextPollAt) : null;
    if (dueAt && !Number.isNaN(dueAt.getTime()) && dueAt.getTime() > now.getTime()) {
      if (!earliestNextPollAt || dueAt.getTime() < earliestNextPollAt.getTime()) {
        earliestNextPollAt = dueAt;
      }
      continue;
    }
    let updated: EnrichmentPollTaskSnap;
    try {
      // Persist attempt progress on the in-memory snap before HTTP (job lease held by caller).
      const preFlight: EnrichmentPollTaskSnap = {
        ...task,
        attempts: Math.max(0, Number(task.attempts ?? 0)) + 1,
        nextPollAt: task.nextPollAt ?? new Date(now.getTime() + 2_000),
      };
      byId.set(task.id, preFlight);
      updated = await input.pollTask(preFlight);
    } catch (err) {
      const nextPollAt = new Date(
        now.getTime() + Math.min(30_000, 2_000 * 2 ** Math.min(Number(task.attempts ?? 0), 4))
      );
      const diag = buildSafePollErrorDiagnostic({
        providerTaskId: task.id,
        externalTaskId: ext,
        operation: "poll",
        error: err,
        pollAttempt: input.jobPollAttempt ?? null,
        nextPollAt,
        now,
      });
      pollErrors.push(diag);
      console.error(
        JSON.stringify({
          event: "arsenkin_enrichment_poll_error",
          providerTaskId: diag.providerTaskId,
          externalTaskId: diag.externalTaskId,
          operation: diag.operation,
          errorCode: diag.errorCode,
          httpStatus: diag.httpStatus,
          pollAttempt: diag.pollAttempt,
          nextPollAt: diag.nextPollAt,
          lastErrorAt: diag.lastErrorAt,
          message: diag.message,
        })
      );
      try {
        await input.persistPollError?.(diag);
      } catch (persistErr) {
        console.error(
          JSON.stringify({
            event: "arsenkin_enrichment_poll_error_persist_failed",
            providerTaskId: task.id,
            externalTaskId: ext,
            message: (persistErr instanceof Error ? persistErr.message : String(persistErr)).slice(
              0,
              300
            ),
          })
        );
      }
      updated = {
        ...task,
        attempts: Math.max(0, Number(task.attempts ?? 0)) + 1,
        nextPollAt,
        responseJson: {
          ...(isPlainObject(task.responseJson) ? task.responseJson : {}),
          _pollDiagnostics: diag,
        },
      };
      byId.set(task.id, updated);
      polledExternalTaskIds.push(ext);
      if (!earliestNextPollAt || nextPollAt.getTime() < earliestNextPollAt.getTime()) {
        earliestNextPollAt = nextPollAt;
      }
      continue;
    }
    byId.set(task.id, { ...updated });
    polledExternalTaskIds.push(ext);
    const next = updated.nextPollAt ? new Date(updated.nextPollAt) : null;
    if (next && !Number.isNaN(next.getTime()) && String(updated.state).toUpperCase() !== "DONE") {
      if (!earliestNextPollAt || next.getTime() < earliestNextPollAt.getTime()) {
        earliestNextPollAt = next;
      }
    }
  }

  return {
    tasks: [...byId.values()],
    polledExternalTaskIds,
    earliestNextPollAt,
    pollErrors,
  };
}

export type LivePollEnrichmentContext = {
  caseId: string;
  unifiedJobId: string;
  enrichmentRunIds: readonly string[];
  jobPollAttempt?: number | null;
};

/** Safe poll diagnostic (no tokens / secret URLs / raw bodies). */
export type ArsenkinPollErrorDiagnostic = {
  providerTaskId: string;
  externalTaskId: string;
  operation: "check" | "get" | "poll";
  errorCode: string;
  httpStatus: number | null;
  pollAttempt: number | null;
  nextPollAt: string | null;
  lastErrorAt: string;
  message: string;
};

export function buildSafePollErrorDiagnostic(input: {
  providerTaskId: string;
  externalTaskId: string;
  operation?: "check" | "get" | "poll";
  error: unknown;
  pollAttempt?: number | null;
  nextPollAt?: Date | string | null;
  now?: Date;
}): ArsenkinPollErrorDiagnostic {
  const err = input.error;
  const message = (err instanceof Error ? err.message : String(err)).slice(0, 400);
  const httpStatus =
    err && typeof err === "object" && "options" in err
      ? Number((err as { options?: { status?: number } }).options?.status) || null
      : err && typeof err === "object" && "status" in err
        ? Number((err as { status?: number }).status) || null
        : null;
  let errorCode = "ARSENKIN_POLL_FAILED";
  if (/live-network-blocked|poll-auth-blocked|no-authorization/i.test(message)) {
    errorCode = "ARSENKIN_POLL_AUTH_BLOCKED";
  } else if (/ARSENKIN_SCHEMA_INVALID/i.test(message)) {
    errorCode = "ARSENKIN_SCHEMA_INVALID";
  } else if (httpStatus != null) {
    errorCode = `ARSENKIN_POLL_HTTP_${httpStatus}`;
  }
  const next =
    input.nextPollAt == null
      ? null
      : typeof input.nextPollAt === "string"
        ? input.nextPollAt
        : input.nextPollAt.toISOString();
  return {
    providerTaskId: input.providerTaskId,
    externalTaskId: input.externalTaskId,
    operation: input.operation ?? "poll",
    errorCode,
    httpStatus,
    pollAttempt: input.pollAttempt ?? null,
    nextPollAt: next,
    lastErrorAt: (input.now ?? new Date()).toISOString(),
    message,
  };
}

/**
 * Default live poll: Arsenkin check+get via pollArsenkinTask (never /set).
 * Requires withExistingExternalTaskPollAuthorization scope for the persisted task.
 */
export async function defaultLivePollEnrichmentTask(
  task: EnrichmentPollTaskSnap,
  ctx: LivePollEnrichmentContext
): Promise<EnrichmentPollTaskSnap> {
  const { createArsenkinClientFromEnv, ARSENKIN_DEFAULT_API_BASE } = await import(
    "../providers/arsenkin/client"
  );
  const { createPrismaProviderTaskStore } = await import(
    "../providers/arsenkin/prisma-provider-task-store"
  );
  const { pollArsenkinTask } = await import("../providers/arsenkin/poll-worker");
  const { withExistingExternalTaskPollAuthorization } = await import(
    "../providers/arsenkin/live-execution-authorization"
  );
  const client = createArsenkinClientFromEnv();
  if (!client) {
    throw new Error("ARSENKIN_POLL_FAILED:client-unavailable");
  }
  const store = createPrismaProviderTaskStore();
  const row = await store.findById(task.id);
  if (!row) {
    throw new Error(`ARSENKIN_POLL_FAILED:providerTask-missing:${task.id}`);
  }
  const externalTaskId = String(row.externalTaskId ?? task.externalTaskId ?? "").trim();
  const enrichmentRunId = String(row.reportRunId ?? task.reportRunId ?? "").trim();
  if (!externalTaskId || !enrichmentRunId) {
    throw new Error("ARSENKIN_POLL_FAILED:missing-externalTaskId-or-enrichmentRunId");
  }

  const polled = await withExistingExternalTaskPollAuthorization(
    {
      caseId: ctx.caseId,
      unifiedJobId: ctx.unifiedJobId,
      enrichmentRunId,
      providerTaskId: row.id,
      externalTaskId,
      allowedOperations: ["check", "get"],
      maxNewTasks: 0,
      expectedBaseUrl: client.getBaseUrl() || ARSENKIN_DEFAULT_API_BASE,
      providerTask: {
        id: row.id,
        caseId: row.caseId,
        reportRunId: row.reportRunId,
        externalTaskId: row.externalTaskId,
        submittedAt: row.submittedAt,
        state: row.state,
      },
      jobEnrichmentRunIds: ctx.enrichmentRunIds,
      jobCaseId: ctx.caseId,
      jobUnifiedJobId: ctx.unifiedJobId,
    },
    async () => pollArsenkinTask(client, store, row)
  );

  return {
    id: polled.id,
    reportRunId: String(polled.reportRunId ?? task.reportRunId),
    externalTaskId: polled.externalTaskId,
    toolName: polled.toolName,
    state: String(polled.state),
    responseJson: polled.responseJson,
    requestJson: polled.requestJson,
    nextPollAt: polled.nextPollAt,
    attempts: polled.attempts,
  };
}

/**
 * Live durable tick: reuse enrichmentRunIds, poll ProviderTasks, ingest, no new submits.
 */
export async function runDurableArsenkinEnrichmentTick(input: {
  job: UnifiedCollectionJob;
  prisma?: PrismaClient | null;
  /** When true (NETWORK_CALLS=0), empty offline agents may EMPTY_VALID without tasks. */
  offlineEmptyValid?: boolean;
  scheduleIfMissing?: () => Promise<{
    enrichmentRunIds: string[];
    arsenkinReportRunId: string | null;
    warnings: string[];
  }>;
  /** Offline / test: load ProviderTasks without Prisma. */
  listProviderTasks?: (enrichmentRunIds: string[]) => Promise<EnrichmentPollTaskSnap[]>;
  /** Offline / test: poll adapter (must not call /set). */
  pollTask?: (task: EnrichmentPollTaskSnap) => Promise<EnrichmentPollTaskSnap>;
  now?: () => Date;
}): Promise<ArsenkinEnrichmentTickResult> {
  const job = input.job;
  let enrichmentRunIds = [...(job.enrichmentRunIds ?? [])];
  const warnings: string[] = [];
  let earliestNextPollAt: Date | null = null;

  if (enrichmentRunIds.length < ARSENKIN_REAL_AGENT_NAMES.length) {
    if (!input.scheduleIfMissing) {
      const state = emptyArsenkinEnrichmentState({
        caseId: job.caseId,
        unifiedJobId: job.unifiedJobId,
      });
      return {
        state,
        observations: [],
        enrichmentRunIds,
        arsenkinReportRunId: null,
        warnings: ["arsenkin-not-scheduled"],
        blockPipeline: true,
        blockCode: "ARSENKIN_STAGE_NOT_STARTED",
        blockMessage: "Arsenkin CaseAgents not scheduled",
        waiting: false,
      };
    }
    const scheduled = await input.scheduleIfMissing();
    enrichmentRunIds = scheduled.enrichmentRunIds;
    warnings.push(...scheduled.warnings, "arsenkin-five-agents-scheduled");
    // After schedule — wait for next ticks; do NOT advance to composite.
    const agents: ArsenkinAgentProgress[] = ARSENKIN_REAL_AGENT_NAMES.map((agentName, i) => ({
      agentName,
      enrichmentRunId: enrichmentRunIds[i] ?? null,
      scheduled: true,
      terminal: false,
      terminalKind: null,
      ingested: false,
      pendingTaskCount: 1,
      doneTaskCount: 0,
      submitUnknownCount: 0,
      observationCount: 0,
    }));
    const state = buildArsenkinEnrichmentState({
      caseId: job.caseId,
      unifiedJobId: job.unifiedJobId,
      agents,
    });
    return {
      state,
      observations: [],
      enrichmentRunIds,
      arsenkinReportRunId: enrichmentRunIds[0] ?? scheduled.arsenkinReportRunId,
      warnings,
      blockPipeline: false,
      waiting: true,
    };
  }

  // Poll existing tasks — never create new external submissions here.
  let tasks: EnrichmentPollTaskSnap[] = [];
  if (input.listProviderTasks) {
    tasks = await input.listProviderTasks(enrichmentRunIds);
  } else {
    let prisma = input.prisma ?? null;
    if (!prisma) {
      try {
        prisma = (await import("@/server/prisma/client")).prisma;
      } catch {
        prisma = null;
      }
    }
    if (prisma) {
      try {
        const rows = await prisma.providerTask.findMany({
          where: { reportRunId: { in: enrichmentRunIds } },
          select: {
            id: true,
            reportRunId: true,
            externalTaskId: true,
            toolName: true,
            state: true,
            responseJson: true,
            requestJson: true,
            nextPollAt: true,
            attempts: true,
          },
        });
        tasks = rows
          .filter((r): r is typeof r & { reportRunId: string } => Boolean(r.reportRunId))
          .map((r) => ({
            id: r.id,
            reportRunId: r.reportRunId,
            externalTaskId: r.externalTaskId,
            toolName: r.toolName,
            state: String(r.state),
            responseJson: r.responseJson,
            requestJson: r.requestJson,
            nextPollAt: r.nextPollAt,
            attempts: r.attempts,
          }));
      } catch (err) {
        warnings.push(
          `arsenkin-providerTask-list-failed:${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`
        );
      }
    }
  }

  const networkOff = String(process.env.NETWORK_CALLS ?? "") === "0";
  const pollCtx: LivePollEnrichmentContext = {
    caseId: job.caseId,
    unifiedJobId: job.unifiedJobId,
    enrichmentRunIds,
    jobPollAttempt: job.pollAttempt ?? null,
  };
  const pollTask =
    input.pollTask ??
    (networkOff
      ? async (t: EnrichmentPollTaskSnap) => t
      : (t: EnrichmentPollTaskSnap) => defaultLivePollEnrichmentTask(t, pollCtx));

  const persistPollError = async (diag: ArsenkinPollErrorDiagnostic) => {
    try {
      const { writeUnifiedArtifact } = await import("./unified-collection-job-store");
      writeUnifiedArtifact(job.caseId, job.unifiedJobId, "arsenkin-poll-error-latest.json", diag);
    } catch {
      /* best-effort artifact */
    }
    if (networkOff || input.pollTask) return;
    try {
      const { createPrismaProviderTaskStore } = await import(
        "../providers/arsenkin/prisma-provider-task-store"
      );
      const store = createPrismaProviderTaskStore();
      const row = await store.findById(diag.providerTaskId);
      if (!row) return;
      const prev = isPlainObject(row.responseJson) ? row.responseJson : {};
      await store.updateState(diag.providerTaskId, {
        state: row.state,
        attempts: Math.max(0, Number(row.attempts ?? 0)) + 1,
        nextPollAt: diag.nextPollAt ? new Date(diag.nextPollAt) : row.nextPollAt,
        errorCode: diag.errorCode.slice(0, 80),
        responseJson: {
          ...prev,
          _pollDiagnostics: diag,
        },
      });
    } catch {
      /* persistence best-effort; console already logged */
    }
  };

  const polled = await pollDueEnrichmentProviderTasks({
    tasks,
    now: input.now?.(),
    jobPollAttempt: job.pollAttempt ?? null,
    pollTask,
    persistPollError,
  });
  tasks = polled.tasks;
  earliestNextPollAt = polled.earliestNextPollAt;
  if (polled.polledExternalTaskIds.length > 0) {
    warnings.push(
      `arsenkin-polled:${polled.polledExternalTaskIds.length}`,
      ...polled.polledExternalTaskIds.map((id) => `arsenkin-poll-externalTaskId:${id}`)
    );
  }
  for (const pe of polled.pollErrors) {
    warnings.push(
      ...[
        `arsenkin-poll-error:${pe.externalTaskId}`,
        `providerTaskId:${pe.providerTaskId}`,
        `${pe.errorCode}:${pe.message.slice(0, 120)}`,
        pe.httpStatus != null ? `httpStatus:${pe.httpStatus}` : "",
        pe.pollAttempt != null ? `jobPollAttempt:${pe.pollAttempt}` : "",
      ].filter(Boolean)
    );
  }

  // Load CaseAgent execution files for terminal status.
  let executions: Array<{
    agentId: string;
    enrichmentReportRunId: string;
    status: string;
    phase: string;
  }> = [];
  try {
    const { listRunningArsenkinCaseAgentExecutions, loadArsenkinCaseAgentExecution } = await import(
      "./arsenkin-case-agent-execution"
    );
    const { readdirSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(
      process.cwd(),
      "storage",
      "digital-profile",
      "arsenkin-case-agent-runs",
      job.caseId
    );
    if (existsSync(root)) {
      for (const f of readdirSync(root)) {
        if (!f.endsWith(".json")) continue;
        const ex = loadArsenkinCaseAgentExecution(job.caseId, f.replace(/\.json$/, ""));
        if (ex && enrichmentRunIds.includes(ex.enrichmentReportRunId)) {
          executions.push({
            agentId: ex.agentId,
            enrichmentReportRunId: ex.enrichmentReportRunId,
            status: ex.status,
            phase: ex.phase,
          });
        }
      }
    }
    void listRunningArsenkinCaseAgentExecutions;
  } catch {
    /* offline / missing */
  }

  const candidateObservations: ArsenkinIngestedObservation[] = [];
  const agents: ArsenkinAgentProgress[] = [];
  let schemaBlock: string | null = null;

  for (let i = 0; i < ARSENKIN_REAL_AGENT_NAMES.length; i++) {
    const agentName = ARSENKIN_REAL_AGENT_NAMES[i]!;
    const runId =
      enrichmentRunIds.find((id) => agentNameFromEnrichmentRunId(id) === agentName) ??
      enrichmentRunIds[i]!;
    const agentTasks = tasks.filter((t) => t.reportRunId === runId);
    const exec = executions.find((e) => e.enrichmentReportRunId === runId);

    if (input.offlineEmptyValid && agentTasks.length === 0 && !exec) {
      agents.push({
        agentName,
        enrichmentRunId: runId,
        scheduled: true,
        terminal: true,
        terminalKind: "EMPTY_VALID",
        ingested: true,
        pendingTaskCount: 0,
        doneTaskCount: 0,
        submitUnknownCount: 0,
        observationCount: 0,
      });
      continue;
    }

    const built = progressFromTasks({
      agentName,
      enrichmentRunId: runId,
      unifiedJobId: job.unifiedJobId,
      tasks: agentTasks,
      executionStatus: exec?.status,
      executionPhase: exec?.phase,
      allowEmptyValid: Boolean(input.offlineEmptyValid),
    });
    warnings.push(...built.warnings);
    if (built.schemaError) {
      schemaBlock = built.schemaError;
    }
    const obs = built.observations.map((o) => ({
      ...o,
      unifiedJobId: job.unifiedJobId,
      enrichmentRunId: runId,
    }));
    candidateObservations.push(...obs);
    agents.push({
      ...built.progress,
      observationCount: obs.filter(isArsenkinClientEvidenceObservation).length,
    });
  }

  const previousState = normalizeArsenkinEnrichmentState(job.arsenkinEnrichmentState, {
    caseId: job.caseId,
    unifiedJobId: job.unifiedJobId,
  });
  const exactly = applyExactlyOnceIngest({
    caseId: job.caseId,
    unifiedJobId: job.unifiedJobId,
    previousState,
    previousObservations: [],
    candidates: candidateObservations,
    agents,
  });
  warnings.push(...exactly.warnings);

  if (exactly.conflict) {
    return {
      state: exactly.state,
      observations: exactly.observations,
      enrichmentRunIds,
      arsenkinReportRunId: enrichmentRunIds[0] ?? null,
      coverageMeasured: exactly.observations.filter(isArsenkinClientEvidenceObservation).length,
      warnings: [...warnings, "ARSENKIN_INGEST_CONFLICT"],
      blockPipeline: true,
      blockCode: exactly.conflictCode,
      blockMessage: exactly.conflictMessage,
      waiting: false,
    };
  }

  if (schemaBlock) {
    return {
      state: exactly.state,
      observations: [],
      enrichmentRunIds,
      arsenkinReportRunId: enrichmentRunIds[0] ?? null,
      warnings: [...warnings, "ARSENKIN_SCHEMA_INVALID", schemaBlock],
      blockPipeline: true,
      blockCode: "ARSENKIN_SCHEMA_INVALID",
      blockMessage: schemaBlock,
      waiting: false,
    };
  }

  const state = exactly.state;
  const failed = state.failedAgents.length > 0;
  const waiting = !state.enrichmentComplete && !failed;
  const nowMs = (input.now?.() ?? new Date()).getTime();
  const pollAttempt = Math.max(0, Number(job.pollAttempt ?? 0));
  const backoffMs = waiting
    ? Math.min(30_000, Math.max(2_000, 2_000 * 2 ** Math.min(pollAttempt, 4)))
    : 0;
  const computedNext =
    earliestNextPollAt && earliestNextPollAt.getTime() > nowMs
      ? earliestNextPollAt
      : waiting
        ? new Date(nowMs + backoffMs)
        : null;
  return {
    state,
    observations: exactly.observations,
    enrichmentRunIds,
    arsenkinReportRunId: enrichmentRunIds[0] ?? null,
    coverageMeasured: exactly.observations.filter(isArsenkinClientEvidenceObservation).length,
    warnings: [
      ...warnings,
      failed
        ? `arsenkin-failed:${state.failedAgents.join(",")}`
        : state.enrichmentComplete
          ? "arsenkin-enrichment-complete"
          : "arsenkin-enrichment-waiting",
      `arsenkin-scheduled:${state.scheduledAgents.length}`,
      `arsenkin-completed:${state.completedAgents.length}`,
      `arsenkin-ingested:${state.ingestedAgents.length}`,
      `arsenkin-resultHashes:${state.ingestedResultHashes.length}`,
    ],
    blockPipeline: failed,
    blockCode: failed ? "ARSENKIN_ENRICHMENT_FAILED" : undefined,
    blockMessage: failed
      ? `Arsenkin failed/unreconciled: ${state.failedAgents.join(",")}`
      : undefined,
    waiting,
    nextPollAt: computedNext ? computedNext.toISOString() : null,
  };
}

export function offlineSyntheticCompleteTick(job: UnifiedCollectionJob): ArsenkinEnrichmentTickResult {
  const enrichmentRunIds = ARSENKIN_REAL_AGENT_NAMES.map(
    (name, i) => `offline-arsenkin-${name.toLowerCase()}-${i + 1}`
  );
  const agents: ArsenkinAgentProgress[] = ARSENKIN_REAL_AGENT_NAMES.map((agentName, i) => ({
    agentName,
    enrichmentRunId: enrichmentRunIds[i]!,
    scheduled: true,
    terminal: true,
    terminalKind: "EMPTY_VALID",
    ingested: true,
    pendingTaskCount: 0,
    doneTaskCount: 0,
    submitUnknownCount: 0,
    observationCount: 0,
  }));
  return buildEnrichmentTickFromAgentSnapshots({
    caseId: job.caseId,
    unifiedJobId: job.unifiedJobId,
    agents,
    observations: [],
    enrichmentRunIds,
  });
}

export { emptyCoverage, FIRST36_PLANNED_SUPPORTED_SURFACES };
