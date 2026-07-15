/**
 * Arsenkin Stage-1 recovery actions for admin UI (link / confirm / retry / reconcile / continue).
 * Live network only when explicitly invoked from UI — offline tests inject mocks (NETWORK_CALLS=0).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { createArsenkinClientFromEnv, type ArsenkinClient } from "../providers/arsenkin/client";
import { createPrismaProviderTaskStore } from "../providers/arsenkin/prisma-provider-task-store";
import type { ProviderTaskStore } from "../providers/arsenkin/provider-task-store";
import {
  confirmSubmitUnknownNotCreated,
  linkExistingArsenkinTask,
  retryUnconfirmedSubmitOnce,
} from "../providers/arsenkin/submit-unknown-recovery";
import { reconcileAllDoneZeroObservationTasks } from "../providers/arsenkin/reconcile-done-zero-observations";
import { appendArsenkinRecoveryDecision } from "../providers/arsenkin/recovery-decisions";
import { persistSerpObservations } from "../serp-observation/persist";
import { recordAudit } from "./audit-log-service";
import type { ArsenkinExecutionPlan } from "../orion-golden/classic/arsenkin-execution-plan";
import {
  createProductionCanonicalStageDeps,
  executeCanonicalArsenkinStage,
} from "../orion-golden/classic/execute-canonical-arsenkin-stage";
import { getArsenkinNetworkCallCount } from "../providers/arsenkin/network-guard";
import { getDefaultReadinessArtifactPath } from "../providers/arsenkin/arsenkin-db-readiness-service";
import { ValidationError, ConflictError } from "../http/errors";
import {
  arsenkinBudgetForStage,
  arsenkinCanaryOutRoot,
  getArsenkinUiStatus,
  hasBlockingRecovery,
  resolveMappedArsenkinReportRunId,
  toPublicArsenkinUiDto,
  type ArsenkinUiStage,
  type ArsenkinUiStatusDto,
} from "./arsenkin-ui-orchestration-service";
import type { ArsenkinTaskState } from "../providers/arsenkin/types";

function loadPlan(outRoot: string): ArsenkinExecutionPlan | null {
  const path = join(outRoot, "arsenkin-live-plan.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ArsenkinExecutionPlan;
  } catch {
    return null;
  }
}

function requireClient(client?: ArsenkinClient | null): ArsenkinClient {
  const c = client ?? createArsenkinClientFromEnv();
  if (!c) throw new ValidationError("Arsenkin API не настроен на сервере");
  return c;
}

function mapReportRunId(caseId: string, reportRunId: string, stage: ArsenkinUiStage): string {
  const workflow = stage === "SUGGEST_RU_CANARY" ? "suggest-canary" : "first36-full";
  const mapped = resolveMappedArsenkinReportRunId({
    caseId,
    workflow,
    clientReportRunId: reportRunId,
    requireMapping: false,
  });
  return mapped.arsenkinReportRunId ?? reportRunId;
}

export type ArsenkinRecoveryDeps = {
  prisma?: PrismaClient;
  client?: ArsenkinClient | null;
  store?: ProviderTaskStore;
  persistObservations?: typeof persistSerpObservations;
  refetch?: boolean;
};

async function reopenFailedStageForContinue(input: {
  prisma: PrismaClient;
  caseId: string;
  reportRunId: string;
  stage: ArsenkinUiStage;
}): Promise<void> {
  const now = new Date();
  await input.prisma.$transaction(async (tx) => {
    const stageUp = await tx.orionArsenkinStageRun.updateMany({
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
    if (stageUp.count !== 1) {
      // Idempotent: already PREPARED after a prior reopen
      const current = await tx.orionArsenkinStageRun.findFirst({
        where: { reportRunId: input.reportRunId, caseId: input.caseId, stage: input.stage },
        select: { status: true },
      });
      if (String(current?.status ?? "").toUpperCase() !== "PREPARED") {
        throw new ConflictError("stage-reopen-failed: expected FAILED or PREPARED Stage row");
      }
    }
    await tx.orionReportRun.updateMany({
      where: { id: input.reportRunId, caseId: input.caseId, status: { in: ["FAILED", "RUNNING"] } },
      data: { status: "RUNNING", finishedAt: null, errorsJson: undefined },
    });
  });
}

export async function recoverLinkExistingTask(
  input: {
    caseId: string;
    reportRunId: string;
    stage: ArsenkinUiStage;
    providerTaskId: string;
    externalTaskId: string;
    actorId: string;
    evidenceNote?: string;
  },
  deps: ArsenkinRecoveryDeps = {}
): Promise<ArsenkinUiStatusDto> {
  const prisma = deps.prisma ?? (await import("@/server/prisma/client")).prisma;
  const reportRunId = mapReportRunId(input.caseId, input.reportRunId, input.stage);
  const outRoot = arsenkinCanaryOutRoot(input.caseId, reportRunId);
  const store = deps.store ?? createPrismaProviderTaskStore();
  const client = requireClient(deps.client);
  await linkExistingArsenkinTask({
    client,
    store,
    outRoot,
    caseId: input.caseId,
    reportRunId,
    providerTaskId: input.providerTaskId,
    externalTaskId: input.externalTaskId,
    actorId: input.actorId,
    evidenceNote: input.evidenceNote,
  });
  await recordAudit({
    caseId: input.caseId,
    action: "ARSENKIN_RECOVERY_LINK_EXISTING_TASK",
    actorId: input.actorId,
    metadata: {
      reportRunId,
      providerTaskId: input.providerTaskId,
      externalTaskId: input.externalTaskId,
    },
  });
  return toPublicArsenkinUiDto(
    await getArsenkinUiStatus(input.caseId, reportRunId, input.stage, { prisma })
  ) as ArsenkinUiStatusDto;
}

export async function recoverConfirmNotCreated(
  input: {
    caseId: string;
    reportRunId: string;
    stage: ArsenkinUiStage;
    providerTaskId: string;
    actorId: string;
    reason: string;
    evidenceNote?: string;
  },
  deps: ArsenkinRecoveryDeps = {}
): Promise<ArsenkinUiStatusDto> {
  const prisma = deps.prisma ?? (await import("@/server/prisma/client")).prisma;
  const reportRunId = mapReportRunId(input.caseId, input.reportRunId, input.stage);
  const outRoot = arsenkinCanaryOutRoot(input.caseId, reportRunId);
  const store = deps.store ?? createPrismaProviderTaskStore();
  await confirmSubmitUnknownNotCreated({
    outRoot,
    caseId: input.caseId,
    reportRunId,
    store,
    providerTaskId: input.providerTaskId,
    actorId: input.actorId,
    reason: input.reason,
    evidenceNote: input.evidenceNote,
  });
  await recordAudit({
    caseId: input.caseId,
    action: "ARSENKIN_RECOVERY_CONFIRM_NOT_CREATED",
    actorId: input.actorId,
    metadata: {
      reportRunId,
      providerTaskId: input.providerTaskId,
      reason: input.reason,
    },
  });
  return toPublicArsenkinUiDto(
    await getArsenkinUiStatus(input.caseId, reportRunId, input.stage, { prisma })
  ) as ArsenkinUiStatusDto;
}

export async function recoverRetryUnconfirmedSubmit(
  input: {
    caseId: string;
    reportRunId: string;
    stage: ArsenkinUiStage;
    providerTaskId: string;
    actorId: string;
  },
  deps: ArsenkinRecoveryDeps = {}
): Promise<ArsenkinUiStatusDto> {
  const prisma = deps.prisma ?? (await import("@/server/prisma/client")).prisma;
  const reportRunId = mapReportRunId(input.caseId, input.reportRunId, input.stage);
  const outRoot = arsenkinCanaryOutRoot(input.caseId, reportRunId);
  const store = deps.store ?? createPrismaProviderTaskStore();
  const client = requireClient(deps.client);
  await retryUnconfirmedSubmitOnce({
    client,
    store,
    outRoot,
    caseId: input.caseId,
    reportRunId,
    providerTaskId: input.providerTaskId,
    actorId: input.actorId,
  });
  await recordAudit({
    caseId: input.caseId,
    action: "ARSENKIN_RECOVERY_RETRY_UNCONFIRMED_SUBMIT",
    actorId: input.actorId,
    metadata: { reportRunId, providerTaskId: input.providerTaskId },
  });
  return toPublicArsenkinUiDto(
    await getArsenkinUiStatus(input.caseId, reportRunId, input.stage, { prisma })
  ) as ArsenkinUiStatusDto;
}

export async function recoverReconcileDoneZeroObs(
  input: {
    caseId: string;
    reportRunId: string;
    stage: ArsenkinUiStage;
    actorId: string;
  },
  deps: ArsenkinRecoveryDeps = {}
): Promise<ArsenkinUiStatusDto & { reconcileResults?: unknown }> {
  const prisma = deps.prisma ?? (await import("@/server/prisma/client")).prisma;
  const reportRunId = mapReportRunId(input.caseId, input.reportRunId, input.stage);
  const outRoot = arsenkinCanaryOutRoot(input.caseId, reportRunId);
  const store = deps.store ?? createPrismaProviderTaskStore();
  const client = requireClient(deps.client);
  const plan = loadPlan(outRoot);
  const tasks = await prisma.providerTask.findMany({
    where: { reportRunId, provider: "arsenkin" },
  });
  const obs = await prisma.serpObservation.groupBy({
    by: ["providerTaskId"],
    where: { auditRunId: reportRunId, provider: "arsenkin" },
    _count: { _all: true },
  });
  const observationCountByTaskId = new Map<string, number>();
  for (const row of obs) {
    if (row.providerTaskId) observationCountByTaskId.set(row.providerTaskId, row._count._all);
  }

  const mappedTasks = tasks.map((t) => ({
    ...t,
    provider: "arsenkin" as const,
    state: t.state as ArsenkinTaskState,
    requestJson: (t.requestJson ?? {}) as Record<string, unknown>,
    responseJson: t.responseJson ? (t.responseJson as Record<string, unknown>) : null,
  }));

  const results = await reconcileAllDoneZeroObservationTasks({
    client,
    store,
    outRoot,
    caseId: input.caseId,
    reportRunId,
    actorId: input.actorId,
    plan,
    tasks: mappedTasks,
    observationCountByTaskId,
    persistObservations: deps.persistObservations ?? persistSerpObservations,
    refetch: deps.refetch,
  });

  await recordAudit({
    caseId: input.caseId,
    action: "ARSENKIN_RECOVERY_RECONCILE_DONE_ZERO_OBS",
    actorId: input.actorId,
    metadata: { reportRunId, results },
  });

  const status = await getArsenkinUiStatus(input.caseId, reportRunId, input.stage, { prisma });
  return { ...(toPublicArsenkinUiDto(status) as ArsenkinUiStatusDto), reconcileResults: results };
}

export async function recoverContinueStage1(
  input: {
    caseId: string;
    reportRunId: string;
    stage: ArsenkinUiStage;
    actorId: string;
    confirmPlanDigest: string;
  },
  deps: ArsenkinRecoveryDeps = {}
): Promise<ArsenkinUiStatusDto> {
  const prisma = deps.prisma ?? (await import("@/server/prisma/client")).prisma;
  const reportRunId = mapReportRunId(input.caseId, input.reportRunId, input.stage);
  const outRoot = arsenkinCanaryOutRoot(input.caseId, reportRunId);
  const status = await getArsenkinUiStatus(input.caseId, reportRunId, input.stage, { prisma });
  if (hasBlockingRecovery(status.recovery)) {
    throw new ConflictError("recovery-incomplete: reconcile SUBMIT_UNKNOWN / DONE zero-obs first");
  }
  const plan = loadPlan(outRoot);
  if (!plan) throw new ValidationError("plan-missing");
  if (plan.digest !== input.confirmPlanDigest) {
    throw new ConflictError("plan-digest-mismatch");
  }

  await reopenFailedStageForContinue({
    prisma,
    caseId: input.caseId,
    reportRunId,
    stage: input.stage,
  });

  appendArsenkinRecoveryDecision(outRoot, {
    caseId: input.caseId,
    reportRunId,
    decision: {
      kind: "CONTINUE_STAGE1",
      reportRunId,
      providerTaskId: "*",
      requestHash: plan.digest,
      toolName: "stage",
      actorId: input.actorId,
      reason: "continue_stage1_after_recovery",
      metadata: { digest: plan.digest },
    },
  });

  await recordAudit({
    caseId: input.caseId,
    action: "ARSENKIN_RECOVERY_CONTINUE_STAGE1",
    actorId: input.actorId,
    metadata: { reportRunId, digest: plan.digest },
  });

  const budget = arsenkinBudgetForStage(input.stage);
  const stageDeps = createProductionCanonicalStageDeps(prisma, {
    getNetworkCalls: getArsenkinNetworkCallCount,
  });
  await executeCanonicalArsenkinStage(stageDeps, {
    caseId: input.caseId,
    reportRunId,
    stage: input.stage,
    mode: "execute-live",
    confirmPlanDigest: plan.digest,
    liveConfirm: true,
    maxNewTasks: budget.maxNewTasks,
    maxEstimatedLimits: budget.maxEstimatedLimits,
    dbReadinessPath: getDefaultReadinessArtifactPath(),
    outRoot,
  });

  return toPublicArsenkinUiDto(
    await getArsenkinUiStatus(input.caseId, reportRunId, input.stage, { prisma })
  ) as ArsenkinUiStatusDto;
}
