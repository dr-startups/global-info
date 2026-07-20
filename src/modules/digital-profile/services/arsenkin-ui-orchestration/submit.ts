/**
 * Arsenkin UI orchestration — split from arsenkin-ui-orchestration-service.ts
 * (REMEDIATION §9.5) — mechanical move only.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/server/prisma/client";
import {
  createProductionCanonicalStageDeps,
  executeCanonicalArsenkinStage,
  type CanonicalStageCommand,
  type CanonicalStageDeps,
  type CanonicalStageResult,
} from "../../orion-golden/classic/execute-canonical-arsenkin-stage";
import type { ArsenkinLiveStage } from "../../orion-golden/classic/arsenkin-execution-plan";
import {
  workflowForStage,
  workflowFromRunMetadata,
  type ArsenkinWorkflow,
} from "../../orion-golden/classic/arsenkin-stage-ledger";
import {
  caseScopedArtifactRoot,
  loadAdminReviewDecisions,
  ORION_GOLDEN_QA_STORAGE_ROOT,
} from "../../orion-golden/evidence/admin-review-decision-store";
import type { AdminReviewDecisionSet } from "../../orion-golden/evidence/admin-review-decision";
import { markUnifiedReportArtifactsStale } from "../unified-report-staleness";
import {
  loadArsenkinReportBinding,
  saveArsenkinReportBinding,
  inspectArsenkinTransferContentGate,
  toCompositeBindingModel,
  type ArsenkinReportBinding,
  type ArsenkinTransferStatus,
} from "../../orion-golden/classic/arsenkin-report-binding";
import {
  assertDbMutationAllowed,
  computeSchemaContentHash,
  computeSourceTreeHash,
  fingerprintDatabaseUrl,
  resolveBuildIdentity,
  validateDbReadinessArtifact,
  writeJsonAtomic,
  type ArsenkinDbReadinessArtifact,
} from "../../providers/arsenkin/arsenkin-db-readiness";
import {
  ensureArsenkinDbReadiness,
  refreshArsenkinDbReadiness,
  type EnsureArsenkinDbReadinessResult,
} from "../../providers/arsenkin/arsenkin-db-readiness-runner";
import {
  getDefaultReadinessArtifactPath,
  humanizeReadinessCode,
  mapReadinessBlockersToCode,
  type ArsenkinReadinessCode,
} from "../../providers/arsenkin/arsenkin-db-readiness-service";
import { isArsenkinConfigured, isArsenkinEnabled } from "../../providers/arsenkin/flags";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../../providers/arsenkin/network-guard";
import { toSubmitUnknownCandidate } from "../../providers/arsenkin/submit-unknown-recovery";
import { getArsenkinFullAuditStatus, scheduleOrchestrationTick } from "../../providers/arsenkin/full-audit-orchestrator";
import { isActiveOrchestrationState } from "../../providers/arsenkin/full-audit-job-store";
import {
  FIRST36_FULL_EXPECTED_SURFACES,
  isTerminalSurfaceStatus,
  SUGGEST_CANARY_EXPECTED_SURFACES,
} from "../../providers/arsenkin/workflow-contract";
import {
  isArsenkinProviderRunId,
  isValidBaseOrionReportRunId,
  resolveCanonicalBaseOrionReportRunId,
  repairFirst36FullSourceBinding,
  needsSourceBindingRepair,
} from "../../providers/arsenkin/source-binding-repair";
import { ConflictError, ValidationError } from "../../http/errors";

import type { ArsenkinUiOrchestrationDeps, ArsenkinUiStage, ArsenkinUiStatusDto, ArsenkinUiPlanDto } from "./types";
import type { ArsenkinUiRunMapping } from "./shared";
import {
  DEFAULT_DB_READINESS,
  arsenkinBudgetForStage,
  arsenkinCanaryOutRoot,
  ensureBindingArtifacts,
  generateArsenkinReportRunId,
  loadArsenkinUiRunMapping,
  productionDeps,
  readJson,
  resolveDbReadinessGate,
  resolveMappedArsenkinReportRunId,
  saveArsenkinUiRunMapping,
} from "./shared";
import { getArsenkinUiStatus } from "./poll";

export async function prepareArsenkinUiRun(input: {
  caseId: string;
  reportRunId: string;
  stage: ArsenkinUiStage;
  deps?: ArsenkinUiOrchestrationDeps;
}): Promise<ArsenkinUiStatusDto> {
  const prisma = input.deps?.prisma ?? defaultPrisma;
  const dbReadinessPath = input.deps?.dbReadinessPath ?? DEFAULT_DB_READINESS;
  const rebuild = input.deps?.rebuild ?? null;
  const executeStage = input.deps?.executeStage ?? executeCanonicalArsenkinStage;
  const configured = (input.deps?.isConfigured ?? isArsenkinConfigured)();
  const now = input.deps?.now ?? (() => new Date());
  resetArsenkinNetworkCallCount();

  if (!configured) {
    throw new ConflictError("Arsenkin API не настроен на сервере");
  }
  const readiness = await resolveDbReadinessGate(input.deps ?? {}, { wait: true });
  if (readiness.running || readiness.blockers.length) {
    throw new ConflictError(
      humanizeReadinessCode(readiness.readinessCode, readiness.blockers)
    );
  }

  const sourceReportRunId = String(input.reportRunId ?? "").trim();
  if (!sourceReportRunId) throw new ValidationError("reportRunId required");

  const workflow = workflowForStage(input.stage);
  let existingMapping = loadArsenkinUiRunMapping(input.caseId, workflow);

  // FIRST36_FULL: never keep an Arsenkin enrichment id as mapping.source — auto-repair.
  if (workflow === "first36-full" && existingMapping) {
    const enrichmentId = existingMapping.arsenkinReportRunId;
    if (
      needsSourceBindingRepair(existingMapping.sourceReportRunId) ||
      (isValidBaseOrionReportRunId(sourceReportRunId) &&
        existingMapping.sourceReportRunId !== sourceReportRunId &&
        isArsenkinProviderRunId(existingMapping.sourceReportRunId))
    ) {
      const repair = await repairFirst36FullSourceBinding({
        caseId: input.caseId,
        enrichmentReportRunId: enrichmentId,
        prisma,
      });
      if (!repair.ok) {
        throw new ConflictError(
          repair.code === "NEEDS_ADMIN"
            ? `NEEDS_ADMIN: ${repair.detail}`
            : `SOURCE_BINDING_REPAIRABLE: ${repair.detail}`
        );
      }
      existingMapping = loadArsenkinUiRunMapping(input.caseId, workflow);
    }
  }

  // Idempotent reuse of mapping — never auto-create a second Arsenkin run.
  if (existingMapping) {
    const mappingSource = existingMapping.sourceReportRunId;
    if (mappingSource !== sourceReportRunId) {
      // Caller may pass enrichment/canary/UI run — never use those as the mapping source check fail.
      const inputIsEnrichmentOrProvider = isArsenkinProviderRunId(sourceReportRunId);
      const allowed =
        inputIsEnrichmentOrProvider ||
        sourceReportRunId === existingMapping.arsenkinReportRunId ||
        sourceReportRunId === mappingSource ||
        sourceReportRunId === existingMapping.baseOrionReportRunId ||
        (workflow === "first36-full" &&
          isValidBaseOrionReportRunId(sourceReportRunId) &&
          isValidBaseOrionReportRunId(mappingSource));
      if (!allowed) {
        throw new ConflictError(
          `Workflow ${workflow} уже привязан к source ${mappingSource}`
        );
      }
      // Align mapping to canonical base when caller provided a valid base.
      if (
        workflow === "first36-full" &&
        isValidBaseOrionReportRunId(sourceReportRunId) &&
        mappingSource !== sourceReportRunId
      ) {
        saveArsenkinUiRunMapping({
          ...existingMapping,
          sourceReportRunId,
          baseOrionReportRunId: sourceReportRunId,
          updatedAt: now().toISOString(),
        });
        existingMapping = loadArsenkinUiRunMapping(input.caseId, workflow)!;
      }
    }
    const arsenkinId = existingMapping.arsenkinReportRunId;
    if (input.stage === "FIRST36_STAGE2") {
      const s1 = await prisma.orionArsenkinStageRun.findFirst({
        where: { reportRunId: arsenkinId, stage: "FIRST36_STAGE1" },
      });
      if (!s1 || s1.status !== "DONE") {
        throw new ConflictError("Stage 2 доступен только после FIRST36_STAGE1=DONE");
      }
    }
    const stageRow = await prisma.orionArsenkinStageRun.findFirst({
      where: { reportRunId: arsenkinId, stage: input.stage },
    });
    if (stageRow?.status === "FAILED") {
      throw new ConflictError("Стадия FAILED — автоматический повтор prepare запрещён");
    }
    const intervention = existsSync(
      join(arsenkinCanaryOutRoot(input.caseId, arsenkinId), "manual-intervention-required.json")
    );
    if (intervention || stageRow?.status === "MANUAL_INTERVENTION_REQUIRED") {
      throw new ConflictError("MANUAL_INTERVENTION_REQUIRED — автоматический повтор запрещён");
    }
    if (stageRow?.status === "DONE") {
      return getArsenkinUiStatus(input.caseId, sourceReportRunId, input.stage, input.deps);
    }
    // PREPARED / RUNNING / absent stage row → continue prepare on mapped id (idempotent).
    const budget = arsenkinBudgetForStage(input.stage);
    const outRoot = arsenkinCanaryOutRoot(input.caseId, arsenkinId);
    await ensureBindingArtifacts(input.caseId, arsenkinId, outRoot, rebuild);
    const stageDeps = (input.deps?.createDeps ?? productionDeps)(prisma);
    const result = await executeStage(stageDeps, {
      mode: "prepare",
      caseId: input.caseId,
      reportRunId: arsenkinId,
      stage: input.stage,
      workflow,
      maxNewTasks: budget.maxNewTasks,
      maxEstimatedLimits: budget.maxEstimatedLimits,
      dbReadinessPath,
      outRoot,
      tokenPresent: configured,
    });
    if (!result.ok) {
      throw new ConflictError(result.blockers?.[0] ?? result.verdict);
    }
    if (getArsenkinNetworkCallCount() !== 0) {
      throw new ConflictError("prepare leaked network calls");
    }
    saveArsenkinUiRunMapping({
      ...existingMapping,
      stage: input.stage,
      updatedAt: now().toISOString(),
    });
    return getArsenkinUiStatus(input.caseId, sourceReportRunId, input.stage, input.deps);
  }

  // Stage2 never allocates a new run — requires first36-full mapping from Stage1.
  if (input.stage === "FIRST36_STAGE2") {
    throw new ConflictError(
      "Stage 2 требует mapping first36-full после FIRST36_STAGE1 — сначала prepare Stage1"
    );
  }

  const sourceRun = await prisma.orionReportRun.findUnique({ where: { id: sourceReportRunId } });
  if (sourceRun && sourceRun.caseId !== input.caseId) {
    throw new ConflictError("reportRunId принадлежит другому кейсу");
  }

  // Fresh-run invariant: if source OrionReportRun already exists, allocate a NEW Arsenkin id.
  // Never delete or mutate the existing production run.
  let arsenkinReportRunId = sourceReportRunId;
  if (sourceRun) {
    arsenkinReportRunId =
      input.deps?.createReportRunId?.(workflow) ?? generateArsenkinReportRunId(workflow);
  }

  const mapping: ArsenkinUiRunMapping = {
    caseId: input.caseId,
    sourceReportRunId,
    arsenkinReportRunId,
    workflow,
    stage: input.stage,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
  };
  saveArsenkinUiRunMapping(mapping);

  const budget = arsenkinBudgetForStage(input.stage);
  const outRoot = arsenkinCanaryOutRoot(input.caseId, arsenkinReportRunId);
  await ensureBindingArtifacts(input.caseId, arsenkinReportRunId, outRoot, rebuild);

  const stageDeps = (input.deps?.createDeps ?? productionDeps)(prisma);
  const result = await executeStage(stageDeps, {
    mode: "prepare",
    caseId: input.caseId,
    reportRunId: arsenkinReportRunId,
    stage: input.stage,
    workflow,
    maxNewTasks: budget.maxNewTasks,
    maxEstimatedLimits: budget.maxEstimatedLimits,
    dbReadinessPath,
    outRoot,
    tokenPresent: configured,
  });

  if (!result.ok) {
    throw new ConflictError(result.blockers?.[0] ?? result.verdict);
  }
  if (getArsenkinNetworkCallCount() !== 0) {
    throw new ConflictError("prepare leaked network calls");
  }

  return getArsenkinUiStatus(input.caseId, sourceReportRunId, input.stage, input.deps);
}

export async function buildArsenkinUiPlan(input: {
  caseId: string;
  reportRunId: string;
  stage: ArsenkinUiStage;
  deps?: ArsenkinUiOrchestrationDeps;
}): Promise<ArsenkinUiPlanDto> {
  const prisma = input.deps?.prisma ?? defaultPrisma;
  const dbReadinessPath = input.deps?.dbReadinessPath ?? DEFAULT_DB_READINESS;
  const executeStage = input.deps?.executeStage ?? executeCanonicalArsenkinStage;
  const configured = (input.deps?.isConfigured ?? isArsenkinConfigured)();
  resetArsenkinNetworkCallCount();

  if (!configured) throw new ConflictError("Arsenkin API не настроен");
  const readiness = await resolveDbReadinessGate(input.deps ?? {}, { wait: true });
  if (readiness.running || readiness.blockers.length) {
    throw new ConflictError(
      humanizeReadinessCode(readiness.readinessCode, readiness.blockers)
    );
  }

  const workflow = workflowForStage(input.stage);
  const { arsenkinReportRunId } = resolveMappedArsenkinReportRunId({
    caseId: input.caseId,
    workflow,
    clientReportRunId: input.reportRunId,
    requireMapping: true,
  });
  if (!arsenkinReportRunId) throw new ConflictError("Arsenkin reportRunId mapping отсутствует");

  const budget = arsenkinBudgetForStage(input.stage);
  const outRoot = arsenkinCanaryOutRoot(input.caseId, arsenkinReportRunId);
  const stageDeps = (input.deps?.createDeps ?? productionDeps)(prisma);

  const result = await executeStage(stageDeps, {
    mode: "plan-only",
    caseId: input.caseId,
    reportRunId: arsenkinReportRunId,
    stage: input.stage,
    workflow,
    maxNewTasks: budget.maxNewTasks,
    maxEstimatedLimits: budget.maxEstimatedLimits,
    dbReadinessPath,
    outRoot,
    tokenPresent: true,
  });

  if (getArsenkinNetworkCallCount() !== 0) {
    throw new ConflictError("plan leaked network calls");
  }

  const plan = readJson<{
    digest: string;
    requests: Array<{
      tool: string;
      engine: string;
      region: string;
      query?: string | null;
      action: string;
      requestHash: string;
    }>;
    plannedNewTasks: number;
    estimatedLimitsTotal: number;
  }>(join(outRoot, "arsenkin-live-plan.json"));

  if (!result.ok || !plan?.digest) {
    throw new ConflictError(result.blockers?.[0] ?? "plan-blocked");
  }

  const status = await getArsenkinUiStatus(
    input.caseId,
    input.reportRunId,
    input.stage,
    input.deps
  );

  const requests = plan.requests.map((r) => ({
    tool: r.tool,
    engine: r.engine,
    region: r.region,
    query: r.query ?? null,
    action: r.action,
    requestHash: r.requestHash,
  }));

  return {
    ...status,
    status: "PLAN_READY",
    reportRunId: arsenkinReportRunId,
    arsenkinReportRunId,
    planDigest: plan.digest,
    digest: plan.digest,
    plannedNewTasks: plan.plannedNewTasks,
    estimatedLimitsTotal: plan.estimatedLimitsTotal,
    maxNewTasks: budget.maxNewTasks,
    maxEstimatedLimits: budget.maxEstimatedLimits,
    requests,
    plannedRequests: requests,
    canExecute: true,
    networkCalls: 0,
    humanMessages: [],
  };
}

/** Spec alias — same as buildArsenkinUiPlan. */
export const planArsenkinUiRun = buildArsenkinUiPlan;

export async function executeArsenkinUiPlan(input: {
  caseId: string;
  reportRunId: string;
  stage: ArsenkinUiStage;
  confirmPlanDigest: string;
  confirmed: boolean;
  deps?: ArsenkinUiOrchestrationDeps;
}): Promise<ArsenkinUiStatusDto & { result: CanonicalStageResult }> {
  if (!input.confirmed) {
    throw new ConflictError("Требуется явное подтверждение платного запуска");
  }
  if (!input.confirmPlanDigest?.trim()) {
    throw new ConflictError("Отсутствует digest плана");
  }

  const prisma = input.deps?.prisma ?? defaultPrisma;
  const dbReadinessPath = input.deps?.dbReadinessPath ?? DEFAULT_DB_READINESS;
  const executeStage = input.deps?.executeStage ?? executeCanonicalArsenkinStage;
  const configured = (input.deps?.isConfigured ?? isArsenkinConfigured)();
  resetArsenkinNetworkCallCount();

  if (!configured) throw new ConflictError("Arsenkin API не настроен");
  const readiness = await resolveDbReadinessGate(input.deps ?? {}, { wait: true });
  if (readiness.running || readiness.blockers.length) {
    throw new ConflictError(
      humanizeReadinessCode(readiness.readinessCode, readiness.blockers)
    );
  }

  const workflow = workflowForStage(input.stage);
  const { arsenkinReportRunId } = resolveMappedArsenkinReportRunId({
    caseId: input.caseId,
    workflow,
    clientReportRunId: input.reportRunId,
    requireMapping: true,
  });
  if (!arsenkinReportRunId) throw new ConflictError("Arsenkin reportRunId mapping отсутствует");

  const intervention = existsSync(
    join(arsenkinCanaryOutRoot(input.caseId, arsenkinReportRunId), "manual-intervention-required.json")
  );
  if (intervention) {
    throw new ConflictError("MANUAL_INTERVENTION_REQUIRED — автоматический повтор запрещён");
  }

  const stageRow = await prisma.orionArsenkinStageRun.findFirst({
    where: { reportRunId: arsenkinReportRunId, stage: input.stage },
  });
  if (stageRow?.status === "FAILED") {
    throw new ConflictError("Стадия FAILED — автоматический повтор запрещён");
  }
  if (stageRow?.status === "MANUAL_INTERVENTION_REQUIRED") {
    throw new ConflictError("MANUAL_INTERVENTION_REQUIRED — автоматический повтор запрещён");
  }

  const budget = arsenkinBudgetForStage(input.stage);
  const outRoot = arsenkinCanaryOutRoot(input.caseId, arsenkinReportRunId);
  const stageDeps = (input.deps?.createDeps ?? productionDeps)(prisma);

  // liveConfirm only on this command — never set process.env.ARSENKIN_LIVE_CONFIRM
  const result = await executeStage(stageDeps, {
    mode: "execute-live",
    caseId: input.caseId,
    reportRunId: arsenkinReportRunId,
    stage: input.stage,
    workflow,
    maxNewTasks: budget.maxNewTasks,
    maxEstimatedLimits: budget.maxEstimatedLimits,
    confirmPlanDigest: input.confirmPlanDigest,
    liveConfirm: true,
    dbReadinessPath,
    outRoot,
    tokenPresent: true,
  });

  if (result.verdict === "MANUAL_INTERVENTION_REQUIRED") {
    const status = await getArsenkinUiStatus(
      input.caseId,
      input.reportRunId,
      input.stage,
      input.deps
    );
    return { ...status, status: "MANUAL_INTERVENTION_REQUIRED", result };
  }

  if (!result.ok && result.verdict !== "IDEMPOTENT_REPLAY_DONE") {
    throw new ConflictError(result.blockers?.[0] ?? result.verdict);
  }

  const status = await getArsenkinUiStatus(
    input.caseId,
    input.reportRunId,
    input.stage,
    input.deps
  );
  return {
    ...status,
    reportRunId: arsenkinReportRunId,
    arsenkinReportRunId,
    collectorCalls: result.collectorCalls ?? null,
    networkCalls: result.networkCalls,
    result,
  };
}

/** Spec alias — same as executeArsenkinUiPlan. */
export const executeArsenkinUiRun = executeArsenkinUiPlan;

