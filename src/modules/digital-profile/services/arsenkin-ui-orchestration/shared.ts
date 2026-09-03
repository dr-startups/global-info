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
import { arsenkinTools } from "../../providers/arsenkin/flags";
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
  ArsenkinRecoveryUiState,
  ArsenkinSurfaceMatrixRow,
  ArsenkinSurfaceMatrixStatus,
  RebuildClientContentFn,
} from "./types";

export const DEFAULT_DB_READINESS = getDefaultReadinessArtifactPath();

export const FULL_FIRST36_SURFACE_MATRIX: Array<
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

export function toRegionBucket(value: string): "RU" | "UAE" {
  return /UAE|AE|INTL/i.test(String(value ?? "")) ? "UAE" : "RU";
}

/**
 * Бюджет стадии — и её состав инструментов.
 *
 * Состав спрашивается у `arsenkinTools()`, а не перечисляется здесь второй раз:
 * пока списков было три (здесь, у агентов и в кнопке целевого повтора), стадия
 * обещала инструменты, которых в прогоне нет, — а в режиме `topvisor` обещала
 * бы платный `suggest`, который собирает уже Topvisor.
 */
export function arsenkinBudgetForStage(
  stage: ArsenkinUiStage,
  env: NodeJS.ProcessEnv = process.env
): {
  maxNewTasks: number;
  maxEstimatedLimits: number;
  tools: string[];
} {
  const enabled = arsenkinTools(env) as readonly string[];
  const only = (tools: string[]): string[] => tools.filter((t) => enabled.includes(t));
  if (stage === "SUGGEST_RU_CANARY") {
    return { maxNewTasks: 2, maxEstimatedLimits: 2, tools: only(["suggest"]) };
  }
  if (stage === "FIRST36_STAGE1") {
    return {
      maxNewTasks: 20,
      maxEstimatedLimits: 20,
      tools: only(["check-top", "suggest", "paa"]),
    };
  }
  return {
    maxNewTasks: 10,
    maxEstimatedLimits: 10,
    tools: only(["ai-serp", "check-h", "indexation"]),
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
  /** Canonical pre-Arsenkin ORION base — never an orion-arsenkin-* id. */
  baseOrionReportRunId?: string;
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

export function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function humanizeBlockers(blockers: string[], readinessCode?: ArsenkinReadinessCode | null): string[] {
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

export function engineMatchesCell(planOrRowEngine: string, cellEngine: string): boolean {
  const eng = String(planOrRowEngine ?? "").toUpperCase();
  const cell = String(cellEngine ?? "").toUpperCase();
  if (cell === "MULTI") return true;
  if (eng === cell) return true;
  // MIXED RU check-top covers both YANDEX and GOOGLE organic cells.
  if (eng === "MIXED" && (cell === "YANDEX" || cell === "GOOGLE")) return true;
  return false;
}

export function buildSurfaceMatrix(input: {
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

export function productionDeps(prisma: PrismaClient): CanonicalStageDeps {
  return createProductionCanonicalStageDeps(prisma, {
    getNetworkCalls: getArsenkinNetworkCallCount,
  });
}

export async function resolveSourceReportRunId(
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

export function loadDbReadiness(path: string): ArsenkinDbReadinessArtifact | null {
  return readJson<ArsenkinDbReadinessArtifact>(path);
}

export function readinessBlockers(path: string): string[] {
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

export async function resolveDbReadinessGate(
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

export async function ensureBindingArtifacts(
  caseId: string,
  reportRunId: string,
  outRoot: string,
  rebuild: RebuildClientContentFn | null
): Promise<void> {
  mkdirSync(outRoot, { recursive: true });
  // Diagnostic-only default: no legacy client-content rebuild. A test-injected
  // rebuild still exercises the legacy promote path.
  if (rebuild) {
    await rebuild(caseId, reportRunId, outRoot, { requireAi: false });
  }
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

