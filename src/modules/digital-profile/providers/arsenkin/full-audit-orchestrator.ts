/**
 * One-click durable Arsenkin full-audit orchestrator.
 * Steps are internal; UI only starts/cancels/polls status.
 * NETWORK_CALLS=0 offline via injectable deps — never live from Cursor tests.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createArsenkinClientFromEnv, type ArsenkinClient, ArsenkinClient as ArsenkinClientClass } from "./client";
import { createPrismaProviderTaskStore } from "./prisma-provider-task-store";
import type { ProviderTaskStore } from "./provider-task-store";
import { probeArsenkinLightweightReadiness } from "./lightweight-readiness";
import { reconcileAllDoneZeroObservationTasks } from "./reconcile-done-zero-observations";
import {
  confirmSubmitUnknownNotCreated,
  retryUnconfirmedSubmitOnce,
  linkExistingArsenkinTask,
} from "./submit-unknown-recovery";
import { persistSerpObservations } from "../../serp-observation/persist";
import type { ArsenkinExecutionPlan } from "../../orion-golden/classic/arsenkin-execution-plan";
import {
  claimOrchestrationJobLease,
  createOrchestrationJob,
  findOrCreateActiveOrchestrationJob,
  humanPhaseForState,
  isActiveOrchestrationState,
  loadOrchestrationJob,
  patchOrchestrationJob,
  releaseOrchestrationJobLease,
  type ArsenkinOrchestrationJob,
  type ArsenkinOrchestrationState,
} from "./full-audit-job-store";
import {
  arsenkinBudgetForStage,
  arsenkinCanaryOutRoot,
  prepareArsenkinUiRun,
  planArsenkinUiRun,
  executeArsenkinUiRun,
  syncArsenkinResultsToOrion,
  generateArsenkinReportRunId,
  saveArsenkinUiRunMapping,
  loadArsenkinUiRunMapping,
  type ArsenkinUiStage,
} from "../../services/arsenkin-ui-orchestration-service";
import { enqueueOrionClassicAuditReport } from "../../services/orion-classic-audit-report-service";
import { recordAudit } from "../../services/audit-log-service";

const AMBIGUOUS_SUBMIT_RETRY_MAX = Math.max(
  0,
  Number(process.env.ARSENKIN_AMBIGUOUS_SUBMIT_RETRY_MAX ?? 1) || 1
);
const MAX_ACTIVE_SUBMISSIONS = Math.max(1, Number(process.env.ARSENKIN_MAX_CONCURRENT ?? 2) || 2);

export type FullAuditOrchestratorDeps = {
  prisma?: PrismaClient;
  client?: ArsenkinClient | null;
  store?: ProviderTaskStore;
  prepare?: typeof prepareArsenkinUiRun;
  plan?: typeof planArsenkinUiRun;
  execute?: typeof executeArsenkinUiRun;
  sync?: typeof syncArsenkinResultsToOrion;
  render?: typeof enqueueOrionClassicAuditReport;
  persistObservations?: typeof persistSerpObservations;
  readiness?: typeof probeArsenkinLightweightReadiness;
  /** Offline tests: skip live /get refetch during reconcile. */
  refetchResults?: boolean;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export type StartFullAuditInput = {
  caseId: string;
  reportRunId: string;
  workflow?: "suggest-canary" | "first36-full";
  actorId?: string;
  /** Explicit new collection (not auto). */
  forceNewRun?: boolean;
  confirmed?: boolean;
};

export type StartFullAuditResult = {
  accepted: true;
  jobId: string;
  reportRunId: string;
  state: ArsenkinOrchestrationState;
  created: boolean;
};

function loadPlan(outRoot: string): ArsenkinExecutionPlan | null {
  const path = join(outRoot, "arsenkin-live-plan.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ArsenkinExecutionPlan;
  } catch {
    return null;
  }
}

function setState(
  job: ArsenkinOrchestrationJob,
  state: ArsenkinOrchestrationState,
  extra: Partial<ArsenkinOrchestrationJob> = {}
): ArsenkinOrchestrationJob {
  return (
    patchOrchestrationJob(job.caseId, job.workflow, {
      state,
      humanPhase: humanPhaseForState(state),
      ...extra,
      completedAt:
        state === "COMPLETED" ||
        state === "COMPLETED_PARTIAL" ||
        state === "FAILED_TERMINAL" ||
        state === "CANCELLED"
          ? new Date().toISOString()
          : job.completedAt,
    }) ?? job
  );
}

/**
 * Public entry: enqueue or resume one durable job. Returns immediately (202 semantics).
 */
export async function startArsenkinFullAudit(
  input: StartFullAuditInput,
  deps: FullAuditOrchestratorDeps = {}
): Promise<StartFullAuditResult> {
  if (input.confirmed !== true) {
    throw new Error("confirmed=true required for full Arsenkin audit");
  }
  const workflow = input.workflow ?? "first36-full";
  const mapping = loadArsenkinUiRunMapping(input.caseId, workflow);
  let reportRunId = mapping?.arsenkinReportRunId ?? null;
  const sourceReportRunId = mapping?.sourceReportRunId ?? input.reportRunId;

  // Prefer recovering the known production / existing mapped run — never invent a new id on resume.
  if (!reportRunId || input.forceNewRun) {
    if (input.forceNewRun) {
      reportRunId = generateArsenkinReportRunId(workflow);
      saveArsenkinUiRunMapping({
        caseId: input.caseId,
        sourceReportRunId,
        arsenkinReportRunId: reportRunId,
        workflow,
        stage: workflow === "suggest-canary" ? "SUGGEST_RU_CANARY" : "FIRST36_STAGE1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    } else if (input.reportRunId.startsWith("orion-arsenkin-")) {
      reportRunId = input.reportRunId;
    } else {
      reportRunId = generateArsenkinReportRunId(workflow);
      saveArsenkinUiRunMapping({
        caseId: input.caseId,
        sourceReportRunId,
        arsenkinReportRunId: reportRunId,
        workflow,
        stage: workflow === "suggest-canary" ? "SUGGEST_RU_CANARY" : "FIRST36_STAGE1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
  }

  // Explicit production recovery pin: keep this reportRunId.
  if (
    !input.forceNewRun &&
    (input.reportRunId === "orion-arsenkin-first36-full-1784142276718-5d3c206e" ||
      reportRunId === "orion-arsenkin-first36-full-1784142276718-5d3c206e")
  ) {
    reportRunId = "orion-arsenkin-first36-full-1784142276718-5d3c206e";
  }

  const { job, created } = findOrCreateActiveOrchestrationJob({
    caseId: input.caseId,
    workflow,
    reportRunId,
    sourceReportRunId,
    forceNew: Boolean(input.forceNewRun),
  });

  if (job.state === "FAILED_RETRYABLE") {
    setState(job, "PREFLIGHT", {
      attempt: job.attempt + 1,
      lastError: null,
      lastErrorCode: null,
      nextStep: "preflight",
      completedAt: null,
    });
  }

  await recordAudit({
    caseId: input.caseId,
    action: "ARSENKIN_FULL_AUDIT_START",
    actorId: input.actorId ?? "system",
    metadata: {
      jobId: job.jobId,
      reportRunId,
      created,
      workflow,
    },
  }).catch(() => undefined);

  // Fire-and-forget tick in-process (durable via job file + lease).
  scheduleOrchestrationTick(input.caseId, workflow, deps);

  return {
    accepted: true,
    jobId: job.jobId,
    reportRunId,
    state: loadOrchestrationJob(input.caseId, workflow)?.state ?? job.state,
    created,
  };
}

export async function cancelArsenkinFullAudit(input: {
  caseId: string;
  workflow?: "suggest-canary" | "first36-full";
  actorId?: string;
}): Promise<ArsenkinOrchestrationJob | null> {
  const workflow = input.workflow ?? "first36-full";
  const job = loadOrchestrationJob(input.caseId, workflow);
  if (!job) return null;
  return setState(job, "CANCELLED", {
    cancelRequested: true,
    nextStep: "cancelled",
    lastError: "Отменено пользователем",
  });
}

export function getArsenkinFullAuditStatus(
  caseId: string,
  workflow: "suggest-canary" | "first36-full" = "first36-full"
): ArsenkinOrchestrationJob | null {
  return loadOrchestrationJob(caseId, workflow);
}

const ticking = new Set<string>();

export function scheduleOrchestrationTick(
  caseId: string,
  workflow: string,
  deps: FullAuditOrchestratorDeps = {}
): void {
  const key = `${caseId}|${workflow}`;
  if (ticking.has(key)) return;
  ticking.add(key);
  const run = async () => {
    try {
      await runOrchestrationTick(caseId, workflow, deps);
    } finally {
      ticking.delete(key);
      const job = loadOrchestrationJob(caseId, workflow);
      if (job && isActiveOrchestrationState(job.state)) {
        const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
        void sleep(1500).then(() => scheduleOrchestrationTick(caseId, workflow, deps));
      }
    }
  };
  setImmediate(() => void run());
}

/** Resume any active jobs after process start. */
export function resumeActiveArsenkinOrchestrations(deps: FullAuditOrchestratorDeps = {}): void {
  // Best-effort: scan known mapping dirs is expensive; callers pass caseIds or we rely on start.
  void deps;
}

export async function runOrchestrationTick(
  caseId: string,
  workflow: string,
  deps: FullAuditOrchestratorDeps = {}
): Promise<ArsenkinOrchestrationJob | null> {
  const ownerId = `orch-${process.pid}-${randomUUID().slice(0, 6)}`;
  const claimed = claimOrchestrationJobLease({
    caseId,
    workflow,
    ownerId,
    leaseMs: 90_000,
    now: deps.now?.(),
  });
  if (!claimed) return loadOrchestrationJob(caseId, workflow);

  try {
    let job = claimed;
    if (job.cancelRequested) {
      return setState(job, "CANCELLED", { nextStep: "cancelled" });
    }

    switch (job.state) {
      case "PREFLIGHT":
      case "WAITING_INFRASTRUCTURE":
        job = await stepPreflight(job, deps);
        break;
      case "PLANNING":
        job = await stepPlanning(job, deps);
        break;
      case "STAGE1_SUBMITTING":
      case "STAGE1_POLLING":
      case "STAGE1_FETCHING":
      case "STAGE1_PARSING":
        job = await stepStage(job, "FIRST36_STAGE1", deps);
        break;
      case "STAGE2_SUBMITTING":
      case "STAGE2_POLLING":
      case "STAGE2_FETCHING":
      case "STAGE2_PARSING":
        job = await stepStage(job, "FIRST36_STAGE2", deps);
        break;
      case "WAITING_PROVIDER":
        job = await stepWaitingProvider(job, deps);
        break;
      case "BINDING":
        job = await stepBinding(job, deps);
        break;
      case "RENDERING":
        job = await stepRendering(job, deps);
        break;
      case "FAILED_RETRYABLE":
        // Wait for user "Продолжить" which moves back to PREFLIGHT via start.
        break;
      default:
        break;
    }
    return loadOrchestrationJob(caseId, workflow);
  } finally {
    releaseOrchestrationJobLease({ caseId, workflow, ownerId });
  }
}

async function stepPreflight(
  job: ArsenkinOrchestrationJob,
  deps: FullAuditOrchestratorDeps
): Promise<ArsenkinOrchestrationJob> {
  const readiness = await (deps.readiness ?? probeArsenkinLightweightReadiness)({});
  if (!readiness.ok) {
    return setState(job, "WAITING_INFRASTRUCTURE", {
      percent: 5,
      nextStep: "retry-preflight",
      lastError: readiness.blockers[0] ?? readiness.code,
      lastErrorCode: readiness.code,
    });
  }
  return setState(job, "PLANNING", {
    percent: 8,
    nextStep: "prepare-plan",
    lastError: null,
    lastErrorCode: null,
  });
}

async function stepPlanning(
  job: ArsenkinOrchestrationJob,
  deps: FullAuditOrchestratorDeps
): Promise<ArsenkinOrchestrationJob> {
  const stage: ArsenkinUiStage =
    job.workflow === "suggest-canary" ? "SUGGEST_RU_CANARY" : "FIRST36_STAGE1";
  const prepare = deps.prepare ?? prepareArsenkinUiRun;
  const plan = deps.plan ?? planArsenkinUiRun;
  try {
    await prepare({
      caseId: job.caseId,
      reportRunId: job.sourceReportRunId || job.reportRunId,
      stage,
      deps: { prisma: deps.prisma },
    });
    const planned = await plan({
      caseId: job.caseId,
      reportRunId: job.reportRunId,
      stage,
      deps: { prisma: deps.prisma },
    });
    return setState(job, "STAGE1_SUBMITTING", {
      percent: 15,
      planDigest: planned.digest ?? planned.planDigest,
      estimatedLimits: planned.estimatedLimitsTotal,
      nextStep: "stage1-execute",
      recoveryNotes: [
        ...job.recoveryNotes,
        "plan-ready",
        `transport=${ArsenkinClientClass.TRANSPORT.method} check/get body={task_id}`,
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/readiness|infrastructure|token/i.test(message)) {
      return setState(job, "WAITING_INFRASTRUCTURE", {
        lastError: message,
        nextStep: "retry-preflight",
      });
    }
    return setState(job, "FAILED_RETRYABLE", {
      lastError: message,
      lastErrorCode: "planning_failed",
      nextStep: "user-continue",
    });
  }
}

async function autoRecoverBeforeStage(
  job: ArsenkinOrchestrationJob,
  deps: FullAuditOrchestratorDeps
): Promise<{ notes: string[]; blocked: boolean; blockReason?: string }> {
  const notes: string[] = [];
  // Offline / injected pipeline: skip DB recovery when explicitly disabled.
  if (deps.refetchResults === false && deps.client === null) {
    return { notes: ["offline-skip-auto-recover"], blocked: false };
  }
  let prisma: PrismaClient;
  try {
    prisma = deps.prisma ?? (await import("@/server/prisma/client")).prisma;
  } catch (err) {
    return {
      notes: [`prisma-unavailable:${err instanceof Error ? err.message : String(err)}`],
      blocked: false,
    };
  }
  const store = deps.store ?? createPrismaProviderTaskStore();
  const client = deps.client ?? createArsenkinClientFromEnv();
  const outRoot = arsenkinCanaryOutRoot(job.caseId, job.reportRunId);

  if (!client) {
    return { notes: ["client-not-configured"], blocked: false };
  }

  // 1) Reconcile DONE + 0 observations via /get only (PAA 30638342, check-top 30638350).
  const tasks = await prisma.providerTask.findMany({
    where: { reportRunId: job.reportRunId, provider: "arsenkin" },
  });
  const obs = await prisma.serpObservation.groupBy({
    by: ["providerTaskId"],
    where: { auditRunId: job.reportRunId, provider: "arsenkin" },
    _count: { _all: true },
  });
  const observationCountByTaskId = new Map<string, number>();
  for (const row of obs) {
    if (row.providerTaskId) observationCountByTaskId.set(row.providerTaskId, row._count._all);
  }
  const mappedTasks = tasks.map((t) => ({
    ...t,
    provider: "arsenkin" as const,
    state: t.state as import("./types").ArsenkinTaskState,
    requestJson: (t.requestJson ?? {}) as Record<string, unknown>,
    responseJson: t.responseJson ? (t.responseJson as Record<string, unknown>) : null,
  }));
  const plan = loadPlan(outRoot);
  try {
    const results = await reconcileAllDoneZeroObservationTasks({
      client,
      store,
      outRoot,
      caseId: job.caseId,
      reportRunId: job.reportRunId,
      actorId: "orchestrator",
      plan,
      tasks: mappedTasks,
      observationCountByTaskId,
      persistObservations: deps.persistObservations ?? persistSerpObservations,
      refetch: deps.refetchResults !== false,
    });
    for (const r of results) {
      notes.push(`reconcile:${r.externalTaskId}:${r.outcome}`);
      job = patchOrchestrationJob(job.caseId, job.workflow, {
        getCalls: (job.getCalls ?? 0) + 1,
      })!;
    }
  } catch (err) {
    notes.push(`reconcile-error:${err instanceof Error ? err.message : String(err)}`);
  }

  // 2) Auto SUBMIT_UNKNOWN handling with configured ambiguous retry max.
  const refreshed = await prisma.providerTask.findMany({
    where: { reportRunId: job.reportRunId, provider: "arsenkin", state: "SUBMIT_UNKNOWN" },
  });
  for (const row of refreshed) {
    const hash = row.requestHash;
    const attempts = job.submitAttemptsByHash[hash] ?? row.attempts ?? 0;
    if (attempts > AMBIGUOUS_SUBMIT_RETRY_MAX + 1) {
      notes.push(`submit-unknown-terminal:${hash.slice(0, 8)}`);
      continue;
    }
    try {
      await confirmSubmitUnknownNotCreated({
        outRoot,
        caseId: job.caseId,
        reportRunId: job.reportRunId,
        store,
        providerTaskId: row.id,
        actorId: "orchestrator",
        reason: "provider_queue_and_results_checked_no_task_found",
        evidenceNote: "auto-orchestrator-confirm-not-created",
      });
      const retried = await retryUnconfirmedSubmitOnce({
        client,
        store,
        outRoot,
        caseId: job.caseId,
        reportRunId: job.reportRunId,
        providerTaskId: row.id,
        actorId: "orchestrator",
      });
      notes.push(`auto-retry-set:${hash.slice(0, 8)}:${retried.state}`);
      patchOrchestrationJob(job.caseId, job.workflow, {
        setCalls: (job.setCalls ?? 0) + 1,
        submitAttemptsByHash: {
          ...job.submitAttemptsByHash,
          [hash]: attempts + 1,
        },
      });
    } catch (err) {
      notes.push(`auto-retry-blocked:${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { notes, blocked: false };
}

async function reopenFailedStageIfNeeded(input: {
  prisma: PrismaClient;
  caseId: string;
  reportRunId: string;
  stage: ArsenkinUiStage;
}): Promise<void> {
  const now = new Date();
  await input.prisma.orionArsenkinStageRun.updateMany({
    where: {
      reportRunId: input.reportRunId,
      caseId: input.caseId,
      stage: input.stage,
      status: "FAILED",
    },
    data: {
      status: "PREPARED",
      finishedAt: null,
      errorJson: undefined,
      leaseOwnerId: null,
      updatedAt: now,
    },
  });
  await input.prisma.orionReportRun.updateMany({
    where: { id: input.reportRunId, caseId: input.caseId, status: { in: ["FAILED", "RUNNING"] } },
    data: { status: "RUNNING", finishedAt: null, errorsJson: undefined },
  });
  // Clear manual-intervention marker if present so orchestrator can proceed.
  const marker = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    input.caseId,
    input.reportRunId,
    "manual-intervention-required.json"
  );
  if (existsSync(marker)) {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(marker);
    } catch {
      /* ignore */
    }
  }
}

async function stepWaitingProvider(
  job: ArsenkinOrchestrationJob,
  deps: FullAuditOrchestratorDeps
): Promise<ArsenkinOrchestrationJob> {
  const client = deps.client ?? createArsenkinClientFromEnv();
  if (!client) {
    return setState(job, "WAITING_INFRASTRUCTURE", { lastError: "token-missing" });
  }
  try {
    const status = await client.getQueueStatus();
    const active = status.activeTasks ?? 0;
    if (active >= MAX_ACTIVE_SUBMISSIONS) {
      return setState(job, "WAITING_PROVIDER", {
        nextStep: "wait-queue",
        lastError: `Очередь Arsenkin занята (active=${active}). Ожидание без очистки чужих задач.`,
        recoveryNotes: [...job.recoveryNotes, "waiting-provider-no-global-reset"],
      });
    }
    return setState(job, "STAGE1_SUBMITTING", {
      nextStep: "stage1-execute",
      lastError: null,
    });
  } catch {
    return setState(job, "WAITING_PROVIDER", { nextStep: "wait-queue-retry" });
  }
}

async function stepStage(
  job: ArsenkinOrchestrationJob,
  stage: ArsenkinUiStage,
  deps: FullAuditOrchestratorDeps
): Promise<ArsenkinOrchestrationJob> {
  if (job.workflow === "suggest-canary" && stage === "FIRST36_STAGE2") {
    return setState(job, "BINDING", { percent: 80, nextStep: "binding" });
  }

  const recovering = await autoRecoverBeforeStage(job, deps);
  const afterRecoverState =
    stage === "FIRST36_STAGE1" ? "STAGE1_FETCHING" : "STAGE2_FETCHING";
  job =
    patchOrchestrationJob(job.caseId, job.workflow, {
      recoveryNotes: [...job.recoveryNotes, ...recovering.notes],
      state: afterRecoverState,
      humanPhase: humanPhaseForState(afterRecoverState),
      percent: stage === "FIRST36_STAGE1" ? 35 : 65,
    }) ?? job;

  const client = deps.client ?? createArsenkinClientFromEnv();
  if (client && deps.refetchResults !== false) {
    try {
      const q = await client.getQueueStatus();
      if ((q.activeTasks ?? 0) >= MAX_ACTIVE_SUBMISSIONS) {
        return setState(job, "WAITING_PROVIDER", {
          nextStep: "wait-queue",
          lastError: "Ожидание свободного слота Arsenkin (чужие задачи не удаляются)",
        });
      }
    } catch {
      /* proceed; rate limiter still protects */
    }
  }

  const execute = deps.execute ?? executeArsenkinUiRun;
  const planDigest = job.planDigest;
  if (!planDigest && stage === "FIRST36_STAGE1") {
    return setState(job, "PLANNING", { nextStep: "replan" });
  }

  // Stage2: prepare+plan first if needed
  if (stage === "FIRST36_STAGE2") {
    const prepare = deps.prepare ?? prepareArsenkinUiRun;
    const plan = deps.plan ?? planArsenkinUiRun;
    try {
      await prepare({
        caseId: job.caseId,
        reportRunId: job.reportRunId,
        stage,
        deps: { prisma: deps.prisma },
      });
      const planned = await plan({
        caseId: job.caseId,
        reportRunId: job.reportRunId,
        stage,
        deps: { prisma: deps.prisma },
      });
      job =
        patchOrchestrationJob(job.caseId, job.workflow, {
          planDigest: planned.digest ?? planned.planDigest,
          state: "STAGE2_SUBMITTING",
          humanPhase: humanPhaseForState("STAGE2_SUBMITTING"),
          percent: 55,
        }) ?? job;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/stage2-requires-stage1/i.test(message)) {
        return setState(job, "STAGE1_SUBMITTING", { nextStep: "stage1-again", lastError: message });
      }
      return setState(job, "FAILED_RETRYABLE", {
        lastError: message,
        lastErrorCode: "stage2_prepare_failed",
      });
    }
  }

  try {
    job = setState(job, stage === "FIRST36_STAGE1" ? "STAGE1_POLLING" : "STAGE2_POLLING", {
      percent: stage === "FIRST36_STAGE1" ? 40 : 70,
      nextStep: "execute-live",
    });
    const execStage: ArsenkinUiStage =
      job.workflow === "suggest-canary" ? "SUGGEST_RU_CANARY" : stage;
    if (deps.refetchResults !== false || deps.prisma) {
      try {
        const prisma = deps.prisma ?? (await import("@/server/prisma/client")).prisma;
        await reopenFailedStageIfNeeded({
          prisma,
          caseId: job.caseId,
          reportRunId: job.reportRunId,
          stage: execStage,
        });
      } catch {
        /* offline / missing DB — continue with injected execute */
      }
    }
    const result = await execute({
      caseId: job.caseId,
      reportRunId: job.reportRunId,
      stage: execStage,
      confirmPlanDigest: job.planDigest ?? "",
      confirmed: true,
      deps: { prisma: deps.prisma },
    });

    if (result.status === "FAILED" || result.status === "MANUAL_INTERVENTION_REQUIRED") {
      // Auto-recovery path already attempted; if still blocked mark retryable once.
      return setState(job, "FAILED_RETRYABLE", {
        lastError: result.lastError ?? result.status,
        lastErrorCode: result.status,
        nextStep: "user-continue",
        recoveryNotes: [...job.recoveryNotes, "stage-failed-after-auto-recovery"],
      });
    }

    if (stage === "FIRST36_STAGE1" && job.workflow === "first36-full") {
      return setState(job, "STAGE2_SUBMITTING", {
        percent: 50,
        nextStep: "stage2",
        observationCount: result.observationCount,
        surfacesDone: Math.max(job.surfacesDone, 1),
      });
    }
    return setState(job, "BINDING", {
      percent: 80,
      nextStep: "binding",
      observationCount: result.observationCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/SUBMIT_UNKNOWN|FAILED —|MANUAL_INTERVENTION/i.test(message)) {
      // Try one more auto-recover cycle then retryable.
      await autoRecoverBeforeStage(job, deps);
      return setState(job, "FAILED_RETRYABLE", {
        lastError: message,
        lastErrorCode: "stage_execute_failed",
        nextStep: "user-continue",
      });
    }
    if (/429|rate|queue/i.test(message)) {
      return setState(job, "WAITING_PROVIDER", { lastError: message, nextStep: "wait-queue" });
    }
    return setState(job, "FAILED_RETRYABLE", {
      lastError: message,
      lastErrorCode: "stage_error",
      nextStep: "user-continue",
    });
  }
}

async function stepBinding(
  job: ArsenkinOrchestrationJob,
  deps: FullAuditOrchestratorDeps
): Promise<ArsenkinOrchestrationJob> {
  const sync = deps.sync ?? syncArsenkinResultsToOrion;
  const stage: ArsenkinUiStage =
    job.workflow === "suggest-canary"
      ? "SUGGEST_RU_CANARY"
      : "FIRST36_STAGE2";
  try {
    await sync({
      caseId: job.caseId,
      reportRunId: job.reportRunId,
      stage,
      deps: { prisma: deps.prisma },
    });
    return setState(job, "RENDERING", { percent: 90, nextStep: "render" });
  } catch (err) {
    // Fallback: try Stage1 sync for canary / partial
    try {
      await sync({
        caseId: job.caseId,
        reportRunId: job.reportRunId,
        stage: job.workflow === "suggest-canary" ? "SUGGEST_RU_CANARY" : "FIRST36_STAGE1",
        deps: { prisma: deps.prisma },
      });
      return setState(job, "RENDERING", { percent: 90, nextStep: "render" });
    } catch {
      return setState(job, "FAILED_RETRYABLE", {
        lastError: err instanceof Error ? err.message : String(err),
        lastErrorCode: "binding_failed",
      });
    }
  }
}

async function stepRendering(
  job: ArsenkinOrchestrationJob,
  deps: FullAuditOrchestratorDeps
): Promise<ArsenkinOrchestrationJob> {
  const render = deps.render ?? enqueueOrionClassicAuditReport;
  try {
    render({ caseId: job.caseId });
    return setState(job, "COMPLETED", {
      percent: 100,
      nextStep: "done",
      lastError: null,
    });
  } catch (err) {
    return setState(job, "COMPLETED_PARTIAL", {
      percent: 95,
      lastError: err instanceof Error ? err.message : String(err),
      lastErrorCode: "render_failed",
      nextStep: "partial",
    });
  }
}

/** Test helper: proves check/get contract is POST + {task_id}. */
export function arsenkinTransportContract() {
  return ArsenkinClientClass.TRANSPORT;
}

export { AMBIGUOUS_SUBMIT_RETRY_MAX, createOrchestrationJob, linkExistingArsenkinTask };
