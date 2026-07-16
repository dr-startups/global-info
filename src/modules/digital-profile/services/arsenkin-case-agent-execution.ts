/**
 * Durable Arsenkin CaseAgent execution: start ≠ SUCCESS.
 * Finalization requires ProviderTask + coverage evidence (or explicit NO_RESULTS).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { ArsenkinToolName } from "../providers/arsenkin/flags";
import {
  FIRST36_FULL_SURFACE_SLOTS,
  type FullFirst36SurfaceSlot,
} from "../providers/arsenkin/workflow-contract";
import { writeJsonAtomic } from "../providers/arsenkin/arsenkin-db-readiness";
import { isValidBaseOrionReportRunId } from "../providers/arsenkin/source-binding-repair";

export type ArsenkinAgentOutcome =
  | "SUCCESS"
  | "PARTIAL_SUCCESS"
  | "NO_RESULTS"
  | "REUSED"
  | "FAILED"
  | "RUNNING";

export type ArsenkinCaseAgentExecutionSummary = {
  agentId: string;
  executionId: string;
  agentRunId: string;
  baseReportRunId: string | null;
  enrichmentReportRunId: string;
  plannedSurfaceCount: number;
  terminalSurfaceCount: number;
  measuredSurfaceCount: number;
  noResultsSurfaceCount: number;
  notSupportedSurfaceCount: number;
  failedSurfaceCount: number;
  providerTaskCount: number;
  observationCount: number;
  coverageCount: number;
  reusedTaskCount: number;
  networkCallCount: number;
  outcome: ArsenkinAgentOutcome;
  summary: string;
  errorCode?: string | null;
};

export type ArsenkinCaseAgentExecutionJob = {
  version: "arsenkin-case-agent-execution-v1";
  executionId: string;
  agentRunId: string;
  caseId: string;
  agentId: string;
  tools: ArsenkinToolName[];
  plannedSurfaces: Array<{ id: string; tool: string; label: string }>;
  enrichmentReportRunId: string;
  baseReportRunId: string | null;
  createdAt: string;
  updatedAt: string;
  status: "RUNNING" | "FINALIZED";
  networkCallsAttempted: boolean;
};

const NON_TERMINAL_TASK = new Set([
  "QUEUED",
  "SUBMITTING",
  "RUNNING",
  "RATE_LIMITED",
  "WAITING",
  "SUBMIT_UNKNOWN",
]);

function executionRoot(caseId: string): string {
  return join(process.cwd(), "storage", "digital-profile", "arsenkin-case-agent-runs", caseId);
}

export function arsenkinCaseAgentExecutionPath(caseId: string, executionId: string): string {
  return join(executionRoot(caseId), `${executionId}.json`);
}

export function plannedSurfacesForTools(tools: ArsenkinToolName[]): FullFirst36SurfaceSlot[] {
  const set = new Set(tools);
  // URL audit agent includes indexation with check-h
  return FIRST36_FULL_SURFACE_SLOTS.filter((s) => {
    if (set.has(s.tool as ArsenkinToolName)) return true;
    if (s.tool === "check-h" && set.has("indexation")) return true;
    return false;
  });
}

export function saveArsenkinCaseAgentExecution(job: ArsenkinCaseAgentExecutionJob): void {
  const path = arsenkinCaseAgentExecutionPath(job.caseId, job.executionId);
  mkdirSync(executionRoot(job.caseId), { recursive: true });
  writeJsonAtomic(path, { ...job, updatedAt: new Date().toISOString() });
}

export function loadArsenkinCaseAgentExecution(
  caseId: string,
  executionId: string
): ArsenkinCaseAgentExecutionJob | null {
  const path = arsenkinCaseAgentExecutionPath(caseId, executionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ArsenkinCaseAgentExecutionJob;
  } catch {
    return null;
  }
}

export function listRunningArsenkinCaseAgentExecutions(caseId?: string): ArsenkinCaseAgentExecutionJob[] {
  const root = join(process.cwd(), "storage", "digital-profile", "arsenkin-case-agent-runs");
  if (!existsSync(root)) return [];
  const cases = caseId ? [caseId] : readdirSync(root);
  const out: ArsenkinCaseAgentExecutionJob[] = [];
  for (const c of cases) {
    const dir = join(root, c);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const job = JSON.parse(readFileSync(join(dir, f), "utf-8")) as ArsenkinCaseAgentExecutionJob;
        if (job.status === "RUNNING") out.push(job);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

export type FinalizeEvidence = {
  providerTasks: Array<{ id: string; state: string; toolName: string; externalTaskId: string | null }>;
  observationCount: number;
  coverageRows: Array<{ status: string; surface: string; tool: string; resultCount: number }>;
};

export function computeArsenkinCaseAgentOutcome(input: {
  plannedSurfaceCount: number;
  evidence: FinalizeEvidence;
  reused?: boolean;
  networkCallCount?: number;
}): ArsenkinCaseAgentExecutionSummary & { agentDbStatus: "RUNNING" | "SUCCEEDED" | "FAILED" } {
  const tasks = input.evidence.providerTasks;
  const providerTaskCount = tasks.length;
  const coverageCount = input.evidence.coverageRows.length;
  const observationCount = input.evidence.observationCount;

  const measuredSurfaceCount = input.evidence.coverageRows.filter((c) =>
    /MEASURED|^OK$/i.test(c.status)
  ).length;
  const noResultsSurfaceCount = input.evidence.coverageRows.filter((c) =>
    /NO_RESULTS/i.test(c.status)
  ).length;
  const notSupportedSurfaceCount = input.evidence.coverageRows.filter((c) =>
    /NOT_SUPPORTED/i.test(c.status)
  ).length;
  const failedSurfaceCount = input.evidence.coverageRows.filter((c) =>
    /FAILED|ERROR/i.test(c.status)
  ).length;

  const hasNonTerminal = tasks.some((t) => NON_TERMINAL_TASK.has(String(t.state).toUpperCase()));
  const allTasksTerminal =
    providerTaskCount > 0 && tasks.every((t) => !NON_TERMINAL_TASK.has(String(t.state).toUpperCase()));

  const terminalSurfaceCount =
    measuredSurfaceCount + noResultsSurfaceCount + notSupportedSurfaceCount + failedSurfaceCount;

  const base = {
    plannedSurfaceCount: input.plannedSurfaceCount,
    terminalSurfaceCount,
    measuredSurfaceCount,
    noResultsSurfaceCount,
    notSupportedSurfaceCount,
    failedSurfaceCount,
    providerTaskCount,
    observationCount,
    coverageCount,
    reusedTaskCount: input.reused ? providerTaskCount : 0,
    networkCallCount: input.networkCallCount ?? 0,
  };

  // Still in flight
  if (hasNonTerminal || (providerTaskCount > 0 && !allTasksTerminal)) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "RUNNING",
      summary: `Выполняется: tasks=${providerTaskCount}, coverage=${coverageCount}, surfaces ${terminalSurfaceCount}/${input.plannedSurfaceCount}`,
      agentDbStatus: "RUNNING",
      errorCode: null,
    };
  }

  // No execution evidence
  if (providerTaskCount === 0 && coverageCount === 0) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "FAILED",
      summary: "Arsenkin executor не создал ProviderTask/coverage — сбор не доказан.",
      agentDbStatus: "FAILED",
      errorCode: "ARSENKIN_NO_EXECUTION_EVIDENCE",
    };
  }

  if (input.reused && allTasksTerminal && (observationCount > 0 || noResultsSurfaceCount > 0 || measuredSurfaceCount > 0)) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "REUSED",
      summary: `Переиспользованы результаты: tasks=${providerTaskCount}, observations=${observationCount}, coverage=${coverageCount}`,
      agentDbStatus: "SUCCEEDED",
      errorCode: null,
    };
  }

  // Proven NO_RESULTS
  if (
    allTasksTerminal &&
    observationCount === 0 &&
    noResultsSurfaceCount > 0 &&
    measuredSurfaceCount === 0 &&
    failedSurfaceCount === 0
  ) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "NO_RESULTS",
      summary: `Запрос выполнен: результатов нет. Поверхности ${terminalSurfaceCount}/${input.plannedSurfaceCount}, coverage=NO_RESULTS.`,
      agentDbStatus: "SUCCEEDED",
      errorCode: null,
    };
  }

  if (failedSurfaceCount > 0 && (measuredSurfaceCount > 0 || noResultsSurfaceCount > 0)) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "PARTIAL_SUCCESS",
      summary: `Частично: measured=${measuredSurfaceCount}, noResults=${noResultsSurfaceCount}, failed=${failedSurfaceCount}, observations=${observationCount}`,
      agentDbStatus: "SUCCEEDED",
      errorCode: null,
    };
  }

  if (
    input.plannedSurfaceCount > 0 &&
    providerTaskCount > 0 &&
    allTasksTerminal &&
    failedSurfaceCount === 0 &&
    (measuredSurfaceCount > 0 || noResultsSurfaceCount > 0 || notSupportedSurfaceCount === input.plannedSurfaceCount)
  ) {
    // All NOT_SUPPORTED is odd but terminal; treat as SUCCESS only if planned covered
    if (measuredSurfaceCount > 0 || noResultsSurfaceCount > 0) {
      return {
        ...emptyIds(),
        ...base,
        outcome: "SUCCESS",
        summary: `Успешно: surfaces ${terminalSurfaceCount}/${input.plannedSurfaceCount}, tasks=${providerTaskCount}, observations=${observationCount}`,
        agentDbStatus: "SUCCEEDED",
        errorCode: null,
      };
    }
  }

  if (providerTaskCount > 0 && allTasksTerminal && failedSurfaceCount === input.plannedSurfaceCount) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "FAILED",
      summary: `Ошибка: все поверхности FAILED_FINAL (tasks=${providerTaskCount})`,
      agentDbStatus: "FAILED",
      errorCode: "ARSENKIN_ALL_SURFACES_FAILED",
    };
  }

  if (providerTaskCount > 0 && coverageCount === 0 && allTasksTerminal) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "FAILED",
      summary: "ProviderTask есть, но SurfaceCollectionCoverage отсутствует.",
      agentDbStatus: "FAILED",
      errorCode: "ARSENKIN_NO_COVERAGE",
    };
  }

  return {
    ...emptyIds(),
    ...base,
    outcome: "FAILED",
    summary: "Недостаточно доказательств успешного Arsenkin-сбора.",
    agentDbStatus: "FAILED",
    errorCode: "ARSENKIN_INCONCLUSIVE",
  };
}

function emptyIds(): Pick<
  ArsenkinCaseAgentExecutionSummary,
  "agentId" | "executionId" | "agentRunId" | "baseReportRunId" | "enrichmentReportRunId"
> {
  return {
    agentId: "",
    executionId: "",
    agentRunId: "",
    baseReportRunId: null,
    enrichmentReportRunId: "",
  };
}

export async function loadFinalizeEvidence(input: {
  prisma: PrismaClient;
  enrichmentReportRunId: string;
  tools: ArsenkinToolName[];
}): Promise<FinalizeEvidence> {
  const toolSet = new Set(input.tools.map(String));
  if (toolSet.has("indexation")) toolSet.add("check-h");
  if (toolSet.has("check-h")) toolSet.add("indexation");

  const providerTasks = await input.prisma.providerTask.findMany({
    where: {
      reportRunId: input.enrichmentReportRunId,
      provider: "arsenkin",
      toolName: { in: [...toolSet] },
    },
    select: { id: true, state: true, toolName: true, externalTaskId: true },
  });
  const taskIds = providerTasks.map((t) => t.id);
  const observationCount =
    taskIds.length === 0
      ? 0
      : await input.prisma.serpObservation.count({
          where: {
            auditRunId: input.enrichmentReportRunId,
            provider: "arsenkin",
            providerTaskId: { in: taskIds },
          },
        });
  const coverageRows = await input.prisma.surfaceCollectionCoverage.findMany({
    where: {
      reportRunId: input.enrichmentReportRunId,
      provider: "arsenkin",
      tool: { in: [...toolSet] },
    },
    select: { status: true, surface: true, tool: true, resultCount: true },
  });
  return {
    providerTasks,
    observationCount,
    coverageRows: coverageRows.map((c) => ({
      status: String(c.status ?? ""),
      surface: String(c.surface ?? ""),
      tool: String(c.tool ?? ""),
      resultCount: c.resultCount ?? 0,
    })),
  };
}

export async function startArsenkinCaseAgentDurable(input: {
  caseId: string;
  agentRunId: string;
  agentId: string;
  tools: ArsenkinToolName[];
  actorId?: string;
  prisma?: PrismaClient;
  /** Injected for tests / offline. */
  resolveBaseReportRunId?: () => Promise<string | null>;
  /** When NETWORK_CALLS=0 or no client — do not pretend SUCCESS. */
  attemptLiveEnqueue?: (ctx: {
    enrichmentReportRunId: string;
    baseReportRunId: string | null;
    plannedSurfaces: FullFirst36SurfaceSlot[];
  }) => Promise<{ networkCallCount: number; reusedTaskCount: number }>;
}): Promise<{
  executionId: string;
  enrichmentReportRunId: string;
  baseReportRunId: string | null;
  plannedSurfaces: FullFirst36SurfaceSlot[];
  status: "RUNNING";
}> {
  const planned = plannedSurfacesForTools(input.tools);
  const executionId = `ace-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const enrichmentReportRunId = `orion-arsenkin-agent-${input.agentId
    .toLowerCase()
    .replace(/_/g, "-")}-${Date.now().toString(36)}`;

  let baseReportRunId: string | null = null;
  if (input.resolveBaseReportRunId) {
    baseReportRunId = await input.resolveBaseReportRunId();
  } else {
    try {
      const { resolveCanonicalBaseOrionReportRunId } = await import(
        "../providers/arsenkin/source-binding-repair"
      );
      const resolved = await resolveCanonicalBaseOrionReportRunId(input.caseId, {
        prisma: input.prisma,
      });
      if (resolved.ok && isValidBaseOrionReportRunId(resolved.baseOrionReportRunId)) {
        baseReportRunId = resolved.baseOrionReportRunId;
      }
    } catch {
      baseReportRunId = null;
    }
  }

  const job: ArsenkinCaseAgentExecutionJob = {
    version: "arsenkin-case-agent-execution-v1",
    executionId,
    agentRunId: input.agentRunId,
    caseId: input.caseId,
    agentId: input.agentId,
    tools: input.tools,
    plannedSurfaces: planned.map((s) => ({ id: s.id, tool: s.tool, label: s.label })),
    enrichmentReportRunId,
    baseReportRunId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "RUNNING",
    networkCallsAttempted: false,
  };
  saveArsenkinCaseAgentExecution(job);

  // Live enqueue is best-effort and must not block HTTP; never mark SUCCESS here.
  const networkOff = String(process.env.NETWORK_CALLS ?? "") === "0";
  if (!networkOff && input.attemptLiveEnqueue) {
    try {
      await input.attemptLiveEnqueue({
        enrichmentReportRunId,
        baseReportRunId,
        plannedSurfaces: planned,
      });
      saveArsenkinCaseAgentExecution({ ...job, networkCallsAttempted: true });
    } catch {
      /* leave RUNNING — finalize will FAIL if no evidence */
    }
  }

  return {
    executionId,
    enrichmentReportRunId,
    baseReportRunId,
    plannedSurfaces: planned,
    status: "RUNNING",
  };
}

export async function finalizeArsenkinCaseAgentRun(input: {
  agentRunId: string;
  caseId: string;
  executionId: string;
  enrichmentReportRunId: string;
  agentId: string;
  tools: ArsenkinToolName[];
  plannedSurfaceCount: number;
  baseReportRunId?: string | null;
  prisma?: PrismaClient;
  evidence?: FinalizeEvidence;
  reused?: boolean;
  networkCallCount?: number;
}): Promise<ArsenkinCaseAgentExecutionSummary & { agentDbStatus: "RUNNING" | "SUCCEEDED" | "FAILED" }> {
  let evidence = input.evidence;
  if (!evidence) {
    const prisma = input.prisma ?? (await import("@/server/prisma/client")).prisma;
    evidence = await loadFinalizeEvidence({
      prisma,
      enrichmentReportRunId: input.enrichmentReportRunId,
      tools: input.tools,
    });
  }

  const computed = computeArsenkinCaseAgentOutcome({
    plannedSurfaceCount: input.plannedSurfaceCount,
    evidence,
    reused: input.reused,
    networkCallCount: input.networkCallCount,
  });

  const summary: ArsenkinCaseAgentExecutionSummary = {
    ...computed,
    agentId: input.agentId,
    executionId: input.executionId,
    agentRunId: input.agentRunId,
    baseReportRunId: input.baseReportRunId ?? null,
    enrichmentReportRunId: input.enrichmentReportRunId,
  };

  if (computed.agentDbStatus === "RUNNING") {
    return { ...summary, agentDbStatus: "RUNNING" };
  }

  const prisma = input.prisma ?? (await import("@/server/prisma/client")).prisma;
  await prisma.agentRun.update({
    where: { id: input.agentRunId },
    data: {
      status: computed.agentDbStatus,
      finishedAt: new Date(),
      error:
        computed.agentDbStatus === "FAILED"
          ? summary.errorCode
            ? `${summary.errorCode}: ${summary.summary}`
            : summary.summary
          : null,
      itemsSaved: summary.observationCount,
      output: {
        summary: summary.summary,
        outcome: summary.outcome,
        arsenkinExecution: summary,
        demo: false,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  const job = loadArsenkinCaseAgentExecution(input.caseId, input.executionId);
  if (job) {
    saveArsenkinCaseAgentExecution({ ...job, status: "FINALIZED" });
  }

  return { ...summary, agentDbStatus: computed.agentDbStatus };
}

/** Tick RUNNING executions: attempt finalize (idempotent). */
export async function tickArsenkinCaseAgentFinalizations(deps?: {
  prisma?: PrismaClient;
  evidenceByExecutionId?: Record<string, FinalizeEvidence>;
}): Promise<number> {
  const running = listRunningArsenkinCaseAgentExecutions();
  let n = 0;
  for (const job of running) {
    try {
      const result = await finalizeArsenkinCaseAgentRun({
        agentRunId: job.agentRunId,
        caseId: job.caseId,
        executionId: job.executionId,
        enrichmentReportRunId: job.enrichmentReportRunId,
        agentId: job.agentId,
        tools: job.tools,
        plannedSurfaceCount: job.plannedSurfaces.length,
        baseReportRunId: job.baseReportRunId,
        prisma: deps?.prisma,
        evidence: deps?.evidenceByExecutionId?.[job.executionId],
        networkCallCount: job.networkCallsAttempted ? 1 : 0,
      });
      if (result.agentDbStatus !== "RUNNING") n += 1;
    } catch {
      /* keep RUNNING */
    }
  }
  return n;
}

/**
 * Enqueue ProviderTasks for this agent tool subset via ensureArsenkinTask (/set).
 * Does NOT wait for DONE — poll/finalize owns completion. Skips when NETWORK_CALLS=0.
 */
export async function enqueueArsenkinCaseAgentProviderTasks(input: {
  caseId: string;
  agentId: string;
  executionId: string;
  enrichmentReportRunId: string;
  tools: ArsenkinToolName[];
}): Promise<{ setCalls: number }> {
  if (String(process.env.NETWORK_CALLS ?? "") === "0") {
    return { setCalls: 0 };
  }
  const job = loadArsenkinCaseAgentExecution(input.caseId, input.executionId);
  const { createArsenkinClientFromEnv } = await import("../providers/arsenkin/client");
  const client = createArsenkinClientFromEnv();
  if (!client) return { setCalls: 0 };

  const { createPrismaProviderTaskStore } = await import("../providers/arsenkin/prisma-provider-task-store");
  const { ensureArsenkinTask } = await import("../providers/arsenkin/poll-worker");
  const { planArsenkinExactTasks } = await import(
    "../orion-golden/classic/plan-arsenkin-exact-tasks"
  );

  // Minimal subject query placeholders — production should load case subject queries.
  let queriesRu = ["subject"];
  let queriesUae = ["subject"];
  try {
    const prisma = (await import("@/server/prisma/client")).prisma;
    const subjects = await prisma.subject.findMany({
      where: { caseId: input.caseId },
      take: 1,
      select: { fullName: true },
    });
    const name = subjects[0]?.fullName?.trim();
    if (name) {
      queriesRu = [name];
      queriesUae = [name];
    }
  } catch {
    /* keep placeholder */
  }

  const planned = planArsenkinExactTasks({
    queriesRu,
    queriesUae,
    tools: input.tools,
  });
  const store = createPrismaProviderTaskStore();
  let setCalls = 0;
  for (const req of planned) {
    try {
      await ensureArsenkinTask(client, store, {
        toolName: req.tools_name,
        data: req.data,
        caseId: input.caseId,
        reportRunId: input.enrichmentReportRunId,
        workerId: "arsenkin-case-agent",
      });
      setCalls += 1;
    } catch {
      /* continue other tasks */
    }
  }
  if (job) {
    saveArsenkinCaseAgentExecution({ ...job, networkCallsAttempted: setCalls > 0 });
  }
  return { setCalls };
}
