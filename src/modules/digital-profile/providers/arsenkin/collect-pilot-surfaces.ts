/**
 * Collect Arsenkin First36 pilot surfaces (check-top / suggest / paa) for one subject.
 * Uses live API when configured; otherwise fixtures (no limit spend).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ArsenkinClient } from "./client";
import { createArsenkinClientFromEnv } from "./client";
import { isArsenkinConfigured, isArsenkinToolEnabled, type ArsenkinToolName } from "./flags";
import { ensureArsenkinTask, pollArsenkinTask } from "./poll-worker";
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

const FIX = join(
  process.cwd(),
  "src/modules/digital-profile/providers/arsenkin/fixtures"
);

function loadFix(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf-8"));
}

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
};

async function completeTask(
  client: ArsenkinClient,
  store: ProviderTaskStore,
  toolName: string,
  data: Record<string, unknown>,
  meta: { caseId: string; auditRunId: string; taskIds?: string[] },
  waitTimeoutMs: number
): Promise<Record<string, unknown>> {
  let row = await ensureArsenkinTask(client, store, {
    toolName,
    data,
    caseId: meta.caseId,
    reportRunId: meta.auditRunId,
  });
  const started = Date.now();
  while (row.state !== "DONE" && row.state !== "FAILED" && row.state !== "CANCELLED") {
    if (Date.now() - started > waitTimeoutMs) {
      throw new Error(`Arsenkin task timeout tool=${toolName} id=${row.externalTaskId}`);
    }
    row = await pollArsenkinTask(client, store, row);
    if (row.state !== "DONE") {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  if (row.state !== "DONE" || !row.responseJson) {
    throw new Error(`Arsenkin task ${row.state}: ${row.errorCode ?? toolName}`);
  }
  meta.taskIds?.push(row.id);
  return row.responseJson;
}

export async function collectArsenkinPilotSurfaces(
  input: ArsenkinPilotCollectInput
): Promise<ArsenkinPilotCollectResult> {
  const live =
    !input.fixturesOnly &&
    isArsenkinConfigured() &&
    (input.client != null || createArsenkinClientFromEnv() != null);
  if (!input.fixturesOnly && !live) {
    throw new Error("Arsenkin live collection requires a configured client and API token");
  }
  const client = input.client ?? (live ? createArsenkinClientFromEnv() : null);
  // Persist real provider jobs across processes; fixture work stays isolated in memory.
  const store = live ? createPrismaProviderTaskStore() : input.store ?? createMemoryProviderTaskStore();
  const drafts: SerpObservationDraft[] = [];
  const taskIds: string[] = [];
  const waitTimeoutMs = input.waitTimeoutMs ?? 10 * 60_000;

  const ruQuery = input.queriesRu[0] ?? "subject";
  const uaeQuery = input.queriesUae[0] ?? ruQuery;
  const want = (tool: ArsenkinToolName) =>
    (!input.tools || input.tools.includes(tool)) &&
    (isArsenkinToolEnabled(tool) || input.fixturesOnly || !live);

  // --- check-top RU ---
  if (want("check-top")) {
    const se = pilotSeForRegion("RU");
    const req = buildCheckTopRequest({
      queries: input.queriesRu.slice(0, 3),
      se,
      depth: 10,
      is_snippet: true,
    });
    const payload =
      live && client
        ? await completeTask(client, store, "check-top", req.data, { ...input, taskIds }, waitTimeoutMs)
        : loadFix("get-check-top.json");
    drafts.push(
      ...mapCheckTopToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        queries: input.queriesRu.slice(0, 3),
        se,
        payload,
      })
    );
  }

  // --- check-top UAE (Google only) ---
  if (want("check-top") && input.queriesUae.length > 0) {
    const se = pilotSeForRegion("UAE");
    const req = buildCheckTopRequest({
      queries: input.queriesUae.slice(0, 2),
      se,
      depth: 10,
      is_snippet: true,
    });
    const payload =
      live && client
        ? await completeTask(client, store, "check-top", req.data, { ...input, taskIds }, waitTimeoutMs)
        : {
            result: {
              result: {
                collect: [[["https://highways.today/2025/11/06/biography-of-glinka-sergei/"]]],
                snippets: {
                  "https://highways.today/2025/11/06/biography-of-glinka-sergei/": [
                    { title: "Biography of Glinka Sergei", snippet: "UAE fixture" },
                  ],
                },
              },
            },
          };
    drafts.push(
      ...mapCheckTopToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "UAE",
        language: "en",
        queries: input.queriesUae.slice(0, 2),
        se,
        payload,
      })
    );
  }

  // --- suggest RU (Yandex) ---
  if (want("suggest")) {
    const req = buildSuggestRequest({
      queries: [ruQuery],
      se: 1,
      region: ARSENKIN_REGION.YANDEX_MOSCOW,
      depth: 1,
    });
    const payload =
      live && client
        ? await completeTask(client, store, "suggest", req.data, { ...input, taskIds }, waitTimeoutMs)
        : loadFix("get-suggest.json");
    drafts.push(
      ...mapSuggestToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        queries: [ruQuery],
        se: 1,
        payload,
      })
    );
  }

  // --- suggest RU (Google) ---
  if (want("suggest")) {
    const req = buildSuggestRequest({
      queries: [ruQuery],
      se: 2,
      region: ARSENKIN_REGION.GOOGLE_MOSCOW,
      google_domain: "www.google.ru",
      google_from: "RU",
      google_lang: "ru",
      depth: 1,
    });
    const payload =
      live && client
        ? await completeTask(client, store, "suggest", req.data, { ...input, taskIds }, waitTimeoutMs)
        : loadFix("get-suggest.json");
    drafts.push(
      ...mapSuggestToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        queries: [ruQuery],
        se: 2,
        payload,
      })
    );
  }

  // --- suggest UAE (Google) ---
  if (want("suggest") && input.queriesUae.length > 0) {
    const req = buildSuggestRequest({
      queries: [uaeQuery],
      se: 2,
      region: ARSENKIN_REGION.GOOGLE_UAE,
      google_domain: "www.google.ae",
      google_from: "AE",
      google_lang: "en",
      depth: 1,
    });
    const payload =
      live && client
        ? await completeTask(client, store, "suggest", req.data, { ...input, taskIds }, waitTimeoutMs)
        : loadFix("get-suggest.json");
    drafts.push(
      ...mapSuggestToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "UAE",
        language: "en",
        queries: [uaeQuery],
        se: 2,
        payload,
      })
    );
  }

  // --- paa RU (Google-only) ---
  if (want("paa")) {
    const req = buildPaaRequest({
      queries: [ruQuery],
      region: ARSENKIN_REGION.GOOGLE_MOSCOW,
      depth: 1,
      count: 10,
    });
    const payload =
      live && client
        ? await completeTask(client, store, "paa", req.data, { ...input, taskIds }, waitTimeoutMs)
        : loadFix("get-paa.json");
    drafts.push(
      ...mapPaaToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        queries: [ruQuery],
        payload,
      })
    );
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
    const payload =
      live && client
        ? await completeTask(client, store, "paa", req.data, { ...input, taskIds }, waitTimeoutMs)
        : loadFix("get-paa.json");
    drafts.push(
      ...mapPaaToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "UAE",
        language: "en",
        queries: [uaeQuery],
        payload,
      })
    );
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
      const payload =
        live && client
        ? await completeTask(client, store, "ai-serp", req.data, { ...input, taskIds }, waitTimeoutMs)
          : loadFix("get-ai-serp.json");
      drafts.push(
        ...mapAiSerpToObservations({
          caseId: input.caseId,
          auditRunId: input.auditRunId,
          regionLabel: "RU",
          language: "ru",
          queries: [ruQuery],
          se: 1,
          payload,
        })
      );
    }

    if (targets.has("google_ru")) {
      const req = buildAiSerpRequest({
        queries: [ruQuery],
        se: 2,
        region: ARSENKIN_REGION.GOOGLE_MOSCOW,
      });
      const payload =
        live && client
        ? await completeTask(client, store, "ai-serp", req.data, { ...input, taskIds }, waitTimeoutMs)
          : loadFix("get-ai-serp-google.json");
      drafts.push(
        ...mapAiSerpToObservations({
          caseId: input.caseId,
          auditRunId: input.auditRunId,
          regionLabel: "RU",
          language: "ru",
          queries: [ruQuery],
          se: 2,
          payload,
        })
      );
    }

    if (targets.has("google_uae")) {
      const req = buildAiSerpRequest({
        queries: [uaeQuery],
        se: 2,
        region: ARSENKIN_REGION.GOOGLE_UAE,
      });
      const payload =
        live && client
        ? await completeTask(client, store, "ai-serp", req.data, { ...input, taskIds }, waitTimeoutMs)
          : loadFix("get-ai-serp-google-uae.json");
      drafts.push(
        ...mapAiSerpToObservations({
          caseId: input.caseId,
          auditRunId: input.auditRunId,
          regionLabel: "UAE",
          language: "en",
          queries: [uaeQuery],
          se: 2,
          payload,
        })
      );
    }
  }

  const enrichUrls = (input.urlsEnrichment ?? [])
    .map((u) => String(u).trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 5);

  if (want("check-h") && enrichUrls.length > 0) {
    const req = buildCheckHRequest({ urls: enrichUrls, mode: "url" });
    const payload =
      live && client
        ? await completeTask(client, store, "check-h", req.data, { ...input, taskIds }, waitTimeoutMs)
        : loadFix("get-check-h.json");
    drafts.push(
      ...mapCheckHToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        urls: enrichUrls,
        payload,
      })
    );
  }

  if (want("indexation") && enrichUrls.length > 0) {
    const req = buildIndexationRequest({ urls: enrichUrls });
    const payload =
      live && client
        ? await completeTask(client, store, "indexation", req.data, { ...input, taskIds }, waitTimeoutMs)
        : loadFix("get-indexation.json");
    drafts.push(
      ...mapIndexationToObservations({
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        regionLabel: "RU",
        language: "ru",
        urls: enrichUrls,
        payload,
      })
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
      coverageTargets.push(
        { tool: "suggest", query: ruQuery, engine: "YANDEX", region: "RU", language: "ru", surface: "autocomplete" },
        { tool: "suggest", query: ruQuery, engine: "GOOGLE", region: "RU", language: "ru", surface: "autocomplete" }
      );
      if (input.queriesUae.length > 0) {
        coverageTargets.push({ tool: "suggest", query: uaeQuery, engine: "GOOGLE", region: "UAE", language: "en", surface: "autocomplete" });
      }
    }
    if (want("paa")) {
      coverageTargets.push({ tool: "paa", query: ruQuery, engine: "GOOGLE", region: "RU", language: "ru", surface: "paa" });
      if (input.queriesUae.length > 0) {
        coverageTargets.push({ tool: "paa", query: uaeQuery, engine: "GOOGLE", region: "UAE", language: "en", surface: "paa" });
      }
    }
    await Promise.all(
      coverageTargets.map((target) =>
        upsertSurfaceCollectionCoverage({
          reportRunId: input.auditRunId,
          provider: "arsenkin",
          tool: target.tool,
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
          resultCount: drafts.filter(
            (draft) =>
              draft.surface === target.surface &&
              draft.engine === target.engine &&
              draft.region === target.region &&
              draft.queryText === target.query &&
              draft.providerStatus === "OK"
          ).length,
        })
      )
    );
  }
  return {
    mode: live && client ? "live" : "fixtures",
    drafts,
    bySurface,
    taskIds,
  };
}
