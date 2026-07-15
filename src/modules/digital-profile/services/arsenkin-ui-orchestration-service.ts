/**
 * Arsenkin UI orchestration — thin adapter over executeCanonicalArsenkinStage.
 * No CLI spawn. No parallel Arsenkin pipeline. Token never leaves the server.
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
  loadArsenkinReportBinding,
  saveArsenkinReportBinding,
  inspectArsenkinTransferContentGate,
  type ArsenkinReportBinding,
  type ArsenkinTransferStatus,
} from "../orion-golden/classic/arsenkin-report-binding";
import {
  assertDbMutationAllowed,
  computeSchemaContentHash,
  computeSourceTreeHash,
  fingerprintDatabaseUrl,
  resolveBuildIdentity,
  validateDbReadinessArtifact,
  writeJsonAtomic,
  type ArsenkinDbReadinessArtifact,
} from "../providers/arsenkin/arsenkin-db-readiness";
import {
  ensureArsenkinDbReadiness,
  refreshArsenkinDbReadiness,
  type EnsureArsenkinDbReadinessResult,
} from "../providers/arsenkin/arsenkin-db-readiness-runner";
import {
  getDefaultReadinessArtifactPath,
  humanizeReadinessCode,
  mapReadinessBlockersToCode,
  type ArsenkinReadinessCode,
} from "../providers/arsenkin/arsenkin-db-readiness-service";
import { isArsenkinConfigured, isArsenkinEnabled } from "../providers/arsenkin/flags";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../providers/arsenkin/network-guard";
import { toSubmitUnknownCandidate } from "../providers/arsenkin/submit-unknown-recovery";
import { ConflictError, ValidationError } from "../http/errors";

export type ArsenkinUiStatusCode =
  | "NOT_CONFIGURED"
  | "READINESS_RUNNING"
  | "READY_TO_PREPARE"
  | "PREPARED"
  | "PLAN_READY"
  | "EXECUTING"
  | "STAGE_DONE"
  | "SYNC_READY"
  | "READY_TO_TRANSFER"
  | "TRANSFERRING"
  | "SYNCED"
  | "TRANSFERRED"
  | "TRANSFER_FAILED"
  | "REPORT_BOUND"
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
  /** Active Arsenkin OrionReportRun id (mapped). */
  reportRunId: string | null;
  /** Manual-review / ORION source run (may differ from Arsenkin run). */
  sourceReportRunId: string | null;
  /** Explicit Arsenkin run id when mapping exists. */
  arsenkinReportRunId: string | null;
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
  /** Case-scoped transfer binding status when present. */
  transferStatus: ArsenkinTransferStatus | null;
  effectiveReportRunId: string | null;
  transferredAt: string | null;
  updatedAt: string;
  humanMessages: string[];
  readinessCode: ArsenkinReadinessCode | null;
  canRefreshReadiness: boolean;
  surfaceMatrix?: ArsenkinSurfaceMatrixRow[];
  recovery?: ArsenkinRecoveryUiState | null;
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

export type ArsenkinSurfaceMatrixStatus =
  | "NOT STARTED"
  | "PLANNED"
  | "RUNNING"
  | "MEASURED"
  | "NO RESULTS"
  | "FAILED PARSE"
  | "SUBMIT UNKNOWN"
  | "RESULT FETCH FAILED"
  | "DONE"
  | "FAILED";

export type ArsenkinSurfaceMatrixRow = {
  id: string;
  label: string;
  tool: "check-top" | "suggest" | "paa" | "ai-serp" | "check-h" | "indexation";
  engine: string;
  region: string;
  surface: string;
  status: ArsenkinSurfaceMatrixStatus;
  observationsCount: number;
  tasksCount: number;
};

export type ArsenkinRecoveryUiState = {
  submitUnknown: Array<{
    providerTaskId: string;
    toolName: string;
    requestHash: string;
    errorCode: string | null;
    externalTaskId: string | null;
    engine: string | null;
    region: string | null;
    query: string | null;
    createdAt: string;
    httpStatus: number | null;
    sanitizedRequest: Record<string, unknown>;
    sanitizedResponse: Record<string, unknown> | null;
    canLinkExisting: boolean;
    canConfirmNotCreated: boolean;
    canRetryAfterConfirm: boolean;
  }>;
  doneZeroObservations: Array<{
    providerTaskId: string;
    toolName: string;
    externalTaskId: string;
    requestHash: string;
  }>;
  canReconcileDoneZeroObs: boolean;
  canContinueStage1: boolean;
  canRetryUnconfirmed: boolean;
};

const DEFAULT_DB_READINESS = getDefaultReadinessArtifactPath();

const FULL_FIRST36_SURFACE_MATRIX: Array<
  Omit<ArsenkinSurfaceMatrixRow, "status" | "observationsCount" | "tasksCount">
> = [
  {
    id: "ru-yandex-organic",
    label: "RU Yandex organic",
    tool: "check-top",
    engine: "YANDEX",
    region: "RU",
    surface: "organic",
  },
  {
    id: "ru-google-organic",
    label: "RU Google organic",
    tool: "check-top",
    engine: "GOOGLE",
    region: "RU",
    surface: "organic",
  },
  {
    id: "uae-google-organic",
    label: "UAE Google organic",
    tool: "check-top",
    engine: "GOOGLE",
    region: "UAE",
    surface: "organic",
  },
  {
    id: "ru-yandex-suggest",
    label: "RU Yandex suggestions",
    tool: "suggest",
    engine: "YANDEX",
    region: "RU",
    surface: "autocomplete",
  },
  {
    id: "ru-google-suggest",
    label: "RU Google suggestions",
    tool: "suggest",
    engine: "GOOGLE",
    region: "RU",
    surface: "autocomplete",
  },
  {
    id: "uae-google-suggest",
    label: "UAE Google suggestions",
    tool: "suggest",
    engine: "GOOGLE",
    region: "UAE",
    surface: "autocomplete",
  },
  {
    id: "ru-google-paa",
    label: "RU Google PAA",
    tool: "paa",
    engine: "GOOGLE",
    region: "RU",
    surface: "paa",
  },
  {
    id: "uae-google-paa",
    label: "UAE Google PAA",
    tool: "paa",
    engine: "GOOGLE",
    region: "UAE",
    surface: "paa",
  },
  {
    id: "ru-yandex-ai",
    label: "RU Yandex AI",
    tool: "ai-serp",
    engine: "YANDEX",
    region: "RU",
    surface: "ai_answer",
  },
  {
    id: "ru-google-ai",
    label: "RU Google AI",
    tool: "ai-serp",
    engine: "GOOGLE",
    region: "RU",
    surface: "ai_answer",
  },
  {
    id: "uae-google-ai",
    label: "UAE Google AI",
    tool: "ai-serp",
    engine: "GOOGLE",
    region: "UAE",
    surface: "ai_answer",
  },
  {
    id: "url-audit",
    label: "URL audit",
    tool: "check-h",
    engine: "MULTI",
    region: "MIXED",
    surface: "page_meta",
  },
];

function toRegionBucket(value: string): "RU" | "UAE" {
  return /UAE|AE|INTL/i.test(String(value ?? "")) ? "UAE" : "RU";
}

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

export type ArsenkinUiRunMapping = {
  caseId: string;
  sourceReportRunId: string;
  arsenkinReportRunId: string;
  workflow: ArsenkinWorkflow;
  stage: ArsenkinUiStage;
  createdAt: string;
  updatedAt: string;
};

export function arsenkinUiRunMappingPath(caseId: string, workflow: ArsenkinWorkflow): string {
  return join(arsenkinOrionCaseRoot(caseId), `arsenkin-ui-run-mapping-${workflow}.json`);
}

export function loadArsenkinUiRunMapping(
  caseId: string,
  workflow: ArsenkinWorkflow
): ArsenkinUiRunMapping | null {
  return readJson<ArsenkinUiRunMapping>(arsenkinUiRunMappingPath(caseId, workflow));
}

export function saveArsenkinUiRunMapping(mapping: ArsenkinUiRunMapping): void {
  writeJsonAtomic(arsenkinUiRunMappingPath(mapping.caseId, mapping.workflow), mapping);
}

export function generateArsenkinReportRunId(
  workflow: ArsenkinWorkflow,
  nowMs = Date.now(),
  rand = randomBytes(4).toString("hex")
): string {
  const slug = workflow === "suggest-canary" ? "suggest-canary" : "first36-full";
  return `orion-arsenkin-${slug}-${nowMs}-${rand}`;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function humanizeBlockers(blockers: string[], readinessCode?: ArsenkinReadinessCode | null): string[] {
  if (
    readinessCode &&
    readinessCode !== "READINESS_NOT_REQUIRED" &&
    readinessCode !== "READINESS_SKIPPED"
  ) {
    const dbRelated = blockers.some((b) => /db-readiness|readiness-/i.test(b));
    if (dbRelated || readinessCode.startsWith("READINESS_")) {
      return [humanizeReadinessCode(readinessCode, blockers)];
    }
  }
  return blockers.map((b) => {
    if (/readiness-running/i.test(b)) return humanizeReadinessCode("READINESS_RUNNING");
    if (/db-readiness/i.test(b)) return humanizeReadinessCode(mapReadinessBlockersToCode([b]), [b]);
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

function engineMatchesCell(planOrRowEngine: string, cellEngine: string): boolean {
  const eng = String(planOrRowEngine ?? "").toUpperCase();
  const cell = String(cellEngine ?? "").toUpperCase();
  if (cell === "MULTI") return true;
  if (eng === cell) return true;
  // MIXED RU check-top covers both YANDEX and GOOGLE organic cells.
  if (eng === "MIXED" && (cell === "YANDEX" || cell === "GOOGLE")) return true;
  return false;
}

function buildSurfaceMatrix(input: {
  hasRun: boolean;
  uiStatus: ArsenkinUiStatusCode;
  plannedRequests: ArsenkinUiPlanRequestDto[];
  coverageRows: Array<{
    tool: string;
    engine: string;
    region: string;
    surface: string;
    status: string;
    providerTaskId?: string | null;
  }>;
  observations: Array<{ engine: string; region: string; surface: string }>;
  providerTasks: Array<{
    id: string;
    toolName: string;
    state: string;
    engine: string | null;
    region: string | null;
  }>;
}): ArsenkinSurfaceMatrixRow[] {
  return FULL_FIRST36_SURFACE_MATRIX.map((cell) => {
    const planned = input.plannedRequests.some(
      (r) =>
        r.tool === cell.tool &&
        (cell.region === "MIXED" || toRegionBucket(r.region) === cell.region) &&
        engineMatchesCell(String(r.engine ?? ""), cell.engine)
    );
    const matchingCoverage = input.coverageRows.filter(
      (r) =>
        r.tool === cell.tool &&
        (cell.region === "MIXED" || toRegionBucket(r.region) === cell.region) &&
        engineMatchesCell(String(r.engine ?? ""), cell.engine) &&
        (cell.surface === r.surface ||
          (cell.id === "url-audit" && (r.surface === "page_meta" || r.surface === "indexation")))
    );
    const matchingObs = input.observations.filter(
      (o) =>
        (cell.region === "MIXED" || toRegionBucket(o.region) === cell.region) &&
        engineMatchesCell(String(o.engine ?? ""), cell.engine) &&
        (cell.surface === o.surface ||
          (cell.id === "url-audit" && (o.surface === "page_meta" || o.surface === "indexation")))
    );
    const matchingTasks = input.providerTasks.filter((t) => {
      if (t.toolName !== cell.tool) return false;
      if (cell.region !== "MIXED" && t.region && toRegionBucket(t.region) !== cell.region) {
        // region may be arsenkin numeric; allow when engine/tool match and planned
        if (!planned && matchingCoverage.length === 0) return false;
      }
      if (t.engine && !engineMatchesCell(t.engine, cell.engine) && cell.engine !== "MULTI") {
        return false;
      }
      // Include task when planned for this cell or coverage already exists for this cell.
      return planned || matchingCoverage.some((c) => c.providerTaskId === t.id) || matchingCoverage.length > 0;
    });
    // Distinct ProviderTask count scoped to this surface (MIXED may count 1 on each engine cell).
    const taskIds = new Set<string>();
    for (const t of matchingTasks) taskIds.add(t.id);
    for (const c of matchingCoverage) {
      if (c.providerTaskId) taskIds.add(c.providerTaskId);
    }

    let status: ArsenkinSurfaceMatrixStatus = "NOT STARTED";
    if (!input.hasRun) {
      status = "NOT STARTED";
    } else if (matchingCoverage.some((r) => /^FAILED_PARSE$/i.test(r.status))) {
      status = "FAILED PARSE";
    } else if (matchingCoverage.some((r) => /^RESULT_FETCH_FAILED$/i.test(r.status))) {
      status = "RESULT FETCH FAILED";
    } else if (matchingCoverage.some((r) => /^NO_RESULTS$/i.test(r.status))) {
      status = "NO RESULTS";
    } else if (matchingCoverage.some((r) => /^(OK|MEASURED)$/i.test(r.status))) {
      status = "MEASURED";
    } else if (matchingTasks.some((t) => t.state === "SUBMIT_UNKNOWN")) {
      status = "SUBMIT UNKNOWN";
    } else if (
      matchingTasks.some((t) => /^(RUNNING|SUBMITTING|QUEUED|RATE_LIMITED)$/i.test(t.state)) ||
      input.uiStatus === "EXECUTING"
    ) {
      status = planned || matchingCoverage.length > 0 || matchingTasks.length > 0 ? "RUNNING" : "NOT STARTED";
    } else if (matchingTasks.some((t) => /^(FAILED|CANCELLED)$/i.test(t.state))) {
      status = "FAILED";
    } else if (planned) {
      status = "PLANNED";
    }

    return {
      ...cell,
      status,
      observationsCount: matchingObs.length,
      tasksCount: taskIds.size,
    };
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
  /** Override readiness checks (tests). Production uses ensureArsenkinDbReadiness. */
  readinessBlockers?: () => string[];
  ensureDbReadiness?: (input?: { force?: boolean; wait?: boolean }) => Promise<EnsureArsenkinDbReadinessResult>;
  now?: () => Date;
  rebuild?: typeof rebuildClientContentForReportRun;
  /** Test/prod override for configured flag (token stays server-side). */
  isConfigured?: () => boolean;
  isEnabled?: () => boolean;
  /** Override Arsenkin reportRunId allocation (tests). */
  createReportRunId?: (workflow: ArsenkinWorkflow) => string;
};

function productionDeps(prisma: PrismaClient): CanonicalStageDeps {
  return createProductionCanonicalStageDeps(prisma, {
    getNetworkCalls: getArsenkinNetworkCallCount,
  });
}

async function resolveSourceReportRunId(
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

/**
 * Plan/execute/sync must use server mapping. Client may pass source OR arsenkin id;
 * foreign ids are rejected.
 */
export function resolveMappedArsenkinReportRunId(input: {
  caseId: string;
  workflow: ArsenkinWorkflow;
  clientReportRunId?: string | null;
  requireMapping: boolean;
}): { mapping: ArsenkinUiRunMapping | null; arsenkinReportRunId: string | null } {
  const mapping = loadArsenkinUiRunMapping(input.caseId, input.workflow);
  const client = input.clientReportRunId?.trim() || null;
  if (!mapping) {
    if (input.requireMapping) {
      throw new ConflictError("Сначала выполните prepare Arsenkin для этого workflow");
    }
    return { mapping: null, arsenkinReportRunId: null };
  }
  if (
    client &&
    client !== mapping.sourceReportRunId &&
    client !== mapping.arsenkinReportRunId
  ) {
    throw new ConflictError(
      "Передан foreign reportRunId — используйте mapped Arsenkin run или исходный ORION run"
    );
  }
  return { mapping, arsenkinReportRunId: mapping.arsenkinReportRunId };
}

function loadDbReadiness(path: string): ArsenkinDbReadinessArtifact | null {
  return readJson<ArsenkinDbReadinessArtifact>(path);
}

function readinessBlockers(path: string): string[] {
  const art = loadDbReadiness(path);
  const build = resolveBuildIdentity();
  const dbUrl = String(process.env.DATABASE_URL ?? "");
  const mutation = assertDbMutationAllowed();
  const r = validateDbReadinessArtifact({
    artifact: art,
    currentFingerprint: fingerprintDatabaseUrl(dbUrl || "postgresql://unknown/unknown"),
    currentBuildCommit: build.buildCommit,
    currentSourceTreeHash: computeSourceTreeHash(),
    currentSchemaContentHash: computeSchemaContentHash(),
    currentDirtyTree: build.dirtyTree,
    currentEnvironment: mutation.environment,
  });
  return r.ok ? [] : r.blockers;
}

export function hasBlockingRecovery(recovery: ArsenkinRecoveryUiState | null | undefined): boolean {
  if (!recovery) return false;
  return recovery.submitUnknown.length > 0 || recovery.doneZeroObservations.length > 0;
}

export function buildRecoveryUiState(input: {
  caseId: string;
  reportRunId: string | null;
  providerTasks: Array<{
    id: string;
    toolName: string;
    state: string;
    requestHash: string;
    errorCode: string | null;
    externalTaskId: string | null;
    createdAt: Date;
    requestJson: unknown;
    responseJson: unknown;
  }>;
  observationRows: Array<{ providerTaskId?: string | null }>;
  stageStatus: string | null;
  uiStatus: string;
  coverageRows: Array<{ status: string }>;
}): ArsenkinRecoveryUiState | null {
  if (!input.reportRunId) return null;
  const outRoot = arsenkinCanaryOutRoot(input.caseId, input.reportRunId);
  const obsByTask = new Map<string, number>();
  for (const o of input.observationRows) {
    if (!o.providerTaskId) continue;
    obsByTask.set(o.providerTaskId, (obsByTask.get(o.providerTaskId) ?? 0) + 1);
  }

  const submitUnknown: ArsenkinRecoveryUiState["submitUnknown"] = [];
  const doneZeroObservations: ArsenkinRecoveryUiState["doneZeroObservations"] = [];
  for (const t of input.providerTasks) {
    if (t.state === "SUBMIT_UNKNOWN") {
      const cand = toSubmitUnknownCandidate(
        {
          id: t.id,
          caseId: input.caseId,
          reportRunId: input.reportRunId,
          provider: "arsenkin",
          toolName: t.toolName,
          externalTaskId: t.externalTaskId,
          requestHash: t.requestHash,
          state: "SUBMIT_UNKNOWN",
          attempts: 0,
          nextPollAt: null,
          errorCode: t.errorCode,
          limitsSpent: null,
          lockedBy: null,
          lockedAt: null,
          leaseUntil: null,
          submittedAt: null,
          latencyMs: null,
          limitsBefore: null,
          limitsAfter: null,
          requestJson:
            t.requestJson && typeof t.requestJson === "object"
              ? (t.requestJson as Record<string, unknown>)
              : {},
          responseJson:
            t.responseJson && typeof t.responseJson === "object"
              ? (t.responseJson as Record<string, unknown>)
              : null,
          createdAt: t.createdAt,
          completedAt: null,
          updatedAt: t.createdAt,
        },
        outRoot
      );
      if (cand) {
        submitUnknown.push({
          providerTaskId: cand.providerTaskId,
          toolName: cand.toolName,
          requestHash: cand.requestHash,
          errorCode: cand.errorCode,
          externalTaskId: cand.externalTaskId,
          engine: cand.engine,
          region: cand.region,
          query: cand.query,
          createdAt: cand.createdAt,
          httpStatus: cand.httpStatus,
          sanitizedRequest: cand.sanitizedRequest,
          sanitizedResponse: cand.sanitizedResponse,
          canLinkExisting: cand.canLinkExisting,
          canConfirmNotCreated: cand.canConfirmNotCreated,
          canRetryAfterConfirm: cand.canRetryAfterConfirm,
        });
      }
    }
    if (t.state === "DONE" && t.externalTaskId && (obsByTask.get(t.id) ?? 0) === 0) {
      doneZeroObservations.push({
        providerTaskId: t.id,
        toolName: t.toolName,
        externalTaskId: t.externalTaskId,
        requestHash: t.requestHash,
      });
    }
  }

  const hasFailedParse = input.coverageRows.some((c) => /^FAILED_PARSE$/i.test(c.status));
  const hasFetchFailed = input.coverageRows.some((c) => /^RESULT_FETCH_FAILED$/i.test(c.status));
  const canRetryUnconfirmed = submitUnknown.some((s) => s.canRetryAfterConfirm);
  const canContinueStage1 =
    submitUnknown.length === 0 &&
    doneZeroObservations.length === 0 &&
    !hasFailedParse &&
    !hasFetchFailed &&
    (input.stageStatus === "FAILED" ||
      input.uiStatus === "FAILED" ||
      input.uiStatus === "MANUAL_INTERVENTION_REQUIRED" ||
      input.uiStatus === "PREPARED" ||
      input.uiStatus === "PLAN_READY");

  return {
    submitUnknown,
    doneZeroObservations,
    canReconcileDoneZeroObs: doneZeroObservations.length > 0,
    canContinueStage1,
    canRetryUnconfirmed,
  };
}

async function resolveDbReadinessGate(
  deps: ArsenkinUiOrchestrationDeps,
  input?: { force?: boolean; wait?: boolean }
): Promise<{
  blockers: string[];
  readinessCode: ArsenkinReadinessCode;
  running: boolean;
}> {
  const dbReadinessPath = deps.dbReadinessPath ?? DEFAULT_DB_READINESS;
  if (deps.readinessBlockers) {
    const blockers = deps.readinessBlockers();
    return {
      blockers,
      readinessCode: mapReadinessBlockersToCode(blockers),
      running: false,
    };
  }
  const ensure =
    deps.ensureDbReadiness ??
    ((opts) =>
      ensureArsenkinDbReadiness({
        outPath: dbReadinessPath,
        prisma: deps.prisma,
        force: opts?.force,
        wait: opts?.wait,
      }));
  const outcome = await ensure({ force: input?.force, wait: input?.wait });
  return {
    blockers: outcome.blockers,
    readinessCode: outcome.readinessCode,
    running: outcome.running,
  };
}

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
  const mapping = workflowHint ? loadArsenkinUiRunMapping(caseId, workflowHint) : null;
  const sourceReportRunId = mapping?.sourceReportRunId ?? sourceFromClientOrQueue;
  const arsenkinReportRunId = mapping?.arsenkinReportRunId ?? null;
  const runId = arsenkinReportRunId ?? sourceReportRunId;
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

  const ledgerRunId = arsenkinReportRunId;
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
  const existingMapping = loadArsenkinUiRunMapping(input.caseId, workflow);

  // Idempotent reuse of mapping — never auto-create a second Arsenkin run.
  if (existingMapping) {
    if (existingMapping.sourceReportRunId !== sourceReportRunId) {
      throw new ConflictError(
        `Workflow ${workflow} уже привязан к source ${existingMapping.sourceReportRunId}`
      );
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

/**
 * Sync Arsenkin observations into ORION Golden case root without Arsenkin network.
 * Preserves existing non-pending admin decisions by evidenceId.
 * Atomically writes case-scoped arsenkin-report-binding.json (canonical effectiveReportRunId).
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

  const workflow = workflowForStage(input.stage);
  const { mapping, arsenkinReportRunId } = resolveMappedArsenkinReportRunId({
    caseId: input.caseId,
    workflow,
    clientReportRunId: input.reportRunId,
    requireMapping: true,
  });
  if (!arsenkinReportRunId || !mapping) {
    throw new ConflictError("Arsenkin reportRunId mapping отсутствует");
  }

  const run = await prisma.orionReportRun.findUnique({ where: { id: arsenkinReportRunId } });
  if (!run || run.caseId !== input.caseId) {
    throw new ConflictError("Arsenkin reportRunId не принадлежит кейсу");
  }

  const stageRow = await prisma.orionArsenkinStageRun.findFirst({
    where: { reportRunId: arsenkinReportRunId, stage: input.stage },
  });
  if (!stageRow || stageRow.status !== "DONE") {
    throw new ConflictError("Sync доступен только после STAGE_DONE");
  }

  if (workflow === "first36-full") {
    const stages = await prisma.orionArsenkinStageRun.findMany({
      where: { reportRunId: arsenkinReportRunId },
    });
    const s1 = stages.find((s) => s.stage === "FIRST36_STAGE1");
    const s2 = stages.find((s) => s.stage === "FIRST36_STAGE2");
    if (input.stage === "FIRST36_STAGE2" || (s1?.status === "DONE" && s2?.status === "DONE")) {
      if (s1?.status !== "DONE" || s2?.status !== "DONE") {
        if (input.stage === "FIRST36_STAGE2" && s2?.status !== "DONE") {
          throw new ConflictError("Полный First36 sync требует обе стадии DONE");
        }
      }
    }
  }

  const obs = await prisma.serpObservation.findMany({
    where: { auditRunId: arsenkinReportRunId, provider: "arsenkin" },
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
      const has = obs.some((o) => o.region === "RU" && (o.surface === "autocomplete" || o.surface === "organic"));
      if (!has) throw new ConflictError("Canary sync ожидает RU suggest observations");
    }
  }

  const [providerTaskCount, coverageCount] = await Promise.all([
    prisma.providerTask.count({ where: { reportRunId: arsenkinReportRunId, provider: "arsenkin" } }),
    prisma.surfaceCollectionCoverage.count({
      where: { reportRunId: arsenkinReportRunId, provider: "arsenkin" },
    }),
  ]);

  const existingBinding = loadArsenkinReportBinding(input.caseId);
  const caseRoot = arsenkinOrionCaseRoot(input.caseId);
  const postReviewPath = join(caseRoot, "orion-client-content.post-review.json");

  // Idempotent replay: same effective run already transferred with matching client content.
  if (
    existingBinding &&
    (existingBinding.status === "TRANSFERRED" || existingBinding.status === "REPORT_BOUND") &&
    existingBinding.effectiveReportRunId === arsenkinReportRunId &&
    existsSync(postReviewPath)
  ) {
    const post = readJson<{ reportRunId?: string; caseId?: string }>(postReviewPath);
    if (post?.reportRunId === arsenkinReportRunId && post?.caseId === input.caseId) {
      if (getArsenkinNetworkCallCount() !== 0) {
        throw new ConflictError("sync leaked network calls");
      }
      const status = await getArsenkinUiStatus(
        input.caseId,
        input.reportRunId,
        input.stage,
        input.deps
      );
      return { ...status, status: "TRANSFERRED", synced: true, orphanedEvidenceIds: [] };
    }
  }

  const existing = loadAdminReviewDecisions(input.caseId);
  if (existing?.qaSampleOnly) {
    throw new ConflictError("QA sample decisions cannot sync to production");
  }
  const preserved = (existing?.decisions ?? []).filter((d) => d.status !== "PENDING");

  saveArsenkinReportBinding({
    caseId: input.caseId,
    sourceReportRunId: mapping.sourceReportRunId,
    effectiveReportRunId: arsenkinReportRunId,
    provider: "arsenkin",
    workflow,
    stage: input.stage,
    status: "TRANSFERRING",
    transferredAt: new Date().toISOString(),
    providerTaskCount,
    observationCount: obs.length,
    coverageCount,
    lastError: null,
  });

  const tempRoot = join(caseRoot, `.arsenkin-sync-tmp-${process.pid}-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });

  let orphanedEvidenceIds: string[] = [];
  try {
    await rebuild(input.caseId, arsenkinReportRunId, tempRoot, {
      requireAi: false,
      sourceReportRunId: mapping.sourceReportRunId,
    });

    const rebuiltPost = readJson<{ reportRunId?: string; caseId?: string }>(
      join(tempRoot, "orion-client-content.post-review.json")
    );
    if (!rebuiltPost || rebuiltPost.reportRunId !== arsenkinReportRunId) {
      throw new ConflictError(
        `ARSENKIN_CLIENT_CONTENT_RUN_MISMATCH: rebuilt reportRunId=${rebuiltPost?.reportRunId ?? "missing"} expected=${arsenkinReportRunId}`
      );
    }

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
    writeJsonAtomic(join(tempRoot, "client-content-binding.json"), {
      sourceReportRunId: mapping.sourceReportRunId,
      effectiveReportRunId: arsenkinReportRunId,
      overridden: false,
      rebuilt: true,
    });
    writeJsonAtomic(join(tempRoot, "arsenkin-ui-sync-diagnostics.json"), {
      orphanedEvidenceIds,
      preservedCount: reapplied.length,
      reportRunId: arsenkinReportRunId,
      sourceReportRunId: mapping.sourceReportRunId,
    });

    // Atomic promote: case-root artifacts including inventory (prevents regenerate fallback).
    for (const name of [
      "orion-client-content.post-review.json",
      "orion-client-content.pre-review.json",
      "orion-client-content.post-review.md",
      "orion-client-content.pre-review.md",
      "client-content-binding.json",
      "admin-review-decisions.json",
      "run-scoped-serp-merge.json",
      "manual-review-queue.json",
      "full-evidence-inventory.json",
      "evidence-judgment-inspection.json",
      "r10-4-evidence-bundles.json",
      "report-assets.json",
      "final-deck-manifest.json",
    ]) {
      const src = join(tempRoot, name);
      if (!existsSync(src)) continue;
      const dest = join(caseRoot, name);
      writeFileSync(dest, readFileSync(src));
    }

    const merge = readJson<{ usedRunScoped?: boolean; observationCount?: number; auditRunId?: string }>(
      join(caseRoot, "run-scoped-serp-merge.json")
    );
    if (merge && merge.usedRunScoped === false) {
      throw new ConflictError("run-scoped merge не использован");
    }
    if (merge?.auditRunId && merge.auditRunId !== arsenkinReportRunId) {
      throw new ConflictError(
        `ARSENKIN_REPORT_BINDING_MISMATCH: merge.auditRunId=${merge.auditRunId} expected=${arsenkinReportRunId}`
      );
    }

    const transferredAt = new Date().toISOString();
    const bindingPayload: ArsenkinReportBinding = {
      caseId: input.caseId,
      sourceReportRunId: mapping.sourceReportRunId,
      effectiveReportRunId: arsenkinReportRunId,
      provider: "arsenkin",
      workflow,
      stage: input.stage,
      status: "TRANSFERRED",
      transferredAt,
      providerTaskCount,
      observationCount: obs.length,
      coverageCount,
      lastError: null,
    };
    saveArsenkinReportBinding(bindingPayload);
    writeJsonAtomic(join(caseRoot, "arsenkin-ui-sync.json"), {
      synced: true,
      reportRunId: arsenkinReportRunId,
      sourceReportRunId: mapping.sourceReportRunId,
      effectiveReportRunId: arsenkinReportRunId,
      stage: input.stage,
      workflow,
      status: "TRANSFERRED",
      at: transferredAt,
      observationCount: obs.length,
      providerTaskCount,
      coverageCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    saveArsenkinReportBinding({
      caseId: input.caseId,
      sourceReportRunId: mapping.sourceReportRunId,
      effectiveReportRunId: arsenkinReportRunId,
      provider: "arsenkin",
      workflow,
      stage: input.stage,
      status: "TRANSFER_FAILED",
      transferredAt: new Date().toISOString(),
      providerTaskCount,
      observationCount: obs.length,
      coverageCount,
      lastError: message,
    });
    throw err;
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
  return { ...status, status: "TRANSFERRED", synced: true, orphanedEvidenceIds };
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
    sourceReportRunId: dto.sourceReportRunId,
    arsenkinReportRunId: dto.arsenkinReportRunId,
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
    transferStatus: dto.transferStatus,
    effectiveReportRunId: dto.effectiveReportRunId,
    transferredAt: dto.transferredAt,
    updatedAt: dto.updatedAt,
    humanMessages: dto.humanMessages,
    readinessCode: dto.readinessCode,
    canRefreshReadiness: dto.canRefreshReadiness,
    surfaceMatrix: dto.surfaceMatrix ?? [],
    recovery: dto.recovery ?? null,
  };
  if ("requests" in dto && Array.isArray((dto as ArsenkinUiPlanDto).requests)) {
    const plan = dto as ArsenkinUiPlanDto;
    base.requests = plan.requests;
    base.plannedRequests = plan.plannedRequests?.length ? plan.plannedRequests : plan.requests;
    base.digest = plan.digest ?? plan.planDigest;
  }
  return base;
}
