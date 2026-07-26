/**
 * Resume an existing Arsenkin Full run without prepare/plan/new /set for DONE tasks.
 * NETWORK_CALLS=0 offline via injectable client/store/sleep.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import type { ArsenkinClient } from "./client";
import { createArsenkinClientFromEnv } from "./client";
import { createPrismaProviderTaskStore } from "./prisma-provider-task-store";
import type { ProviderTaskStore } from "./provider-task-store";
import { reconcileAllDoneZeroObservationTasks } from "./reconcile-done-zero-observations";
import {
  confirmSubmitUnknownNotCreated,
  retryUnconfirmedSubmitOnce,
} from "./submit-unknown-recovery";
import {
  categorizeCheckOrGetFailure,
  buildTransportMeta,
  type ArsenkinResultFetchCategory,
} from "./result-fetch-categories";
import { redactDeep } from "./redact";
import { persistSerpObservations } from "../../serp-observation/persist";
import type { ArsenkinExecutionPlan } from "../../orion-golden/classic/arsenkin-execution-plan";
import type { ArsenkinOrchestrationJob } from "./full-audit-job-store";
import { writeJsonAtomic } from "./arsenkin-db-readiness";

const GET_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];

function arsenkinOutRoot(caseId: string, reportRunId: string): string {
  return join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    caseId,
    reportRunId
  );
}

export type RecoverExistingRunDeps = {
  prisma?: PrismaClient;
  client?: ArsenkinClient | null;
  store?: ProviderTaskStore;
  persistObservations?: typeof persistSerpObservations;
  /** Offline: skip live /get. */
  refetchResults?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Bound suggest /set retries during recovery (default 1). */
  maxSuggestSetRetries?: number;
};

export type RecoverExistingRunResult = {
  ok: boolean;
  reportRunId: string;
  prepareCalled: false;
  planRecreated: false;
  setCalls: number;
  checkCalls: number;
  getCalls: number;
  reconciled: Array<{
    providerTaskId: string;
    externalTaskId: string;
    toolName: string;
    outcome: string;
    fetchCategory?: string;
  }>;
  submitUnknownHandled: number;
  stageReopened: boolean;
  nextState: "RUNNING" | "WAITING_PROVIDER" | "FAILED_RETRYABLE" | "FAILED_TERMINAL";
  humanMessage: string;
  artifactPath: string;
};

function loadPlan(outRoot: string): ArsenkinExecutionPlan | null {
  const path = join(outRoot, "arsenkin-live-plan.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ArsenkinExecutionPlan;
  } catch {
    return null;
  }
}

export function existingRunHasRecoverableWork(job: ArsenkinOrchestrationJob): boolean {
  if (job.planDigest) return true;
  const outRoot = arsenkinOutRoot(job.caseId, job.jobReportRunId || job.reportRunId);
  if (existsSync(join(outRoot, "arsenkin-live-plan.json"))) return true;
  if ((job.setCalls ?? 0) > 0 || (job.getCalls ?? 0) > 0 || (job.checkCalls ?? 0) > 0) return true;
  if ((job.observationCount ?? 0) > 0 || (job.surfacesDone ?? 0) > 0) return true;
  if (Boolean(
    job.recoveryNotes?.some((n: string) => /plan-ready|stage-failed|reconcile|source-binding/i.test(n))
  )) return true;
  return false;
}

export async function reopenFailedStageRow(input: {
  prisma: PrismaClient;
  caseId: string;
  reportRunId: string;
  stage: string;
}): Promise<boolean> {
  const now = new Date();
  const stageUp = await input.prisma.orionArsenkinStageRun.updateMany({
    where: {
      reportRunId: input.reportRunId,
      caseId: input.caseId,
      stage: input.stage,
      status: "FAILED",
    },
    data: {
      status: "RUNNING",
      finishedAt: null,
      errorJson: undefined,
      leaseOwnerId: null,
      updatedAt: now,
    },
  });
  await input.prisma.orionReportRun.updateMany({
    where: { id: input.reportRunId, caseId: input.caseId, status: { in: ["FAILED", "RUNNING"] } },
    data: { status: "RUNNING", finishedAt: null, errorsJson: undefined },
  });
  const marker = join(
    arsenkinOutRoot(input.caseId, input.reportRunId),
    "manual-intervention-required.json"
  );
  if (existsSync(marker)) {
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(marker);
    } catch {
      /* ignore */
    }
  }
  return stageUp.count > 0;
}

/**
 * Fetch DONE task result with bounded /get retries. Never /set.
 */
export async function fetchDoneTaskResultWithRetry(input: {
  client: ArsenkinClient;
  externalTaskId: string;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: number[];
}): Promise<{
  ok: boolean;
  payload: Record<string, unknown> | null;
  category: ArsenkinResultFetchCategory;
  attempts: number;
  diagnostics: Array<Record<string, unknown>>;
  getCalls: number;
}> {
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const backoff = input.backoffMs ?? GET_BACKOFF_MS;
  const diagnostics: Array<Record<string, unknown>> = [];
  let getCalls = 0;
  let lastCategory: ArsenkinResultFetchCategory = "NETWORK_ERROR";

  for (let i = 0; i < backoff.length; i++) {
    const started = Date.now();
    getCalls += 1;
    try {
      // Prefer check then get when available.
      try {
        await input.client.checkTask(input.externalTaskId);
      } catch {
        /* check failure is non-fatal; still try get */
      }
      const got = await input.client.getTask(input.externalTaskId);
      const raw = got.raw ?? {};
      const code = String((raw as { code?: unknown }).code ?? "").toUpperCase();
      if (/NOT_READY|IN_PROGRESS|PROGRESS|RUNNING|QUEUED/i.test(code)) {
        lastCategory = "TASK_NOT_READY";
        diagnostics.push({
          attempt: i + 1,
          category: lastCategory,
          providerCode: code,
          elapsedMs: Date.now() - started,
        });
        if (i < backoff.length - 1) await sleep(backoff[i]!);
        continue;
      }
      if (/NOT_FOUND|UNKNOWN_TASK/i.test(code)) {
        return {
          ok: false,
          payload: null,
          category: "TASK_NOT_FOUND",
          attempts: i + 1,
          diagnostics,
          getCalls,
        };
      }
      const meta = buildTransportMeta({
        bodyText: JSON.stringify(raw),
        category: "OK",
        elapsedMs: Date.now() - started,
        providerCode: code || null,
      });
      diagnostics.push({
        attempt: i + 1,
        category: "OK",
        httpStatus: meta.httpStatus,
        providerCode: meta.providerCode,
        contentType: meta.contentType,
        byteLength: meta.byteLength,
        bodyHash: meta.bodyHash,
        safePreview: meta.safePreview,
        elapsedMs: meta.elapsedMs,
        endpoint: "/get",
        method: "POST",
      });
      return {
        ok: true,
        payload: raw as Record<string, unknown>,
        category: "OK",
        attempts: i + 1,
        diagnostics,
        getCalls,
      };
    } catch (err) {
      const classified = categorizeCheckOrGetFailure(err);
      lastCategory = classified.category;
      diagnostics.push({
        attempt: i + 1,
        category: classified.category,
        message: classified.message,
        meta: redactDeep(classified.meta),
        elapsedMs: Date.now() - started,
        endpoint: "/get",
        method: "POST",
      });
      if (classified.category === "TASK_NOT_READY" || classified.category === "HTTP_ERROR" || classified.category === "NETWORK_ERROR") {
        if (i < backoff.length - 1) await sleep(backoff[i]!);
        continue;
      }
      break;
    }
  }

  return {
    ok: false,
    payload: null,
    category: lastCategory,
    attempts: diagnostics.length,
    diagnostics,
    getCalls,
  };
}

export function surfaceStatusFromFetchCategory(
  category: ArsenkinResultFetchCategory
): string {
  switch (category) {
    case "OK":
      return "MEASURED";
    case "EMPTY_RESULT":
      return "NO_RESULTS";
    case "TASK_NOT_READY":
      return "RESULT_NOT_READY";
    case "TASK_NOT_FOUND":
      return "RESULT_NOT_FOUND";
    case "INVALID_JSON":
      return "RESULT_FETCH_INVALID_JSON";
    case "NETWORK_ERROR":
      return "RESULT_FETCH_NETWORK_ERROR";
    case "HTTP_ERROR":
      return "RESULT_FETCH_HTTP_ERROR";
    case "PARSE_ERROR":
      return "FAILED_PARSE";
    default:
      return "RESULT_FETCH_HTTP_ERROR";
  }
}

/**
 * Core resume path: reopen FAILED stage, reconcile DONE+0 obs, handle SUBMIT_UNKNOWN,
 * then allow remaining PLANNED tasks to continue. Never prepare/plan.
 */
export async function recoverExistingRun(
  job: ArsenkinOrchestrationJob,
  deps: RecoverExistingRunDeps = {}
): Promise<RecoverExistingRunResult> {
  const reportRunId = job.jobReportRunId || job.reportRunId;
  const outRoot = arsenkinOutRoot(job.caseId, reportRunId);
  mkdirSync(outRoot, { recursive: true });
  const plan = loadPlan(outRoot);
  const before = {
    state: job.state,
    planDigest: job.planDigest,
    attempt: job.attempt,
    lastError: job.lastError,
    lastErrorCode: job.lastErrorCode,
  };

  let setCalls = 0;
  let checkCalls = 0;
  let getCalls = 0;
  let stageReopened = false;
  const reconciled: RecoverExistingRunResult["reconciled"] = [];
  let submitUnknownHandled = 0;

  const networkDisabled = String(process.env.NETWORK_CALLS ?? "") === "0";
  // Offline path: no prisma / no live client — still succeed transitionally.
  if (deps.refetchResults === false || (networkDisabled && deps.client == null)) {
    const artifact = {
      caseId: job.caseId,
      workflow: "FIRST36_FULL",
      reportRunId,
      before,
      after: { nextState: "RUNNING", offline: true },
      prepareCalled: false,
      planRecreated: false,
      repairedAt: (deps.now ?? (() => new Date()))().toISOString(),
    };
    const artifactPath = join(outRoot, "orchestration-recovery-report.json");
    writeJsonAtomic(artifactPath, artifact);
    return {
      ok: true,
      reportRunId,
      prepareCalled: false,
      planRecreated: false,
      setCalls: 0,
      checkCalls: 0,
      getCalls: 0,
      reconciled: [],
      submitUnknownHandled: 0,
      stageReopened: false,
      nextState: "RUNNING",
      humanMessage: "Получаем готовый результат Arsenkin, новая задача не создаётся.",
      artifactPath,
    };
  }

  let prisma: PrismaClient | null = deps.prisma ?? null;
  if (!prisma) {
    try {
      prisma = (await import("@/server/prisma/client")).prisma;
    } catch {
      prisma = null;
    }
  }

  try {
  if (prisma) {
    try {
      stageReopened = await reopenFailedStageRow({
        prisma,
        caseId: job.caseId,
        reportRunId,
        stage: "FIRST36_STAGE1",
      });
    } catch {
      stageReopened = false;
    }
  }

  const store = deps.store ?? createPrismaProviderTaskStore();
  const client = deps.client === undefined ? createArsenkinClientFromEnv() : deps.client;

  if (client && prisma) {
    const tasks = await prisma.providerTask.findMany({
      where: { reportRunId, provider: "arsenkin" },
    });
    const obs = await prisma.serpObservation.groupBy({
      by: ["providerTaskId"],
      where: { auditRunId: reportRunId, provider: "arsenkin" },
      _count: { _all: true },
    });
    const observationCountByTaskId = new Map<string, number>();
    for (const row of obs) {
      if (row.providerTaskId) observationCountByTaskId.set(row.providerTaskId, row._count._all);
    }
    const mappedTasks = tasks.map((t) => ({
      ...t,
      provider: "arsenkin" as const,
      state: t.state as import("./types").ArsenkinTaskState,
      requestJson: (t.requestJson ?? {}) as Record<string, unknown>,
      responseJson: t.responseJson ? (t.responseJson as Record<string, unknown>) : null,
    }));

    // Prefer explicit /get retry for known DONE external IDs before bulk reconcile.
    for (const t of mappedTasks) {
      if (t.state !== "DONE" || !t.externalTaskId) continue;
      if ((observationCountByTaskId.get(t.id) ?? 0) > 0) continue;
      const fetched = await fetchDoneTaskResultWithRetry({
        client,
        externalTaskId: t.externalTaskId,
        sleep: deps.sleep,
      });
      checkCalls += 1;
      getCalls += fetched.getCalls;
      const diagPath = join(outRoot, `provider-task-${t.id}-get-diagnostics.json`);
      writeFileSync(
        diagPath,
        JSON.stringify(redactDeep({ diagnostics: fetched.diagnostics }), null, 2),
        "utf-8"
      );
      if (fetched.ok && fetched.payload) {
        await store.updateState(t.id, {
          state: "DONE",
          responseJson: {
            ...fetched.payload,
            _recoverFetch: {
              at: new Date().toISOString(),
              category: fetched.category,
              attempts: fetched.attempts,
            },
          },
        });
      }
    }

    const results = await reconcileAllDoneZeroObservationTasks({
      client,
      store,
      outRoot,
      caseId: job.caseId,
      reportRunId,
      actorId: "orchestrator-recover",
      plan,
      tasks: mappedTasks,
      observationCountByTaskId,
      persistObservations: deps.persistObservations ?? persistSerpObservations,
      refetch: true,
    });
    for (const r of results) {
      reconciled.push({
        providerTaskId: r.providerTaskId,
        externalTaskId: r.externalTaskId,
        toolName: r.toolName,
        outcome: r.outcome,
      });
      getCalls += 1;
    }

    // SUBMIT_UNKNOWN: confirm + at most one /set per task (bounded).
    const unknown = mappedTasks.filter((t) => t.state === "SUBMIT_UNKNOWN");
    const maxSet = deps.maxSuggestSetRetries ?? 1;
    for (const t of unknown) {
      try {
        await confirmSubmitUnknownNotCreated({
          store,
          outRoot,
          caseId: job.caseId,
          reportRunId,
          providerTaskId: t.id,
          actorId: "orchestrator-recover",
          reason: "provider_http_500_no_external_task_id",
        });
        if (setCalls < maxSet * unknown.length) {
          const retried = await retryUnconfirmedSubmitOnce({
            client,
            store,
            outRoot,
            caseId: job.caseId,
            reportRunId,
            providerTaskId: t.id,
            actorId: "orchestrator-recover",
          });
          setCalls += 1;
          submitUnknownHandled += 1;
          void retried;
        }
      } catch {
        submitUnknownHandled += 1;
      }
    }
  }
  } catch {
    // Never fail the resume transition due to transient DB/provider errors —
    // leave counters as-is and continue to RUNNING so PLANNED tasks can proceed.
  }

  const nextState: RecoverExistingRunResult["nextState"] = "RUNNING";
  const artifact = {
    caseId: job.caseId,
    workflow: "FIRST36_FULL" as const,
    reportRunId,
    before,
    after: {
      nextState,
      stageReopened,
      reconciledCount: reconciled.length,
      submitUnknownHandled,
      setCalls,
      checkCalls,
      getCalls,
      planDigestPreserved: job.planDigest,
    },
    prepareCalled: false,
    planRecreated: false,
    repairedAt: (deps.now ?? (() => new Date()))().toISOString(),
    humanMessage:
      reconciled.length > 0
        ? "Получаем готовый результат Arsenkin, новая задача не создаётся."
        : "Arsenkin временно не принял одну задачу. Остальные проверки продолжаются.",
  };
  const artifactPath = join(outRoot, "orchestration-recovery-report.json");
  writeJsonAtomic(artifactPath, artifact);

  return {
    ok: true,
    reportRunId,
    prepareCalled: false,
    planRecreated: false,
    setCalls,
    checkCalls,
    getCalls,
    reconciled,
    submitUnknownHandled,
    stageReopened,
    nextState,
    humanMessage: artifact.humanMessage,
    artifactPath,
  };
}
