/**
 * Pure Arsenkin planned-task matrix builder (no network).
 * Builds exact { tools_name, data } bodies + requestHash matching ProviderTaskStore.
 */

import { createHash } from "node:crypto";
import { buildCheckTopRequest } from "../../providers/arsenkin/adapters/check-top";
import { buildSuggestRequest } from "../../providers/arsenkin/adapters/suggest";
import { buildPaaRequest } from "../../providers/arsenkin/adapters/paa";
import { buildAiSerpRequest } from "../../providers/arsenkin/adapters/ai-serp";
import { buildCheckHRequest } from "../../providers/arsenkin/adapters/check-h";
import { buildIndexationRequest } from "../../providers/arsenkin/adapters/indexation";
import { ARSENKIN_REGION, pilotSeForRegion } from "../../providers/arsenkin/regions";
import { hashProviderRequest } from "../../providers/arsenkin/provider-task-store";
import type { ArsenkinToolName } from "../../providers/arsenkin/flags";

export type PlannedExactRequest = {
  tool: string;
  engine: string | null;
  region: string | null;
  query: string | null;
  queryCount: number;
  tools_name: string;
  data: Record<string, unknown>;
  requestJson: { tools_name: string; data: Record<string, unknown> };
  requestHash: string;
  estimatedLimits: number | null;
};

export type PlanArsenkinExactTasksInput = {
  queriesRu: string[];
  queriesUae: string[];
  tools: string[];
  urlsEnrichment?: string[];
  aiSerpTargets?: Array<"yandex_ru" | "google_ru" | "google_uae">;
};

function push(
  out: PlannedExactRequest[],
  tool: string,
  req: { tools_name: string; data: Record<string, unknown> },
  meta: { engine: string | null; region: string | null; query: string | null; queryCount: number; estimatedLimits?: number | null }
) {
  const requestJson = { tools_name: req.tools_name, data: req.data };
  out.push({
    tool,
    engine: meta.engine,
    region: meta.region,
    query: meta.query,
    queryCount: meta.queryCount,
    tools_name: req.tools_name,
    data: req.data,
    requestJson,
    requestHash: hashProviderRequest(requestJson),
    estimatedLimits: meta.estimatedLimits ?? null,
  });
}

/** Build the full First36 Arsenkin request matrix (same shapes as collect-pilot-surfaces). */
export function planArsenkinExactTasks(input: PlanArsenkinExactTasksInput): PlannedExactRequest[] {
  const tools = new Set(input.tools.map((t) => t.trim()).filter(Boolean));
  const want = (t: string) => tools.has(t);
  const ruQueries = input.queriesRu.map((q) => String(q ?? "").trim()).filter(Boolean).slice(0, 5);
  const uaeQueries = input.queriesUae.map((q) => String(q ?? "").trim()).filter(Boolean).slice(0, 4);
  const ruPrimary = ruQueries[0] ?? "subject";
  const uaePrimary = uaeQueries[0] ?? ruPrimary;
  const out: PlannedExactRequest[] = [];

  if (want("check-top")) {
    const se = pilotSeForRegion("RU");
    const req = buildCheckTopRequest({
      queries: ruQueries.length > 0 ? ruQueries : [ruPrimary],
      se,
      depth: 20,
      is_snippet: true,
      noreask: true,
    });
    push(out, "check-top", req, {
      engine: "MIXED",
      region: "RU",
      query: ruPrimary,
      queryCount: req.data.queries instanceof Array ? req.data.queries.length : 1,
      estimatedLimits: 1,
    });
  }

  if (want("check-top") && uaeQueries.length > 0) {
    const se = pilotSeForRegion("UAE");
    const req = buildCheckTopRequest({
      queries: uaeQueries,
      se,
      depth: 20,
      is_snippet: true,
      noreask: true,
    });
    push(out, "check-top", req, {
      engine: "GOOGLE",
      region: "UAE",
      query: uaePrimary,
      queryCount: req.data.queries instanceof Array ? req.data.queries.length : 1,
      estimatedLimits: 1,
    });
  }

  if (want("suggest")) {
    // Yandex suggest: exactly one canonical localized query per ProviderTask.
    const yandexSuggest = buildSuggestRequest({
      queries: ruQueries.length > 0 ? ruQueries : [ruPrimary],
      se: 1,
      region: ARSENKIN_REGION.YANDEX_MOSCOW,
      depth: 1,
      primaryLocalized: ruPrimary,
      primaryLatin: uaePrimary,
    });
    const yandexQuery = String((yandexSuggest.data.queries as string[])[0] ?? ruPrimary);
    push(out, "suggest", yandexSuggest, {
      engine: "YANDEX",
      region: "RU",
      query: yandexQuery,
      queryCount: 1,
      estimatedLimits: 1,
    });
    // Google suggest: exactly one Latin query (Cyrillic-only rejected by Arsenkin).
    const googleRuQueries = uaeQueries.length > 0 ? uaeQueries : [];
    if (googleRuQueries.length > 0) {
      const googleRuSuggest = buildSuggestRequest({
        queries: googleRuQueries,
        se: 2,
        region: ARSENKIN_REGION.GOOGLE_MOSCOW,
        google_domain: "www.google.ru",
        google_from: "RU",
        google_lang: "ru",
        depth: 1,
        primaryLocalized: ruPrimary,
        primaryLatin: uaePrimary,
      });
      const googleRuQuery = String((googleRuSuggest.data.queries as string[])[0] ?? uaePrimary);
      push(out, "suggest", googleRuSuggest, {
        engine: "GOOGLE",
        region: "RU",
        query: googleRuQuery,
        queryCount: 1,
        estimatedLimits: 1,
      });
    }
  }

  if (want("suggest") && uaeQueries.length > 0) {
    const googleUaeSuggest = buildSuggestRequest({
      queries: uaeQueries,
      se: 2,
      region: ARSENKIN_REGION.GOOGLE_UAE,
      google_domain: "www.google.ae",
      google_from: "AE",
      google_lang: "en",
      depth: 1,
      primaryLocalized: ruPrimary,
      primaryLatin: uaePrimary,
    });
    const googleUaeQuery = String((googleUaeSuggest.data.queries as string[])[0] ?? uaePrimary);
    push(out, "suggest", googleUaeSuggest, {
      engine: "GOOGLE",
      region: "UAE",
      query: googleUaeQuery,
      queryCount: 1,
      estimatedLimits: 1,
    });
  }

  if (want("paa")) {
    push(
      out,
      "paa",
      buildPaaRequest({
        queries: [ruPrimary],
        region: ARSENKIN_REGION.GOOGLE_MOSCOW,
        depth: 1,
        count: 10,
      }),
      { engine: "GOOGLE", region: "RU", query: ruPrimary, queryCount: 1, estimatedLimits: 1 }
    );
  }

  if (want("paa") && uaeQueries.length > 0) {
    push(
      out,
      "paa",
      buildPaaRequest({
        queries: [uaePrimary],
        region: ARSENKIN_REGION.GOOGLE_UAE,
        google_domain: "www.google.ae",
        google_from: "AE",
        google_lang: "en",
        depth: 1,
        count: 10,
      }),
      { engine: "GOOGLE", region: "UAE", query: uaePrimary, queryCount: 1, estimatedLimits: 1 }
    );
  }

  if (want("ai-serp")) {
    const targets = new Set(input.aiSerpTargets ?? (["yandex_ru", "google_ru", "google_uae"] as const));
    if (targets.has("yandex_ru")) {
      push(
        out,
        "ai-serp",
        buildAiSerpRequest({
          queries: [ruPrimary],
          se: 1,
          region: ARSENKIN_REGION.YANDEX_MOSCOW,
        }),
        { engine: "YANDEX", region: "RU", query: ruPrimary, queryCount: 1, estimatedLimits: 1 }
      );
    }
    if (targets.has("google_ru")) {
      push(
        out,
        "ai-serp",
        buildAiSerpRequest({
          queries: [ruPrimary],
          se: 2,
          region: ARSENKIN_REGION.GOOGLE_MOSCOW,
        }),
        { engine: "GOOGLE", region: "RU", query: ruPrimary, queryCount: 1, estimatedLimits: 1 }
      );
    }
    if (targets.has("google_uae")) {
      push(
        out,
        "ai-serp",
        buildAiSerpRequest({
          queries: [uaePrimary],
          se: 2,
          region: ARSENKIN_REGION.GOOGLE_UAE,
        }),
        { engine: "GOOGLE", region: "UAE", query: uaePrimary, queryCount: 1, estimatedLimits: 1 }
      );
    }
  }

  const enrichUrls = (input.urlsEnrichment ?? [])
    .map((u) => String(u).trim())
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, 10);

  if (want("check-h") && enrichUrls.length > 0) {
    push(out, "check-h", buildCheckHRequest({ urls: enrichUrls, mode: "url" }), {
      engine: null,
      region: "RU",
      query: enrichUrls[0] ?? null,
      queryCount: enrichUrls.length,
      estimatedLimits: 1,
    });
  }

  if (want("indexation") && enrichUrls.length > 0) {
    push(out, "indexation", buildIndexationRequest({ urls: enrichUrls }), {
      engine: null,
      region: "RU",
      query: enrichUrls[0] ?? null,
      queryCount: enrichUrls.length,
      estimatedLimits: 1,
    });
  }

  return out;
}

/** Stable digest over canonical planned request hashes (order-insensitive). */
export function computePlanDigest(planned: Array<{ requestHash: string }>): string {
  const hashes = planned.map((p) => p.requestHash).sort();
  return createHash("sha256").update(JSON.stringify(hashes)).digest("hex").slice(0, 32);
}
