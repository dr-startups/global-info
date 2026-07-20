/**
 * Arsenkin UI orchestration — split from arsenkin-ui-orchestration-service.ts
 * (REMEDIATION §9.5) — mechanical move only.
 */

import type { PrismaClient } from "@prisma/client";
import type { CanonicalStageCommand, CanonicalStageDeps, CanonicalStageResult } from "../../orion-golden/classic/execute-canonical-arsenkin-stage";
import type { ArsenkinLiveStage } from "../../orion-golden/classic/arsenkin-execution-plan";
import type { ArsenkinWorkflow } from "../../orion-golden/classic/arsenkin-stage-ledger";
import type { ArsenkinTransferStatus } from "../../orion-golden/classic/arsenkin-report-binding";
import type { EnsureArsenkinDbReadinessResult } from "../../providers/arsenkin/arsenkin-db-readiness-runner";
import type { ArsenkinReadinessCode } from "../../providers/arsenkin/arsenkin-db-readiness-service";

/**
 * Client-content rebuild seam. In production this is intentionally absent: a
 * standalone diagnostic Arsenkin run persists tasks/observations/coverage/
 * provenance, appends the enrichment run to the binding, updates the provider
 * delta and marks any accepted canonical report STALE — it never rebuilds the
 * client report (that is the unified CTA's job) and never calls a legacy
 * composer. Tests may inject a rebuild to exercise legacy promote behavior.
 */
export type RebuildClientContentFn = (
  caseId: string,
  reportRunId: string,
  outputRoot: string,
  options?: { requireAi?: boolean; sourceReportRunId?: string }
) => Promise<unknown>;

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
  orchestration?: {
    jobId: string;
    state: string;
    humanPhase: string;
    percent: number;
    surfacesDone: number;
    surfacesTotal: number;
    observationCount: number;
    nextStep: string;
    lastError: string | null;
    attempt: number;
    cancelRequested: boolean;
    orchestrationResumeCount?: number;
    providerSubmitAttempt?: number;
    providerCheckAttempt?: number;
    providerFetchAttempt?: number;
    humanMessage?: string | null;
    nextRetryAt?: string | null;
    requestedWorkflowType?: "SUGGEST_RU_CANARY" | "FIRST36_FULL";
    jobWorkflowType?: "SUGGEST_RU_CANARY" | "FIRST36_FULL";
    jobReportRunId?: string;
    sourceOrionReportRunId?: string | null;
    currentlyBoundReportRunId?: string | null;
    previousBindingReportRunId?: string | null;
    expectedSurfaceCount?: number;
    terminalSurfaceCount?: number;
    stage1TerminalCount?: number;
    stage2TerminalCount?: number;
  } | null;
  /** Informational — never mixed into aggregates. */
  jobReportRunId?: string | null;
  sourceOrionReportRunId?: string | null;
  previousBindingReportRunId?: string | null;
  currentlyBoundReportRunId?: string | null;
  /** Canonical pre-Arsenkin ORION base (never orion-arsenkin-*). */
  baseOrionReportRunId?: string | null;
  /** Current Arsenkin Full enrichment run. */
  enrichmentReportRunId?: string | null;
  /** Prior enrichment (e.g. suggest-canary), informational only. */
  previousEnrichmentReportRunId?: string | null;
  requestedWorkflowType?: "SUGGEST_RU_CANARY" | "FIRST36_FULL" | null;
  jobWorkflowType?: "SUGGEST_RU_CANARY" | "FIRST36_FULL" | null;
  expectedSurfaceCount?: number | null;
  terminalSurfaceCount?: number | null;
  runScopedDataMismatch?: string | null;
  /** True when source mismatch is auto-repairable — UI must not ask user to continue. */
  sourceBindingAutoRepairable?: boolean;
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
  /** Test-only legacy rebuild seam; absent in production (diagnostic-only run). */
  rebuild?: RebuildClientContentFn;
  /** Test/prod override for configured flag (token stays server-side). */
  isConfigured?: () => boolean;
  isEnabled?: () => boolean;
  /** Override Arsenkin reportRunId allocation (tests). */
  createReportRunId?: (workflow: ArsenkinWorkflow) => string;
};

