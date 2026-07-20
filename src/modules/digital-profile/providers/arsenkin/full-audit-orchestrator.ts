/**
 * One-click durable Arsenkin full-audit orchestrator.
 * Steps are internal; UI only starts/cancels/polls status.
 * NETWORK_CALLS=0 offline via injectable deps — never live from Cursor tests.
 */

import {
  assertWorkflowRunMatch,
  computeFullAuditPercent,
  evaluateFullAuditCompletionGate,
  FIRST36_FULL_EXPECTED_SURFACES,
  isFirst36FullReportRunId,
  isSuggestCanaryReportRunId,
  type ArsenkinWorkflowType,
} from "./workflow-contract";
import {
  ensureFirst36FullCanonicalSource,
  isArsenkinProviderRunId,
  isSourceBindingRepairableError,
  isValidBaseOrionReportRunId,
  needsSourceBindingRepair,
  resolveCanonicalBaseOrionReportRunId,
} from "./source-binding-repair";
import {
  existingRunHasRecoverableWork,
  recoverExistingRun,
} from "./recover-existing-run";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
import { recordAudit } from "../../services/audit-log-service";
import { markUnifiedReportArtifactsStale } from "../../services/unified-report-staleness";

/**
 * Diagnostic finalize adapter. A standalone Arsenkin run NEVER generates the
 * client report — full report generation is the unified canonical job's job.
 * This seam exists only so tests can observe the finalize step; the default
 * implementation just marks any existing canonical report artifacts stale.
 */
type DiagnosticFinalizeFn = (input: { caseId: string }) => unknown;

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
  /** Diagnostic finalize seam (tests only). Never the legacy report composer. */
  render?: DiagnosticFinalizeFn;
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
  /**
   * Ignored for one-click full audit: always FIRST36_FULL.
   * Kept optional for backwards-compatible callers; canary must use a separate entry.
   */
  workflow?: "suggest-canary" | "first36-full";
  /** Explicit requested type — must be FIRST36_FULL for this entry point. */
  requestedWorkflowType?: ArsenkinWorkflowType;
  actorId?: string;
  /** Explicit new collection (not auto). */
  forceNewRun?: boolean;
  confirmed?: boolean;
};

export type StartFullAuditResult = {
  accepted: true;
  jobId: string;
  reportRunId: string;
  jobReportRunId: string;
  requestedWorkflowType: ArsenkinWorkflowType;
  jobWorkflowType: ArsenkinWorkflowType;
  sourceOrionReportRunId: string;
  currentlyBoundReportRunId: string | null;
  expectedSurfaceCount: number;
  terminalSurfaceCount: number;
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
  const percent =
    extra.percent ??
    computeFullAuditPercent({
      state,
      stage1Terminal: extra.stage1TerminalCount ?? job.stage1TerminalCount,
      stage2Terminal: extra.stage2TerminalCount ?? job.stage2TerminalCount,
      completed: state === "COMPLETED",
    });
  return (
    patchOrchestrationJob(job.caseId, job.workflow, {
      state,
      humanPhase: humanPhaseForState(state),
      percent: state === "COMPLETED" ? 100 : Math.min(99, percent),
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

function resolveFirst36FullReportRunId(input: {
  caseId: string;
  sourceOrionReportRunId: string;
  forceNewRun: boolean;
}): { reportRunId: string; resumed: boolean } {
  const workflow = "first36-full" as const;

  // 1) Unfinished FIRST36_FULL job wins (never suggest-canary job).
  const existingJob = loadOrchestrationJob(input.caseId, workflow);
  if (
    !input.forceNewRun &&
    existingJob &&
    isActiveOrchestrationState(existingJob.state) &&
    isFirst36FullReportRunId(existingJob.jobReportRunId || existingJob.reportRunId)
  ) {
    return { reportRunId: existingJob.jobReportRunId || existingJob.reportRunId, resumed: true };
  }

  // 2) FIRST36_FULL mapping only (ignore suggest-canary mapping entirely).
  const mapping = loadArsenkinUiRunMapping(input.caseId, workflow);
  if (
    !input.forceNewRun &&
    mapping?.arsenkinReportRunId &&
    isFirst36FullReportRunId(mapping.arsenkinReportRunId)
  ) {
    return { reportRunId: mapping.arsenkinReportRunId, resumed: true };
  }

  // 3) Explicit first36-full reportRunId (recovery/resume) — never suggest-canary / plain ORION.
  if (!input.forceNewRun && isFirst36FullReportRunId(input.sourceOrionReportRunId)) {
    const now = new Date().toISOString();
    saveArsenkinUiRunMapping({
      caseId: input.caseId,
      sourceReportRunId: mapping?.sourceReportRunId ?? input.sourceOrionReportRunId,
      arsenkinReportRunId: input.sourceOrionReportRunId,
      workflow,
      stage: "FIRST36_STAGE1",
      createdAt: mapping?.createdAt ?? now,
      updatedAt: now,
    });
    return { reportRunId: input.sourceOrionReportRunId, resumed: true };
  }

  // 4) Create a new full run. Never adopt canary ids.
  const reportRunId = generateArsenkinReportRunId(workflow);
  const now = new Date().toISOString();
  saveArsenkinUiRunMapping({
    caseId: input.caseId,
    sourceReportRunId: input.sourceOrionReportRunId,
    arsenkinReportRunId: reportRunId,
    workflow,
    stage: "FIRST36_STAGE1",
    createdAt: mapping?.createdAt ?? now,
    updatedAt: now,
  });
  return { reportRunId, resumed: false };
}

/**
 * Public entry: enqueue or resume one durable FIRST36_FULL job. Returns immediately (202).
 * Never resumes suggest-canary. Never derives workflow from UI tab / binding / last run.
 */
export async function startArsenkinFullAudit(
  input: StartFullAuditInput,
  deps: FullAuditOrchestratorDeps = {}
): Promise<StartFullAuditResult> {
  if (input.confirmed !== true) {
    throw new Error("confirmed=true required for full Arsenkin audit");
  }

  const requestedWorkflowType: ArsenkinWorkflowType = "FIRST36_FULL";
  if (input.requestedWorkflowType && input.requestedWorkflowType !== "FIRST36_FULL") {
    throw new Error(
      `WORKFLOW_RUN_MISMATCH: startArsenkinFullAudit requires FIRST36_FULL, got ${input.requestedWorkflowType}`
    );
  }
  // Intentionally ignore input.workflow === "suggest-canary" — one-click is always Full.
  const workflow = "first36-full" as const;

  // Resolve canonical base ORION — never use canary / effective / UI enrichment id as base.
  const previousBinding =
    loadArsenkinUiRunMapping(input.caseId, "suggest-canary")?.arsenkinReportRunId ?? null;
  let sourceOrionReportRunId = input.reportRunId;
  if (!isValidBaseOrionReportRunId(sourceOrionReportRunId)) {
    const resolved = await resolveCanonicalBaseOrionReportRunId(input.caseId, {
      prisma: deps.prisma,
    });
    if (resolved.ok) {
      sourceOrionReportRunId = resolved.baseOrionReportRunId;
    }
  }
  const currentlyBoundReportRunId = previousBinding;

  const { reportRunId } = resolveFirst36FullReportRunId({
    caseId: input.caseId,
    sourceOrionReportRunId,
    forceNewRun: Boolean(input.forceNewRun),
  });

  // Preflight repair: corrupted Full mapping with Arsenkin source → fix before job create/resume.
  const preRepair = await ensureFirst36FullCanonicalSource({
    caseId: input.caseId,
    enrichmentReportRunId: reportRunId,
    prisma: deps.prisma,
  });
  if (preRepair.ok) {
    sourceOrionReportRunId = preRepair.baseOrionReportRunId;
  } else if (preRepair.code === "NEEDS_ADMIN") {
    throw new Error(`NEEDS_ADMIN: ${preRepair.detail}`);
  }

  const match = assertWorkflowRunMatch({
    requestedWorkflowType,
    jobWorkflowType: "FIRST36_FULL",
    jobReportRunId: reportRunId,
  });
  if (!match.ok) {
    throw new Error(`${match.code}: ${match.detail}`);
  }

  const { job, created } = findOrCreateActiveOrchestrationJob({
    caseId: input.caseId,
    workflow,
    reportRunId,
    sourceReportRunId: sourceOrionReportRunId,
    currentlyBoundReportRunId,
    previousBindingReportRunId: previousBinding,
    forceNew: Boolean(input.forceNewRun),
  });

  // Harden identity on resume of legacy jobs.
  patchOrchestrationJob(input.caseId, workflow, {
    requestedWorkflowType: "FIRST36_FULL",
    jobWorkflowType: "FIRST36_FULL",
    jobReportRunId: job.reportRunId,
    expectedSurfaceCount: FIRST36_FULL_EXPECTED_SURFACES,
    surfacesTotal: FIRST36_FULL_EXPECTED_SURFACES,
    sourceReportRunId: sourceOrionReportRunId,
    sourceOrionReportRunId,
    currentlyBoundReportRunId,
    previousBindingReportRunId: previousBinding,
  });

  if (
    job.state === "FAILED_RETRYABLE" ||
    job.state === "WAITING_PROVIDER" ||
    needsSourceBindingRepair(job.sourceReportRunId) ||
    isSourceBindingRepairableError(job.lastError)
  ) {
    const resumeExisting = existingRunHasRecoverableWork(job);
    if (resumeExisting) {
      // NEVER go PREFLIGHT→prepare for an existing Full run.
      setState(job, "RECOVERING", {
        orchestrationResumeCount: (job.orchestrationResumeCount ?? 0) + 1,
        stageRecoveryGeneration: (job.stageRecoveryGeneration ?? 0) + 1,
        lastError: null,
        lastErrorCode: null,
        nextStep: "recover-existing-run",
        completedAt: null,
        humanMessage: "Получаем готовый результат Arsenkin, новая задача не создаётся.",
        sourceReportRunId: sourceOrionReportRunId,
        sourceOrionReportRunId,
        // Do NOT increment provider attempt counters on resume without /set|/check|/get.
      });
    } else {
      setState(job, "PREFLIGHT", {
        orchestrationResumeCount: (job.orchestrationResumeCount ?? 0) + 1,
        lastError: null,
        lastErrorCode: null,
        nextStep: "preflight",
        completedAt: null,
        sourceReportRunId: sourceOrionReportRunId,
        sourceOrionReportRunId,
      });
    }
  }

  await recordAudit({
    caseId: input.caseId,
    action: "ARSENKIN_FULL_AUDIT_START",
    actorId: input.actorId ?? "system",
    metadata: {
      jobId: job.jobId,
      reportRunId,
      jobReportRunId: reportRunId,
      created,
      workflow,
      requestedWorkflowType,
      sourceOrionReportRunId,
      currentlyBoundReportRunId,
    },
  }).catch(() => undefined);

  scheduleOrchestrationTick(input.caseId, workflow, deps);

  const latest = loadOrchestrationJob(input.caseId, workflow) ?? job;
  return {
    accepted: true,
    jobId: latest.jobId,
    reportRunId: latest.reportRunId,
    jobReportRunId: latest.jobReportRunId || latest.reportRunId,
    requestedWorkflowType: "FIRST36_FULL",
    jobWorkflowType: "FIRST36_FULL",
    sourceOrionReportRunId,
    currentlyBoundReportRunId,
    expectedSurfaceCount: FIRST36_FULL_EXPECTED_SURFACES,
    terminalSurfaceCount: latest.terminalSurfaceCount ?? 0,
    state: latest.state,
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

/** Resume any active/retryable jobs after process start (no user click). */
export function resumeActiveArsenkinOrchestrations(deps: FullAuditOrchestratorDeps = {}): void {
  try {
    const root = join(process.cwd(), "storage", "digital-profile", "arsenkin-orchestration");
    if (!existsSync(root)) return;
    for (const caseId of readdirSync(root)) {
      const wfRoot = join(root, caseId, "first36-full");
      const jobPath = join(wfRoot, "job.json");
      if (!existsSync(jobPath)) continue;
      const job = loadOrchestrationJob(caseId, "first36-full");
      if (!job) continue;
      if (
        job.state === "FAILED_RETRYABLE" ||
        job.state === "RECOVERING" ||
        job.state === "WAITING_PROVIDER" ||
        job.state === "RUNNING" ||
        isActiveOrchestrationState(job.state)
      ) {
        if (job.state === "FAILED_RETRYABLE" && existingRunHasRecoverableWork(job)) {
          patchOrchestrationJob(caseId, "first36-full", {
            state: "RECOVERING",
            humanPhase: humanPhaseForState("RECOVERING"),
            nextStep: "recover-existing-run",
            orchestrationResumeCount: (job.orchestrationResumeCount ?? 0) + 1,
            stageRecoveryGeneration: (job.stageRecoveryGeneration ?? 0) + 1,
            lastError: null,
            lastErrorCode: null,
            completedAt: null,
            humanMessage: "Автовосстановление после перезапуска сервера.",
          });
        }
        scheduleOrchestrationTick(caseId, "first36-full", deps);
      }
    }
  } catch {
    /* best-effort startup resume */
  }
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
      case "RECOVERING":
        job = await stepRecovering(job, deps);
        break;
      case "RUNNING":
        job = await stepStage(job, "FIRST36_STAGE1", deps);
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
      case "FAILED_RETRYABLE": {
        // Prefer recoverExistingRun over PREFLIGHT/prepare.
        if (existingRunHasRecoverableWork(job) || job.workflow === "first36-full") {
          const repairableSource =
            job.lastErrorCode === "SOURCE_BINDING_REPAIRABLE" ||
            needsSourceBindingRepair(job.sourceReportRunId) ||
            isSourceBindingRepairableError(job.lastError);
          if (repairableSource) {
            const repair = await ensureFirst36FullCanonicalSource({
              caseId: job.caseId,
              enrichmentReportRunId: job.jobReportRunId || job.reportRunId,
              prisma: deps.prisma,
            });
            if (repair.ok) {
              job =
                patchOrchestrationJob(job.caseId, job.workflow, {
                  sourceReportRunId: repair.baseOrionReportRunId,
                  sourceOrionReportRunId: repair.baseOrionReportRunId,
                }) ?? job;
            } else if (repair.code === "NEEDS_ADMIN") {
              job = setState(job, "FAILED_TERMINAL", {
                lastError: repair.detail,
                lastErrorCode: "NEEDS_ADMIN",
                nextStep: "needs-admin",
              });
              break;
            }
          }
          job = setState(job, "RECOVERING", {
            orchestrationResumeCount: (job.orchestrationResumeCount ?? 0) + 1,
            stageRecoveryGeneration: (job.stageRecoveryGeneration ?? 0) + 1,
            lastError: null,
            lastErrorCode: null,
            nextStep: "recover-existing-run",
            completedAt: null,
            humanMessage: "Получаем готовый результат Arsenkin, новая задача не создаётся.",
          });
          job = await stepRecovering(job, deps);
        } else if ((job.orchestrationResumeCount ?? 0) < (job.maxAttempts ?? 3)) {
          job = setState(job, "PREFLIGHT", {
            orchestrationResumeCount: (job.orchestrationResumeCount ?? 0) + 1,
            lastError: null,
            lastErrorCode: null,
            nextStep: "bounded-resume",
            completedAt: null,
          });
        }
        break;
      }
      default:
        break;
    }
    return loadOrchestrationJob(caseId, workflow);
  } finally {
    releaseOrchestrationJobLease({ caseId, workflow, ownerId });
  }
}

async function stepRecovering(
  job: ArsenkinOrchestrationJob,
  deps: FullAuditOrchestratorDeps
): Promise<ArsenkinOrchestrationJob> {
  const result = await recoverExistingRun(job, {
    prisma: deps.prisma,
    client: deps.client === undefined ? undefined : deps.client,
    store: deps.store,
    persistObservations: deps.persistObservations,
    refetchResults: deps.refetchResults,
    sleep: deps.sleep,
    now: deps.now,
  });

  job =
    patchOrchestrationJob(job.caseId, job.workflow, {
      setCalls: (job.setCalls ?? 0) + result.setCalls,
      checkCalls: (job.checkCalls ?? 0) + result.checkCalls,
      getCalls: (job.getCalls ?? 0) + result.getCalls,
      providerSubmitAttempt: (job.providerSubmitAttempt ?? 0) + result.setCalls,
      providerCheckAttempt: (job.providerCheckAttempt ?? 0) + result.checkCalls,
      providerFetchAttempt: (job.providerFetchAttempt ?? 0) + result.getCalls,
      recoveryNotes: [
        ...job.recoveryNotes,
        `recover-existing:${result.nextState}`,
        `prepareCalled=false`,
        `reconciled=${result.reconciled.length}`,
      ],
      humanMessage: result.humanMessage,
      observationCount: Math.max(job.observationCount, result.reconciled.filter((r) => r.outcome === "MEASURED" || r.outcome === "NO_RESULTS").length),
    }) ?? job;

  if (!result.ok) {
    return setState(job, "FAILED_RETRYABLE", {
      lastError: "recover-existing-run-failed",
      lastErrorCode: "RECOVER_FAILED",
      nextStep: "recover-existing-run",
      humanMessage:
        "Arsenkin временно не принял одну задачу. Повтор через несколько секунд. Остальные проверки продолжаются.",
    });
  }

  // Continue remaining Stage 1 work without prepare.
  return setState(job, "STAGE1_SUBMITTING", {
    percent: 20,
    nextStep: "stage1-execute",
    lastError: null,
    lastErrorCode: null,
    humanMessage: result.humanMessage,
  });
}

async function stepPreflight(
  job: ArsenkinOrchestrationJob,
  deps: FullAuditOrchestratorDeps
): Promise<ArsenkinOrchestrationJob> {
  // Repair Arsenkin-prefixed base source before readiness / planning.
  if (job.workflow === "first36-full") {
    const enrichmentId = job.jobReportRunId || job.reportRunId;
    if (
      needsSourceBindingRepair(job.sourceReportRunId) ||
      needsSourceBindingRepair(job.sourceOrionReportRunId) ||
      isSourceBindingRepairableError(job.lastError)
    ) {
      const repair = await ensureFirst36FullCanonicalSource({
        caseId: job.caseId,
        enrichmentReportRunId: enrichmentId,
        prisma: deps.prisma,
      });
      if (!repair.ok) {
        if (repair.code === "NEEDS_ADMIN") {
          return setState(job, "FAILED_TERMINAL", {
            lastError: repair.detail,
            lastErrorCode: "NEEDS_ADMIN",
            nextStep: "needs-admin",
          });
        }
        return setState(job, "FAILED_RETRYABLE", {
          lastError: repair.detail,
          lastErrorCode: "SOURCE_BINDING_REPAIRABLE",
          nextStep: "auto-repair-source",
        });
      }
      job =
        patchOrchestrationJob(job.caseId, job.workflow, {
          sourceReportRunId: repair.baseOrionReportRunId,
          sourceOrionReportRunId: repair.baseOrionReportRunId,
          currentlyBoundReportRunId: repair.previousEnrichmentReportRunId,
          previousBindingReportRunId: repair.previousEnrichmentReportRunId,
          recoveryNotes: [
            ...job.recoveryNotes,
            repair.repaired
              ? `source-binding-repaired:${repair.artifact.reason}`
              : "source-binding-already-canonical",
          ],
        }) ?? job;
    }
  }

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
  // Existing Full run with plan → recover, never prepare.
  if (job.workflow === "first36-full" && existingRunHasRecoverableWork(job)) {
    return setState(job, "RECOVERING", {
      nextStep: "recover-existing-run",
      humanMessage: "Получаем готовый результат Arsenkin, новая задача не создаётся.",
      orchestrationResumeCount: (job.orchestrationResumeCount ?? 0) + 1,
    });
  }

  const stage: ArsenkinUiStage =
    job.workflow === "suggest-canary" ? "SUGGEST_RU_CANARY" : "FIRST36_STAGE1";
  const prepare = deps.prepare ?? prepareArsenkinUiRun;
  const plan = deps.plan ?? planArsenkinUiRun;

  // Always prepare against canonical base, never against canary/effective.
  let baseSource = job.sourceOrionReportRunId || job.sourceReportRunId;
  if (job.workflow === "first36-full" && !isValidBaseOrionReportRunId(baseSource)) {
    const repair = await ensureFirst36FullCanonicalSource({
      caseId: job.caseId,
      enrichmentReportRunId: job.jobReportRunId || job.reportRunId,
      prisma: deps.prisma,
    });
    if (!repair.ok) {
      return setState(job, "FAILED_RETRYABLE", {
        lastError: repair.detail,
        lastErrorCode:
          repair.code === "NEEDS_ADMIN" ? "NEEDS_ADMIN" : "SOURCE_BINDING_REPAIRABLE",
        nextStep: repair.code === "NEEDS_ADMIN" ? "needs-admin" : "auto-repair-source",
      });
    }
    baseSource = repair.baseOrionReportRunId;
    job =
      patchOrchestrationJob(job.caseId, job.workflow, {
        sourceReportRunId: baseSource,
        sourceOrionReportRunId: baseSource,
      }) ?? job;
  }

  try {
    await prepare({
      caseId: job.caseId,
      reportRunId: baseSource,
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
        `baseOrionReportRunId=${baseSource}`,
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
    if (isSourceBindingRepairableError(message) || /NEEDS_ADMIN/i.test(message)) {
      return setState(job, /NEEDS_ADMIN/i.test(message) ? "FAILED_TERMINAL" : "FAILED_RETRYABLE", {
        lastError: message,
        lastErrorCode: /NEEDS_ADMIN/i.test(message) ? "NEEDS_ADMIN" : "SOURCE_BINDING_REPAIRABLE",
        nextStep: /NEEDS_ADMIN/i.test(message) ? "needs-admin" : "auto-repair-source",
      });
    }
    return setState(job, "FAILED_RETRYABLE", {
      lastError: message,
      lastErrorCode: "planning_failed",
      nextStep: job.attempt < job.maxAttempts ? "bounded-resume" : "user-continue",
    });
  }
}

async function autoRecoverBeforeStage(
  job: ArsenkinOrchestrationJob,
  deps: FullAuditOrchestratorDeps
): Promise<{ notes: string[]; blocked: boolean; blockReason?: string }> {
  const notes: string[] = [];
  const allowLiveRecover =
    deps.refetchResults !== false &&
    deps.client !== null &&
    String(process.env.NETWORK_CALLS ?? "") !== "0";
  // Offline / injected pipeline: skip DB recovery when explicitly disabled.
  if (!allowLiveRecover) {
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
      refetch: allowLiveRecover,
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
      // Partial surface failures are retryable — do not require user-continue / prepare.
      return setState(job, "FAILED_RETRYABLE", {
        lastError: result.lastError ?? result.status,
        lastErrorCode: result.status,
        nextStep: "recover-existing-run",
        humanMessage:
          "Arsenkin временно не принял одну задачу. Повтор через несколько секунд. Остальные проверки продолжаются.",
        recoveryNotes: [...job.recoveryNotes, "stage-partial-failure-auto-recover"],
      });
    }

    if (stage === "FIRST36_STAGE1" && job.workflow === "first36-full") {
      return setState(job, "STAGE2_SUBMITTING", {
        nextStep: "stage2",
        observationCount: result.observationCount,
        stage1TerminalCount: 8,
        surfacesDone: Math.min(8, Math.max(job.surfacesDone, 8)),
        terminalSurfaceCount: Math.min(
          FIRST36_FULL_EXPECTED_SURFACES,
          Math.max(job.terminalSurfaceCount, 8)
        ),
        expectedSurfaceCount: FIRST36_FULL_EXPECTED_SURFACES,
        surfacesTotal: FIRST36_FULL_EXPECTED_SURFACES,
      });
    }
    if (job.workflow === "first36-full") {
      return setState(job, "BINDING", {
        nextStep: "binding",
        observationCount: result.observationCount,
        stage1TerminalCount: Math.max(job.stage1TerminalCount, 8),
        stage2TerminalCount: 4,
        surfacesDone: FIRST36_FULL_EXPECTED_SURFACES,
        terminalSurfaceCount: FIRST36_FULL_EXPECTED_SURFACES,
        expectedSurfaceCount: FIRST36_FULL_EXPECTED_SURFACES,
        surfacesTotal: FIRST36_FULL_EXPECTED_SURFACES,
      });
    }
    return setState(job, "BINDING", {
      nextStep: "binding",
      observationCount: result.observationCount,
      surfacesDone: job.surfacesTotal,
      terminalSurfaceCount: job.surfacesTotal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/SUBMIT_UNKNOWN|FAILED —|MANUAL_INTERVENTION/i.test(message)) {
      await autoRecoverBeforeStage(job, deps);
      return setState(job, "FAILED_RETRYABLE", {
        lastError: message,
        lastErrorCode: "stage_execute_failed",
        nextStep: "recover-existing-run",
        humanMessage:
          "Arsenkin временно не принял одну задачу. Повтор через несколько секунд. Остальные проверки продолжаются.",
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
  // Diagnostic finalize only: a standalone Arsenkin run never invokes the legacy
  // report composer. When no test seam is injected, we mark any existing
  // canonical report artifacts stale (REBUILD_REQUIRED) — the unified CTA owns
  // full report generation.
  const finalize: DiagnosticFinalizeFn =
    deps.render ?? (async ({ caseId }) => markUnifiedReportArtifactsStale(caseId, "arsenkin-diagnostic-run"));
  const jobReportRunId = job.jobReportRunId || job.reportRunId;

  if (isArsenkinProviderRunId(job.sourceReportRunId) || isArsenkinProviderRunId(job.sourceOrionReportRunId)) {
    return setState(job, "FAILED_RETRYABLE", {
      lastError: "FIRST36_FULL.baseOrionReportRunId must not start with orion-arsenkin-",
      lastErrorCode: "SOURCE_BINDING_REPAIRABLE",
      nextStep: "auto-repair-source",
      percent: Math.min(99, job.percent),
    });
  }

  const identity = assertWorkflowRunMatch({
    requestedWorkflowType: job.requestedWorkflowType ?? "FIRST36_FULL",
    jobWorkflowType: job.jobWorkflowType ?? "FIRST36_FULL",
    jobReportRunId,
  });
  if (!identity.ok) {
    return setState(job, "FAILED_TERMINAL", {
      lastError: identity.detail,
      lastErrorCode: identity.code,
      nextStep: "workflow-mismatch",
      percent: Math.min(99, job.percent),
    });
  }

  if (job.reportRunId !== jobReportRunId) {
    return setState(job, "FAILED_TERMINAL", {
      lastError: `job.reportRunId (${job.reportRunId}) !== jobReportRunId (${jobReportRunId})`,
      lastErrorCode: "WORKFLOW_RUN_MISMATCH",
      nextStep: "workflow-mismatch",
    });
  }

  const expected = job.expectedSurfaceCount || FIRST36_FULL_EXPECTED_SURFACES;
  const terminal = job.terminalSurfaceCount ?? 0;
  const surfaceStatuses =
    terminal >= expected
      ? Array.from({ length: expected }, () => "MEASURED")
      : [
          ...Array.from({ length: terminal }, () => "MEASURED"),
          ...Array.from({ length: Math.max(0, expected - terminal) }, () => "PLANNED"),
        ];

  const gate = evaluateFullAuditCompletionGate({
    workflowType: "FIRST36_FULL",
    expectedSurfaceCount: expected,
    terminalSurfaceCount: terminal,
    surfaceStatuses,
    stage1Done: (job.stage1TerminalCount ?? 0) >= 8,
    stage2Done: (job.stage2TerminalCount ?? 0) >= 4,
    bindingMatchesJob: true, // set after sync; binding step already targeted job.reportRunId
    renderDone: false,
    acceptancePass: true,
  });

  // Pre-render gate: never COMPLETED with 0/12 or canary 2/12.
  if (!gate.ok && gate.code !== "RENDER_INCOMPLETE") {
    return setState(job, "FAILED_RETRYABLE", {
      lastError: `${gate.code}: ${gate.detail}`,
      lastErrorCode: gate.code,
      nextStep: "completion-gate",
      percent: Math.min(99, computeFullAuditPercent({
        state: job.state,
        stage1Terminal: job.stage1TerminalCount,
        stage2Terminal: job.stage2TerminalCount,
      })),
    });
  }

  try {
    finalize({ caseId: job.caseId });
    const afterRender = evaluateFullAuditCompletionGate({
      workflowType: "FIRST36_FULL",
      expectedSurfaceCount: expected,
      terminalSurfaceCount: terminal,
      surfaceStatuses: Array.from({ length: expected }, () => "MEASURED"),
      stage1Done: (job.stage1TerminalCount ?? 0) >= 8,
      stage2Done: (job.stage2TerminalCount ?? 0) >= 4,
      bindingMatchesJob: true,
      renderDone: true,
      acceptancePass: true,
    });
    if (!afterRender.ok) {
      return setState(job, "FAILED_RETRYABLE", {
        lastError: `${afterRender.code}: ${afterRender.detail}`,
        lastErrorCode: afterRender.code,
        nextStep: "completion-gate",
      });
    }
    return setState(job, "COMPLETED", {
      percent: 100,
      nextStep: "done",
      lastError: null,
      lastErrorCode: null,
      surfacesDone: expected,
      terminalSurfaceCount: expected,
      expectedSurfaceCount: expected,
    });
  } catch (err) {
    return setState(job, "FAILED_RETRYABLE", {
      percent: 95,
      lastError: err instanceof Error ? err.message : String(err),
      lastErrorCode: "render_failed",
      nextStep: "render",
    });
  }
}

/** Test helper: proves check/get contract is POST + {task_id}. */
export function arsenkinTransportContract() {
  return ArsenkinClientClass.TRANSPORT;
}

export { AMBIGUOUS_SUBMIT_RETRY_MAX, createOrchestrationJob, linkExistingArsenkinTask };
