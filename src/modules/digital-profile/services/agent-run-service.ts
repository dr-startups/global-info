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
import { resolveRuntimeStrategy } from "../agents/runtime-strategy";
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
  lastRun: {
    status: string;
    startedAt: Date | null;
    finishedAt: Date | null;
  } | null;
}

export interface FullAuditResultDTO {
  outcome: FullAuditOutcome;
  runs: AgentRunDTO[];
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
  };
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
  const output = (row.output ?? null) as { summary?: string } | null;
  const input = runInput(row);
  return {
    id: row.id,
    agentName: input.agentId ?? row.agentName,
    kind: input.kind ?? "MOCK",
    status: row.status,
    summary: output?.summary ?? null,
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
    mock: true,
  };
  await agent.validateInput(agentCtx);

  const run = await prisma.agentRun.create({
    data: {
      caseId,
      agentName: agent.agentName,
      input: { agentId: agent.name, kind: agent.kind },
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
  const runtimeStrategy = resolveRuntimeStrategy({
    mode: options.runtimeMode,
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
      },
    },
  });

  const runs: AgentRunDTO[] = [];
  for (const step of runtimeStrategy.steps) {
    try {
      const firstRun = await runAgent(caseId, step.primaryAgent, ctx);
      runs.push(firstRun);
      if (
        runtimeStrategy.mode === "real_first_with_fallback" &&
        firstRun.status !== "SUCCEEDED" &&
        step.primaryRuntime === "real" &&
        step.fallbackAgent
      ) {
        const fallbackRun = await runAgent(caseId, step.fallbackAgent, ctx);
        runs.push(fallbackRun);
        runtimeStrategy.fallbackEvents.push({
          providerId: step.providerId,
          reason: `Primary real agent ${step.primaryAgent} failed; fallback agent ${step.fallbackAgent} executed.`,
          from: "real",
          to: "mock",
        });
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
      if (
        runtimeStrategy.mode === "real_first_with_fallback" &&
        step.primaryRuntime === "real" &&
        step.fallbackAgent
      ) {
        try {
          const fallbackRun = await runAgent(caseId, step.fallbackAgent, ctx);
          runs.push(fallbackRun);
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
      runtimeStrategy: {
        mode: runtimeStrategy.mode,
        fallbackPolicy: runtimeStrategy.fallbackPolicy,
        fallbackEvents: runtimeStrategy.fallbackEvents,
        warnings: runtimeStrategy.warnings,
      },
    },
  });

  return {
    outcome,
    runs,
    runtimeStrategy: {
      mode: runtimeStrategy.mode,
      selectedOrder: runtimeStrategy.selectedOrder,
      fallbackPolicy: runtimeStrategy.fallbackPolicy,
      realProvidersAvailable: runtimeStrategy.realProvidersAvailable,
      mockProvidersAvailable: runtimeStrategy.mockProvidersAvailable,
      fallbackEvents: runtimeStrategy.fallbackEvents,
      warnings: runtimeStrategy.warnings,
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
    select: { agentName: true, input: true, status: true, startedAt: true, finishedAt: true },
  });
  // Key by the agent slug (input.agentId) so mock + real Wikipedia stay distinct.
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) {
    const key = runInput(r).agentId ?? r.agentName;
    if (!latest.has(key)) latest.set(key, r);
  }

  return defs.map((d) => {
    const last = latest.get(d.name);
    return {
      name: d.name,
      displayName: d.displayName,
      description: d.description,
      kind: d.kind,
      enabled: d.enabled,
      availability: d.availability,
      lastRun: last
        ? { status: last.status, startedAt: last.startedAt, finishedAt: last.finishedAt }
        : null,
    };
  });
}
