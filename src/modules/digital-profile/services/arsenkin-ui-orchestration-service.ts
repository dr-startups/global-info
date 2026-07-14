/**
 * Arsenkin UI orchestration — thin adapter over executeCanonicalArsenkinStage.
 * No CLI spawn. No parallel Arsenkin pipeline. Token never leaves the server.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/server/prisma/client";
import {
  createProductionCanonicalStageDeps,
  executeCanonicalArsenkinStage,
  type CanonicalStageCommand,
  type CanonicalStageDeps,
  type CanonicalStageResult,
} from "../orion-golden/classic/execute-canonical-arsenkin-stage";
import type { ArsenkinLiveStage } from "../orion-golden/classic/arsenkin-execution-plan";
import {
  workflowForStage,
  workflowFromRunMetadata,
  type ArsenkinWorkflow,
} from "../orion-golden/classic/arsenkin-stage-ledger";
import {
  caseScopedArtifactRoot,
  loadAdminReviewDecisions,
  ORION_GOLDEN_QA_STORAGE_ROOT,
} from "../orion-golden/evidence/admin-review-decision-store";
import type { AdminReviewDecisionSet } from "../orion-golden/evidence/admin-review-decision";
import { rebuildClientContentForReportRun } from "../orion-golden/rebuild-client-content-for-report-run";
import {
  computeSchemaContentHash,
  computeSourceTreeHash,
  fingerprintDatabaseUrl,
  resolveBuildIdentity,
  validateDbReadinessArtifact,
  writeJsonAtomic,
  type ArsenkinDbReadinessArtifact,
} from "../providers/arsenkin/arsenkin-db-readiness";
import { isArsenkinConfigured, isArsenkinEnabled } from "../providers/arsenkin/flags";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../providers/arsenkin/network-guard";
import { ConflictError, ValidationError } from "../http/errors";

export type ArsenkinUiStatusCode =
  | "NOT_CONFIGURED"
  | "READY_TO_PREPARE"
  | "PREPARED"
  | "PLAN_READY"
  | "EXECUTING"
  | "STAGE_DONE"
  | "SYNC_READY"
  | "SYNCED"
  | "BLOCKED"
  | "FAILED"
  | "MANUAL_INTERVENTION_REQUIRED";

export type ArsenkinUiStage = ArsenkinLiveStage;

export type ArsenkinUiStatusDto = {
  enabled: boolean;
  configured: boolean;
  caseId: string;
  workflow: ArsenkinWorkflow | null;
  stage: ArsenkinUiStage | null;
  reportRunId: string | null;
  status: ArsenkinUiStatusCode;
  verdict: string | null;
  tools: string[];
  planDigest: string | null;
  plannedRequests: ArsenkinUiPlanRequestDto[];
  plannedNewTasks: number | null;
  estimatedLimitsTotal: number | null;
  maxNewTasks: number;
  maxEstimatedLimits: number;
  networkCalls: number;
  collectorCalls: number | null;
  providerTaskCount: number;
  observationCount: number;
  coverageCount: number;
  blockers: string[];
  lastError: string | null;
  canPrepare: boolean;
  canPlan: boolean;
  canExecute: boolean;
  canSync: boolean;
  synced: boolean;
  updatedAt: string;
  humanMessages: string[];
};

export type ArsenkinUiPlanRequestDto = {
  tool: string;
  engine: string;
  region: string;
  query: string | null;
  action: string;
  requestHash: string;
};

export type ArsenkinUiPlanDto = ArsenkinUiStatusDto & {
  requests: ArsenkinUiPlanRequestDto[];
  digest: string;
};

const DEFAULT_DB_READINESS = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-arsenkin-p05",
  "arsenkin-db-readiness.json"
);

export function arsenkinBudgetForStage(stage: ArsenkinUiStage): {
  maxNewTasks: number;
  maxEstimatedLimits: number;
  tools: string[];
} {
  if (stage === "SUGGEST_RU_CANARY") {
    return { maxNewTasks: 2, maxEstimatedLimits: 2, tools: ["suggest"] };
  }
  if (stage === "FIRST36_STAGE1") {
    return {
      maxNewTasks: 20,
      maxEstimatedLimits: 20,
      tools: ["check-top", "suggest", "paa"],
    };
  }
  return {
    maxNewTasks: 10,
    maxEstimatedLimits: 10,
    tools: ["ai-serp", "check-h", "indexation"],
  };
}

export function arsenkinCanaryOutRoot(caseId: string, reportRunId: string): string {
  return join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    caseId,
    reportRunId
  );
}

export function arsenkinOrionCaseRoot(caseId: string): string {
  return caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function humanizeBlockers(blockers: string[]): string[] {
  return blockers.map((b) => {
    if (/db-readiness/i.test(b)) return "Проверка готовности БД не пройдена.";
    if (/dirty-source-tree/i.test(b)) return "Исходный код изменён (dirty tree) — live заблокирован.";
    if (/digest/i.test(b)) return "План устарел. Сформируйте план заново.";
    if (/token|ARSENKIN_API_TOKEN/i.test(b)) return "Arsenkin API не настроен на сервере.";
    if (/qaSampleOnly|qa-sample/i.test(b)) return "QA-решения нельзя использовать для production.";
    if (/binding|reportRunId|foreign/i.test(b)) return "Клиентский контент привязан к другому прогону.";
    if (/stage2-requires-stage1/i.test(b)) return "Сначала завершите Stage 1.";
    if (/workflow/i.test(b)) return "Несовместимый workflow для выбранной стадии.";
    if (/LIVE_CONFIRM|confirmed/i.test(b)) return "Требуется явное подтверждение платного запуска.";
    if (/MANUAL_INTERVENTION/i.test(b)) return "Требуется ручное вмешательство — автоповтор запрещён.";
    return "Операция заблокирована проверками безопасности.";
  });
}

export type ArsenkinUiOrchestrationDeps = {
  prisma?: PrismaClient;
  createDeps?: (prisma: PrismaClient) => CanonicalStageDeps;
  executeStage?: (
    deps: CanonicalStageDeps,
    command: CanonicalStageCommand
  ) => Promise<CanonicalStageResult>;
  dbReadinessPath?: string;
  /** Override readiness checks (tests). Production uses validateDbReadinessArtifact. */
  readinessBlockers?: () => string[];
  now?: () => Date;
  rebuild?: typeof rebuildClientContentForReportRun;
  /** Test/prod override for configured flag (token stays server-side). */
  isConfigured?: () => boolean;
  isEnabled?: () => boolean;
};

function productionDeps(prisma: PrismaClient): CanonicalStageDeps {
  return createProductionCanonicalStageDeps(prisma, {
    getNetworkCalls: getArsenkinNetworkCallCount,
  });
}

async function resolveReportRunId(
  prisma: PrismaClient,
  caseId: string,
  reportRunId?: string | null
): Promise<string | null> {
  if (reportRunId?.trim()) return reportRunId.trim();
  const queuePath = join(arsenkinOrionCaseRoot(caseId), "manual-review-queue.json");
  const queue = readJson<{ reportRunId?: string }>(queuePath);
  if (queue?.reportRunId) return queue.reportRunId;
  const run = await prisma.orionReportRun.findFirst({
    where: { caseId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return run?.id ?? null;
}

function loadDbReadiness(path: string): ArsenkinDbReadinessArtifact | null {
  return readJson<ArsenkinDbReadinessArtifact>(path);
}

function readinessBlockers(path: string): string[] {
  const art = loadDbReadiness(path);
  const build = resolveBuildIdentity();
  const dbUrl = String(process.env.DATABASE_URL ?? "");
  const r = validateDbReadinessArtifact({
    artifact: art,
    currentFingerprint: fingerprintDatabaseUrl(dbUrl || "postgresql://unknown/unknown"),
    currentBuildCommit: build.buildCommit,
    currentSourceTreeHash: computeSourceTreeHash(),
    currentSchemaContentHash: computeSchemaContentHash(),
    currentDirtyTree: build.dirtyTree,
  });
  return r.ok ? [] : r.blockers;
}

export async function getArsenkinUiStatus(
  caseId: string,
  reportRunId?: string | null,
  stageHint?: ArsenkinUiStage | null,
  deps: ArsenkinUiOrchestrationDeps = {}
): Promise<ArsenkinUiStatusDto> {
  const prisma = deps.prisma ?? defaultPrisma;
  const dbReadinessPath = deps.dbReadinessPath ?? DEFAULT_DB_READINESS;
  const enabled = (deps.isEnabled ?? isArsenkinEnabled)();
  const configured = (deps.isConfigured ?? isArsenkinConfigured)();
  const runId = await resolveReportRunId(prisma, caseId, reportRunId);
  const blockers: string[] = [];
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();

  if (!enabled || !configured) {
    return {
      enabled,
      configured,
      caseId,
      workflow: null,
      stage: stageHint ?? null,
      reportRunId: runId,
      status: "NOT_CONFIGURED",
      verdict: null,
      tools: stageHint ? arsenkinBudgetForStage(stageHint).tools : [],
      planDigest: null,
      plannedRequests: [],
      plannedNewTasks: null,
      estimatedLimitsTotal: null,
      maxNewTasks: stageHint ? arsenkinBudgetForStage(stageHint).maxNewTasks : 2,
      maxEstimatedLimits: stageHint ? arsenkinBudgetForStage(stageHint).maxEstimatedLimits : 2,
      networkCalls: getArsenkinNetworkCallCount(),
      collectorCalls: null,
      providerTaskCount: 0,
      observationCount: 0,
      coverageCount: 0,
      blockers: ["arsenkin-not-configured"],
      lastError: null,
      canPrepare: false,
      canPlan: false,
      canExecute: false,
      canSync: false,
      synced: false,
      updatedAt: nowIso,
      humanMessages: ["Arsenkin API не подключён на сервере."],
    };
  }

  blockers.push(
    ...((deps.readinessBlockers ?? (() => readinessBlockers(dbReadinessPath)))())
  );

  let stage: ArsenkinUiStage | null = stageHint ?? null;
  let workflow: ArsenkinWorkflow | null = stage ? workflowForStage(stage) : null;
  let stageStatus: string | null = null;
  let planDigest: string | null = null;
  let lastError: string | null = null;
  let plannedRequests: ArsenkinUiPlanRequestDto[] = [];
  let plannedNewTasksFromArt: number | null = null;
  let estimatedLimitsFromArt: number | null = null;
  let uiStatus: ArsenkinUiStatusCode = blockers.length ? "BLOCKED" : "READY_TO_PREPARE";

  const [providerTaskCount, observationCount, coverageCount] = runId
    ? await Promise.all([
        prisma.providerTask.count({ where: { reportRunId: runId, provider: "arsenkin" } }),
        prisma.serpObservation.count({
          where: { auditRunId: runId, provider: "arsenkin" },
        }),
        prisma.surfaceCollectionCoverage.count({
          where: { reportRunId: runId, provider: "arsenkin" },
        }),
      ])
    : [0, 0, 0];

  if (runId) {
    const run = await prisma.orionReportRun.findUnique({ where: { id: runId } });
    if (run && run.caseId !== caseId) {
      blockers.push("foreign-reportRunId");
      uiStatus = "BLOCKED";
    }
    if (run) {
      const stored = workflowFromRunMetadata(run.metadataJson);
      if (stored) workflow = stored;
    }
    const stages = await prisma.orionArsenkinStageRun.findMany({
      where: { reportRunId: runId },
      orderBy: { updatedAt: "desc" },
    });
    const current =
      (stage ? stages.find((s) => s.stage === stage) : null) ?? stages[0] ?? null;
    if (current) {
      stage = current.stage as ArsenkinUiStage;
      stageStatus = current.status;
      planDigest = current.planDigest;
      const err = current.errorJson as { message?: string } | null;
      lastError = err?.message ?? null;
      if (current.status === "PREPARED") uiStatus = "PREPARED";
      if (current.status === "RUNNING") uiStatus = "EXECUTING";
      if (current.status === "DONE") uiStatus = "STAGE_DONE";
      if (current.status === "FAILED") uiStatus = "FAILED";
    }
    const syncMarker = readJson<{ synced?: boolean; reportRunId?: string }>(
      join(arsenkinOrionCaseRoot(caseId), "arsenkin-ui-sync.json")
    );
    if (syncMarker?.synced && syncMarker.reportRunId === runId && uiStatus === "STAGE_DONE") {
      uiStatus = "SYNCED";
    } else if (uiStatus === "STAGE_DONE") {
      uiStatus = "SYNC_READY";
    }
    const intervention = runId
      ? existsSync(join(arsenkinCanaryOutRoot(caseId, runId), "manual-intervention-required.json"))
      : false;
    if (intervention) uiStatus = "MANUAL_INTERVENTION_REQUIRED";

    const planArt = runId
      ? readJson<{
          digest?: string;
          plannedNewTasks?: number;
          estimatedLimitsTotal?: number;
          requests?: ArsenkinUiPlanRequestDto[];
        }>(join(arsenkinCanaryOutRoot(caseId, runId), "arsenkin-live-plan.json"))
      : null;
    if (planArt?.digest && stageStatus === "PREPARED") {
      uiStatus = "PLAN_READY";
      planDigest = planArt.digest;
    }
    if (planArt?.requests?.length) {
      plannedRequests = planArt.requests.map((r) => ({
        tool: r.tool,
        engine: r.engine,
        region: r.region,
        query: r.query ?? null,
        action: r.action,
        requestHash: r.requestHash,
      }));
    }
    if (typeof planArt?.plannedNewTasks === "number") plannedNewTasksFromArt = planArt.plannedNewTasks;
    if (typeof planArt?.estimatedLimitsTotal === "number") {
      estimatedLimitsFromArt = planArt.estimatedLimitsTotal;
    }
  }

  if (blockers.length && uiStatus !== "FAILED" && uiStatus !== "MANUAL_INTERVENTION_REQUIRED") {
    uiStatus = "BLOCKED";
  }

  const budget = stage
    ? arsenkinBudgetForStage(stage)
    : { maxNewTasks: 2, maxEstimatedLimits: 2, tools: ["suggest"] };

  const canPrepare =
    configured &&
    blockers.length === 0 &&
    Boolean(runId) &&
    uiStatus !== "EXECUTING" &&
    uiStatus !== "MANUAL_INTERVENTION_REQUIRED";
  const canPlan =
    configured &&
    blockers.length === 0 &&
    Boolean(runId) &&
    (uiStatus === "PREPARED" ||
      uiStatus === "PLAN_READY" ||
      uiStatus === "SYNC_READY" ||
      uiStatus === "SYNCED");
  const canExecute =
    configured &&
    blockers.length === 0 &&
    Boolean(runId) &&
    (uiStatus === "PLAN_READY" || uiStatus === "PREPARED");
  const canSync =
    configured &&
    Boolean(runId) &&
    (uiStatus === "SYNC_READY" || uiStatus === "SYNCED");

  return {
    enabled,
    configured,
    caseId,
    workflow,
    stage,
    reportRunId: runId,
    status: uiStatus,
    verdict: stageStatus,
    tools: budget.tools,
    planDigest,
    plannedRequests,
    plannedNewTasks: plannedNewTasksFromArt,
    estimatedLimitsTotal: estimatedLimitsFromArt,
    maxNewTasks: budget.maxNewTasks,
    maxEstimatedLimits: budget.maxEstimatedLimits,
    networkCalls: getArsenkinNetworkCallCount(),
    collectorCalls: null,
    providerTaskCount,
    observationCount,
    coverageCount,
    blockers,
    lastError,
    canPrepare,
    canPlan,
    canExecute: canExecute && Boolean(planDigest),
    canSync,
    synced: uiStatus === "SYNCED",
    updatedAt: nowIso,
    humanMessages: humanizeBlockers(blockers),
  };
}

async function ensureBindingArtifacts(
  caseId: string,
  reportRunId: string,
  outRoot: string,
  rebuild: typeof rebuildClientContentForReportRun
): Promise<void> {
  mkdirSync(outRoot, { recursive: true });
  await rebuild(caseId, reportRunId, outRoot, { requireAi: false });
  // Non-QA admin decisions stub for gate (production decisions from ORION root if present)
  const prod = loadAdminReviewDecisions(caseId);
  if (prod?.qaSampleOnly) {
    throw new ConflictError("QA sample decisions cannot be used for Arsenkin live");
  }
  const decisions: AdminReviewDecisionSet = prod ?? {
    version: "r10-5-admin-review-decisions-v1",
    caseId,
    generatedAt: new Date().toISOString(),
    qaSampleOnly: false,
    decisions: [],
  };
  writeJsonAtomic(join(outRoot, "admin-review-decisions.json"), {
    ...decisions,
    qaSampleOnly: false,
  });
}

export async function prepareArsenkinUiRun(input: {
  caseId: string;
  reportRunId: string;
  stage: ArsenkinUiStage;
  deps?: ArsenkinUiOrchestrationDeps;
}): Promise<ArsenkinUiStatusDto> {
  const prisma = input.deps?.prisma ?? defaultPrisma;
  const dbReadinessPath = input.deps?.dbReadinessPath ?? DEFAULT_DB_READINESS;
  const rebuild = input.deps?.rebuild ?? rebuildClientContentForReportRun;
  const executeStage = input.deps?.executeStage ?? executeCanonicalArsenkinStage;
  const configured = (input.deps?.isConfigured ?? isArsenkinConfigured)();
  resetArsenkinNetworkCallCount();

  if (!configured) {
    throw new ConflictError("Arsenkin API не настроен на сервере");
  }
  const rb = (input.deps?.readinessBlockers ?? (() => readinessBlockers(dbReadinessPath)))();
  if (rb.length) throw new ConflictError(`DB readiness: ${rb[0]}`);

  const run = await prisma.orionReportRun.findUnique({ where: { id: input.reportRunId } });
  const workflow = workflowForStage(input.stage);
  if (run) {
    if (run.caseId !== input.caseId) {
      throw new ConflictError("reportRunId принадлежит другому кейсу");
    }
    const stored = workflowFromRunMetadata(run.metadataJson);
    if (stored && stored !== workflow) {
      throw new ConflictError(
        `Run уже использует workflow ${stored}; нельзя смешивать с ${workflow}`
      );
    }
  }

  if (input.stage === "FIRST36_STAGE2") {
    if (!run) throw new ConflictError("Stage 2 требует существующий run");
    const s1 = await prisma.orionArsenkinStageRun.findFirst({
      where: { reportRunId: input.reportRunId, stage: "FIRST36_STAGE1" },
    });
    if (!s1 || s1.status !== "DONE") {
      throw new ConflictError("Stage 2 доступен только после FIRST36_STAGE1=DONE");
    }
  }

  const budget = arsenkinBudgetForStage(input.stage);
  const outRoot = arsenkinCanaryOutRoot(input.caseId, input.reportRunId);
  await ensureBindingArtifacts(input.caseId, input.reportRunId, outRoot, rebuild);

  const stageDeps = (input.deps?.createDeps ?? productionDeps)(prisma);
  const result = await executeStage(stageDeps, {
    mode: "prepare",
    caseId: input.caseId,
    reportRunId: input.reportRunId,
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

  return getArsenkinUiStatus(input.caseId, input.reportRunId, input.stage, input.deps);
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
  const rb = (input.deps?.readinessBlockers ?? (() => readinessBlockers(dbReadinessPath)))();
  if (rb.length) throw new ConflictError(`DB readiness: ${rb[0]}`);

  const budget = arsenkinBudgetForStage(input.stage);
  const outRoot = arsenkinCanaryOutRoot(input.caseId, input.reportRunId);
  const workflow = workflowForStage(input.stage);
  const stageDeps = (input.deps?.createDeps ?? productionDeps)(prisma);

  const result = await executeStage(stageDeps, {
    mode: "plan-only",
    caseId: input.caseId,
    reportRunId: input.reportRunId,
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

  return {
    ...status,
    status: "PLAN_READY",
    planDigest: plan.digest,
    digest: plan.digest,
    plannedNewTasks: plan.plannedNewTasks,
    estimatedLimitsTotal: plan.estimatedLimitsTotal,
    maxNewTasks: budget.maxNewTasks,
    maxEstimatedLimits: budget.maxEstimatedLimits,
    requests: plan.requests.map((r) => ({
      tool: r.tool,
      engine: r.engine,
      region: r.region,
      query: r.query ?? null,
      action: r.action,
      requestHash: r.requestHash,
    })),
    plannedRequests: plan.requests.map((r) => ({
      tool: r.tool,
      engine: r.engine,
      region: r.region,
      query: r.query ?? null,
      action: r.action,
      requestHash: r.requestHash,
    })),
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
  const rb = (input.deps?.readinessBlockers ?? (() => readinessBlockers(dbReadinessPath)))();
  if (rb.length) throw new ConflictError(`DB readiness: ${rb[0]}`);

  const intervention = existsSync(
    join(arsenkinCanaryOutRoot(input.caseId, input.reportRunId), "manual-intervention-required.json")
  );
  if (intervention) {
    throw new ConflictError("MANUAL_INTERVENTION_REQUIRED — автоматический повтор запрещён");
  }

  const stageRow = await prisma.orionArsenkinStageRun.findFirst({
    where: { reportRunId: input.reportRunId, stage: input.stage },
  });
  if (stageRow?.status === "FAILED") {
    throw new ConflictError("Стадия FAILED — автоматический повтор запрещён");
  }
  if (stageRow?.status === "MANUAL_INTERVENTION_REQUIRED") {
    throw new ConflictError("MANUAL_INTERVENTION_REQUIRED — автоматический повтор запрещён");
  }

  const budget = arsenkinBudgetForStage(input.stage);
  const outRoot = arsenkinCanaryOutRoot(input.caseId, input.reportRunId);
  const workflow = workflowForStage(input.stage);
  const stageDeps = (input.deps?.createDeps ?? productionDeps)(prisma);

  // liveConfirm only on this command — never set process.env.ARSENKIN_LIVE_CONFIRM
  const result = await executeStage(stageDeps, {
    mode: "execute-live",
    caseId: input.caseId,
    reportRunId: input.reportRunId,
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
    collectorCalls: result.collectorCalls ?? null,
    networkCalls: result.networkCalls,
    result,
  };
}

/** Spec alias — same as executeArsenkinUiPlan. */
export const executeArsenkinUiRun = executeArsenkinUiPlan;

/**
 * Sync Arsenkin observations into ORION Golden case root without Arsenkin network.
 * Preserves existing non-pending admin decisions by evidenceId.
 */
export async function syncArsenkinResultsToOrion(input: {
  caseId: string;
  reportRunId: string;
  stage: ArsenkinUiStage;
  deps?: ArsenkinUiOrchestrationDeps;
}): Promise<ArsenkinUiStatusDto & { orphanedEvidenceIds: string[] }> {
  const prisma = input.deps?.prisma ?? defaultPrisma;
  const rebuild = input.deps?.rebuild ?? rebuildClientContentForReportRun;
  resetArsenkinNetworkCallCount();

  const run = await prisma.orionReportRun.findUnique({ where: { id: input.reportRunId } });
  if (!run || run.caseId !== input.caseId) {
    throw new ConflictError("reportRunId не принадлежит кейсу");
  }

  const stageRow = await prisma.orionArsenkinStageRun.findFirst({
    where: { reportRunId: input.reportRunId, stage: input.stage },
  });
  if (!stageRow || stageRow.status !== "DONE") {
    throw new ConflictError("Sync доступен только после STAGE_DONE");
  }

  const workflow = workflowForStage(input.stage);
  if (workflow === "first36-full") {
    const stages = await prisma.orionArsenkinStageRun.findMany({
      where: { reportRunId: input.reportRunId },
    });
    const s1 = stages.find((s) => s.stage === "FIRST36_STAGE1");
    const s2 = stages.find((s) => s.stage === "FIRST36_STAGE2");
    if (input.stage === "FIRST36_STAGE2" || (s1?.status === "DONE" && s2?.status === "DONE")) {
      if (s1?.status !== "DONE" || s2?.status !== "DONE") {
        // canary-like preview sync for stage1 alone is allowed as preview for stage1 DONE
        if (input.stage === "FIRST36_STAGE2" && s2?.status !== "DONE") {
          throw new ConflictError("Полный First36 sync требует обе стадии DONE");
        }
      }
    }
  }

  const obs = await prisma.serpObservation.findMany({
    where: { auditRunId: input.reportRunId, provider: "arsenkin" },
    select: { id: true, providerTaskId: true, surface: true, engine: true, region: true },
  });
  if (obs.length === 0) throw new ConflictError("Нет Arsenkin observations для sync");
  if (obs.some((o) => !o.providerTaskId)) {
    throw new ConflictError("Наблюдения без providerTaskId — sync заблокирован");
  }

  if (input.stage === "SUGGEST_RU_CANARY") {
    const ok = obs.every(
      (o) => o.surface === "autocomplete" && o.region === "RU" && (o.engine === "YANDEX" || o.engine === "GOOGLE")
    );
    if (!ok) {
      // Soft: still allow if suggest mapped differently; require at least RU autocomplete
      const has = obs.some((o) => o.region === "RU" && (o.surface === "autocomplete" || o.surface === "organic"));
      if (!has) throw new ConflictError("Canary sync ожидает RU suggest observations");
    }
  }

  const existing = loadAdminReviewDecisions(input.caseId);
  if (existing?.qaSampleOnly) {
    throw new ConflictError("QA sample decisions cannot sync to production");
  }
  const preserved = (existing?.decisions ?? []).filter((d) => d.status !== "PENDING");

  const caseRoot = arsenkinOrionCaseRoot(input.caseId);
  const tempRoot = join(caseRoot, `.arsenkin-sync-tmp-${process.pid}-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });

  let orphanedEvidenceIds: string[] = [];
  try {
    await rebuild(input.caseId, input.reportRunId, tempRoot, { requireAi: false });

    const queue = readJson<{ items?: Array<{ evidenceId?: string; id?: string }> }>(
      join(tempRoot, "manual-review-queue.json")
    );
    const evidenceIds = new Set(
      (queue?.items ?? [])
        .map((i) => i.evidenceId ?? i.id)
        .filter((x): x is string => Boolean(x))
    );

    const reapplied: typeof preserved = [];
    for (const d of preserved) {
      if (evidenceIds.has(d.evidenceId) || evidenceIds.size === 0) {
        reapplied.push(d);
      } else {
        orphanedEvidenceIds.push(d.evidenceId);
      }
    }

    const merged: AdminReviewDecisionSet = {
      version: "r10-5-admin-review-decisions-v1",
      caseId: input.caseId,
      generatedAt: existing?.generatedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      qaSampleOnly: false,
      decisions: reapplied,
    };
    writeJsonAtomic(join(tempRoot, "admin-review-decisions.json"), merged);
    writeJsonAtomic(join(tempRoot, "arsenkin-ui-sync-diagnostics.json"), {
      orphanedEvidenceIds,
      preservedCount: reapplied.length,
      reportRunId: input.reportRunId,
    });

    // Atomic promote: move key artifacts into case root
    for (const name of [
      "orion-client-content.post-review.json",
      "orion-client-content.pre-review.json",
      "client-content-binding.json",
      "admin-review-decisions.json",
      "run-scoped-serp-merge.json",
      "manual-review-queue.json",
    ]) {
      const src = join(tempRoot, name);
      if (!existsSync(src)) continue;
      const dest = join(caseRoot, name);
      writeFileSync(dest, readFileSync(src));
    }

    writeJsonAtomic(join(caseRoot, "arsenkin-ui-sync.json"), {
      synced: true,
      reportRunId: input.reportRunId,
      stage: input.stage,
      at: new Date().toISOString(),
      observationCount: obs.length,
    });

    const merge = readJson<{ usedRunScoped?: boolean; observationCount?: number }>(
      join(caseRoot, "run-scoped-serp-merge.json")
    );
    if (merge && merge.usedRunScoped === false) {
      throw new ConflictError("run-scoped merge не использован");
    }
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  if (getArsenkinNetworkCallCount() !== 0) {
    throw new ConflictError("sync leaked network calls");
  }

  const status = await getArsenkinUiStatus(
    input.caseId,
    input.reportRunId,
    input.stage,
    input.deps
  );
  return { ...status, status: "SYNCED", synced: true, orphanedEvidenceIds };
}

export function parseArsenkinUiStage(raw: unknown): ArsenkinUiStage {
  const s = String(raw ?? "").trim();
  if (s === "SUGGEST_RU_CANARY" || s === "FIRST36_STAGE1" || s === "FIRST36_STAGE2") return s;
  throw new ValidationError(`Неизвестная стадия: ${s || "empty"}`);
}

/** Public API DTO — never includes token, DSN, authorization, or raw provider payloads. */
export function toPublicArsenkinUiDto(
  dto: ArsenkinUiStatusDto | ArsenkinUiPlanDto
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    enabled: dto.enabled,
    configured: dto.configured,
    caseId: dto.caseId,
    workflow: dto.workflow,
    stage: dto.stage,
    reportRunId: dto.reportRunId,
    status: dto.status,
    verdict: dto.verdict,
    tools: dto.tools,
    planDigest: dto.planDigest,
    plannedRequests: dto.plannedRequests ?? [],
    plannedNewTasks: dto.plannedNewTasks,
    estimatedLimitsTotal: dto.estimatedLimitsTotal,
    maxNewTasks: dto.maxNewTasks,
    maxEstimatedLimits: dto.maxEstimatedLimits,
    networkCalls: dto.networkCalls,
    collectorCalls: dto.collectorCalls,
    providerTaskCount: dto.providerTaskCount,
    observationCount: dto.observationCount,
    coverageCount: dto.coverageCount,
    blockers: dto.blockers,
    lastError: dto.lastError,
    canPrepare: dto.canPrepare,
    canPlan: dto.canPlan,
    canExecute: dto.canExecute,
    canSync: dto.canSync,
    synced: dto.synced,
    updatedAt: dto.updatedAt,
    humanMessages: dto.humanMessages,
  };
  if ("requests" in dto && Array.isArray((dto as ArsenkinUiPlanDto).requests)) {
    const plan = dto as ArsenkinUiPlanDto;
    base.requests = plan.requests;
    base.plannedRequests = plan.plannedRequests?.length ? plan.plannedRequests : plan.requests;
    base.digest = plan.digest ?? plan.planDigest;
  }
  return base;
}
