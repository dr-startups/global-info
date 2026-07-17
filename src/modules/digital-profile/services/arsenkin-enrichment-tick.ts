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
  "SUBMIT_UNKNOWN",
  "POLLING",
  "SUBMITTED",
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
  const submitUnknown = tasks.filter((t) => String(t.state).toUpperCase() === "SUBMIT_UNKNOWN");
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

  if (submitUnknown.length > 0 && done.length === 0 && !input.allowEmptyValid) {
    terminal = true;
    terminalKind = "SUBMIT_UNKNOWN_UNRECONCILED";
  } else if (failed.length > 0 && done.length === 0) {
    terminal = true;
    terminalKind = "FAILED";
  } else if (execFailed && tasks.length === 0) {
    terminal = true;
    terminalKind = "FAILED";
  } else if (pending.length === 0 && (done.length > 0 || execFinalized || input.allowEmptyValid)) {
    terminal = true;
    let anyEmptyValid = false;
    for (const t of done) {
      const adapted = observationsFromTask(t, input.agentName, input.unifiedJobId);
      if (!adapted.ok) {
        schemaError = adapted.message;
        terminalKind = "FAILED";
        ingested = false;
        observations = [];
        break;
      }
      warnings.push(...adapted.warnings);
      if (adapted.emptyValid) anyEmptyValid = true;
      observations.push(
        ...adapted.observations.map((o) => ({ ...o, enrichmentRunId: input.enrichmentRunId }))
      );
    }
    if (!schemaError) {
      if (observations.length === 0) {
        terminalKind = anyEmptyValid || done.length === 0 || input.allowEmptyValid ? "EMPTY_VALID" : "EMPTY_VALID";
      } else {
        terminalKind = "SUCCESS";
      }
      ingested = true;
    }
  } else if (pending.length > 0 || (!execFinalized && tasks.length === 0 && !input.allowEmptyValid)) {
    terminal = false;
    terminalKind = null;
  }

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
      submitUnknownCount: submitUnknown.length,
      observationCount: observations.length,
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
}): Promise<ArsenkinEnrichmentTickResult> {
  const job = input.job;
  let enrichmentRunIds = [...(job.enrichmentRunIds ?? [])];
  const warnings: string[] = [];

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
  let prisma = input.prisma ?? null;
  if (!prisma) {
    try {
      prisma = (await import("@/server/prisma/client")).prisma;
    } catch {
      prisma = null;
    }
  }

  let tasks: ProviderTaskSnap[] = [];
  if (prisma) {
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
      }));
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
      observationCount: obs.length,
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
      coverageMeasured: exactly.observations.length,
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
  return {
    state,
    observations: exactly.observations,
    enrichmentRunIds,
    arsenkinReportRunId: enrichmentRunIds[0] ?? null,
    coverageMeasured: exactly.observations.length,
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
    waiting: !state.enrichmentComplete && !failed,
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
