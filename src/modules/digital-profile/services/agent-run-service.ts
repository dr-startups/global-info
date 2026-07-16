/**
 * Agent run service (Stage G).
 *
 * Owns the agent_runs lifecycle and audit logging around agent execution:
 *  - a RUNNING agent_run row is created before the agent runs;
 *  - on completion it becomes SUCCEEDED or FAILED with timing + output;
 *  - errors are stored but never returned with a stack trace.
 *
 * Mock vs real agents share this service and the same dp_* tables.
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/server/prisma/client";
import { NotFoundError, ValidationError } from "../http/errors";
import { recordAudit } from "./audit-log-service";
import type { ActorContext } from "./case-service";
import { getAgent, listAgentDefinitions } from "../agents/registry";
import { FULL_AUDIT_DEFAULT_RUNTIME_MODE, resolveRuntimeStrategy } from "../agents/runtime-strategy";
import type { AgentAvailability, AgentKind, FullAuditOutcome } from "../agents/types";
import type { AgentContext, SavedEvidenceSummary } from "../types";
import type { ProviderRuntimeMode } from "../types";

export interface AgentRunDTO {
  id: string;
  /** Agent slug (from agent_runs.input.agentId), falls back to the DB enum. */
  agentName: string;
  kind: AgentKind;
  status: string;
  summary: string | null;
  /** Arsenkin durable outcome from output.outcome when present. */
  outcome?: string | null;
  executionId?: string | null;
  itemsSaved: number;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface AgentInfoDTO {
  name: string;
  displayName: string;
  description: string;
  kind: AgentKind;
  enabled: boolean;
  availability: AgentAvailability;
  executionMode?: "SYNC" | "DURABLE_ASYNC";
  lastRun: {
    status: string;
    outcome?: string | null;
    summary?: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
  } | null;
}

export interface FullAuditResultDTO {
  outcome: FullAuditOutcome;
  runs: AgentRunDTO[];
  runSummary: FullAuditRunSummaryItem[];
  runtimeStrategy: {
    mode: ProviderRuntimeMode;
    selectedOrder: string[];
    fallbackPolicy: "allow_mock_fallback" | "allow_empty_fallback" | "no_mock_fallback";
    realProvidersAvailable: number;
    mockProvidersAvailable: number;
    fallbackEvents: Array<{
      providerId: string;
      reason: string;
      from: "real" | "mock" | "none";
      to: "real" | "mock" | "none";
    }>;
    warnings: string[];
    decisions: Array<{
      providerId: string;
      phase: "collection" | "surfaces" | "enrichment" | "report";
      status: "selected" | "skipped_unavailable" | "skipped_by_mode";
      selectedAgent?: string;
      selectedRuntime?: "real" | "mock";
      fallbackAgent?: string;
      reason: string;
    }>;
  };
}

export interface FullAuditRunSummaryItem {
  providerId: string;
  phase: "collection" | "surfaces" | "enrichment" | "report";
  status: "completed" | "failed" | "skipped" | "unavailable";
  runtime: "real" | "mock" | "none";
  agentName?: string;
  fallbackAgent?: string;
  reason: string;
  runId?: string;
}

const agentRunSelect = {
  id: true,
  agentName: true,
  input: true,
  status: true,
  output: true,
  error: true,
  itemsSaved: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
} satisfies Prisma.AgentRunSelect;

function summarize(saved: SavedEvidenceSummary): string {
  const parts = Object.entries(saved)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([k, n]) => `${n} ${k}`);
  return parts.length ? `Saved ${parts.join(", ")}` : "No new records";
}

function sumSaved(saved: SavedEvidenceSummary): number {
  return Object.values(saved).reduce<number>((a, n) => a + (typeof n === "number" ? n : 0), 0);
}

function runInput(row: { input: Prisma.JsonValue }): { agentId?: string; kind?: AgentKind } {
  return (row.input ?? {}) as { agentId?: string; kind?: AgentKind };
}

function toRunDTO(
  row: Prisma.AgentRunGetPayload<{ select: typeof agentRunSelect }>
): AgentRunDTO {
  const output = (row.output ?? null) as {
    summary?: string;
    outcome?: string;
    arsenkinExecution?: { executionId?: string };
  } | null;
  const input = runInput(row);
  return {
    id: row.id,
    agentName: input.agentId ?? row.agentName,
    kind: input.kind ?? "MOCK",
    status: row.status,
    summary: output?.summary ?? null,
    outcome: output?.outcome ?? null,
    executionId: output?.arsenkinExecution?.executionId ?? null,
    itemsSaved: row.itemsSaved,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    createdAt: row.createdAt,
  };
}

async function ensureActiveCase(caseId: string): Promise<void> {
  const found = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: { id: true },
  });
  if (!found) throw new NotFoundError("Case not found");
}

/** Runs a single agent, recording an agent_run row + audit logs around it. */
export async function runAgent(
  caseId: string,
  agentName: string,
  ctx: ActorContext = {}
): Promise<AgentRunDTO> {
  await ensureActiveCase(caseId);

  const agent = getAgent(agentName);
  if (!agent) throw new ValidationError(`Unknown agent: ${agentName}`);

  const agentCtx: AgentContext = {
    caseId,
    actorId: ctx.actorId ?? "system",
    mock: agent.kind === "MOCK",
  };
  await agent.validateInput(agentCtx);

  const run = await prisma.agentRun.create({
    data: {
      caseId,
      agentName: agent.agentName,
      input: {
        agentId: agent.name,
        kind: agent.kind,
        executionMode: agent.executionMode ?? "SYNC",
      },
      status: "RUNNING",
      startedAt: new Date(),
      triggeredBy: ctx.actorId ?? null,
    },
    select: { id: true },
  });
  await recordAudit({
    caseId,
    action: "AGENT_RUN_STARTED",
    actorId: ctx.actorId,
    metadata: { runId: run.id, agentName: agent.name },
  });

  // ---- Durable async Arsenkin (and future) agents ----
  if ((agent.executionMode ?? "SYNC") === "DURABLE_ASYNC") {
    const tools =
      "tools" in agent && Array.isArray((agent as { tools?: string[] }).tools)
        ? ((agent as { tools: import("../providers/arsenkin/flags").ArsenkinToolName[] }).tools)
        : [];
    try {
      const { startArsenkinCaseAgentDurable, tickArsenkinCaseAgentFinalizations } = await import(
        "./arsenkin-case-agent-execution"
      );
      const started = await startArsenkinCaseAgentDurable({
        caseId,
        agentRunId: run.id,
        agentId: agent.name,
        tools,
        actorId: ctx.actorId ?? undefined,
      });
      const updated = await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: "RUNNING",
          finishedAt: null,
          itemsSaved: 0,
          output: {
            summary: `Выполняется Arsenkin (${started.plannedSurfaces.length} поверхностей)…`,
            outcome: "RUNNING",
            arsenkinExecution: {
              agentId: agent.name,
              executionId: started.executionId,
              agentRunId: run.id,
              baseReportRunId: started.baseReportRunId,
              enrichmentReportRunId: started.enrichmentReportRunId,
              plannedSurfaceCount: started.plannedSurfaces.length,
              outcome: "RUNNING",
            },
            demo: false,
          } as unknown as Prisma.InputJsonValue,
        },
        select: agentRunSelect,
      });
  // Best-effort early finalize (e.g. NETWORK_CALLS=0 → NO_EXECUTION_EVIDENCE after enqueue).
      // Do not treat enqueue as SUCCESS.
      setImmediate(() => {
        void (async () => {
          try {
            const { enqueueArsenkinCaseAgentProviderTasks } = await import(
              "./arsenkin-case-agent-execution"
            );
            await enqueueArsenkinCaseAgentProviderTasks({
              caseId,
              agentId: agent.name,
              executionId: started.executionId,
              enrichmentReportRunId: started.enrichmentReportRunId,
              tools,
            });
          } catch {
            /* enqueue failures leave RUNNING until finalize */
          }
          await tickArsenkinCaseAgentFinalizations().catch(() => undefined);
        })();
      });
      return toRunDTO(updated);
    } catch (err) {
      const updated = await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          error: err instanceof Error ? err.message : "Durable Arsenkin start failed",
          output: {
            summary: "Не удалось запустить durable Arsenkin execution",
            outcome: "FAILED",
            demo: false,
          } as unknown as Prisma.InputJsonValue,
        },
        select: agentRunSelect,
      });
      return toRunDTO(updated);
    }
  }

  const result = await agent.run(agentCtx);

  if (result.status === "SUCCEEDED") {
    const summary = summarize(result.saved);
    const updated = await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCEEDED",
        finishedAt: new Date(),
        itemsSaved: sumSaved(result.saved),
        output: { saved: result.saved, summary, demo: true } as unknown as Prisma.InputJsonValue,
      },
      select: agentRunSelect,
    });
    await recordAudit({
      caseId,
      action: "AGENT_RUN_SUCCEEDED",
      actorId: ctx.actorId,
      metadata: { runId: run.id, agentName: agent.name, summary },
    });
    return toRunDTO(updated);
  }

  if (result.status === "RUNNING") {
    // SYNC agents should not return RUNNING; keep RUNNING without fake SUCCESS.
    const updated = await prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: "RUNNING",
        finishedAt: null,
        output: {
          summary: "Выполняется…",
          outcome: "RUNNING",
          ...(typeof result.output === "object" && result.output ? result.output : {}),
        } as unknown as Prisma.InputJsonValue,
      },
      select: agentRunSelect,
    });
    return toRunDTO(updated);
  }

  const updated = await prisma.agentRun.update({
    where: { id: run.id },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      error: result.error ?? "Agent failed",
    },
    select: agentRunSelect,
  });
  await recordAudit({
    caseId,
    action: "AGENT_RUN_FAILED",
    actorId: ctx.actorId,
    metadata: { runId: run.id, agentName: agent.name },
  });
  return toRunDTO(updated);
}

/**
 * Runs all agents in order. A failing agent does NOT abort the audit — the
 * remaining independent agents still run. The overall outcome is SUCCESS (all
 * ok), PARTIAL_SUCCESS (some failed) or FAILED (all failed). There is no
 * PARTIAL_SUCCESS DB enum, so the outcome is returned + audited in metadata.
 */
export async function runFullAudit(
  caseId: string,
  ctx: ActorContext = {},
  options: { runtimeMode?: ProviderRuntimeMode } = {}
): Promise<FullAuditResultDTO> {
  await ensureActiveCase(caseId);
  const runtimeMode = options.runtimeMode ?? FULL_AUDIT_DEFAULT_RUNTIME_MODE;
  const runtimeStrategy = resolveRuntimeStrategy({
    mode: runtimeMode,
    requestedBy: options.runtimeMode ? "request" : "default",
  });
  await recordAudit({
    caseId,
    action: "FULL_AUDIT_STARTED",
    actorId: ctx.actorId,
    metadata: {
      agents: runtimeStrategy.selectedOrder,
      runtimeStrategy: {
        mode: runtimeStrategy.mode,
        fallbackPolicy: runtimeStrategy.fallbackPolicy,
        warnings: runtimeStrategy.warnings,
        decisions: runtimeStrategy.decisions,
      },
    } as unknown as Prisma.InputJsonValue,
  });

  const runs: AgentRunDTO[] = [];
  const runSummary: FullAuditRunSummaryItem[] = runtimeStrategy.decisions.map((decision) => {
    if (decision.status === "selected") {
      return {
        providerId: decision.providerId,
        phase: decision.phase,
        status: "skipped",
        runtime: decision.selectedRuntime ?? "none",
        agentName: decision.selectedAgent,
        fallbackAgent: decision.fallbackAgent,
        reason: `Planned: ${decision.reason}`,
      };
    }
    return {
      providerId: decision.providerId,
      phase: decision.phase,
      status: decision.status === "skipped_unavailable" ? "unavailable" : "skipped",
      runtime: "none",
      reason: decision.reason,
    };
  });

  const summaryByProvider = new Map<string, FullAuditRunSummaryItem>(
    runSummary.map((item) => [item.providerId, item])
  );

  for (const step of runtimeStrategy.steps) {
    try {
      const firstRun = await runAgent(caseId, step.primaryAgent, ctx);
      runs.push(firstRun);
      const summaryItem = summaryByProvider.get(step.providerId);
      if (summaryItem) {
        summaryItem.agentName = step.primaryAgent;
        summaryItem.runtime = step.primaryRuntime;
        summaryItem.runId = firstRun.id || undefined;
      }
      if (
        runtimeStrategy.mode === "real_first_with_fallback" &&
        firstRun.status !== "SUCCEEDED" &&
        step.primaryRuntime === "real" &&
        step.fallbackAgent
      ) {
        const fallbackRun = await runAgent(caseId, step.fallbackAgent, ctx);
        runs.push(fallbackRun);
        if (summaryItem) {
          summaryItem.fallbackAgent = step.fallbackAgent;
          summaryItem.agentName = fallbackRun.status === "SUCCEEDED" ? step.fallbackAgent : step.primaryAgent;
          summaryItem.runtime = fallbackRun.status === "SUCCEEDED" ? "mock" : "real";
          summaryItem.runId = fallbackRun.id || summaryItem.runId;
          summaryItem.status = fallbackRun.status === "SUCCEEDED" ? "completed" : "failed";
          summaryItem.reason =
            fallbackRun.status === "SUCCEEDED"
              ? `Primary real agent ${step.primaryAgent} failed; fallback ${step.fallbackAgent} completed.`
              : `Primary real agent ${step.primaryAgent} failed and fallback ${step.fallbackAgent} failed.`;
        }
        runtimeStrategy.fallbackEvents.push({
          providerId: step.providerId,
          reason: `Primary real agent ${step.primaryAgent} failed; fallback agent ${step.fallbackAgent} executed.`,
          from: "real",
          to: "mock",
        });
      } else if (summaryItem) {
        summaryItem.status = firstRun.status === "SUCCEEDED" ? "completed" : "failed";
        summaryItem.reason =
          firstRun.status === "SUCCEEDED"
            ? `${step.primaryAgent} completed successfully.`
            : `${step.primaryAgent} failed${firstRun.error ? `: ${firstRun.error}` : "."}`;
      }
    } catch (err) {
      // Defensive: runAgent normally captures agent errors itself.
      runs.push({
        id: "",
        agentName: step.primaryAgent,
        kind: step.primaryRuntime === "real" ? "REAL" : "MOCK",
        status: "FAILED",
        summary: null,
        itemsSaved: 0,
        error: err instanceof Error ? err.message : "Agent failed",
        startedAt: null,
        finishedAt: null,
        createdAt: new Date(),
      });
      const summaryItem = summaryByProvider.get(step.providerId);
      if (summaryItem) {
        summaryItem.status = "failed";
        summaryItem.reason = `${step.primaryAgent} threw before completion${
          err instanceof Error ? `: ${err.message}` : "."
        }`;
      }
      if (
        runtimeStrategy.mode === "real_first_with_fallback" &&
        step.primaryRuntime === "real" &&
        step.fallbackAgent
      ) {
        try {
          const fallbackRun = await runAgent(caseId, step.fallbackAgent, ctx);
          runs.push(fallbackRun);
          if (summaryItem) {
            summaryItem.fallbackAgent = step.fallbackAgent;
            summaryItem.agentName = fallbackRun.status === "SUCCEEDED" ? step.fallbackAgent : step.primaryAgent;
            summaryItem.runtime = fallbackRun.status === "SUCCEEDED" ? "mock" : "real";
            summaryItem.runId = fallbackRun.id || summaryItem.runId;
            summaryItem.status = fallbackRun.status === "SUCCEEDED" ? "completed" : "failed";
            summaryItem.reason =
              fallbackRun.status === "SUCCEEDED"
                ? `Primary real agent ${step.primaryAgent} threw; fallback ${step.fallbackAgent} completed.`
                : `Primary real agent ${step.primaryAgent} threw and fallback ${step.fallbackAgent} failed.`;
          }
          runtimeStrategy.fallbackEvents.push({
            providerId: step.providerId,
            reason: `Primary real agent ${step.primaryAgent} threw; fallback ${step.fallbackAgent} executed.`,
            from: "real",
            to: "mock",
          });
        } catch {
          runtimeStrategy.fallbackEvents.push({
            providerId: step.providerId,
            reason: `Primary real agent ${step.primaryAgent} failed and fallback ${step.fallbackAgent} failed.`,
            from: "real",
            to: "none",
          });
          if (summaryItem) {
            summaryItem.status = "failed";
            summaryItem.reason = `Primary real agent ${step.primaryAgent} failed and fallback ${step.fallbackAgent} failed.`;
          }
        }
      }
    }
  }

  const succeeded = runs.filter((r) => r.status === "SUCCEEDED").length;
  const outcome: FullAuditOutcome =
    succeeded === runs.length ? "SUCCESS" : succeeded === 0 ? "FAILED" : "PARTIAL_SUCCESS";

  await recordAudit({
    caseId,
    action: outcome === "FAILED" ? "FULL_AUDIT_FAILED" : "FULL_AUDIT_COMPLETED",
    actorId: ctx.actorId,
    metadata: {
      outcome,
      results: runs.map((r) => ({ agent: r.agentName, status: r.status })),
      runSummary,
      runtimeStrategy: {
        mode: runtimeStrategy.mode,
        fallbackPolicy: runtimeStrategy.fallbackPolicy,
        fallbackEvents: runtimeStrategy.fallbackEvents,
        warnings: runtimeStrategy.warnings,
        decisions: runtimeStrategy.decisions,
      },
    } as unknown as Prisma.InputJsonValue,
  });

  return {
    outcome,
    runs,
    runSummary,
    runtimeStrategy: {
      mode: runtimeStrategy.mode,
      selectedOrder: runtimeStrategy.selectedOrder,
      fallbackPolicy: runtimeStrategy.fallbackPolicy,
      realProvidersAvailable: runtimeStrategy.realProvidersAvailable,
      mockProvidersAvailable: runtimeStrategy.mockProvidersAvailable,
      fallbackEvents: runtimeStrategy.fallbackEvents,
      warnings: runtimeStrategy.warnings,
      decisions: runtimeStrategy.decisions,
    },
  };
}

export async function listAgentRuns(caseId: string): Promise<AgentRunDTO[]> {
  await ensureActiveCase(caseId);
  const rows = await prisma.agentRun.findMany({
    where: { caseId },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: agentRunSelect,
  });
  return rows.map(toRunDTO);
}

export async function getAgentRun(runId: string): Promise<AgentRunDTO> {
  const row = await prisma.agentRun.findUnique({
    where: { id: runId },
    select: agentRunSelect,
  });
  if (!row) throw new NotFoundError("Agent run not found");
  return toRunDTO(row);
}

/** Lists registered agents with each agent's most recent run (if any). */
export async function listAgents(caseId: string): Promise<AgentInfoDTO[]> {
  await ensureActiveCase(caseId);
  const defs = listAgentDefinitions();

  const runs = await prisma.agentRun.findMany({
    where: { caseId },
    orderBy: { createdAt: "desc" },
    select: {
      agentName: true,
      input: true,
      status: true,
      output: true,
      startedAt: true,
      finishedAt: true,
    },
  });
  // Key strictly by input.agentId so agents sharing Prisma AgentName (SEARCH_SURFACES)
  // never collide. Legacy rows without agentId only map when enum is unique.
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    const agentId = runInput(r).agentId;
    if (typeof agentId === "string" && agentId.trim()) {
      if (!latest.has(agentId)) latest.set(agentId, r);
      continue;
    }
    if (r.agentName === "SEARCH_SURFACES") continue;
    if (!latest.has(r.agentName)) latest.set(r.agentName, r);
  }

  return defs.map((d) => {
    const last = latest.get(d.name);
    const agent = getAgent(d.name);
    const out = (last?.output ?? null) as { summary?: string; outcome?: string } | null;
    return {
      name: d.name,
      displayName: d.displayName,
      description: d.description,
      kind: d.kind,
      enabled: d.enabled,
      availability: d.availability,
      executionMode: agent?.executionMode ?? "SYNC",
      lastRun: last
        ? {
            status: last.status,
            outcome: out?.outcome ?? null,
            summary: out?.summary ?? null,
            startedAt: last.startedAt,
            finishedAt: last.finishedAt,
          }
        : null,
    };
  });
}
