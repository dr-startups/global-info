/**
 * Durable Arsenkin CaseAgent execution: start ≠ SUCCESS.
 * Full cycle: OrionReportRun → plan → executeArsenkinExecutionPlan (/set→/check→/get)
 * → observations + coverage → finalize AgentRun.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { ArsenkinToolName } from "../providers/arsenkin/flags";
import {
  FIRST36_FULL_SURFACE_SLOTS,
  type FullFirst36SurfaceSlot,
} from "../providers/arsenkin/workflow-contract";
import { writeJsonAtomic } from "../providers/arsenkin/arsenkin-db-readiness";
import { isValidBaseOrionReportRunId } from "../providers/arsenkin/source-binding-repair";
import { buildArsenkinSubjectQueryPlan } from "../orion-golden/classic/arsenkin-subject-query-plan";
import {
  buildArsenkinExecutionPlan,
  type ArsenkinExecutionPlan,
  type ArsenkinLiveStage,
} from "../orion-golden/classic/arsenkin-execution-plan";
import { pickEnrichmentUrls } from "../orion-golden/classic/enrich-report-run-with-arsenkin";
import { planArsenkinExactTasks } from "../orion-golden/classic/plan-arsenkin-exact-tasks";

export type ArsenkinAgentOutcome =
  | "SUCCESS"
  | "PARTIAL_SUCCESS"
  | "NO_RESULTS"
  | "REUSED"
  | "FAILED"
  | "RUNNING";

export type ArsenkinCaseAgentPhase =
  | "PREPARING"
  | "COLLECTING"
  | "FINALIZING"
  | "FAILED"
  | "FINALIZED";

export type ArsenkinCaseAgentExecutionSummary = {
  agentId: string;
  executionId: string;
  agentRunId: string;
  baseReportRunId: string | null;
  enrichmentReportRunId: string;
  plannedSurfaceCount: number;
  terminalSurfaceCount: number;
  measuredSurfaceCount: number;
  noResultsSurfaceCount: number;
  notSupportedSurfaceCount: number;
  failedSurfaceCount: number;
  providerTaskCount: number;
  observationCount: number;
  coverageCount: number;
  reusedTaskCount: number;
  networkCallCount: number;
  outcome: ArsenkinAgentOutcome;
  summary: string;
  errorCode?: string | null;
};

export type ArsenkinCaseAgentExecutionJob = {
  version: "arsenkin-case-agent-execution-v2";
  executionId: string;
  agentRunId: string;
  caseId: string;
  agentId: string;
  tools: ArsenkinToolName[];
  plannedSurfaces: Array<{ id: string; tool: string; label: string }>;
  enrichmentReportRunId: string;
  baseReportRunId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Legacy listRunning filter; true while phase is PREPARING|COLLECTING|FINALIZING. */
  status: "RUNNING" | "FINALIZED" | "FAILED";
  phase: ArsenkinCaseAgentPhase;
  networkCallsAttempted: boolean;
  planDigest?: string | null;
  queriesRu?: string[];
  queriesUae?: string[];
  urlsEnrichment?: string[];
  reusedTaskCount?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
};

const NON_TERMINAL_TASK = new Set([
  "QUEUED",
  "SUBMITTING",
  "RUNNING",
  "RATE_LIMITED",
  "WAITING",
  "SUBMIT_UNKNOWN",
]);

/** Process-scoped serial queue: LiveExecutionAuthorization is process-scoped. */
let caseAgentQueue: Promise<void> = Promise.resolve();

function enqueueCaseAgentWork<T>(fn: () => Promise<T>): Promise<T> {
  const run = caseAgentQueue.then(fn, fn);
  caseAgentQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function executionRoot(caseId: string): string {
  return join(process.cwd(), "storage", "digital-profile", "arsenkin-case-agent-runs", caseId);
}

export function arsenkinCaseAgentExecutionPath(caseId: string, executionId: string): string {
  return join(executionRoot(caseId), `${executionId}.json`);
}

export function plannedSurfacesForTools(tools: ArsenkinToolName[]): FullFirst36SurfaceSlot[] {
  const set = new Set(tools);
  return FIRST36_FULL_SURFACE_SLOTS.filter((s) => {
    if (set.has(s.tool as ArsenkinToolName)) return true;
    if (s.tool === "check-h" && set.has("indexation")) return true;
    return false;
  });
}

export function stageForCaseAgentTools(tools: ArsenkinToolName[]): ArsenkinLiveStage {
  const set = new Set(tools);
  if (set.has("ai-serp") || set.has("check-h") || set.has("indexation")) {
    return "FIRST36_STAGE2";
  }
  return "FIRST36_STAGE1";
}

export function isFinalizationAllowed(phase: ArsenkinCaseAgentPhase): boolean {
  return phase === "FINALIZING" || phase === "FAILED";
}

export function saveArsenkinCaseAgentExecution(job: ArsenkinCaseAgentExecutionJob): void {
  const path = arsenkinCaseAgentExecutionPath(job.caseId, job.executionId);
  mkdirSync(executionRoot(job.caseId), { recursive: true });
  writeJsonAtomic(path, { ...job, updatedAt: new Date().toISOString() });
}

export function loadArsenkinCaseAgentExecution(
  caseId: string,
  executionId: string
): ArsenkinCaseAgentExecutionJob | null {
  const path = arsenkinCaseAgentExecutionPath(caseId, executionId);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as ArsenkinCaseAgentExecutionJob & {
      version?: string;
      phase?: ArsenkinCaseAgentPhase;
      status?: string;
    };
    // Migrate v1 jobs (status-only) into phase model.
    if (!raw.phase) {
      const phase: ArsenkinCaseAgentPhase =
        raw.status === "FINALIZED" ? "FINALIZED" : "PREPARING";
      return {
        ...raw,
        version: "arsenkin-case-agent-execution-v2",
        phase,
        status: raw.status === "FINALIZED" ? "FINALIZED" : "RUNNING",
      } as ArsenkinCaseAgentExecutionJob;
    }
    return raw as ArsenkinCaseAgentExecutionJob;
  } catch {
    return null;
  }
}

export function listRunningArsenkinCaseAgentExecutions(caseId?: string): ArsenkinCaseAgentExecutionJob[] {
  const root = join(process.cwd(), "storage", "digital-profile", "arsenkin-case-agent-runs");
  if (!existsSync(root)) return [];
  const cases = caseId ? [caseId] : readdirSync(root);
  const out: ArsenkinCaseAgentExecutionJob[] = [];
  for (const c of cases) {
    const dir = join(root, c);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const job = loadArsenkinCaseAgentExecution(c, f.replace(/\.json$/, ""));
        if (!job) continue;
        if (job.status === "RUNNING" && job.phase !== "FINALIZED" && job.phase !== "FAILED") {
          out.push(job);
        }
      } catch {
        /* ignore corrupt */
      }
    }
  }
  return out;
}

/** Find in-flight job for same case+agent (dedupe concurrent clicks). */
export function findActiveArsenkinCaseAgentExecution(
  caseId: string,
  agentId: string
): ArsenkinCaseAgentExecutionJob | null {
  return (
    listRunningArsenkinCaseAgentExecutions(caseId).find((j) => j.agentId === agentId) ?? null
  );
}

export type FinalizeEvidence = {
  providerTasks: Array<{ id: string; state: string; toolName: string; externalTaskId: string | null }>;
  observationCount: number;
  coverageRows: Array<{ status: string; surface: string; tool: string; resultCount: number }>;
};

export function computeArsenkinCaseAgentOutcome(input: {
  plannedSurfaceCount: number;
  evidence: FinalizeEvidence;
  reused?: boolean;
  networkCallCount?: number;
  explicitErrorCode?: string | null;
  explicitErrorMessage?: string | null;
}): ArsenkinCaseAgentExecutionSummary & { agentDbStatus: "RUNNING" | "SUCCEEDED" | "FAILED" } {
  if (input.explicitErrorCode) {
    return {
      ...emptyIds(),
      plannedSurfaceCount: input.plannedSurfaceCount,
      terminalSurfaceCount: 0,
      measuredSurfaceCount: 0,
      noResultsSurfaceCount: 0,
      notSupportedSurfaceCount: 0,
      failedSurfaceCount: 0,
      providerTaskCount: input.evidence.providerTasks.length,
      observationCount: input.evidence.observationCount,
      coverageCount: input.evidence.coverageRows.length,
      reusedTaskCount: 0,
      networkCallCount: input.networkCallCount ?? 0,
      outcome: "FAILED",
      summary: input.explicitErrorMessage ?? input.explicitErrorCode,
      agentDbStatus: "FAILED",
      errorCode: input.explicitErrorCode,
    };
  }

  const tasks = input.evidence.providerTasks;
  const providerTaskCount = tasks.length;
  const coverageCount = input.evidence.coverageRows.length;
  const observationCount = input.evidence.observationCount;

  const measuredSurfaceCount = input.evidence.coverageRows.filter((c) =>
    /MEASURED|^OK$/i.test(c.status)
  ).length;
  const noResultsSurfaceCount = input.evidence.coverageRows.filter((c) =>
    /NO_RESULTS/i.test(c.status)
  ).length;
  const notSupportedSurfaceCount = input.evidence.coverageRows.filter((c) =>
    /NOT_SUPPORTED/i.test(c.status)
  ).length;
  const failedSurfaceCount = input.evidence.coverageRows.filter((c) =>
    /FAILED|ERROR/i.test(c.status)
  ).length;

  const hasNonTerminal = tasks.some((t) => NON_TERMINAL_TASK.has(String(t.state).toUpperCase()));
  const allTasksTerminal =
    providerTaskCount > 0 && tasks.every((t) => !NON_TERMINAL_TASK.has(String(t.state).toUpperCase()));

  const terminalSurfaceCount =
    measuredSurfaceCount + noResultsSurfaceCount + notSupportedSurfaceCount + failedSurfaceCount;

  const base = {
    plannedSurfaceCount: input.plannedSurfaceCount,
    terminalSurfaceCount,
    measuredSurfaceCount,
    noResultsSurfaceCount,
    notSupportedSurfaceCount,
    failedSurfaceCount,
    providerTaskCount,
    observationCount,
    coverageCount,
    reusedTaskCount: input.reused ? providerTaskCount : 0,
    networkCallCount: input.networkCallCount ?? 0,
  };

  if (hasNonTerminal || (providerTaskCount > 0 && !allTasksTerminal)) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "RUNNING",
      summary: `Выполняется: tasks=${providerTaskCount}, coverage=${coverageCount}, surfaces ${terminalSurfaceCount}/${input.plannedSurfaceCount}`,
      agentDbStatus: "RUNNING",
      errorCode: null,
    };
  }

  if (providerTaskCount === 0 && coverageCount === 0) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "FAILED",
      summary: "Arsenkin executor не создал ProviderTask/coverage — сбор не доказан.",
      agentDbStatus: "FAILED",
      errorCode: "ARSENKIN_NO_EXECUTION_EVIDENCE",
    };
  }

  if (
    input.reused &&
    allTasksTerminal &&
    (observationCount > 0 || noResultsSurfaceCount > 0 || measuredSurfaceCount > 0)
  ) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "REUSED",
      summary: `Переиспользованы результаты: tasks=${providerTaskCount}, observations=${observationCount}, coverage=${coverageCount}`,
      agentDbStatus: "SUCCEEDED",
      errorCode: null,
    };
  }

  if (
    allTasksTerminal &&
    observationCount === 0 &&
    noResultsSurfaceCount > 0 &&
    measuredSurfaceCount === 0 &&
    failedSurfaceCount === 0
  ) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "NO_RESULTS",
      summary: `Запрос выполнен: результатов нет. Поверхности ${terminalSurfaceCount}/${input.plannedSurfaceCount}, coverage=NO_RESULTS.`,
      agentDbStatus: "SUCCEEDED",
      errorCode: null,
    };
  }

  if (failedSurfaceCount > 0 && (measuredSurfaceCount > 0 || noResultsSurfaceCount > 0)) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "PARTIAL_SUCCESS",
      summary: `Частично: measured=${measuredSurfaceCount}, noResults=${noResultsSurfaceCount}, failed=${failedSurfaceCount}, observations=${observationCount}`,
      agentDbStatus: "SUCCEEDED",
      errorCode: null,
    };
  }

  if (
    input.plannedSurfaceCount > 0 &&
    providerTaskCount > 0 &&
    allTasksTerminal &&
    failedSurfaceCount === 0 &&
    (measuredSurfaceCount > 0 || noResultsSurfaceCount > 0 || notSupportedSurfaceCount === input.plannedSurfaceCount)
  ) {
    if (measuredSurfaceCount > 0 || noResultsSurfaceCount > 0) {
      return {
        ...emptyIds(),
        ...base,
        outcome: "SUCCESS",
        summary: `Успешно: surfaces ${terminalSurfaceCount}/${input.plannedSurfaceCount}, tasks=${providerTaskCount}, observations=${observationCount}`,
        agentDbStatus: "SUCCEEDED",
        errorCode: null,
      };
    }
  }

  if (providerTaskCount > 0 && allTasksTerminal && failedSurfaceCount === input.plannedSurfaceCount) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "FAILED",
      summary: `Ошибка: все поверхности FAILED_FINAL (tasks=${providerTaskCount})`,
      agentDbStatus: "FAILED",
      errorCode: "ARSENKIN_ALL_SURFACES_FAILED",
    };
  }

  if (providerTaskCount > 0 && coverageCount === 0 && allTasksTerminal) {
    return {
      ...emptyIds(),
      ...base,
      outcome: "FAILED",
      summary: "ProviderTask есть, но SurfaceCollectionCoverage отсутствует.",
      agentDbStatus: "FAILED",
      errorCode: "ARSENKIN_NO_COVERAGE",
    };
  }

  return {
    ...emptyIds(),
    ...base,
    outcome: "FAILED",
    summary: "Недостаточно доказательств успешного Arsenkin-сбора.",
    agentDbStatus: "FAILED",
    errorCode: "ARSENKIN_INCONCLUSIVE",
  };
}

function emptyIds(): Pick<
  ArsenkinCaseAgentExecutionSummary,
  "agentId" | "executionId" | "agentRunId" | "baseReportRunId" | "enrichmentReportRunId"
> {
  return {
    agentId: "",
    executionId: "",
    agentRunId: "",
    baseReportRunId: null,
    enrichmentReportRunId: "",
  };
}

export async function loadFinalizeEvidence(input: {
  prisma: PrismaClient;
  enrichmentReportRunId: string;
  tools: ArsenkinToolName[];
}): Promise<FinalizeEvidence> {
  const toolSet = new Set(input.tools.map(String));
  if (toolSet.has("indexation")) toolSet.add("check-h");
  if (toolSet.has("check-h")) toolSet.add("indexation");

  const providerTasks = await input.prisma.providerTask.findMany({
    where: {
      reportRunId: input.enrichmentReportRunId,
      provider: "arsenkin",
      toolName: { in: [...toolSet] },
    },
    select: { id: true, state: true, toolName: true, externalTaskId: true },
  });
  const taskIds = providerTasks.map((t) => t.id);
  const observationCount =
    taskIds.length === 0
      ? 0
      : await input.prisma.serpObservation.count({
          where: {
            auditRunId: input.enrichmentReportRunId,
            provider: "arsenkin",
            providerTaskId: { in: taskIds },
          },
        });
  const coverageRows = await input.prisma.surfaceCollectionCoverage.findMany({
    where: {
      reportRunId: input.enrichmentReportRunId,
      provider: "arsenkin",
      tool: { in: [...toolSet] },
    },
    select: { status: true, surface: true, tool: true, resultCount: true },
  });
  return {
    providerTasks,
    observationCount,
    coverageRows: coverageRows.map((c) => ({
      status: String(c.status ?? ""),
      surface: String(c.surface ?? ""),
      tool: String(c.tool ?? ""),
      resultCount: c.resultCount ?? 0,
    })),
  };
}

export async function ensureCaseAgentOrionReportRun(input: {
  prisma: PrismaClient;
  enrichmentReportRunId: string;
  caseId: string;
  agentId: string;
  agentRunId: string;
  executionId: string;
  tools: ArsenkinToolName[];
  baseReportRunId: string | null;
}): Promise<void> {
  const metadataJson = {
    agentId: input.agentId,
    agentRunId: input.agentRunId,
    executionId: input.executionId,
    tools: input.tools,
    baseReportRunId: input.baseReportRunId,
  };
  await input.prisma.orionReportRun.upsert({
    where: { id: input.enrichmentReportRunId },
    create: {
      id: input.enrichmentReportRunId,
      caseId: input.caseId,
      mode: "ARSENKIN_CASE_AGENT",
      storeMode: "db",
      status: "RUNNING",
      internalOnly: true,
      startedAt: new Date(),
      metadataJson: metadataJson as Prisma.InputJsonValue,
    },
    update: {
      status: "RUNNING",
      storeMode: "db",
      internalOnly: true,
      metadataJson: metadataJson as Prisma.InputJsonValue,
      finishedAt: null,
    },
  });
}

export type CaseAgentPlanBuildResult =
  | { ok: true; plan: ArsenkinExecutionPlan; queriesRu: string[]; queriesUae: string[]; urlsEnrichment: string[] }
  | { ok: false; errorCode: string; errorMessage: string };

/** Pure-ish plan builder for CaseAgent tool scopes (uses planArsenkinExactTasks via buildArsenkinExecutionPlan). */
export function buildArsenkinCaseAgentExecutionPlan(input: {
  caseId: string;
  enrichmentReportRunId: string;
  tools: ArsenkinToolName[];
  fullName: string | null | undefined;
  aliases?: readonly string[] | null;
  urlsEnrichment?: string[];
  existingTasks?: Array<{ id: string; requestHash: string; state: string }>;
}): CaseAgentPlanBuildResult {
  const queryPlan = buildArsenkinSubjectQueryPlan({
    fullName: input.fullName,
    aliases: input.aliases ?? [],
  });
  if (queryPlan.blockers.includes("empty-subject-name")) {
    return {
      ok: false,
      errorCode: "ARSENKIN_EMPTY_SUBJECT",
      errorMessage: "Subject fullName/aliases пусты — нельзя построить Arsenkin-запросы.",
    };
  }
  if (queryPlan.queriesRu.length === 0 && queryPlan.queriesUae.length === 0) {
    return {
      ok: false,
      errorCode: "ARSENKIN_EMPTY_QUERY_PLAN",
      errorMessage: "Пустой query plan (queriesRu/queriesUae).",
    };
  }

  const needsUrls = input.tools.includes("check-h") || input.tools.includes("indexation");
  const urls = input.urlsEnrichment ?? [];
  if (needsUrls && urls.length === 0) {
    return {
      ok: false,
      errorCode: "ARSENKIN_URL_AUDIT_NO_SOURCE_URLS",
      errorMessage:
        "URL Audit: нет HTTP/HTTPS URL из SearchResult для check-h/indexation (ARSENKIN_URL_AUDIT_NO_SOURCE_URLS).",
    };
  }

  // Guard: never plan with stub "subject"
  const hasStub =
    queryPlan.queriesRu.some((q) => q.trim().toLowerCase() === "subject") ||
    queryPlan.queriesUae.some((q) => q.trim().toLowerCase() === "subject");
  if (hasStub) {
    return {
      ok: false,
      errorCode: "ARSENKIN_STUB_QUERY",
      errorMessage: "Query plan содержит заглушку 'subject'.",
    };
  }

  const stage = stageForCaseAgentTools(input.tools);
  const plan = buildArsenkinExecutionPlan({
    caseId: input.caseId,
    reportRunId: input.enrichmentReportRunId,
    stage,
    queriesRu: queryPlan.queriesRu,
    queriesUae: queryPlan.queriesUae,
    maxNewTasks: 20,
    maxEstimatedLimits: 20,
    existingTasks: input.existingTasks,
    urlsEnrichment: urls,
    aiSerpTargets: ["yandex_ru", "google_ru", "google_uae"],
    toolsOverride: input.tools,
    allowUnknownCost: true,
  });

  if (plan.requests.length === 0) {
    return {
      ok: false,
      errorCode: "ARSENKIN_EMPTY_PLAN",
      errorMessage: `Пустой execution plan для tools=[${input.tools.join(",")}]`,
    };
  }

  return {
    ok: true,
    plan,
    queriesRu: plan.queriesRu,
    queriesUae: plan.queriesUae,
    urlsEnrichment: plan.urlsEnrichment,
  };
}

/** Offline/test helper: tool-scoped planned requests without DB. */
export function previewCaseAgentPlannedRequests(input: {
  tools: ArsenkinToolName[];
  fullName: string;
  aliases?: string[];
  urlsEnrichment?: string[];
}) {
  const qp = buildArsenkinSubjectQueryPlan({
    fullName: input.fullName,
    aliases: input.aliases ?? [],
  });
  return planArsenkinExactTasks({
    queriesRu: qp.queriesRu,
    queriesUae: qp.queriesUae,
    tools: input.tools,
    urlsEnrichment: input.urlsEnrichment ?? [],
    aiSerpTargets: ["yandex_ru", "google_ru", "google_uae"],
  });
}

async function loadSubjectForCase(
  prisma: PrismaClient,
  caseId: string
): Promise<{ fullName: string | null; aliases: string[] }> {
  const subject = await prisma.subject.findFirst({
    where: { caseId },
    select: { fullName: true, aliases: true },
  });
  return {
    fullName: subject?.fullName ?? null,
    aliases: Array.isArray(subject?.aliases)
      ? (subject!.aliases as string[]).map(String)
      : [],
  };
}

async function loadUrlsFromSearchResults(
  prisma: PrismaClient,
  caseId: string
): Promise<string[]> {
  const results = await prisma.searchResult.findMany({
    where: { caseId },
    select: { url: true, normalizedUrl: true, rank: true },
    orderBy: { rank: "asc" },
    take: 200,
  });
  const rows = results.map((r, i) => {
    const url = String(r.url ?? "").trim();
    let domain: string | null = null;
    try {
      domain = url ? new URL(url).hostname : null;
    } catch {
      domain = null;
    }
    return {
      url,
      domain,
      rank: r.rank ?? i + 1,
      surface: "organic",
    };
  });
  return pickEnrichmentUrls(rows, 10);
}

function classifyWorkerError(err: unknown): { errorCode: string; errorMessage: string } {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (/foreign key|fk_|orionreportrun|violates foreign key/i.test(message)) {
    return { errorCode: "ARSENKIN_FK_DB_ERROR", errorMessage: message };
  }
  if (/token|not configured|api_token|missing/i.test(lower) && /arsenkin|token/i.test(lower)) {
    return { errorCode: "ARSENKIN_TOKEN_MISSING", errorMessage: message };
  }
  if (/submit_unknown/i.test(message)) {
    return { errorCode: "SUBMIT_UNKNOWN", errorMessage: message };
  }
  if (/result_fetch_failed|result-fetch|fetch failed/i.test(lower)) {
    return { errorCode: "RESULT_FETCH_FAILED", errorMessage: message };
  }
  if (/http\s*500|status.?500|500\b/i.test(message)) {
    return { errorCode: "ARSENKIN_HTTP_500", errorMessage: message };
  }
  if (/parser|map.*observation|unsupported-plan-tool/i.test(lower)) {
    return { errorCode: "ARSENKIN_PARSER_ERROR", errorMessage: message };
  }
  if (/live-blocked|authorization|digest/i.test(lower)) {
    return { errorCode: "ARSENKIN_AUTH_ERROR", errorMessage: message };
  }
  return { errorCode: "ARSENKIN_WORKER_ERROR", errorMessage: message };
}

async function failJobAndAgentRun(input: {
  job: ArsenkinCaseAgentExecutionJob;
  errorCode: string;
  errorMessage: string;
  prisma?: PrismaClient;
}): Promise<void> {
  const job: ArsenkinCaseAgentExecutionJob = {
    ...input.job,
    phase: "FAILED",
    status: "FAILED",
    errorCode: input.errorCode,
    errorMessage: input.errorMessage,
  };
  saveArsenkinCaseAgentExecution(job);

  try {
    const prisma = input.prisma ?? (await import("@/server/prisma/client")).prisma;
    await prisma.orionReportRun
      .update({
        where: { id: job.enrichmentReportRunId },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          errorsJson: { errorCode: input.errorCode, message: input.errorMessage } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    await prisma.agentRun.update({
      where: { id: job.agentRunId },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        error: `${input.errorCode}: ${input.errorMessage}`,
        output: {
          summary: input.errorMessage,
          outcome: "FAILED",
          errorCode: input.errorCode,
          arsenkinExecution: {
            agentId: job.agentId,
            executionId: job.executionId,
            agentRunId: job.agentRunId,
            enrichmentReportRunId: job.enrichmentReportRunId,
            baseReportRunId: job.baseReportRunId,
            outcome: "FAILED",
            errorCode: input.errorCode,
            phase: "FAILED",
          },
          demo: false,
        } as unknown as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    console.error(
      "[arsenkin-case-agent] failJobAndAgentRun DB update failed:",
      err instanceof Error ? err.message : err
    );
  }
}

/**
 * Full durable worker: PREPARING → COLLECTING → FINALIZING → FINALIZED|FAILED.
 * Serialized via process-level queue.
 */
export async function runArsenkinCaseAgentWorker(input: {
  caseId: string;
  executionId: string;
  prisma?: PrismaClient;
}): Promise<void> {
  return enqueueCaseAgentWork(async () => {
    const job0 = loadArsenkinCaseAgentExecution(input.caseId, input.executionId);
    if (!job0) {
      console.error(`[arsenkin-case-agent] job not found ${input.caseId}/${input.executionId}`);
      return;
    }
    if (job0.phase === "FINALIZED" || job0.phase === "FAILED") return;
    if (job0.phase === "FINALIZING") {
      await finalizeArsenkinCaseAgentRun({
        agentRunId: job0.agentRunId,
        caseId: job0.caseId,
        executionId: job0.executionId,
        enrichmentReportRunId: job0.enrichmentReportRunId,
        agentId: job0.agentId,
        tools: job0.tools,
        plannedSurfaceCount: job0.plannedSurfaces.length,
        baseReportRunId: job0.baseReportRunId,
        prisma: input.prisma,
        reused: (job0.reusedTaskCount ?? 0) > 0 && (job0.reusedTaskCount ?? 0) === job0.plannedSurfaces.length,
        networkCallCount: job0.networkCallsAttempted ? 1 : 0,
        explicitErrorCode: job0.errorCode,
        explicitErrorMessage: job0.errorMessage,
      });
      return;
    }

    let job = job0;
    const prisma = input.prisma ?? (await import("@/server/prisma/client")).prisma;

    try {
      job = {
        ...job,
        phase: "PREPARING",
        status: "RUNNING",
        errorCode: null,
        errorMessage: null,
      };
      saveArsenkinCaseAgentExecution(job);

      await ensureCaseAgentOrionReportRun({
        prisma,
        enrichmentReportRunId: job.enrichmentReportRunId,
        caseId: job.caseId,
        agentId: job.agentId,
        agentRunId: job.agentRunId,
        executionId: job.executionId,
        tools: job.tools,
        baseReportRunId: job.baseReportRunId,
      });

      const subject = await loadSubjectForCase(prisma, job.caseId);
      let urlsEnrichment: string[] = [];
      if (job.tools.includes("check-h") || job.tools.includes("indexation")) {
        urlsEnrichment = await loadUrlsFromSearchResults(prisma, job.caseId);
      }

      const existingTasks = await prisma.providerTask.findMany({
        where: { reportRunId: job.enrichmentReportRunId, provider: "arsenkin" },
        select: { id: true, requestHash: true, state: true },
      });

      const built = buildArsenkinCaseAgentExecutionPlan({
        caseId: job.caseId,
        enrichmentReportRunId: job.enrichmentReportRunId,
        tools: job.tools,
        fullName: subject.fullName,
        aliases: subject.aliases,
        urlsEnrichment,
        existingTasks,
      });

      if (!built.ok) {
        await failJobAndAgentRun({
          job,
          errorCode: built.errorCode,
          errorMessage: built.errorMessage,
          prisma,
        });
        return;
      }

      const reusedTaskCount = built.plan.requests.filter((r) => r.action === "REUSE").length;
      job = {
        ...job,
        planDigest: built.plan.digest,
        queriesRu: built.queriesRu,
        queriesUae: built.queriesUae,
        urlsEnrichment: built.urlsEnrichment,
        reusedTaskCount,
      };
      saveArsenkinCaseAgentExecution(job);

      if (String(process.env.NETWORK_CALLS ?? "") === "0") {
        await failJobAndAgentRun({
          job,
          errorCode: "ARSENKIN_NETWORK_CALLS_DISABLED",
          errorMessage:
            "NETWORK_CALLS=0 — live Arsenkin /set→/check→/get отключён (offline). OrionReportRun и plan созданы.",
          prisma,
        });
        return;
      }

      const { createArsenkinClientFromEnv } = await import("../providers/arsenkin/client");
      const client = createArsenkinClientFromEnv();
      if (!client) {
        await failJobAndAgentRun({
          job,
          errorCode: "ARSENKIN_TOKEN_MISSING",
          errorMessage: "Arsenkin client недоступен (token missing / ARSENKIN_ENABLED).",
          prisma,
        });
        return;
      }

      job = { ...job, phase: "COLLECTING", status: "RUNNING", networkCallsAttempted: true };
      saveArsenkinCaseAgentExecution(job);

      try {
        await prisma.agentRun.update({
          where: { id: job.agentRunId },
          data: {
            status: "RUNNING",
            output: {
              summary: `Arsenkin API: /set→/check→/get (${built.plan.requests.length} задач)…`,
              outcome: "RUNNING",
              arsenkinExecution: {
                agentId: job.agentId,
                executionId: job.executionId,
                agentRunId: job.agentRunId,
                enrichmentReportRunId: job.enrichmentReportRunId,
                baseReportRunId: job.baseReportRunId,
                plannedSurfaceCount: job.plannedSurfaces.length,
                outcome: "RUNNING",
                phase: "COLLECTING",
                planDigest: built.plan.digest,
                requestCount: built.plan.requests.length,
              },
              demo: false,
            } as unknown as Prisma.InputJsonValue,
          },
        });
      } catch (err) {
        console.error(
          "[arsenkin-case-agent] COLLECTING status update failed:",
          err instanceof Error ? err.message : err
        );
      }

      const { createPrismaProviderTaskStore } = await import(
        "../providers/arsenkin/prisma-provider-task-store"
      );
      const {
        executeArsenkinExecutionPlan,
        authorizationFromPlan,
      } = await import("../providers/arsenkin/execute-arsenkin-execution-plan");
      const { persistSerpObservations } = await import("../serp-observation/persist");

      const auth = authorizationFromPlan(built.plan);
      // Cap per-task wait so a hung Arsenkin /check cannot block the HTTP request forever.
      const collected = await executeArsenkinExecutionPlan({
        plan: built.plan,
        authorization: auth,
        client,
        store: createPrismaProviderTaskStore(),
        waitTimeoutMs: 90_000,
        onProgress: async (info) => {
          const label = `${info.tool}${info.engine ? `/${info.engine}` : ""}${
            info.region ? `:${info.region}` : ""
          }`;
          const summary =
            info.phase === "start"
              ? `Arsenkin API: задача ${info.index}/${info.total} (${label}) — /set→/check→/get…`
              : `Arsenkin API: задача ${info.index}/${info.total} (${label}) готова`;
          try {
            await prisma.agentRun.update({
              where: { id: job.agentRunId },
              data: {
                status: "RUNNING",
                output: {
                  summary,
                  outcome: "RUNNING",
                  arsenkinExecution: {
                    agentId: job.agentId,
                    executionId: job.executionId,
                    agentRunId: job.agentRunId,
                    enrichmentReportRunId: job.enrichmentReportRunId,
                    baseReportRunId: job.baseReportRunId,
                    plannedSurfaceCount: job.plannedSurfaces.length,
                    outcome: "RUNNING",
                    phase: "COLLECTING",
                    planDigest: built.plan.digest,
                    progress: info,
                  },
                  demo: false,
                } as unknown as Prisma.InputJsonValue,
              },
            });
            saveArsenkinCaseAgentExecution({
              ...job,
              phase: "COLLECTING",
              status: "RUNNING",
              updatedAt: new Date().toISOString(),
            });
          } catch (err) {
            console.error(
              "[arsenkin-case-agent] progress update failed:",
              err instanceof Error ? err.message : err
            );
          }
        },
      });
      await persistSerpObservations(collected.drafts);

      await prisma.orionReportRun.update({
        where: { id: job.enrichmentReportRunId },
        data: {
          status: "SUCCEEDED",
          finishedAt: new Date(),
          metadataJson: {
            agentId: job.agentId,
            agentRunId: job.agentRunId,
            executionId: job.executionId,
            tools: job.tools,
            baseReportRunId: job.baseReportRunId,
            planDigest: built.plan.digest,
            taskIds: collected.taskIds,
            bySurface: collected.bySurface,
          } as Prisma.InputJsonValue,
        },
      });

      job = {
        ...job,
        phase: "FINALIZING",
        status: "RUNNING",
        reusedTaskCount,
      };
      saveArsenkinCaseAgentExecution(job);

      await finalizeArsenkinCaseAgentRun({
        agentRunId: job.agentRunId,
        caseId: job.caseId,
        executionId: job.executionId,
        enrichmentReportRunId: job.enrichmentReportRunId,
        agentId: job.agentId,
        tools: job.tools,
        plannedSurfaceCount: job.plannedSurfaces.length,
        baseReportRunId: job.baseReportRunId,
        prisma,
        reused: reusedTaskCount > 0 && reusedTaskCount === built.plan.requests.length,
        networkCallCount: 1,
      });
    } catch (err) {
      const classified = classifyWorkerError(err);
      console.error(
        `[arsenkin-case-agent] worker failed ${job.executionId}:`,
        classified.errorCode,
        classified.errorMessage
      );
      await failJobAndAgentRun({
        job,
        errorCode: classified.errorCode,
        errorMessage: classified.errorMessage,
        prisma,
      });
    }
  });
}

export async function startArsenkinCaseAgentDurable(input: {
  caseId: string;
  agentRunId: string;
  agentId: string;
  tools: ArsenkinToolName[];
  actorId?: string;
  prisma?: PrismaClient;
  resolveBaseReportRunId?: () => Promise<string | null>;
  /** When false, caller schedules worker (default true). */
  scheduleWorker?: boolean;
}): Promise<{
  executionId: string;
  enrichmentReportRunId: string;
  baseReportRunId: string | null;
  plannedSurfaces: FullFirst36SurfaceSlot[];
  status: "RUNNING";
  reusedExisting?: boolean;
}> {
  const existing = findActiveArsenkinCaseAgentExecution(input.caseId, input.agentId);
  if (existing) {
    // Always start a fresh execution on retry — do not reuse a stuck COLLECTING job.
    saveArsenkinCaseAgentExecution({
      ...existing,
      status: "FAILED",
      phase: "FAILED",
      errorCode: "ARSENKIN_SUPERSEDED",
      errorMessage: "Заменён новым запуском того же агента",
    });
    try {
      const prisma = input.prisma ?? (await import("@/server/prisma/client")).prisma;
      await prisma.agentRun.update({
        where: { id: existing.agentRunId },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          error: "ARSENKIN_SUPERSEDED: заменён новым запуском того же агента",
          output: {
            summary: "Запуск замещён повторным нажатием",
            outcome: "FAILED",
            errorCode: "ARSENKIN_SUPERSEDED",
            demo: false,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      console.error(
        "[arsenkin-case-agent] supersede old AgentRun failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  const planned = plannedSurfacesForTools(input.tools);
  const executionId = `ace-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const enrichmentReportRunId = `orion-arsenkin-agent-${input.agentId
    .toLowerCase()
    .replace(/_/g, "-")}-${Date.now().toString(36)}`;

  let baseReportRunId: string | null = null;
  if (input.resolveBaseReportRunId) {
    baseReportRunId = await input.resolveBaseReportRunId();
  } else {
    try {
      const { resolveCanonicalBaseOrionReportRunId } = await import(
        "../providers/arsenkin/source-binding-repair"
      );
      const resolved = await resolveCanonicalBaseOrionReportRunId(input.caseId, {
        prisma: input.prisma,
      });
      if (resolved.ok && isValidBaseOrionReportRunId(resolved.baseOrionReportRunId)) {
        baseReportRunId = resolved.baseOrionReportRunId;
      }
    } catch (err) {
      console.error(
        "[arsenkin-case-agent] resolveBaseReportRunId failed:",
        err instanceof Error ? err.message : err
      );
      baseReportRunId = null;
    }
  }

  const job: ArsenkinCaseAgentExecutionJob = {
    version: "arsenkin-case-agent-execution-v2",
    executionId,
    agentRunId: input.agentRunId,
    caseId: input.caseId,
    agentId: input.agentId,
    tools: input.tools,
    plannedSurfaces: planned.map((s) => ({ id: s.id, tool: s.tool, label: s.label })),
    enrichmentReportRunId,
    baseReportRunId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "RUNNING",
    phase: "PREPARING",
    networkCallsAttempted: false,
  };
  saveArsenkinCaseAgentExecution(job);

  if (input.scheduleWorker !== false) {
    setImmediate(() => {
      void runArsenkinCaseAgentWorker({
        caseId: input.caseId,
        executionId,
        prisma: input.prisma,
      }).catch((err) => {
        console.error(
          "[arsenkin-case-agent] scheduleWorker error:",
          err instanceof Error ? err.message : err
        );
      });
    });
  }

  return {
    executionId,
    enrichmentReportRunId,
    baseReportRunId,
    plannedSurfaces: planned,
    status: "RUNNING",
  };
}

export async function finalizeArsenkinCaseAgentRun(input: {
  agentRunId: string;
  caseId: string;
  executionId: string;
  enrichmentReportRunId: string;
  agentId: string;
  tools: ArsenkinToolName[];
  plannedSurfaceCount: number;
  baseReportRunId?: string | null;
  prisma?: PrismaClient;
  evidence?: FinalizeEvidence;
  reused?: boolean;
  networkCallCount?: number;
  explicitErrorCode?: string | null;
  explicitErrorMessage?: string | null;
}): Promise<ArsenkinCaseAgentExecutionSummary & { agentDbStatus: "RUNNING" | "SUCCEEDED" | "FAILED" }> {
  const job = loadArsenkinCaseAgentExecution(input.caseId, input.executionId);
  if (job && !isFinalizationAllowed(job.phase) && !input.explicitErrorCode) {
    return {
      ...emptyIds(),
      agentId: input.agentId,
      executionId: input.executionId,
      agentRunId: input.agentRunId,
      baseReportRunId: input.baseReportRunId ?? null,
      enrichmentReportRunId: input.enrichmentReportRunId,
      plannedSurfaceCount: input.plannedSurfaceCount,
      terminalSurfaceCount: 0,
      measuredSurfaceCount: 0,
      noResultsSurfaceCount: 0,
      notSupportedSurfaceCount: 0,
      failedSurfaceCount: 0,
      providerTaskCount: 0,
      observationCount: 0,
      coverageCount: 0,
      reusedTaskCount: 0,
      networkCallCount: input.networkCallCount ?? 0,
      outcome: "RUNNING",
      summary: `Фаза ${job.phase}: finalization запрещена до завершения сбора.`,
      agentDbStatus: "RUNNING",
      errorCode: null,
    };
  }

  let evidence = input.evidence;
  if (!evidence) {
    const prisma = input.prisma ?? (await import("@/server/prisma/client")).prisma;
    evidence = await loadFinalizeEvidence({
      prisma,
      enrichmentReportRunId: input.enrichmentReportRunId,
      tools: input.tools,
    });
  }

  const computed = computeArsenkinCaseAgentOutcome({
    plannedSurfaceCount: input.plannedSurfaceCount,
    evidence,
    reused: input.reused,
    networkCallCount: input.networkCallCount,
    explicitErrorCode: input.explicitErrorCode ?? job?.errorCode,
    explicitErrorMessage: input.explicitErrorMessage ?? job?.errorMessage,
  });

  const summary: ArsenkinCaseAgentExecutionSummary = {
    ...computed,
    agentId: input.agentId,
    executionId: input.executionId,
    agentRunId: input.agentRunId,
    baseReportRunId: input.baseReportRunId ?? null,
    enrichmentReportRunId: input.enrichmentReportRunId,
  };

  if (computed.agentDbStatus === "RUNNING") {
    return { ...summary, agentDbStatus: "RUNNING" };
  }

  const prisma = input.prisma ?? (await import("@/server/prisma/client")).prisma;
  await prisma.agentRun.update({
    where: { id: input.agentRunId },
    data: {
      status: computed.agentDbStatus,
      finishedAt: new Date(),
      error:
        computed.agentDbStatus === "FAILED"
          ? summary.errorCode
            ? `${summary.errorCode}: ${summary.summary}`
            : summary.summary
          : null,
      itemsSaved: summary.observationCount,
      output: {
        summary: summary.summary,
        outcome: summary.outcome,
        arsenkinExecution: summary,
        demo: false,
      } as unknown as Prisma.InputJsonValue,
    },
  });

  if (computed.agentDbStatus === "SUCCEEDED") {
    try {
      const { appendCaseAgentEnrichmentToReportBinding } = await import(
        "../orion-golden/classic/arsenkin-report-binding"
      );
      const reg = appendCaseAgentEnrichmentToReportBinding({
        caseId: input.caseId,
        enrichmentReportRunId: input.enrichmentReportRunId,
        baseReportRunId: input.baseReportRunId ?? null,
        agentId: input.agentId,
        tools: input.tools,
        observationCount: summary.observationCount,
        coverageCount: summary.coverageCount,
      });
      console.info(
        JSON.stringify({
          event: "arsenkin_case_agent_report_binding",
          caseId: input.caseId,
          agentId: input.agentId,
          enrichmentReportRunId: input.enrichmentReportRunId,
          ok: reg.ok,
          reason: reg.reason,
        })
      );
    } catch (err) {
      console.error(
        "[arsenkin-case-agent] appendCaseAgentEnrichmentToReportBinding failed:",
        err instanceof Error ? err.message : err
      );
    }
  }

  try {
    const { writeReportEvidenceProvenance } = await import("./report-evidence-provenance");
    await writeReportEvidenceProvenance({
      caseId: input.caseId,
      phase: "ARSENKIN_CASE_AGENT",
      trigger: `${input.agentId}:${summary.outcome}`,
      prisma,
    });
  } catch (err) {
    console.error(
      "[arsenkin-case-agent] provenance write failed:",
      err instanceof Error ? err.message : err
    );
  }

  if (job) {
    saveArsenkinCaseAgentExecution({
      ...job,
      status: computed.agentDbStatus === "FAILED" ? "FAILED" : "FINALIZED",
      phase: computed.agentDbStatus === "FAILED" ? "FAILED" : "FINALIZED",
      errorCode: summary.errorCode ?? null,
      errorMessage: computed.agentDbStatus === "FAILED" ? summary.summary : null,
    });
  }

  return { ...summary, agentDbStatus: computed.agentDbStatus };
}

/**
 * Tick: only finalize jobs already in FINALIZING (never during PREPARING/COLLECTING).
 * Also re-schedules stuck PREPARING/COLLECTING via resume worker.
 */
export async function tickArsenkinCaseAgentFinalizations(deps?: {
  prisma?: PrismaClient;
  evidenceByExecutionId?: Record<string, FinalizeEvidence>;
}): Promise<number> {
  const running = listRunningArsenkinCaseAgentExecutions();
  let n = 0;
  for (const job of running) {
    if (!isFinalizationAllowed(job.phase)) {
      continue;
    }
    try {
      const result = await finalizeArsenkinCaseAgentRun({
        agentRunId: job.agentRunId,
        caseId: job.caseId,
        executionId: job.executionId,
        enrichmentReportRunId: job.enrichmentReportRunId,
        agentId: job.agentId,
        tools: job.tools,
        plannedSurfaceCount: job.plannedSurfaces.length,
        baseReportRunId: job.baseReportRunId,
        prisma: deps?.prisma,
        evidence: deps?.evidenceByExecutionId?.[job.executionId],
        networkCallCount: job.networkCallsAttempted ? 1 : 0,
        explicitErrorCode: job.errorCode,
        explicitErrorMessage: job.errorMessage,
      });
      if (result.agentDbStatus !== "RUNNING") n += 1;
    } catch (err) {
      console.error(
        `[arsenkin-case-agent] finalize tick failed ${job.executionId}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
  return n;
}

/** Resume unfinished CaseAgent jobs after Railway restart / interrupted HTTP. */
export async function resumeArsenkinCaseAgentExecutions(deps?: {
  prisma?: PrismaClient;
  /** Skip jobs updated more recently than this (ms). Avoids stealing in-flight HTTP workers. */
  minAgeMs?: number;
}): Promise<number> {
  const minAgeMs = deps?.minAgeMs ?? 90_000;
  const running = listRunningArsenkinCaseAgentExecutions();
  let n = 0;
  const now = Date.now();
  for (const job of running) {
    if (job.phase === "FINALIZED" || job.phase === "FAILED") continue;
    const updatedMs = Date.parse(job.updatedAt || job.createdAt);
    if (Number.isFinite(updatedMs) && now - updatedMs < minAgeMs) {
      continue;
    }
    n += 1;
    void runArsenkinCaseAgentWorker({
      caseId: job.caseId,
      executionId: job.executionId,
      prisma: deps?.prisma,
    }).catch((err) => {
      console.error(
        `[arsenkin-case-agent] resume failed ${job.executionId}:`,
        err instanceof Error ? err.message : err
      );
    });
  }
  return n;
}

/**
 * @deprecated Removed enqueue-only /set path. Kept as no-op for any stale imports.
 * Use runArsenkinCaseAgentWorker instead.
 */
export async function enqueueArsenkinCaseAgentProviderTasks(_input: {
  caseId: string;
  agentId: string;
  executionId: string;
  enrichmentReportRunId: string;
  tools: ArsenkinToolName[];
}): Promise<{ setCalls: number }> {
  console.error(
    "[arsenkin-case-agent] enqueueArsenkinCaseAgentProviderTasks is deprecated; use runArsenkinCaseAgentWorker"
  );
  return { setCalls: 0 };
}
