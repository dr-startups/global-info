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

import type {
  ArsenkinUiOrchestrationDeps,
  ArsenkinUiPlanRequestDto,
  ArsenkinUiStage,
  ArsenkinUiStatusCode,
  ArsenkinUiStatusDto,
} from "./types";
import {
  DEFAULT_DB_READINESS,
  arsenkinBudgetForStage,
  arsenkinCanaryOutRoot,
  arsenkinOrionCaseRoot,
  buildRecoveryUiState,
  buildSurfaceMatrix,
  hasBlockingRecovery,
  humanizeBlockers,
  loadArsenkinUiRunMapping,
  loadDbReadiness,
  productionDeps,
  readinessBlockers,
  readJson,
  resolveDbReadinessGate,
  resolveMappedArsenkinReportRunId,
  resolveSourceReportRunId,
} from "./shared";

export async function refreshArsenkinDbReadinessForUi(
  deps: ArsenkinUiOrchestrationDeps = {}
): Promise<EnsureArsenkinDbReadinessResult> {
  const dbReadinessPath = deps.dbReadinessPath ?? DEFAULT_DB_READINESS;
  if (deps.ensureDbReadiness) {
    return deps.ensureDbReadiness({ force: true, wait: true });
  }
  return refreshArsenkinDbReadiness({
    outPath: dbReadinessPath,
    prisma: deps.prisma,
  });
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
  const sourceFromClientOrQueue = await resolveSourceReportRunId(prisma, caseId, reportRunId);
  const workflowHint = stageHint ? workflowForStage(stageHint) : null;

  // Prefer active FIRST36_FULL job as canonical status scope (never mix canary ledger).
  const fullJob = getArsenkinFullAuditStatus(caseId, "first36-full");
  // Prefer FIRST36_FULL mapping/ledger when UI asks for Full (or no stage + active full job).
  // Never use canary ledger for Full status aggregates.
  const preferFullJob =
    workflowHint === "first36-full" ||
    stageHint === "FIRST36_STAGE1" ||
    stageHint === "FIRST36_STAGE2" ||
    (!stageHint && Boolean(fullJob) && isActiveOrchestrationState(fullJob!.state));

  const mappingWorkflow = (preferFullJob ? "first36-full" : workflowHint) as ArsenkinWorkflow | null;
  const mapping = mappingWorkflow ? loadArsenkinUiRunMapping(caseId, mappingWorkflow) : null;
  const sourceReportRunId = mapping?.sourceReportRunId ?? sourceFromClientOrQueue;
  const arsenkinReportRunId =
    preferFullJob && fullJob
      ? fullJob.jobReportRunId || fullJob.reportRunId
      : (mapping?.arsenkinReportRunId ?? null);
  const runId = arsenkinReportRunId ?? sourceReportRunId;
  const jobReportRunId = preferFullJob && fullJob ? fullJob.jobReportRunId || fullJob.reportRunId : arsenkinReportRunId;
  const previousBindingReportRunId =
    loadArsenkinUiRunMapping(caseId, "suggest-canary")?.arsenkinReportRunId ?? null;
  const blockers: string[] = [];
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();

  if (!enabled || !configured) {
    return {
      enabled,
      configured,
      caseId,
      workflow: workflowHint,
      stage: stageHint ?? null,
      reportRunId: runId,
      sourceReportRunId,
      arsenkinReportRunId,
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
      transferStatus: null,
      effectiveReportRunId: null,
      transferredAt: null,
      updatedAt: nowIso,
      humanMessages: ["Arsenkin API не подключён на сервере."],
      readinessCode: "READINESS_NOT_REQUIRED",
      canRefreshReadiness: false,
      surfaceMatrix: [],
    };
  }

  const readiness = await resolveDbReadinessGate(deps, { wait: false });
  if (readiness.running || readiness.readinessCode === "READINESS_RUNNING") {
    blockers.push(...readiness.blockers);
  } else if (readiness.blockers.length) {
    blockers.push(...readiness.blockers);
  }
  const readinessCode = readiness.readinessCode;

  let stage: ArsenkinUiStage | null = stageHint ?? mapping?.stage ?? null;
  let workflow: ArsenkinWorkflow | null = workflowHint ?? mapping?.workflow ?? null;
  if (preferFullJob) {
    workflow = "first36-full";
    if (!stage || stage === "SUGGEST_RU_CANARY") {
      stage = stageHint === "FIRST36_STAGE2" ? "FIRST36_STAGE2" : "FIRST36_STAGE1";
    }
  }
  let stageStatus: string | null = null;
  let planDigest: string | null = null;
  let lastError: string | null = null;
  let plannedRequests: ArsenkinUiPlanRequestDto[] = [];
  let plannedNewTasksFromArt: number | null = null;
  let estimatedLimitsFromArt: number | null = null;
  let uiStatus: ArsenkinUiStatusCode =
    readiness.running || readiness.readinessCode === "READINESS_RUNNING"
      ? "READINESS_RUNNING"
      : blockers.length
        ? "BLOCKED"
        : "READY_TO_PREPARE";

  const ledgerRunId = jobReportRunId ?? arsenkinReportRunId;
  const [providerTaskCount, observationCount, coverageCount, coverageRowsRaw, observationRowsRaw, providerTasksRaw] =
    ledgerRunId
      ? await (async () => {
          const anyPrisma = prisma as unknown as {
            surfaceCollectionCoverage?: { findMany?: (...args: unknown[]) => Promise<unknown[]> };
            serpObservation?: { findMany?: (...args: unknown[]) => Promise<unknown[]> };
            providerTask?: { findMany?: (...args: unknown[]) => Promise<unknown[]> };
          };
          const coverageRowsPromise =
            typeof anyPrisma.surfaceCollectionCoverage?.findMany === "function"
              ? prisma.surfaceCollectionCoverage.findMany({
                  where: { reportRunId: ledgerRunId, provider: "arsenkin" },
                  select: {
                    tool: true,
                    engine: true,
                    region: true,
                    surface: true,
                    status: true,
                    providerTaskId: true,
                  },
                })
              : Promise.resolve([]);
          const observationRowsPromise =
            typeof anyPrisma.serpObservation?.findMany === "function"
              ? prisma.serpObservation.findMany({
                  where: { auditRunId: ledgerRunId, provider: "arsenkin" },
                  select: { engine: true, region: true, surface: true, providerTaskId: true },
                })
              : Promise.resolve([]);
          const providerTasksPromise =
            typeof anyPrisma.providerTask?.findMany === "function"
              ? prisma.providerTask.findMany({
                  where: { reportRunId: ledgerRunId, provider: "arsenkin" },
                  select: {
                    id: true,
                    toolName: true,
                    state: true,
                    requestHash: true,
                    errorCode: true,
                    externalTaskId: true,
                    createdAt: true,
                    requestJson: true,
                    responseJson: true,
                  },
                })
              : Promise.resolve([]);
          return Promise.all([
            prisma.providerTask.count({ where: { reportRunId: ledgerRunId, provider: "arsenkin" } }),
            prisma.serpObservation.count({
              where: { auditRunId: ledgerRunId, provider: "arsenkin" },
            }),
            prisma.surfaceCollectionCoverage.count({
              where: { reportRunId: ledgerRunId, provider: "arsenkin" },
            }),
            coverageRowsPromise,
            observationRowsPromise,
            providerTasksPromise,
          ]);
        })()
      : [0, 0, 0, [], [], []];

  if (ledgerRunId) {
    const run = await prisma.orionReportRun.findUnique({ where: { id: ledgerRunId } });
    if (run && run.caseId !== caseId) {
      blockers.push("foreign-reportRunId");
      uiStatus = "BLOCKED";
    }
    if (run) {
      const stored = workflowFromRunMetadata(run.metadataJson);
      if (stored) workflow = stored;
    }
    const stages = await prisma.orionArsenkinStageRun.findMany({
      where: { reportRunId: ledgerRunId },
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
    const reportBinding = loadArsenkinReportBinding(caseId);
    const syncMarker = readJson<{ synced?: boolean; reportRunId?: string }>(
      join(arsenkinOrionCaseRoot(caseId), "arsenkin-ui-sync.json")
    );
    const contentGate = inspectArsenkinTransferContentGate(caseId);
    const transferOk =
      reportBinding &&
      reportBinding.effectiveReportRunId === ledgerRunId &&
      (reportBinding.status === "TRANSFERRED" || reportBinding.status === "REPORT_BOUND") &&
      contentGate.ok &&
      observationCount > 0 &&
      providerTaskCount > 0 &&
      coverageCount > 0;
    const legacySyncOk =
      syncMarker?.synced && syncMarker.reportRunId === ledgerRunId && !reportBinding;
    if (contentGate.reason === "CLIENT_CONTENT_NOT_PROMOTED" && uiStatus === "STAGE_DONE") {
      uiStatus = "TRANSFER_FAILED";
      lastError = "CLIENT_CONTENT_NOT_PROMOTED";
    } else if (transferOk && reportBinding.status === "REPORT_BOUND") {
      uiStatus = "REPORT_BOUND";
    } else if (transferOk) {
      uiStatus = "TRANSFERRED";
    } else if (legacySyncOk && uiStatus === "STAGE_DONE") {
      // Legacy sync without binding file — hydrate already attempted; still require content match.
      if (contentGate.ok && observationCount > 0) {
        uiStatus = "TRANSFERRED";
      } else {
        uiStatus = "TRANSFER_FAILED";
        lastError = contentGate.reason ?? "CLIENT_CONTENT_NOT_PROMOTED";
      }
    } else if (reportBinding?.status === "TRANSFER_FAILED" && uiStatus === "STAGE_DONE") {
      uiStatus = "TRANSFER_FAILED";
    } else if (uiStatus === "STAGE_DONE") {
      uiStatus = "READY_TO_TRANSFER";
    }
    const intervention = existsSync(
      join(arsenkinCanaryOutRoot(caseId, ledgerRunId), "manual-intervention-required.json")
    );
    if (intervention) uiStatus = "MANUAL_INTERVENTION_REQUIRED";

    const planArt = readJson<{
      digest?: string;
      plannedNewTasks?: number;
      estimatedLimitsTotal?: number;
      requests?: ArsenkinUiPlanRequestDto[];
    }>(join(arsenkinCanaryOutRoot(caseId, ledgerRunId), "arsenkin-live-plan.json"));
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

  if (
    blockers.length &&
    uiStatus !== "FAILED" &&
    uiStatus !== "MANUAL_INTERVENTION_REQUIRED" &&
    uiStatus !== "READINESS_RUNNING"
  ) {
    uiStatus = "BLOCKED";
  }

  const budget = stage
    ? arsenkinBudgetForStage(stage)
    : { maxNewTasks: 2, maxEstimatedLimits: 2, tools: ["suggest"] };

  const canPrepare =
    configured &&
    blockers.length === 0 &&
    Boolean(sourceReportRunId) &&
    uiStatus !== "EXECUTING" &&
    uiStatus !== "MANUAL_INTERVENTION_REQUIRED" &&
    uiStatus !== "FAILED";
  const canPlan =
    configured &&
    blockers.length === 0 &&
    Boolean(arsenkinReportRunId) &&
    (uiStatus === "PREPARED" ||
      uiStatus === "PLAN_READY" ||
      uiStatus === "READY_TO_TRANSFER" ||
      uiStatus === "TRANSFERRED" ||
      uiStatus === "REPORT_BOUND");
  const canExecute =
    configured &&
    blockers.length === 0 &&
    Boolean(arsenkinReportRunId) &&
    (uiStatus === "PLAN_READY" || uiStatus === "PREPARED");
  const canSync =
    configured &&
    Boolean(arsenkinReportRunId) &&
    (uiStatus === "READY_TO_TRANSFER" ||
      uiStatus === "TRANSFERRED" ||
      uiStatus === "REPORT_BOUND" ||
      uiStatus === "TRANSFER_FAILED");

  const reportBinding = loadArsenkinReportBinding(caseId);
  const transferComplete =
    uiStatus === "TRANSFERRED" ||
    uiStatus === "REPORT_BOUND";
  const humanMessages = [
    ...humanizeBlockers(blockers, readinessCode),
    ...(uiStatus === "TRANSFER_FAILED"
      ? [
          `Передача неполная: ${lastError ?? "CLIENT_CONTENT_NOT_PROMOTED"}. PDF заблокирован до пересборки client content.`,
        ]
      : []),
    ...(transferComplete && reportBinding
      ? [
          `Отчёт будет собран из данных Arsenkin (${reportBinding.effectiveReportRunId}).`,
          `ProviderTasks=${reportBinding.providerTaskCount}, observations=${reportBinding.observationCount}, coverage=${reportBinding.coverageCount}.`,
        ]
      : []),
  ];
  const surfaceMatrix = buildSurfaceMatrix({
    hasRun: Boolean(ledgerRunId),
    uiStatus,
    plannedRequests,
    coverageRows: coverageRowsRaw.map((r) => ({
      tool: String((r as { tool?: string }).tool ?? ""),
      engine: String((r as { engine?: string }).engine ?? ""),
      region: String((r as { region?: string }).region ?? ""),
      surface: String((r as { surface?: string }).surface ?? ""),
      status: String((r as { status?: string }).status ?? ""),
      providerTaskId: (r as { providerTaskId?: string | null }).providerTaskId ?? null,
    })),
    observations: observationRowsRaw.map((r) => ({
      engine: String((r as { engine?: string }).engine ?? ""),
      region: String((r as { region?: string }).region ?? ""),
      surface: String((r as { surface?: string }).surface ?? ""),
    })),
    providerTasks: providerTasksRaw.map((t) => {
      const row = t as {
        id: string;
        toolName: string;
        state: string;
        requestJson?: unknown;
      };
      const data =
        row.requestJson && typeof row.requestJson === "object" && !Array.isArray(row.requestJson)
          ? (row.requestJson as { data?: Record<string, unknown> }).data ?? {}
          : {};
      const se = data.se;
      let engine: string | null = null;
      let region: string | null = data.region != null ? String(data.region) : null;
      if (typeof se === "number") engine = se === 1 ? "YANDEX" : "GOOGLE";
      else if (Array.isArray(se) && se.length > 1) engine = "MIXED";
      else if (Array.isArray(se) && se[0] && typeof se[0] === "object") {
        const type = Number((se[0] as { type?: number }).type ?? 0);
        engine = type === 1 ? "YANDEX" : "GOOGLE";
        if ((se[0] as { region?: number }).region != null) {
          region = String((se[0] as { region?: number }).region);
        }
      }
      return {
        id: row.id,
        toolName: row.toolName,
        state: row.state,
        engine,
        region,
      };
    }),
  });

  const recovery = buildRecoveryUiState({
    caseId,
    reportRunId: ledgerRunId,
    providerTasks: providerTasksRaw as Array<{
      id: string;
      toolName: string;
      state: string;
      requestHash: string;
      errorCode: string | null;
      externalTaskId: string | null;
      createdAt: Date;
      requestJson: unknown;
      responseJson: unknown;
    }>,
    observationRows: observationRowsRaw as Array<{ providerTaskId?: string | null }>,
    stageStatus,
    uiStatus,
    coverageRows: coverageRowsRaw as Array<{ status: string }>,
  });

  return {
    enabled,
    configured,
    caseId,
    workflow,
    stage,
    reportRunId: arsenkinReportRunId ?? sourceReportRunId,
    sourceReportRunId,
    arsenkinReportRunId,
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
    lastError: reportBinding?.status === "TRANSFER_FAILED" ? reportBinding.lastError ?? lastError : lastError,
    canPrepare,
    canPlan,
    canExecute: canExecute && Boolean(planDigest),
    canSync: canSync && !hasBlockingRecovery(recovery),
    synced: transferComplete,
    transferStatus: reportBinding?.status ?? null,
    effectiveReportRunId: reportBinding?.effectiveReportRunId ?? arsenkinReportRunId,
    transferredAt: reportBinding?.transferredAt ?? null,
    updatedAt: nowIso,
    humanMessages,
    readinessCode,
    canRefreshReadiness:
      configured &&
      enabled &&
      readinessCode !== "READINESS_RUNNING" &&
      readinessCode !== "READINESS_NOT_REQUIRED",
    surfaceMatrix,
    recovery,
    jobReportRunId: jobReportRunId ?? null,
    sourceOrionReportRunId: (() => {
      const raw = sourceReportRunId;
      if (raw && isValidBaseOrionReportRunId(raw)) return raw;
      const mappedBase = mapping?.baseOrionReportRunId ?? mapping?.sourceReportRunId ?? null;
      return mappedBase && isValidBaseOrionReportRunId(mappedBase) ? mappedBase : raw;
    })(),
    baseOrionReportRunId: (() => {
      const fromMapping = mapping?.baseOrionReportRunId ?? null;
      if (fromMapping && isValidBaseOrionReportRunId(fromMapping)) return fromMapping;
      const fromBinding = reportBinding?.sourceReportRunId ?? null;
      if (fromBinding && isValidBaseOrionReportRunId(fromBinding)) return fromBinding;
      if (sourceReportRunId && isValidBaseOrionReportRunId(sourceReportRunId)) return sourceReportRunId;
      return null;
    })(),
    enrichmentReportRunId: preferFullJob
      ? jobReportRunId ?? arsenkinReportRunId
      : workflow === "first36-full"
        ? arsenkinReportRunId
        : null,
    previousEnrichmentReportRunId: previousBindingReportRunId,
    previousBindingReportRunId,
    currentlyBoundReportRunId: reportBinding?.effectiveReportRunId ?? previousBindingReportRunId,
    sourceBindingAutoRepairable: Boolean(
      fullJob &&
        (fullJob.lastErrorCode === "SOURCE_BINDING_REPAIRABLE" ||
          needsSourceBindingRepair(fullJob.sourceReportRunId) ||
          needsSourceBindingRepair(mapping?.sourceReportRunId))
    ),
    requestedWorkflowType: preferFullJob
      ? "FIRST36_FULL"
      : workflow === "suggest-canary"
        ? "SUGGEST_RU_CANARY"
        : workflow === "first36-full"
          ? "FIRST36_FULL"
          : null,
    jobWorkflowType: preferFullJob
      ? "FIRST36_FULL"
      : workflow === "suggest-canary"
        ? "SUGGEST_RU_CANARY"
        : workflow === "first36-full"
          ? "FIRST36_FULL"
          : null,
    expectedSurfaceCount: preferFullJob
      ? FIRST36_FULL_EXPECTED_SURFACES
      : workflow === "suggest-canary"
        ? SUGGEST_CANARY_EXPECTED_SURFACES
        : workflow === "first36-full"
          ? FIRST36_FULL_EXPECTED_SURFACES
          : null,
    terminalSurfaceCount: (() => {
      const rows = surfaceMatrix ?? [];
      if (!rows.length) return preferFullJob ? (fullJob?.terminalSurfaceCount ?? 0) : 0;
      return rows.filter((r) => isTerminalSurfaceStatus(String(r.status ?? ""))).length;
    })(),
    runScopedDataMismatch: null,
    orchestration: (() => {
      // Always surface FIRST36_FULL job when present for Full mode; never attach canary job to Full.
      const job =
        preferFullJob || workflow === "first36-full"
          ? getArsenkinFullAuditStatus(caseId, "first36-full")
          : getArsenkinFullAuditStatus(
              caseId,
              (workflow ?? workflowHint ?? "first36-full") as "suggest-canary" | "first36-full"
            );
      if (!job) return null;
      // Auto-resume FAILED_RETRYABLE / RECOVERING without user click.
      if (
        job.state === "FAILED_RETRYABLE" ||
        job.state === "RECOVERING" ||
        job.state === "WAITING_PROVIDER" ||
        job.state === "RUNNING"
      ) {
        scheduleOrchestrationTick(caseId, "first36-full");
      }
      const expected =
        job.expectedSurfaceCount ||
        (job.workflow === "first36-full" ? FIRST36_FULL_EXPECTED_SURFACES : SUGGEST_CANARY_EXPECTED_SURFACES);
      const terminalFromMatrix = (surfaceMatrix ?? []).filter((r) =>
        isTerminalSurfaceStatus(String(r.status ?? ""))
      ).length;
      const terminal = Math.max(job.terminalSurfaceCount ?? 0, terminalFromMatrix);
      return {
        jobId: job.jobId,
        state: job.state,
        humanPhase: job.humanPhase,
        percent: job.state === "COMPLETED" ? 100 : Math.min(99, job.percent),
        surfacesDone: terminal,
        surfacesTotal: expected,
        observationCount: job.observationCount,
        nextStep: job.nextStep,
        lastError: job.lastError,
        attempt: job.orchestrationResumeCount ?? job.attempt,
        orchestrationResumeCount: job.orchestrationResumeCount ?? 0,
        providerSubmitAttempt: job.providerSubmitAttempt ?? 0,
        providerCheckAttempt: job.providerCheckAttempt ?? 0,
        providerFetchAttempt: job.providerFetchAttempt ?? 0,
        humanMessage: job.humanMessage,
        nextRetryAt: job.nextRetryAt,
        cancelRequested: job.cancelRequested,
        requestedWorkflowType: job.requestedWorkflowType ?? "FIRST36_FULL",
        jobWorkflowType: job.jobWorkflowType ?? "FIRST36_FULL",
        jobReportRunId: job.jobReportRunId || job.reportRunId,
        sourceOrionReportRunId: job.sourceOrionReportRunId ?? job.sourceReportRunId,
        currentlyBoundReportRunId: job.currentlyBoundReportRunId,
        previousBindingReportRunId: job.previousBindingReportRunId,
        expectedSurfaceCount: expected,
        terminalSurfaceCount: terminal,
        stage1TerminalCount: job.stage1TerminalCount ?? 0,
        stage2TerminalCount: job.stage2TerminalCount ?? 0,
      };
    })(),
  };
}

