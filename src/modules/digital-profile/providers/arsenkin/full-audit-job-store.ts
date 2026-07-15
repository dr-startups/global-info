/**
 * Durable file-backed Arsenkin full-audit orchestration job store.
 * No Prisma migration: lease/CAS via atomic JSON rewrite under case storage.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type ArsenkinOrchestrationState =
  | "PREFLIGHT"
  | "PLANNING"
  | "STAGE1_SUBMITTING"
  | "STAGE1_POLLING"
  | "STAGE1_FETCHING"
  | "STAGE1_PARSING"
  | "STAGE2_SUBMITTING"
  | "STAGE2_POLLING"
  | "STAGE2_FETCHING"
  | "STAGE2_PARSING"
  | "BINDING"
  | "RENDERING"
  | "COMPLETED"
  | "COMPLETED_PARTIAL"
  | "WAITING_PROVIDER"
  | "WAITING_INFRASTRUCTURE"
  | "FAILED_RETRYABLE"
  | "FAILED_TERMINAL"
  | "CANCELLED";

export type ArsenkinOrchestrationJob = {
  version: "arsenkin-full-audit-job-v1";
  jobId: string;
  caseId: string;
  workflow: "suggest-canary" | "first36-full";
  /** Strict identity: SUGGEST_RU_CANARY | FIRST36_FULL */
  requestedWorkflowType: "SUGGEST_RU_CANARY" | "FIRST36_FULL";
  jobWorkflowType: "SUGGEST_RU_CANARY" | "FIRST36_FULL";
  /** Canonical job run — never a foreign canary/ORION binding. */
  reportRunId: string;
  jobReportRunId: string;
  sourceReportRunId: string;
  sourceOrionReportRunId: string;
  currentlyBoundReportRunId: string | null;
  previousBindingReportRunId: string | null;
  state: ArsenkinOrchestrationState;
  humanPhase: string;
  percent: number;
  surfacesDone: number;
  surfacesTotal: number;
  expectedSurfaceCount: number;
  terminalSurfaceCount: number;
  stage1TerminalCount: number;
  stage2TerminalCount: number;
  observationCount: number;
  estimatedLimits: number | null;
  spentLimits: number | null;
  attempt: number;
  maxAttempts: number;
  nextStep: string;
  lastError: string | null;
  lastErrorCode: string | null;
  leaseOwnerId: string | null;
  leaseUntil: string | null;
  cancelRequested: boolean;
  planDigest: string | null;
  setCalls: number;
  checkCalls: number;
  getCalls: number;
  /** Per business-key submit attempts (requestHash → count). */
  submitAttemptsByHash: Record<string, number>;
  recoveryNotes: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

const ACTIVE: ArsenkinOrchestrationState[] = [
  "PREFLIGHT",
  "PLANNING",
  "STAGE1_SUBMITTING",
  "STAGE1_POLLING",
  "STAGE1_FETCHING",
  "STAGE1_PARSING",
  "STAGE2_SUBMITTING",
  "STAGE2_POLLING",
  "STAGE2_FETCHING",
  "STAGE2_PARSING",
  "BINDING",
  "RENDERING",
  "WAITING_PROVIDER",
  "WAITING_INFRASTRUCTURE",
  "FAILED_RETRYABLE",
];

export function isActiveOrchestrationState(state: ArsenkinOrchestrationState): boolean {
  return ACTIVE.includes(state);
}

export function orchestrationJobRoot(caseId: string, workflow: string): string {
  return join(
    process.cwd(),
    "storage",
    "digital-profile",
    "arsenkin-orchestration",
    caseId,
    workflow
  );
}

export function orchestrationJobPath(caseId: string, workflow: string): string {
  return join(orchestrationJobRoot(caseId, workflow), "job.json");
}

function writeAtomic(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
  try {
    renameSync(tmp, path);
  } catch {
    try {
      unlinkSync(path);
    } catch {
      /* ignore */
    }
    renameSync(tmp, path);
  }
}

export function loadOrchestrationJob(
  caseId: string,
  workflow: string
): ArsenkinOrchestrationJob | null {
  const path = orchestrationJobPath(caseId, workflow);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ArsenkinOrchestrationJob> & {
      reportRunId: string;
      caseId: string;
      workflow: "suggest-canary" | "first36-full";
      state: ArsenkinOrchestrationState;
    };
    const isFull = raw.workflow === "first36-full";
    const workflowType = isFull ? "FIRST36_FULL" : "SUGGEST_RU_CANARY";
    const expected = isFull ? 12 : 2;
    const job: ArsenkinOrchestrationJob = {
      version: "arsenkin-full-audit-job-v1",
      jobId: raw.jobId ?? `job-legacy-${Date.now()}`,
      caseId: raw.caseId,
      workflow: raw.workflow,
      requestedWorkflowType: raw.requestedWorkflowType ?? workflowType,
      jobWorkflowType: raw.jobWorkflowType ?? workflowType,
      reportRunId: raw.reportRunId,
      jobReportRunId: raw.jobReportRunId ?? raw.reportRunId,
      sourceReportRunId: raw.sourceReportRunId ?? raw.reportRunId,
      sourceOrionReportRunId: raw.sourceOrionReportRunId ?? raw.sourceReportRunId ?? raw.reportRunId,
      currentlyBoundReportRunId: raw.currentlyBoundReportRunId ?? null,
      previousBindingReportRunId: raw.previousBindingReportRunId ?? null,
      state: raw.state,
      humanPhase: raw.humanPhase ?? humanPhaseForState(raw.state),
      percent: raw.percent ?? 0,
      surfacesDone: raw.surfacesDone ?? 0,
      surfacesTotal: raw.surfacesTotal ?? expected,
      expectedSurfaceCount: raw.expectedSurfaceCount ?? expected,
      terminalSurfaceCount: raw.terminalSurfaceCount ?? raw.surfacesDone ?? 0,
      stage1TerminalCount: raw.stage1TerminalCount ?? 0,
      stage2TerminalCount: raw.stage2TerminalCount ?? 0,
      observationCount: raw.observationCount ?? 0,
      estimatedLimits: raw.estimatedLimits ?? null,
      spentLimits: raw.spentLimits ?? null,
      attempt: raw.attempt ?? 1,
      maxAttempts: raw.maxAttempts ?? 3,
      nextStep: raw.nextStep ?? "preflight",
      lastError: raw.lastError ?? null,
      lastErrorCode: raw.lastErrorCode ?? null,
      leaseOwnerId: raw.leaseOwnerId ?? null,
      leaseUntil: raw.leaseUntil ?? null,
      cancelRequested: Boolean(raw.cancelRequested),
      planDigest: raw.planDigest ?? null,
      setCalls: raw.setCalls ?? 0,
      checkCalls: raw.checkCalls ?? 0,
      getCalls: raw.getCalls ?? 0,
      submitAttemptsByHash: raw.submitAttemptsByHash ?? {},
      recoveryNotes: raw.recoveryNotes ?? [],
      createdAt: raw.createdAt ?? new Date().toISOString(),
      updatedAt: raw.updatedAt ?? new Date().toISOString(),
      completedAt: raw.completedAt ?? null,
    };
    return job;
  } catch {
    return null;
  }
}

export function saveOrchestrationJob(job: ArsenkinOrchestrationJob): void {
  job.updatedAt = new Date().toISOString();
  writeAtomic(orchestrationJobPath(job.caseId, job.workflow), job);
}

export function createOrchestrationJob(input: {
  caseId: string;
  workflow: "suggest-canary" | "first36-full";
  reportRunId: string;
  sourceReportRunId: string;
  currentlyBoundReportRunId?: string | null;
  previousBindingReportRunId?: string | null;
  maxAttempts?: number;
}): ArsenkinOrchestrationJob {
  const now = new Date().toISOString();
  const isFull = input.workflow === "first36-full";
  const workflowType = isFull ? "FIRST36_FULL" : "SUGGEST_RU_CANARY";
  const expected = isFull ? 12 : 2;
  const job: ArsenkinOrchestrationJob = {
    version: "arsenkin-full-audit-job-v1",
    jobId: `job-${Date.now()}-${randomUUID().slice(0, 8)}`,
    caseId: input.caseId,
    workflow: input.workflow,
    requestedWorkflowType: workflowType,
    jobWorkflowType: workflowType,
    reportRunId: input.reportRunId,
    jobReportRunId: input.reportRunId,
    sourceReportRunId: input.sourceReportRunId,
    sourceOrionReportRunId: input.sourceReportRunId,
    currentlyBoundReportRunId: input.currentlyBoundReportRunId ?? null,
    previousBindingReportRunId: input.previousBindingReportRunId ?? null,
    state: "PREFLIGHT",
    humanPhase: "Проверка готовности",
    percent: 2,
    surfacesDone: 0,
    surfacesTotal: expected,
    expectedSurfaceCount: expected,
    terminalSurfaceCount: 0,
    stage1TerminalCount: 0,
    stage2TerminalCount: 0,
    observationCount: 0,
    estimatedLimits: null,
    spentLimits: null,
    attempt: 1,
    maxAttempts: input.maxAttempts ?? 3,
    nextStep: "preflight",
    lastError: null,
    lastErrorCode: null,
    leaseOwnerId: null,
    leaseUntil: null,
    cancelRequested: false,
    planDigest: null,
    setCalls: 0,
    checkCalls: 0,
    getCalls: 0,
    submitAttemptsByHash: {},
    recoveryNotes: [],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  saveOrchestrationJob(job);
  return job;
}

function jobRunMatchesWorkflow(
  workflow: "suggest-canary" | "first36-full",
  reportRunId: string
): boolean {
  if (workflow === "first36-full") {
    return String(reportRunId).startsWith("orion-arsenkin-first36-full-");
  }
  return String(reportRunId).startsWith("orion-arsenkin-suggest-canary-");
}

/**
 * Find-or-create active job for case+workflow (canonical key: caseId+provider+workflowType).
 * Never resumes a foreign workflow run (e.g. suggest-canary under first36-full).
 */
export function findOrCreateActiveOrchestrationJob(input: {
  caseId: string;
  workflow: "suggest-canary" | "first36-full";
  reportRunId: string;
  sourceReportRunId: string;
  currentlyBoundReportRunId?: string | null;
  previousBindingReportRunId?: string | null;
  forceNew?: boolean;
}): { job: ArsenkinOrchestrationJob; created: boolean } {
  if (!jobRunMatchesWorkflow(input.workflow, input.reportRunId)) {
    throw new Error(
      `WORKFLOW_RUN_MISMATCH: workflow=${input.workflow} reportRunId=${input.reportRunId}`
    );
  }
  const existing = loadOrchestrationJob(input.caseId, input.workflow);
  if (
    !input.forceNew &&
    existing &&
    isActiveOrchestrationState(existing.state) &&
    jobRunMatchesWorkflow(input.workflow, existing.reportRunId)
  ) {
    // Resume the unfinished workflow job; ignore foreign/canary ids.
    return { job: existing, created: false };
  }
  const job = createOrchestrationJob(input);
  return { job, created: true };
}

export function claimOrchestrationJobLease(input: {
  caseId: string;
  workflow: string;
  ownerId: string;
  leaseMs?: number;
  now?: Date;
}): ArsenkinOrchestrationJob | null {
  const job = loadOrchestrationJob(input.caseId, input.workflow);
  if (!job) return null;
  if (!isActiveOrchestrationState(job.state) && job.state !== "FAILED_RETRYABLE") return null;
  const now = input.now ?? new Date();
  const leaseMs = input.leaseMs ?? 60_000;
  const leaseExpired = !job.leaseUntil || new Date(job.leaseUntil).getTime() <= now.getTime();
  if (job.leaseOwnerId && job.leaseOwnerId !== input.ownerId && !leaseExpired) {
    return null;
  }
  job.leaseOwnerId = input.ownerId;
  job.leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
  saveOrchestrationJob(job);
  return job;
}

export function releaseOrchestrationJobLease(input: {
  caseId: string;
  workflow: string;
  ownerId: string;
}): void {
  const job = loadOrchestrationJob(input.caseId, input.workflow);
  if (!job) return;
  if (job.leaseOwnerId !== input.ownerId) return;
  job.leaseOwnerId = null;
  job.leaseUntil = null;
  saveOrchestrationJob(job);
}

export function patchOrchestrationJob(
  caseId: string,
  workflow: string,
  patch: Partial<ArsenkinOrchestrationJob>
): ArsenkinOrchestrationJob | null {
  const job = loadOrchestrationJob(caseId, workflow);
  if (!job) return null;
  const next = { ...job, ...patch, jobId: job.jobId, caseId: job.caseId, workflow: job.workflow };
  saveOrchestrationJob(next);
  return next;
}

export function humanPhaseForState(state: ArsenkinOrchestrationState): string {
  switch (state) {
    case "PREFLIGHT":
      return "Проверка готовности";
    case "PLANNING":
      return "Формирование плана";
    case "STAGE1_SUBMITTING":
      return "Отправка задач Stage 1";
    case "STAGE1_POLLING":
      return "Ожидание результатов Stage 1";
    case "STAGE1_FETCHING":
      return "Загрузка результатов Stage 1";
    case "STAGE1_PARSING":
      return "Разбор результатов Stage 1";
    case "STAGE2_SUBMITTING":
      return "Отправка задач Stage 2";
    case "STAGE2_POLLING":
      return "Ожидание результатов Stage 2";
    case "STAGE2_FETCHING":
      return "Загрузка результатов Stage 2";
    case "STAGE2_PARSING":
      return "Разбор результатов Stage 2";
    case "BINDING":
      return "Передача данных в отчёт";
    case "RENDERING":
      return "Сборка PDF/PPTX";
    case "COMPLETED":
      return "Сбор завершён";
    case "COMPLETED_PARTIAL":
      return "Сбор завершён частично";
    case "WAITING_PROVIDER":
      return "Ожидание очереди Arsenkin";
    case "WAITING_INFRASTRUCTURE":
      return "Ожидание инфраструктуры";
    case "FAILED_RETRYABLE":
      return "Временная ошибка — можно продолжить";
    case "FAILED_TERMINAL":
      return "Сбор остановлен";
    case "CANCELLED":
      return "Сбор отменён";
  }
}
