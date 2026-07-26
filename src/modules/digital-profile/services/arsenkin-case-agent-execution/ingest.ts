/**
 * Durable Arsenkin CaseAgent execution — split from arsenkin-case-agent-execution.ts
 * (REMEDIATION §9.5) — mechanical move only.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { ArsenkinToolName } from "../../providers/arsenkin/flags";
import {
  FIRST36_FULL_SURFACE_SLOTS,
  type FullFirst36SurfaceSlot,
} from "../../providers/arsenkin/workflow-contract";
import { writeJsonAtomic } from "../../providers/arsenkin/arsenkin-db-readiness";
import { isValidBaseOrionReportRunId } from "../../providers/arsenkin/source-binding-repair";
import { buildArsenkinSubjectQueryPlan } from "../../orion-golden/classic/arsenkin-subject-query-plan";
import {
  buildArsenkinExecutionPlan,
  type ArsenkinExecutionPlan,
  type ArsenkinLiveStage,
} from "../../orion-golden/classic/arsenkin-execution-plan";
import { pickEnrichmentUrls } from "../../orion-golden/classic/enrich-report-run-with-arsenkin";
import { planArsenkinExactTasks } from "../../orion-golden/classic/plan-arsenkin-exact-tasks";
import { writeAgentRunStatus } from "./agent-run-status";

import type {
  ArsenkinCaseAgentExecutionJob,
  ArsenkinCaseAgentExecutionSummary,
  ArsenkinCaseAgentPhase,
  FinalizeEvidence,
} from "./shared";
import {
  computeArsenkinCaseAgentOutcome,
  emptyIds,
  isFinalizationAllowed,
  listRunningArsenkinCaseAgentExecutions,
  loadArsenkinCaseAgentExecution,
  loadFinalizeEvidence,
  plannedSurfacesForTools,
  saveArsenkinCaseAgentExecution,
} from "./shared";

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
  explicitErrorCode?: string | null;
  explicitErrorMessage?: string | null;
}): Promise<ArsenkinCaseAgentExecutionSummary & { agentDbStatus: "RUNNING" | "SUCCEEDED" | "FAILED" }> {
  const job = loadArsenkinCaseAgentExecution(input.caseId, input.executionId);
  if (job && !isFinalizationAllowed(job.phase) && !input.explicitErrorCode) {
    return {
      ...emptyIds(),
      agentId: input.agentId,
      executionId: input.executionId,
      agentRunId: input.agentRunId,
      baseReportRunId: input.baseReportRunId ?? null,
      enrichmentReportRunId: input.enrichmentReportRunId,
      plannedSurfaceCount: input.plannedSurfaceCount,
      terminalSurfaceCount: 0,
      measuredSurfaceCount: 0,
      noResultsSurfaceCount: 0,
      notSupportedSurfaceCount: 0,
      failedSurfaceCount: 0,
      providerTaskCount: 0,
      observationCount: 0,
      coverageCount: 0,
      reusedTaskCount: 0,
      networkCallCount: input.networkCallCount ?? 0,
      outcome: "RUNNING",
      summary: `Фаза ${job.phase}: finalization запрещена до завершения сбора.`,
      agentDbStatus: "RUNNING",
      errorCode: null,
    };
  }

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
    explicitErrorCode: input.explicitErrorCode ?? job?.errorCode,
    explicitErrorMessage: input.explicitErrorMessage ?? job?.errorMessage,
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
  const recorded = await writeAgentRunStatus({
    prisma,
    agentRunId: input.agentRunId,
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
  if (!recorded) {
    // Здесь пропажа записи значима: это итог прогона, и без неё оператор не
    // увидит, чем он кончился. Одна строка вместо трассы — наблюдения уже
    // сохранены, восстанавливать удалённую запись нечем.
    console.warn(
      `[arsenkin-case-agent] AgentRun ${input.agentRunId} отсутствует — итог прогона записать некуда`
    );
  }

  if (computed.agentDbStatus === "SUCCEEDED") {
    try {
      const { appendCaseAgentEnrichmentToReportBinding } = await import(
        "../../orion-golden/classic/arsenkin-report-binding"
      );
      const reg = appendCaseAgentEnrichmentToReportBinding({
        caseId: input.caseId,
        enrichmentReportRunId: input.enrichmentReportRunId,
        baseReportRunId: input.baseReportRunId ?? null,
        agentId: input.agentId,
        tools: input.tools,
        observationCount: summary.observationCount,
        coverageCount: summary.coverageCount,
      });
      console.info(
        JSON.stringify({
          event: "arsenkin_case_agent_report_binding",
          caseId: input.caseId,
          agentId: input.agentId,
          enrichmentReportRunId: input.enrichmentReportRunId,
          ok: reg.ok,
          reason: reg.reason,
        })
      );
    } catch (err) {
      console.error(
        "[arsenkin-case-agent] appendCaseAgentEnrichmentToReportBinding failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  try {
    const { writeReportEvidenceProvenance } = await import("../report-evidence-provenance");
    await writeReportEvidenceProvenance({
      caseId: input.caseId,
      phase: "ARSENKIN_CASE_AGENT",
      trigger: `${input.agentId}:${summary.outcome}`,
      prisma,
    });
  } catch (err) {
    console.error(
      "[arsenkin-case-agent] provenance write failed:",
      err instanceof Error ? err.message : err
    );
  }

  if (job) {
    saveArsenkinCaseAgentExecution({
      ...job,
      status: computed.agentDbStatus === "FAILED" ? "FAILED" : "FINALIZED",
      phase: computed.agentDbStatus === "FAILED" ? "FAILED" : "FINALIZED",
      errorCode: summary.errorCode ?? null,
      errorMessage: computed.agentDbStatus === "FAILED" ? summary.summary : null,
    });
  }

  return { ...summary, agentDbStatus: computed.agentDbStatus };
}

/**
 * Tick: only finalize jobs already in FINALIZING (never during PREPARING/COLLECTING).
 * Also re-schedules stuck PREPARING/COLLECTING via resume worker.
 */
export async function tickArsenkinCaseAgentFinalizations(deps?: {
  prisma?: PrismaClient;
  evidenceByExecutionId?: Record<string, FinalizeEvidence>;
}): Promise<number> {
  const running = listRunningArsenkinCaseAgentExecutions();
  let n = 0;
  for (const job of running) {
    if (!isFinalizationAllowed(job.phase)) {
      continue;
    }
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
        explicitErrorCode: job.errorCode,
        explicitErrorMessage: job.errorMessage,
      });
      if (result.agentDbStatus !== "RUNNING") n += 1;
    } catch (err) {
      console.error(
        `[arsenkin-case-agent] finalize tick failed ${job.executionId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return n;
}


