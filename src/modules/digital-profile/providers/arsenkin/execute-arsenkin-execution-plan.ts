/**
 * Execute a confirmed ArsenkinExecutionPlan (live only, inside LiveExecutionAuthorization).
 * Does not rebuild request bodies — uses plan.requests exactly.
 */

import type { ArsenkinClient } from "./client";
import { waitForArsenkinTaskCompletion } from "./poll-worker";
import type { ProviderTaskStore } from "./provider-task-store";
import { mapCheckTopToObservations } from "./adapters/check-top";
import { mapSuggestToObservations } from "./adapters/suggest";
import { mapPaaToObservations } from "./adapters/paa";
import { mapAiSerpToObservations } from "./adapters/ai-serp";
import { mapCheckHToObservations } from "./adapters/check-h";
import { mapIndexationToObservations } from "./adapters/indexation";
import {
  buildPlannedCoverageMatrix,
  persistPlannedCoverageForDoneRequest,
} from "./planned-coverage-matrix";
import type { SerpObservationDraft } from "../../serp-observation/types";
import type { ArsenkinExecutionPlan, ArsenkinExecutionRequest } from "../../orion-golden/classic/arsenkin-execution-plan";
import { assertPlanRequestHashesMatchBodies } from "../../orion-golden/classic/arsenkin-execution-plan";
import {
  buildLiveAuthorizationFromPlan,
  type LiveExecutionAuthorization,
  withLiveAuthorization,
  getActiveLiveAuthorization,
} from "./live-execution-authorization";
import type { ProviderTaskRecord } from "./types";
import { hashProviderRequest } from "./provider-task-store";

export type ArsenkinSurfaceRun = {
  tool: string;
  engine: string;
  region: string;
  language: string;
  query: string;
  surface: string;
  providerTaskId: string | null;
  resultCount: number;
};

export type ArsenkinPilotCollectResult = {
  mode: "live" | "fixtures";
  drafts: SerpObservationDraft[];
  bySurface: {
    organic: number;
    autocomplete: number;
    paa: number;
    aiAnswer: number;
    pageMeta: number;
    indexation: number;
  };
  taskIds: string[];
  surfaceRuns: ArsenkinSurfaceRun[];
};
function withProviderTaskId<T extends SerpObservationDraft>(
  drafts: T[],
  providerTaskId: string | null | undefined
): T[] {
  if (!providerTaskId) return drafts;
  return drafts.map((d) => ({ ...d, providerTaskId }));
}

async function completePlannedRequest(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  req: ArsenkinExecutionRequest,
  meta: { caseId: string; reportRunId: string; reuseFromRunIds?: readonly string[] },
  waitTimeoutMs: number
): Promise<{ payload: Record<string, unknown>; task: ProviderTaskRecord }> {
  const recomputed = hashProviderRequest(req.requestJson);
  if (recomputed !== req.requestHash) {
    throw new Error(`plan-body-hash-mismatch:${req.requestHash}!=${recomputed}`);
  }
  const row = await waitForArsenkinTaskCompletion(
    client,
    store,
    {
      toolName: req.requestJson.tools_name,
      data: req.requestJson.data,
      caseId: meta.caseId,
      reportRunId: meta.reportRunId,
      reuseFromRunIds: meta.reuseFromRunIds,
    },
    waitTimeoutMs
  );
  if (row.state !== "DONE" || !row.responseJson) {
    throw new Error(`Arsenkin task ${row.state}: ${row.errorCode ?? req.tool}`);
  }
  return { payload: row.responseJson, task: row };
}

export function mapPlannedPayload(input: {
  req: ArsenkinExecutionRequest;
  caseId: string;
  auditRunId: string;
  payload: unknown;
}): SerpObservationDraft[] {
  const { req, caseId, auditRunId, payload } = input;
  const regionLabel = (req.region === "UAE" ? "UAE" : "RU") as "RU" | "UAE";
  const language = regionLabel === "UAE" ? "en" : "ru";
  const query = req.query ?? "subject";

  switch (req.tool) {
    case "check-top": {
      const queries = (req.requestJson.data.queries as string[]) ?? [query];
      const seRaw = req.requestJson.data.se;
      const se = Array.isArray(seRaw)
        ? (seRaw as Array<{ type: number; region: number }>)
        : [{ type: 2, region: 213 }];
      return mapCheckTopToObservations({
        caseId,
        auditRunId,
        regionLabel,
        language,
        queries,
        se,
        payload,
      });
    }
    case "suggest": {
      const seRaw = Number((req.requestJson.data as { se?: number }).se ?? 1);
      const se = (seRaw === 2 ? 2 : seRaw === 3 ? 3 : 1) as 1 | 2 | 3;
      return mapSuggestToObservations({
        caseId,
        auditRunId,
        regionLabel,
        language,
        queries: [query],
        se,
        payload,
      });
    }
    case "paa":
      return mapPaaToObservations({
        caseId,
        auditRunId,
        regionLabel,
        language,
        queries: [query],
        payload,
      });
    case "ai-serp": {
      const seRaw = Number((req.requestJson.data as { se?: number }).se ?? 1);
      const se = (seRaw === 2 ? 2 : 1) as 1 | 2;
      return mapAiSerpToObservations({
        caseId,
        auditRunId,
        regionLabel,
        language,
        queries: [query],
        se,
        payload,
      });
    }
    case "check-h": {
      const urls = (req.requestJson.data.urls as string[]) ?? [];
      return mapCheckHToObservations({
        caseId,
        auditRunId,
        regionLabel: "RU",
        language: "ru",
        urls,
        payload,
      });
    }
    case "indexation": {
      const urls = (req.requestJson.data.urls as string[]) ?? [];
      return mapIndexationToObservations({
        caseId,
        auditRunId,
        regionLabel: "RU",
        language: "ru",
        urls,
        payload,
      });
    }
    default:
      throw new Error(`unsupported-plan-tool:${req.tool}`);
  }
}

export async function executeArsenkinExecutionPlan(input: {
  plan: ArsenkinExecutionPlan;
  authorization: LiveExecutionAuthorization;
  client: ArsenkinClient;
  store: ProviderTaskStore;
  waitTimeoutMs?: number;
  /**
   * Прогоны того же сбора, чьи оплаченные ответы можно переиспользовать вместо
   * повторного платного вызова (см. `EnsureArsenkinTaskInput.reuseFromRunIds`).
   */
  reuseFromRunIds?: readonly string[];
  /** Optional progress hook (CaseAgent UI heartbeat). */
  onProgress?: (info: {
    index: number;
    total: number;
    tool: string;
    engine: string | null;
    region: string | null;
    phase: "start" | "done";
  }) => void | Promise<void>;
}): Promise<ArsenkinPilotCollectResult> {
  assertPlanRequestHashesMatchBodies(input.plan);
  if (input.plan.digest !== input.authorization.confirmedPlanDigest) {
    throw new Error(
      `plan-digest-mismatch plan=${input.plan.digest} auth=${input.authorization.confirmedPlanDigest}`
    );
  }
  if (input.plan.reportRunId !== input.authorization.reportRunId) {
    throw new Error("plan-reportRunId-mismatch");
  }
  for (const r of input.plan.requests) {
    if (!input.authorization.allowedRequestHashes.has(r.requestHash)) {
      throw new Error(`request-not-in-authorization:${r.requestHash}`);
    }
  }

  const run = async (): Promise<ArsenkinPilotCollectResult> => {
    const drafts: SerpObservationDraft[] = [];
    const taskIds: string[] = [];
    const surfaceRuns: ArsenkinSurfaceRun[] = [];
    const waitTimeoutMs = input.waitTimeoutMs ?? 10 * 60_000;
    const coverageMatrix = buildPlannedCoverageMatrix(input.plan);
    const total = input.plan.requests.length;

    for (let index = 0; index < input.plan.requests.length; index += 1) {
      const req = input.plan.requests[index]!;
      await input.onProgress?.({
        index: index + 1,
        total,
        tool: req.tool,
        engine: req.engine,
        region: req.region,
        phase: "start",
      });
      const done = await completePlannedRequest(
        input.client,
        input.store,
        req,
        {
          caseId: input.plan.caseId,
          reportRunId: input.plan.reportRunId,
          reuseFromRunIds: input.reuseFromRunIds,
        },
        waitTimeoutMs
      );
      taskIds.push(done.task.id);
      const mapped = withProviderTaskId(
        mapPlannedPayload({
          req,
          caseId: input.plan.caseId,
          auditRunId: input.plan.reportRunId,
          payload: done.payload,
        }),
        done.task.id
      );
      drafts.push(...mapped);

      const resultCountByQueryId = new Map<string, number>();
      for (const d of mapped) {
        if (d.providerStatus !== "OK") continue;
        resultCountByQueryId.set(d.queryId, (resultCountByQueryId.get(d.queryId) ?? 0) + 1);
      }
      await persistPlannedCoverageForDoneRequest({
        reportRunId: input.plan.reportRunId,
        requestHash: req.requestHash,
        providerTaskId: done.task.id,
        targets: coverageMatrix,
        resultCountByQueryId,
      });

      if (req.tool === "suggest" || req.tool === "paa" || req.tool === "check-top") {
        const surface =
          req.tool === "suggest" ? "autocomplete" : req.tool === "paa" ? "paa" : "organic";
        surfaceRuns.push({
          tool: req.tool,
          engine: req.engine ?? mapped[0]?.engine ?? "GOOGLE",
          region: req.region ?? "RU",
          language: req.region === "UAE" ? "en" : "ru",
          query: req.query ?? "",
          surface,
          providerTaskId: done.task.id,
          resultCount: mapped.filter((d) => d.providerStatus === "OK").length,
        });
      }
      await input.onProgress?.({
        index: index + 1,
        total,
        tool: req.tool,
        engine: req.engine,
        region: req.region,
        phase: "done",
      });
    }

    return {
      mode: "live",
      drafts,
      bySurface: {
        organic: drafts.filter((d) => d.surface === "organic").length,
        autocomplete: drafts.filter((d) => d.surface === "autocomplete").length,
        paa: drafts.filter((d) => d.surface === "paa").length,
        aiAnswer: drafts.filter((d) => d.surface === "ai_answer").length,
        pageMeta: drafts.filter((d) => d.surface === "page_meta").length,
        indexation: drafts.filter((d) => d.surface === "indexation").length,
      },
      taskIds,
      surfaceRuns,
    };
  };

  // Сессия уже открыта выше по этой же цепочке — переиспользуем её вместо
  // вложенной, у которой был бы собственный бюджет.
  //
  // Пока авторизация жила в переменной модуля, «уже открыта» значило «где-то в
  // процессе», и план одного агента мог поехать под авторизацией другого: до
  // отказа `reportRunId-mismatch` дело доходило только на первом же /set. С
  // областью видимости по цепочке (шаг 03) сюда попадает лишь настоящее
  // вложение — но чужую авторизацию всё равно называем вслух и сразу.
  const outer = getActiveLiveAuthorization();
  if (outer) {
    if (outer.reportRunId !== input.authorization.reportRunId) {
      throw new Error(
        `live-authorization-foreign-run outer=${outer.reportRunId} plan=${input.authorization.reportRunId}`
      );
    }
    if (outer.confirmedPlanDigest !== input.authorization.confirmedPlanDigest) {
      throw new Error("live-authorization-foreign-plan-digest");
    }
    return run();
  }
  return withLiveAuthorization(input.authorization, run);
}

export function authorizationFromPlan(
  plan: ArsenkinExecutionPlan,
  liveConfirmed: true = true
): LiveExecutionAuthorization {
  void liveConfirmed;
  return buildLiveAuthorizationFromPlan({
    reportRunId: plan.reportRunId,
    planDigest: plan.digest,
    requestHashes: plan.requests.map((r) => r.requestHash),
    maxNewTasks: plan.maxNewTasks,
    maxEstimatedLimits: plan.maxEstimatedLimits,
    stage: plan.stage,
  });
}

/** Pure gate used by collector entry — no network. */
export function assertLiveCollectAllowed(input: {
  fixturesOnly?: boolean;
  executionPlan?: ArsenkinExecutionPlan | null;
  liveAuthorization?: LiveExecutionAuthorization | null;
}): LiveExecutionAuthorization | null {
  if (input.fixturesOnly) return null;
  const auth = input.liveAuthorization ?? getActiveLiveAuthorization();
  if (!auth) {
    throw new Error(
      "arsenkin-live-blocked: LiveExecutionAuthorization required (token alone is insufficient)"
    );
  }
  if (!input.executionPlan) {
    throw new Error("arsenkin-live-blocked: executionPlan required");
  }
  if (input.executionPlan.digest !== auth.confirmedPlanDigest) {
    throw new Error("arsenkin-live-blocked: plan digest mismatch vs authorization");
  }
  if (input.executionPlan.reportRunId !== auth.reportRunId) {
    throw new Error("arsenkin-live-blocked: reportRunId mismatch");
  }
  if (!auth.liveConfirmed) {
    throw new Error("arsenkin-live-blocked: liveConfirmed required");
  }
  return auth;
}
