/**
 * Durable Arsenkin CaseAgent execution — split from arsenkin-case-agent-execution.ts
 * (REMEDIATION §9.5) — mechanical move only.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { ArsenkinToolName } from "../../providers/arsenkin/flags";
import {
  FIRST36_FULL_SURFACE_SLOTS,
  type FullFirst36SurfaceSlot,
} from "../../providers/arsenkin/workflow-contract";
import { writeJsonAtomic } from "../../providers/arsenkin/arsenkin-db-readiness";
import { isValidBaseOrionReportRunId } from "../../providers/arsenkin/source-binding-repair";
import { buildArsenkinSubjectQueryPlan } from "../../orion-golden/classic/arsenkin-subject-query-plan";
import {
  buildArsenkinExecutionPlan,
  type ArsenkinExecutionPlan,
  type ArsenkinLiveStage,
} from "../../orion-golden/classic/arsenkin-execution-plan";
import { pickEnrichmentUrls } from "../../orion-golden/classic/enrich-report-run-with-arsenkin";
import { planArsenkinExactTasks } from "../../orion-golden/classic/plan-arsenkin-exact-tasks";
import { writeAgentRunStatus } from "./agent-run-status";


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

export const NON_TERMINAL_TASK = new Set([
  "QUEUED",
  "SUBMITTING",
  "RUNNING",
  "RATE_LIMITED",
  "WAITING",
  "SUBMIT_UNKNOWN",
]);

/**
 * Очередь на одно исполнение, а не на весь процесс.
 *
 * Здесь стояла одна очередь на процесс с объяснением «LiveExecutionAuthorization
 * is process-scoped». Это объяснение устарело: авторизация переехала в
 * `AsyncLocalStorage` и действует в пределах цепочки вызовов — в
 * `live-execution-authorization.ts` об этом сказано прямо («параллельная цепочка
 * — не вложение и не мешает»). Очередь пережила свою причину и осталась
 * работать: на живом прогоне пять агентов шли строго друг за другом, первый
 * собирал данные, остальные четыре стояли в PREPARING, и двенадцать
 * поверхностей занимали около двадцати минут.
 *
 * Что очередь защищала помимо авторизации — это повторный запуск **одного и
 * того же** исполнения (перезапуск воркера, дозапуск из тика). Эта защита нужна
 * и сохранена: ключ очереди — `caseId/executionId`. Разные агенты друг друга
 * больше не ждут; сколько задач Arsenkin идёт одновременно, отвечает
 * `withArsenkinTaskSlot`.
 */
const executionQueues = new Map<string, Promise<void>>();

export function enqueueCaseAgentWork<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = executionQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  executionQueues.set(key, tail);
  // Хвост очереди удаляется, когда он последний: иначе карта растёт на каждое
  // исполнение и держит их до конца жизни процесса.
  void tail.then(() => {
    if (executionQueues.get(key) === tail) executionQueues.delete(key);
  });
  return run;
}

export function executionRoot(caseId: string): string {
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

/**
 * Per-task wait for CaseAgent live polls.
 * Production evidence: Arsenkin check-top often needs 3–6 minutes; 90s caused false timeouts
 * while Arsenkin UI already showed the task DONE.
 */
export function caseAgentWaitTimeoutMs(tools: readonly string[]): number {
  const fromEnv = Number(process.env.ARSENKIN_CASE_AGENT_WAIT_MS ?? "");
  if (Number.isFinite(fromEnv) && fromEnv >= 60_000) return fromEnv;
  const set = new Set(tools.map(String));
  if (set.has("check-top")) return 10 * 60_000;
  if (set.has("paa") || set.has("check-h") || set.has("indexation")) return 6 * 60_000;
  if (set.has("suggest") || set.has("ai-serp")) return 4 * 60_000;
  return 8 * 60_000;
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

export function emptyIds(): Pick<
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

export async function loadSubjectForCase(
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

export async function loadUrlsFromSearchResults(
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

export function classifyWorkerError(err: unknown): { errorCode: string; errorMessage: string } {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  if (/timeout|waitedMs/i.test(message)) {
    return { errorCode: "ARSENKIN_TASK_TIMEOUT", errorMessage: message };
  }
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

export async function failJobAndAgentRun(input: {
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

    await writeAgentRunStatus({
      prisma,
      agentRunId: job.agentRunId,
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

