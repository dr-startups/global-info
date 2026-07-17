/**
 * Collect Arsenkin First36 pilot surfaces (check-top / suggest / paa) for one subject.
 * Uses live API when configured; otherwise fixtures (no limit spend).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArsenkinClient } from "./client";
import { createArsenkinClientFromEnv } from "./client";
import { isArsenkinConfigured, isArsenkinToolEnabled, type ArsenkinToolName } from "./flags";
import { ensureArsenkinTask, pollArsenkinTask, waitForArsenkinTaskCompletion } from "./poll-worker";
import { createMemoryProviderTaskStore, type ProviderTaskStore } from "./provider-task-store";
import { createPrismaProviderTaskStore } from "./prisma-provider-task-store";
import { recordSurfaceCoverageFromDrafts } from "./surface-coverage";
import { upsertSurfaceCollectionCoverage } from "./surface-coverage";
import { buildCheckTopRequest, mapCheckTopToObservations } from "./adapters/check-top";
import { buildSuggestRequest, mapSuggestToObservations } from "./adapters/suggest";
import { buildPaaRequest, mapPaaToObservations } from "./adapters/paa";
import { buildAiSerpRequest, mapAiSerpToObservations } from "./adapters/ai-serp";
import { buildCheckHRequest, mapCheckHToObservations } from "./adapters/check-h";
import { buildIndexationRequest, mapIndexationToObservations } from "./adapters/indexation";
import { ARSENKIN_REGION, pilotSeForRegion } from "./regions";
import type { SerpObservationDraft } from "../../serp-observation/types";
import { buildSerpQueryId } from "../../serp-observation/query-id";
import type { ProviderTaskRecord } from "./types";
import type { ArsenkinExecutionPlan } from "../../orion-golden/classic/arsenkin-execution-plan";
import { evaluateExecutionPlanBudget } from "../../orion-golden/classic/arsenkin-execution-plan";
import type { LiveExecutionAuthorization } from "./live-execution-authorization";
import {
  assertLiveCollectAllowed,
  executeArsenkinExecutionPlan,
  type ArsenkinPilotCollectResult as PlanCollectResult,
  type ArsenkinSurfaceRun as PlanSurfaceRun,
} from "./execute-arsenkin-execution-plan";

const FIX = join(
  process.cwd(),
  "src/modules/digital-profile/providers/arsenkin/fixtures"
);

function loadFix(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf-8"));
}

export type ArsenkinSurfaceRun = PlanSurfaceRun;

export type ArsenkinPilotCollectInput = {
  caseId: string;
  auditRunId: string;
  queriesRu: string[];
  queriesUae: string[];
  /** Force fixtures even if token present. */
  fixturesOnly?: boolean;
  /** Limit which tools to run (default: all enabled). */
  tools?: ArsenkinToolName[];
  /**
   * Which ai-serp targets to fetch (default: all three).
   * Use to avoid re-spending limits when some engines already enriched.
   */
  aiSerpTargets?: Array<"yandex_ru" | "google_ru" | "google_uae">;
  /** Organic/risk URLs for check-h + indexation enrichment (max ~5). */
  urlsEnrichment?: string[];
  client?: ArsenkinClient | null;
  store?: ProviderTaskStore;
  waitTimeoutMs?: number;
  /** Required for live: exact confirmed plan. */
  executionPlan?: ArsenkinExecutionPlan;
  /** Required for live: digest-bound authorization. */
  liveAuthorization?: LiveExecutionAuthorization;
};

export type ArsenkinPilotCollectResult = PlanCollectResult;

async function completeTask(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  toolName: string,
  data: Record<string, unknown>,
  meta: { caseId: string; auditRunId: string; taskIds?: string[] },
  waitTimeoutMs: number
): Promise<{ payload: Record<string, unknown>; task: ProviderTaskRecord }> {
  const row = await waitForArsenkinTaskCompletion(
    client,
    store,
    {
      toolName,
      data,
      caseId: meta.caseId,
      reportRunId: meta.auditRunId,
    },
    waitTimeoutMs
  );
  if (row.state !== "DONE" || !row.responseJson) {
    throw new Error(`Arsenkin task ${row.state}: ${row.errorCode ?? toolName}`);
  }
  meta.taskIds?.push(row.id);
  return { payload: row.responseJson, task: row };
}

function withProviderTaskId<T extends SerpObservationDraft>(
  drafts: T[],
  providerTaskId: string | null | undefined
): T[] {
  if (!providerTaskId) return drafts;
  return drafts.map((d) => ({ ...d, providerTaskId }));
}

function pushSurfaceRun(
  surfaceRuns: ArsenkinSurfaceRun[],
  run: ArsenkinSurfaceRun
): void {
  surfaceRuns.push(run);
}

export async function collectArsenkinPilotSurfaces(
  input: ArsenkinPilotCollectInput
): Promise<ArsenkinPilotCollectResult> {
  // Token + ARSENKIN_ENABLED is never enough for live — need plan + authorization.
  if (!input.fixturesOnly) {
    const auth = assertLiveCollectAllowed({
      fixturesOnly: false,
      executionPlan: input.executionPlan,
      liveAuthorization: input.liveAuthorization,
    });
    const plan = input.executionPlan!;
    const budget = evaluateExecutionPlanBudget(plan);
    if (!budget.ok) {
      throw new Error(`arsenkin-live-blocked:budget:${budget.blockers.join(",")}`);
    }
    if (plan.reportRunId !== input.auditRunId) {
      throw new Error("arsenkin-live-blocked:auditRunId-vs-plan-reportRunId");
    }
    const client = input.client ?? createArsenkinClientFromEnv();
    if (!client) {
      throw new Error("Arsenkin live collection requires a configured client and API token");
    }
    const store = input.store ?? createPrismaProviderTaskStore();
    return executeArsenkinExecutionPlan({
      plan,
      authorization: auth!,
      client,
      store,
      waitTimeoutMs: input.waitTimeoutMs,
    });
  }

  // Fixtures-only path (no network, no live authorization).
  const live = false;
  const client = null;
  const store = input.store ?? createMemoryProviderTaskStore();
  const drafts: SerpObservationDraft[] = [];
  const taskIds: string[] = [];
  const surfaceRuns: ArsenkinSurfaceRun[] = [];
  const waitTimeoutMs = input.waitTimeoutMs ?? 10 * 60_000;
  void live;
  void client;
  void waitTimeoutMs;
  void isArsenkinConfigured;

  const ruQuery = input.queriesRu[0] ?? "subject";
  const uaeQuery = input.queriesUae[0] ?? ruQuery;
  const ruQueries = input.queriesRu.map((q) => String(q ?? "").trim()).filter(Boolean).slice(0, 5);
  const uaeQueries = input.queriesUae.map((q) => String(q ?? "").trim()).filter(Boolean).slice(0, 4);
  const want = (tool: ArsenkinToolName) =>
    (!input.tools || input.tools.includes(tool)) &&
    (isArsenkinToolEnabled(tool) || input.fixturesOnly || !live);

  // --- check-top RU ---
  if (want("check-top")) {
    const se = pilotSeForRegion("RU");
    const req = buildCheckTopRequest({
      queries: ruQueries.length > 0 ? ruQueries : [ruQuery],
      se,
      depth: 20,
      is_snippet: true,
      noreask: true,
    });
    let providerTaskId: string | null = null;
    let payload: unknown;
    if (live && client) {
      const done = await completeTask(client, store, "check-top", req.data, { ...input, taskIds }, waitTimeoutMs);
      payload = done.payload;
      providerTaskId = done.task.id;
    } else {
      payload = loadFix("get-check-top.json");
    }
    drafts.push(
      ...withProviderTaskId(mapCheckTopToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        queries: ruQueries.length > 0 ? ruQueries : [ruQuery],
        se,
        payload,
      }), providerTaskId)
    );
    const ruOrganic = drafts.filter(
      (d) => d.surface === "organic" && d.region === "RU" && d.providerTaskId === providerTaskId
    );
    pushSurfaceRun(surfaceRuns, {
      tool: "check-top",
      engine: ruOrganic[0]?.engine ?? "GOOGLE",
      region: "RU",
      language: "ru",
      query: input.queriesRu[0] ?? ruQuery,
      surface: "organic",
      providerTaskId,
      resultCount: ruOrganic.filter((d) => d.providerStatus === "OK").length,
    });
  }

  // --- check-top UAE (Google only) ---
  if (want("check-top") && input.queriesUae.length > 0) {
    const se = pilotSeForRegion("UAE");
    const req = buildCheckTopRequest({
      queries: uaeQueries.length > 0 ? uaeQueries : [uaeQuery],
      se,
      depth: 20,
      is_snippet: true,
      noreask: true,
    });
    let providerTaskId: string | null = null;
    let payload: unknown;
    if (live && client) {
      const done = await completeTask(client, store, "check-top", req.data, { ...input, taskIds }, waitTimeoutMs);
      payload = done.payload;
      providerTaskId = done.task.id;
    } else {
      const stubUrl = "https://example.com/uae/profile";
      payload = {
            result: {
              result: {
                collect: [[[stubUrl]]],
                snippets: {
                  [stubUrl]: [
                    { title: uaeQuery || "UAE profile", snippet: "UAE fixture" },
                  ],
                },
              },
            },
          };
    }
    drafts.push(
      ...withProviderTaskId(mapCheckTopToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "UAE",
        language: "en",
        queries: uaeQueries.length > 0 ? uaeQueries : [uaeQuery],
        se,
        payload,
      }), providerTaskId)
    );
  }

  // --- suggest RU (Yandex) — exactly one query per ProviderTask ---
  if (want("suggest")) {
    const req = buildSuggestRequest({
      queries: ruQueries.length > 0 ? ruQueries : [ruQuery],
      se: 1,
      region: ARSENKIN_REGION.YANDEX_MOSCOW,
      depth: 1,
      primaryLocalized: ruQuery,
      primaryLatin: uaeQuery,
    });
    const selectedYandex = (req.data.queries as string[]).slice(0, 1);
    let providerTaskId: string | null = null;
    let payload: unknown;
    if (live && client) {
      const done = await completeTask(client, store, "suggest", req.data, { ...input, taskIds }, waitTimeoutMs);
      payload = done.payload;
      providerTaskId = done.task.id;
    } else {
      payload = loadFix("get-suggest.json");
    }
    const mappedSuggestYandex = withProviderTaskId(mapSuggestToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        queries: selectedYandex,
        se: 1,
        payload,
      }), providerTaskId);
    drafts.push(...mappedSuggestYandex);
    pushSurfaceRun(surfaceRuns, {
      tool: "suggest",
      engine: "YANDEX",
      region: "RU",
      language: "ru",
      query: selectedYandex[0] ?? ruQuery,
      surface: "autocomplete",
      providerTaskId,
      resultCount: mappedSuggestYandex.filter((d) => d.providerStatus === "OK").length,
    });
  }

  // --- suggest RU (Google) — exactly one Latin query ---
  if (want("suggest") && uaeQueries.length > 0) {
    const req = buildSuggestRequest({
      queries: uaeQueries,
      se: 2,
      region: ARSENKIN_REGION.GOOGLE_MOSCOW,
      google_domain: "www.google.ru",
      google_from: "RU",
      google_lang: "ru",
      depth: 1,
      primaryLocalized: ruQuery,
      primaryLatin: uaeQuery,
    });
    const selectedGoogleRu = (req.data.queries as string[]).slice(0, 1);
    let providerTaskId: string | null = null;
    let payload: unknown;
    if (live && client) {
      const done = await completeTask(client, store, "suggest", req.data, { ...input, taskIds }, waitTimeoutMs);
      payload = done.payload;
      providerTaskId = done.task.id;
    } else {
      payload = loadFix("get-suggest.json");
    }
    const mappedSuggestGoogleRu = withProviderTaskId(mapSuggestToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        queries: selectedGoogleRu,
        se: 2,
        payload,
      }), providerTaskId);
    drafts.push(...mappedSuggestGoogleRu);
    pushSurfaceRun(surfaceRuns, {
      tool: "suggest",
      engine: "GOOGLE",
      region: "RU",
      language: "ru",
      query: selectedGoogleRu[0] ?? uaeQuery,
      surface: "autocomplete",
      providerTaskId,
      resultCount: mappedSuggestGoogleRu.filter((d) => d.providerStatus === "OK").length,
    });
  }

  // --- suggest UAE (Google) — exactly one Latin query ---
  if (want("suggest") && input.queriesUae.length > 0) {
    const req = buildSuggestRequest({
      queries: uaeQueries.length > 0 ? uaeQueries : [uaeQuery],
      se: 2,
      region: ARSENKIN_REGION.GOOGLE_UAE,
      google_domain: "www.google.ae",
      google_from: "AE",
      google_lang: "en",
      depth: 1,
      primaryLocalized: ruQuery,
      primaryLatin: uaeQuery,
    });
    const selectedGoogleUae = (req.data.queries as string[]).slice(0, 1);
    let providerTaskId: string | null = null;
    let payload: unknown;
    if (live && client) {
      const done = await completeTask(client, store, "suggest", req.data, { ...input, taskIds }, waitTimeoutMs);
      payload = done.payload;
      providerTaskId = done.task.id;
    } else {
      payload = loadFix("get-suggest.json");
    }
    const mappedSuggestUae = withProviderTaskId(mapSuggestToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "UAE",
        language: "en",
        queries: selectedGoogleUae,
        se: 2,
        payload,
      }), providerTaskId);
    drafts.push(...mappedSuggestUae);
    pushSurfaceRun(surfaceRuns, {
      tool: "suggest",
      engine: "GOOGLE",
      region: "UAE",
      language: "en",
      query: selectedGoogleUae[0] ?? uaeQuery,
      surface: "autocomplete",
      providerTaskId,
      resultCount: mappedSuggestUae.filter((d) => d.providerStatus === "OK").length,
    });
  }

  // --- paa RU (Google-only) ---
  if (want("paa")) {
    const req = buildPaaRequest({
      queries: [ruQuery],
      region: ARSENKIN_REGION.GOOGLE_MOSCOW,
      depth: 1,
      count: 10,
    });
    let providerTaskId: string | null = null;
    let payload: unknown;
    if (live && client) {
      const done = await completeTask(client, store, "paa", req.data, { ...input, taskIds }, waitTimeoutMs);
      payload = done.payload;
      providerTaskId = done.task.id;
    } else {
      payload = loadFix("get-paa.json");
    }
    const mappedPaaRu = withProviderTaskId(mapPaaToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        queries: [ruQuery],
        payload,
      }), providerTaskId);
    drafts.push(...mappedPaaRu);
    pushSurfaceRun(surfaceRuns, {
      tool: "paa",
      engine: "GOOGLE",
      region: "RU",
      language: "ru",
      query: ruQuery,
      surface: "paa",
      providerTaskId,
      resultCount: mappedPaaRu.filter((d) => d.providerStatus === "OK").length,
    });
  }

  // --- paa UAE (Google-only) ---
  if (want("paa") && input.queriesUae.length > 0) {
    const req = buildPaaRequest({
      queries: [uaeQuery],
      region: ARSENKIN_REGION.GOOGLE_UAE,
      google_domain: "www.google.ae",
      google_from: "AE",
      google_lang: "en",
      depth: 1,
      count: 10,
    });
    let providerTaskId: string | null = null;
    let payload: unknown;
    if (live && client) {
      const done = await completeTask(client, store, "paa", req.data, { ...input, taskIds }, waitTimeoutMs);
      payload = done.payload;
      providerTaskId = done.task.id;
    } else {
      payload = loadFix("get-paa.json");
    }
    const mappedPaaUae = withProviderTaskId(mapPaaToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "UAE",
        language: "en",
        queries: [uaeQuery],
        payload,
      }), providerTaskId);
    drafts.push(...mappedPaaUae);
    pushSurfaceRun(surfaceRuns, {
      tool: "paa",
      engine: "GOOGLE",
      region: "UAE",
      language: "en",
      query: uaeQuery,
      surface: "paa",
      providerTaskId,
      resultCount: mappedPaaUae.filter((d) => d.providerStatus === "OK").length,
    });
  }

  // --- ai-serp: Yandex Alice (RU) + Google AI Overview (RU/UAE) — not Knowledge Panel ---
  if (want("ai-serp")) {
    const targets = new Set(
      input.aiSerpTargets ?? (["yandex_ru", "google_ru", "google_uae"] as const)
    );

    if (targets.has("yandex_ru")) {
      const req = buildAiSerpRequest({
        queries: [ruQuery],
        se: 1,
        region: ARSENKIN_REGION.YANDEX_MOSCOW,
      });
      let providerTaskId: string | null = null;
    let payload: unknown;
    if (live && client) {
      const done = await completeTask(client, store, "ai-serp", req.data, { ...input, taskIds }, waitTimeoutMs);
      payload = done.payload;
      providerTaskId = done.task.id;
    } else {
      payload = loadFix("get-ai-serp.json");
    }
      drafts.push(
        ...withProviderTaskId(mapAiSerpToObservations({
          caseId: input.caseId,
          auditRunId: input.auditRunId,
          regionLabel: "RU",
          language: "ru",
          queries: [ruQuery],
          se: 1,
          payload,
        }), providerTaskId)
      );
    }

    if (targets.has("google_ru")) {
      const req = buildAiSerpRequest({
        queries: [ruQuery],
        se: 2,
        region: ARSENKIN_REGION.GOOGLE_MOSCOW,
      });
      let providerTaskId: string | null = null;
    let payload: unknown;
    if (live && client) {
      const done = await completeTask(client, store, "ai-serp", req.data, { ...input, taskIds }, waitTimeoutMs);
      payload = done.payload;
      providerTaskId = done.task.id;
    } else {
      payload = loadFix("get-ai-serp-google.json");
    }
      drafts.push(
        ...withProviderTaskId(mapAiSerpToObservations({
          caseId: input.caseId,
          auditRunId: input.auditRunId,
          regionLabel: "RU",
          language: "ru",
          queries: [ruQuery],
          se: 2,
          payload,
        }), providerTaskId)
      );
    }

    if (targets.has("google_uae")) {
      const req = buildAiSerpRequest({
        queries: [uaeQuery],
        se: 2,
        region: ARSENKIN_REGION.GOOGLE_UAE,
      });
      let providerTaskId: string | null = null;
    let payload: unknown;
    if (live && client) {
      const done = await completeTask(client, store, "ai-serp", req.data, { ...input, taskIds }, waitTimeoutMs);
      payload = done.payload;
      providerTaskId = done.task.id;
    } else {
      payload = loadFix("get-ai-serp-google-uae.json");
    }
      drafts.push(
        ...withProviderTaskId(mapAiSerpToObservations({
          caseId: input.caseId,
          auditRunId: input.auditRunId,
          regionLabel: "UAE",
          language: "en",
          queries: [uaeQuery],
          se: 2,
          payload,
        }), providerTaskId)
      );
    }
  }

  const enrichUrls = (input.urlsEnrichment ?? [])
    .map((u) => String(u).trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 10);

  if (want("check-h") && enrichUrls.length > 0) {
    const req = buildCheckHRequest({ urls: enrichUrls, mode: "url" });
    let providerTaskId: string | null = null;
    let payload: unknown;
    if (live && client) {
      const done = await completeTask(client, store, "check-h", req.data, { ...input, taskIds }, waitTimeoutMs);
      payload = done.payload;
      providerTaskId = done.task.id;
    } else {
      payload = loadFix("get-check-h.json");
    }
    drafts.push(
      ...withProviderTaskId(mapCheckHToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        urls: enrichUrls,
        payload,
      }), providerTaskId)
    );
  }

  if (want("indexation") && enrichUrls.length > 0) {
    const req = buildIndexationRequest({ urls: enrichUrls });
    let providerTaskId: string | null = null;
    let payload: unknown;
    if (live && client) {
      const done = await completeTask(client, store, "indexation", req.data, { ...input, taskIds }, waitTimeoutMs);
      payload = done.payload;
      providerTaskId = done.task.id;
    } else {
      payload = loadFix("get-indexation.json");
    }
    drafts.push(
      ...withProviderTaskId(mapIndexationToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        urls: enrichUrls,
        payload,
      }), providerTaskId)
    );
  }

  const bySurface = {
    organic: drafts.filter((d) => d.surface === "organic").length,
    autocomplete: drafts.filter((d) => d.surface === "autocomplete").length,
    paa: drafts.filter((d) => d.surface === "paa").length,
    aiAnswer: drafts.filter((d) => d.surface === "ai_answer").length,
    pageMeta: drafts.filter((d) => d.surface === "page_meta").length,
    indexation: drafts.filter((d) => d.surface === "indexation").length,
  };
  if (live) {
    const byTool = new Map<string, SerpObservationDraft[]>();
    for (const draft of drafts) {
      const tool = String(draft.rawPayloadJson?.tool ?? "").trim();
      if (tool) byTool.set(tool, [...(byTool.get(tool) ?? []), draft]);
    }
    await Promise.all(
      [...byTool.entries()].map(([tool, toolDrafts]) =>
        recordSurfaceCoverageFromDrafts({ reportRunId: input.auditRunId, tool, drafts: toolDrafts })
      )
    );
    // A successful empty response is still coverage. Draft-based recording above cannot
    // represent it because there is intentionally no observation row to persist.
    const coverageTargets: Array<{
      tool: "suggest" | "paa";
      query: string;
      engine: "YANDEX" | "GOOGLE";
      region: "RU" | "UAE";
      language: "ru" | "en";
      surface: "autocomplete" | "paa";
    }> = [];
    if (want("suggest")) {
      for (const q of ruQueries.length > 0 ? ruQueries : [ruQuery]) {
        coverageTargets.push(
          { tool: "suggest", query: q, engine: "YANDEX", region: "RU", language: "ru", surface: "autocomplete" },
          { tool: "suggest", query: q, engine: "GOOGLE", region: "RU", language: "ru", surface: "autocomplete" }
        );
      }
      if (uaeQueries.length > 0) {
        for (const q of uaeQueries) {
          coverageTargets.push({
            tool: "suggest",
            query: q,
            engine: "GOOGLE",
            region: "UAE",
            language: "en",
            surface: "autocomplete",
          });
        }
      }
    }
    if (want("paa")) {
      coverageTargets.push({ tool: "paa", query: ruQuery, engine: "GOOGLE", region: "RU", language: "ru", surface: "paa" });
      if (input.queriesUae.length > 0) {
        coverageTargets.push({ tool: "paa", query: uaeQuery, engine: "GOOGLE", region: "UAE", language: "en", surface: "paa" });
      }
    }
    await Promise.all(
      coverageTargets.map((target) => {
        const run = surfaceRuns.find(
          (r) =>
            r.tool === target.tool &&
            r.engine === target.engine &&
            r.region === target.region &&
            r.surface === target.surface &&
            r.query === target.query
        );
        return upsertSurfaceCollectionCoverage({
          reportRunId: input.auditRunId,
          provider: "arsenkin",
          tool: target.tool,
          providerTaskId: run?.providerTaskId ?? null,
          queryId: buildSerpQueryId({
            auditRunId: input.auditRunId,
            provider: "arsenkin",
            engine: target.engine,
            region: target.region,
            language: target.language,
            queryText: target.query,
            surface: target.surface,
          }),
          queryText: target.query,
          engine: target.engine,
          region: target.region,
          language: target.language,
          surface: target.surface,
          resultCount: run?.resultCount ?? 0,
        });
      })
    );
  }
  return {
    mode: live && client ? "live" : "fixtures",
    drafts,
    bySurface,
    taskIds,
    surfaceRuns,
  };
}
