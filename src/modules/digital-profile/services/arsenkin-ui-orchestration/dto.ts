/**
 * Arsenkin UI orchestration — split from arsenkin-ui-orchestration-service.ts
 * (REMEDIATION §9.5) — mechanical move only.
 */

import { ValidationError } from "../../http/errors";
import type { ArsenkinUiPlanDto, ArsenkinUiStage, ArsenkinUiStatusDto } from "./types";

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
    orchestration: dto.orchestration ?? null,
    jobReportRunId: dto.jobReportRunId ?? null,
    sourceOrionReportRunId: dto.sourceOrionReportRunId ?? null,
    previousBindingReportRunId: dto.previousBindingReportRunId ?? null,
    currentlyBoundReportRunId: dto.currentlyBoundReportRunId ?? null,
    baseOrionReportRunId: dto.baseOrionReportRunId ?? null,
    enrichmentReportRunId: dto.enrichmentReportRunId ?? null,
    previousEnrichmentReportRunId: dto.previousEnrichmentReportRunId ?? null,
    sourceBindingAutoRepairable: dto.sourceBindingAutoRepairable ?? false,
    requestedWorkflowType: dto.requestedWorkflowType ?? null,
    jobWorkflowType: dto.jobWorkflowType ?? null,
    expectedSurfaceCount: dto.expectedSurfaceCount ?? null,
    terminalSurfaceCount: dto.terminalSurfaceCount ?? null,
    runScopedDataMismatch: dto.runScopedDataMismatch ?? null,
  };
  if ("requests" in dto && Array.isArray((dto as ArsenkinUiPlanDto).requests)) {
    const plan = dto as ArsenkinUiPlanDto;
    base.requests = plan.requests;
    base.plannedRequests = plan.plannedRequests?.length ? plan.plannedRequests : plan.requests;
    base.digest = plan.digest ?? plan.planDigest;
  }
  return base;
}


