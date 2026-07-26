/**
 * Durable Arsenkin CaseAgent execution — split from arsenkin-case-agent-execution.ts
 * (REMEDIATION §9.5) — mechanical move only.
 */

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { ArsenkinToolName } from "../../providers/arsenkin/flags";
import type { FullFirst36SurfaceSlot } from "../../providers/arsenkin/workflow-contract";
import { isValidBaseOrionReportRunId } from "../../providers/arsenkin/source-binding-repair";
import type { ArsenkinCaseAgentExecutionJob } from "./shared";
import {
  buildArsenkinCaseAgentExecutionPlan,
  caseAgentWaitTimeoutMs,
  classifyWorkerError,
  enqueueCaseAgentWork,
  ensureCaseAgentOrionReportRun,
  failJobAndAgentRun,
  findActiveArsenkinCaseAgentExecution,
  listRunningArsenkinCaseAgentExecutions,
  loadArsenkinCaseAgentExecution,
  loadSubjectForCase,
  loadUrlsFromSearchResults,
  plannedSurfacesForTools,
  saveArsenkinCaseAgentExecution,
  stageForCaseAgentTools,
} from "./shared";
import { finalizeArsenkinCaseAgentRun } from "./ingest";
import { writeAgentRunStatus } from "./agent-run-status";

export async function runArsenkinCaseAgentWorker(input: {
  caseId: string;
  executionId: string;
  prisma?: PrismaClient;
}): Promise<void> {
  return enqueueCaseAgentWork(async () => {
    const job0 = loadArsenkinCaseAgentExecution(input.caseId, input.executionId);
    if (!job0) {
      console.error(`[arsenkin-case-agent] job not found ${input.caseId}/${input.executionId}`);
      return;
    }
    if (job0.phase === "FINALIZED" || job0.phase === "FAILED") return;
    if (job0.phase === "FINALIZING") {
      await finalizeArsenkinCaseAgentRun({
        agentRunId: job0.agentRunId,
        caseId: job0.caseId,
        executionId: job0.executionId,
        enrichmentReportRunId: job0.enrichmentReportRunId,
        agentId: job0.agentId,
        tools: job0.tools,
        plannedSurfaceCount: job0.plannedSurfaces.length,
        baseReportRunId: job0.baseReportRunId,
        prisma: input.prisma,
        reused: (job0.reusedTaskCount ?? 0) > 0 && (job0.reusedTaskCount ?? 0) === job0.plannedSurfaces.length,
        networkCallCount: job0.networkCallsAttempted ? 1 : 0,
        explicitErrorCode: job0.errorCode,
        explicitErrorMessage: job0.errorMessage,
      });
      return;
    }

    let job = job0;
    const prisma = input.prisma ?? (await import("@/server/prisma/client")).prisma;

    try {
      job = {
        ...job,
        phase: "PREPARING",
        status: "RUNNING",
        errorCode: null,
        errorMessage: null,
      };
      saveArsenkinCaseAgentExecution(job);

      await ensureCaseAgentOrionReportRun({
        prisma,
        enrichmentReportRunId: job.enrichmentReportRunId,
        caseId: job.caseId,
        agentId: job.agentId,
        agentRunId: job.agentRunId,
        executionId: job.executionId,
        tools: job.tools,
        baseReportRunId: job.baseReportRunId,
      });

      const subject = await loadSubjectForCase(prisma, job.caseId);
      let urlsEnrichment: string[] = [];
      if (job.tools.includes("check-h") || job.tools.includes("indexation")) {
        urlsEnrichment = await loadUrlsFromSearchResults(prisma, job.caseId);
      }

      const existingTasks = await prisma.providerTask.findMany({
        where: { reportRunId: job.enrichmentReportRunId, provider: "arsenkin" },
        select: { id: true, requestHash: true, state: true },
      });

      const built = buildArsenkinCaseAgentExecutionPlan({
        caseId: job.caseId,
        enrichmentReportRunId: job.enrichmentReportRunId,
        tools: job.tools,
        fullName: subject.fullName,
        aliases: subject.aliases,
        urlsEnrichment,
        existingTasks,
      });

      if (!built.ok) {
        await failJobAndAgentRun({
          job,
          errorCode: built.errorCode,
          errorMessage: built.errorMessage,
          prisma,
        });
        return;
      }

      const reusedTaskCount = built.plan.requests.filter((r) => r.action === "REUSE").length;
      job = {
        ...job,
        planDigest: built.plan.digest,
        queriesRu: built.queriesRu,
        queriesUae: built.queriesUae,
        urlsEnrichment: built.urlsEnrichment,
        reusedTaskCount,
      };
      saveArsenkinCaseAgentExecution(job);

      if (String(process.env.NETWORK_CALLS ?? "") === "0") {
        await failJobAndAgentRun({
          job,
          errorCode: "ARSENKIN_NETWORK_CALLS_DISABLED",
          errorMessage:
            "NETWORK_CALLS=0 — live Arsenkin /set→/check→/get отключён (offline). OrionReportRun и plan созданы.",
          prisma,
        });
        return;
      }

      const { createArsenkinClientFromEnv } = await import("../../providers/arsenkin/client");
      const client = createArsenkinClientFromEnv();
      if (!client) {
        await failJobAndAgentRun({
          job,
          errorCode: "ARSENKIN_TOKEN_MISSING",
          errorMessage: "Arsenkin client недоступен (token missing / ARSENKIN_ENABLED).",
          prisma,
        });
        return;
      }

      job = { ...job, phase: "COLLECTING", status: "RUNNING", networkCallsAttempted: true };
      saveArsenkinCaseAgentExecution(job);

      try {
        await writeAgentRunStatus({
          prisma,
          agentRunId: job.agentRunId,
          data: {
            status: "RUNNING",
            output: {
              summary: `Arsenkin API: /set→/check→/get (${built.plan.requests.length} задач)…`,
              outcome: "RUNNING",
              arsenkinExecution: {
                agentId: job.agentId,
                executionId: job.executionId,
                agentRunId: job.agentRunId,
                enrichmentReportRunId: job.enrichmentReportRunId,
                baseReportRunId: job.baseReportRunId,
                plannedSurfaceCount: job.plannedSurfaces.length,
                outcome: "RUNNING",
                phase: "COLLECTING",
                planDigest: built.plan.digest,
                requestCount: built.plan.requests.length,
              },
              demo: false,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        console.error(
          "[arsenkin-case-agent] COLLECTING status update failed:",
          err instanceof Error ? err.message : err
        );
      }

      const { createPrismaProviderTaskStore } = await import(
        "../../providers/arsenkin/prisma-provider-task-store"
      );
      const {
        executeArsenkinExecutionPlan,
        authorizationFromPlan,
      } = await import("../../providers/arsenkin/execute-arsenkin-execution-plan");
      const { persistSerpObservations } = await import("../../serp-observation/persist");

      const auth = authorizationFromPlan(built.plan);
      const waitTimeoutMs = caseAgentWaitTimeoutMs(job.tools);
      const collected = await executeArsenkinExecutionPlan({
        plan: built.plan,
        authorization: auth,
        client,
        store: createPrismaProviderTaskStore(),
        waitTimeoutMs,
        onProgress: async (info) => {
          const label = `${info.tool}${info.engine ? `/${info.engine}` : ""}${
            info.region ? `:${info.region}` : ""
          }`;
          const summary =
            info.phase === "start"
              ? `Arsenkin API: задача ${info.index}/${info.total} (${label}) — /set→/check→/get…`
              : `Arsenkin API: задача ${info.index}/${info.total} (${label}) готова`;
          try {
            await writeAgentRunStatus({
              prisma,
              agentRunId: job.agentRunId,
              data: {
                status: "RUNNING",
                output: {
                  summary,
                  outcome: "RUNNING",
                  arsenkinExecution: {
                    agentId: job.agentId,
                    executionId: job.executionId,
                    agentRunId: job.agentRunId,
                    enrichmentReportRunId: job.enrichmentReportRunId,
                    baseReportRunId: job.baseReportRunId,
                    plannedSurfaceCount: job.plannedSurfaces.length,
                    outcome: "RUNNING",
                    phase: "COLLECTING",
                    planDigest: built.plan.digest,
                    progress: info,
                  },
                  demo: false,
                } as unknown as Prisma.InputJsonValue,
              },
            });
            saveArsenkinCaseAgentExecution({
              ...job,
              phase: "COLLECTING",
              status: "RUNNING",
              updatedAt: new Date().toISOString(),
            });
          } catch (err) {
            console.error(
              "[arsenkin-case-agent] progress update failed:",
              err instanceof Error ? err.message : err
            );
          }
        },
      });
      await persistSerpObservations(collected.drafts);

      await prisma.orionReportRun.update({
        where: { id: job.enrichmentReportRunId },
        data: {
          status: "SUCCEEDED",
          finishedAt: new Date(),
          metadataJson: {
            agentId: job.agentId,
            agentRunId: job.agentRunId,
            executionId: job.executionId,
            tools: job.tools,
            baseReportRunId: job.baseReportRunId,
            planDigest: built.plan.digest,
            taskIds: collected.taskIds,
            bySurface: collected.bySurface,
          } as Prisma.InputJsonValue,
        },
      });

      job = {
        ...job,
        phase: "FINALIZING",
        status: "RUNNING",
        reusedTaskCount,
      };
      saveArsenkinCaseAgentExecution(job);

      await finalizeArsenkinCaseAgentRun({
        agentRunId: job.agentRunId,
        caseId: job.caseId,
        executionId: job.executionId,
        enrichmentReportRunId: job.enrichmentReportRunId,
        agentId: job.agentId,
        tools: job.tools,
        plannedSurfaceCount: job.plannedSurfaces.length,
        baseReportRunId: job.baseReportRunId,
        prisma,
        reused: reusedTaskCount > 0 && reusedTaskCount === built.plan.requests.length,
        networkCallCount: 1,
      });
    } catch (err) {
      const classified = classifyWorkerError(err);
      console.error(
        `[arsenkin-case-agent] worker failed ${job.executionId}:`,
        classified.errorCode,
        classified.errorMessage
      );
      await failJobAndAgentRun({
        job,
        errorCode: classified.errorCode,
        errorMessage: classified.errorMessage,
        prisma,
      });
    }
  });
}

/**
 * Застряло ли исполнение настолько, что его пора заместить даже автоматически.
 *
 * Порог с запасом: отправка пяти агентов идёт последовательно, и живое
 * исполнение может ждать своей очереди минутами. Замещать раньше — плодить
 * ровно ту churn, ради которой правка и делается.
 */
const CASE_AGENT_STALE_MS = 15 * 60_000;

export function isStaleCaseAgentExecution(
  job: { updatedAt?: string | null; phase?: string },
  now: Date
): boolean {
  const at = Date.parse(String(job.updatedAt ?? ""));
  if (!Number.isFinite(at)) return true;
  return now.getTime() - at > CASE_AGENT_STALE_MS;
}

export async function startArsenkinCaseAgentDurable(input: {
  caseId: string;
  agentRunId: string;
  agentId: string;
  tools: ArsenkinToolName[];
  actorId?: string;
  prisma?: PrismaClient;
  resolveBaseReportRunId?: () => Promise<string | null>;
  /** When false, caller schedules worker (default true). */
  scheduleWorker?: boolean;
  /**
   * Автоматический дозапуск: живое исполнение не замещать, а дождаться.
   * Ручной повтор этого флага не ставит — там замещение и есть смысл действия.
   */
  reuseActiveExecution?: boolean;
}): Promise<{
  executionId: string;
  enrichmentReportRunId: string;
  baseReportRunId: string | null;
  plannedSurfaces: FullFirst36SurfaceSlot[];
  status: "RUNNING";
  reusedExisting?: boolean;
}> {
  const existing = findActiveArsenkinCaseAgentExecution(input.caseId, input.agentId);
  // Живое исполнение автоматическим дозапуском не замещается (шаг 15, I1).
  //
  // Тик предлагает отправку каждому агенту без строки `ProviderTask` и делает
  // это на каждом обороте, пока задача не создана. Прежде каждый такой заход
  // помечал предыдущее исполнение `ARSENKIN_SUPERSEDED`, и на здоровом прогоне
  // оператор видел во вкладке «Агенты» четыре отказа подряд.
  //
  // Замещение остаётся правом человека: ручной повтор именно за тем и нужен,
  // чтобы сбросить застрявшее исполнение. Автоматика же обязана дождаться.
  if (existing && input.reuseActiveExecution && !isStaleCaseAgentExecution(existing, new Date())) {
    return {
      executionId: existing.executionId,
      enrichmentReportRunId: existing.enrichmentReportRunId,
      baseReportRunId: existing.baseReportRunId,
      plannedSurfaces: existing.plannedSurfaces as FullFirst36SurfaceSlot[],
      status: "RUNNING",
      reusedExisting: true,
    };
  }
  if (existing) {
    // Always start a fresh execution on retry — do not reuse a stuck COLLECTING job.
    saveArsenkinCaseAgentExecution({
      ...existing,
      status: "FAILED",
      phase: "FAILED",
      errorCode: "ARSENKIN_SUPERSEDED",
      errorMessage: "Заменён новым запуском того же агента",
    });
    try {
      const prisma = input.prisma ?? (await import("@/server/prisma/client")).prisma;
      // Записи может не быть — прошлый запуск мог быть подчищен. Это не сбой:
      // помечать нечего, и трассы Prisma в журнале здесь не нужны (шаг 13, B6).
      await writeAgentRunStatus({
        prisma,
        agentRunId: existing.agentRunId,
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          error: "ARSENKIN_SUPERSEDED: заменён новым запуском того же агента",
          output: {
            summary: "Запуск замещён повторным нажатием",
            outcome: "FAILED",
            errorCode: "ARSENKIN_SUPERSEDED",
            demo: false,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      console.error(
        "[arsenkin-case-agent] supersede old AgentRun failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

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
        "../../providers/arsenkin/source-binding-repair"
      );
      const resolved = await resolveCanonicalBaseOrionReportRunId(input.caseId, {
        prisma: input.prisma,
      });
      if (resolved.ok && isValidBaseOrionReportRunId(resolved.baseOrionReportRunId)) {
        baseReportRunId = resolved.baseOrionReportRunId;
      }
    } catch (err) {
      console.error(
        "[arsenkin-case-agent] resolveBaseReportRunId failed:",
        err instanceof Error ? err.message : err
      );
      baseReportRunId = null;
    }
  }

  const job: ArsenkinCaseAgentExecutionJob = {
    version: "arsenkin-case-agent-execution-v2",
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
    phase: "PREPARING",
    networkCallsAttempted: false,
  };
  saveArsenkinCaseAgentExecution(job);

  if (input.scheduleWorker !== false) {
    setImmediate(() => {
      void runArsenkinCaseAgentWorker({
        caseId: input.caseId,
        executionId,
        prisma: input.prisma,
      }).catch((err) => {
        console.error(
          "[arsenkin-case-agent] scheduleWorker error:",
          err instanceof Error ? err.message : err
        );
      });
    });
  }

  return {
    executionId,
    enrichmentReportRunId,
    baseReportRunId,
    plannedSurfaces: planned,
    status: "RUNNING",
  };
}

export async function resumeArsenkinCaseAgentExecutions(deps?: {
  prisma?: PrismaClient;
  /** Skip jobs updated more recently than this (ms). Avoids stealing in-flight HTTP workers. */
  minAgeMs?: number;
}): Promise<number> {
  const minAgeMs = deps?.minAgeMs ?? 90_000;
  const running = listRunningArsenkinCaseAgentExecutions();
  let n = 0;
  const now = Date.now();
  for (const job of running) {
    if (job.phase === "FINALIZED" || job.phase === "FAILED") continue;
    const updatedMs = Date.parse(job.updatedAt || job.createdAt);
    if (Number.isFinite(updatedMs) && now - updatedMs < minAgeMs) {
      continue;
    }
    n += 1;
    void runArsenkinCaseAgentWorker({
      caseId: job.caseId,
      executionId: job.executionId,
      prisma: deps?.prisma,
    }).catch((err) => {
      console.error(
        `[arsenkin-case-agent] resume failed ${job.executionId}:`,
        err instanceof Error ? err.message : err
      );
    });
  }
  return n;
}

/**
 * @deprecated Removed enqueue-only /set path. Kept as no-op for any stale imports.
 * Use runArsenkinCaseAgentWorker instead.
 */
export async function enqueueArsenkinCaseAgentProviderTasks(_input: {
  caseId: string;
  agentId: string;
  executionId: string;
  enrichmentReportRunId: string;
  tools: ArsenkinToolName[];
}): Promise<{ setCalls: number }> {
  console.error(
    "[arsenkin-case-agent] enqueueArsenkinCaseAgentProviderTasks is deprecated; use runArsenkinCaseAgentWorker"
  );
  return { setCalls: 0 };
}


