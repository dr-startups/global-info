/**
 * Enrich a classic First36 report run with Arsenkin check-top / suggest / paa / ai-serp
 * / check-h / indexation observations (idempotent).
 */

import { prisma } from "@/server/prisma/client";
import { persistSerpObservations } from "../../serp-observation/persist";
import {
  collectArsenkinPilotSurfaces,
  isArsenkinConfigured,
  isArsenkinEnabled,
} from "../../providers/arsenkin";

export type ArsenkinRenderEnrichResult = {
  skipped: boolean;
  reason?: string;
  mode?: "live" | "fixtures";
  persisted?: number;
  bySurface?: {
    organic: number;
    autocomplete: number;
    paa: number;
    aiAnswer?: number;
    pageMeta?: number;
    indexation?: number;
  };
};

function isAi(row: { surface: string; engine: string; region: string }): boolean {
  return row.surface === "ai_answer";
}

/** Prefer http(s) organic URLs, unique by domain, skip wiki/social noise. */
export function pickEnrichmentUrls(
  rows: Array<{ url: string; domain: string | null; rank: number; surface: string }>,
  limit = 5
): string[] {
  const organic = rows
    .filter((r) => r.surface === "organic" && /^https?:\/\//i.test(r.url))
    .sort((a, b) => a.rank - b.rank);
  const out: string[] = [];
  const seenDomain = new Set<string>();
  for (const r of organic) {
    const domain = String(r.domain ?? "")
      .toLowerCase()
      .replace(/^www\./, "");
    if (!domain) continue;
    if (/wikipedia|wikidata|youtube|facebook|vk\.com|instagram|t\.me/i.test(domain)) continue;
    if (seenDomain.has(domain)) continue;
    seenDomain.add(domain);
    out.push(r.url);
    if (out.length >= limit) break;
  }
  return out;
}

export async function enrichReportRunWithArsenkin(input: {
  caseId: string;
  auditRunId: string;
  queriesRu: string[];
  queriesUae: string[];
  /** Minimum existing arsenkin observations to treat as already enriched. */
  skipIfAtLeast?: number;
}): Promise<ArsenkinRenderEnrichResult> {
  if (!isArsenkinEnabled()) {
    return { skipped: true, reason: "ARSENKIN_ENABLED off" };
  }
  if (process.env.ARSENKIN_ENRICH_ON_RENDER === "0") {
    return { skipped: true, reason: "ARSENKIN_ENRICH_ON_RENDER=0" };
  }
  if (!isArsenkinConfigured() && process.env.ARSENKIN_PILOT_FIXTURES !== "1") {
    return { skipped: true, reason: "ARSENKIN_API_TOKEN missing" };
  }

  const skipIfAtLeast = input.skipIfAtLeast ?? 20;
  const existingRows = await prisma.serpObservation.findMany({
    where: { auditRunId: input.auditRunId, provider: "arsenkin" },
    select: {
      engine: true,
      surface: true,
      region: true,
      language: true,
      queryId: true,
      rank: true,
      url: true,
      domain: true,
    },
  });
  const organicCount = existingRows.filter((r) => r.surface === "organic").length;
  const paaCount = existingRows.filter((r) => r.surface === "paa").length;
  const suggestCount = existingRows.filter((r) => r.surface === "autocomplete").length;
  const pageMetaCount = existingRows.filter((r) => r.surface === "page_meta").length;
  const indexationCount = existingRows.filter((r) => r.surface === "indexation").length;
  const aiRows = existingRows.filter(isAi);
  const hasYandexRuAi = aiRows.some(
    (r) => String(r.engine).toUpperCase() === "YANDEX" && !/UAE|AE|INTL/i.test(r.region)
  );
  const hasGoogleRuAi = aiRows.some(
    (r) => String(r.engine).toUpperCase() === "GOOGLE" && !/UAE|AE|INTL/i.test(r.region)
  );
  const hasGoogleUaeAi = aiRows.some(
    (r) => String(r.engine).toUpperCase() === "GOOGLE" && /UAE|AE|INTL/i.test(r.region)
  );
  const aiSerpTargets: Array<"yandex_ru" | "google_ru" | "google_uae"> = [];
  if (!hasYandexRuAi) aiSerpTargets.push("yandex_ru");
  if (!hasGoogleRuAi) aiSerpTargets.push("google_ru");
  if (!hasGoogleUaeAi) aiSerpTargets.push("google_uae");

  const urlsEnrichment = pickEnrichmentUrls(existingRows);
  const needCheckH = pageMetaCount < 1 && urlsEnrichment.length > 0;
  const needIndexation = indexationCount < 1 && urlsEnrichment.length > 0;

  if (
    organicCount >= skipIfAtLeast &&
    paaCount > 0 &&
    suggestCount >= 3 &&
    aiSerpTargets.length === 0 &&
    !needCheckH &&
    !needIndexation
  ) {
    return {
      skipped: true,
      reason: `already_enriched organic=${organicCount} paa=${paaCount} suggest=${suggestCount} ai=${aiRows.length} meta=${pageMetaCount} idx=${indexationCount}`,
    };
  }

  const tools: Array<
    "check-top" | "suggest" | "paa" | "ai-serp" | "check-h" | "indexation"
  > = [];
  if (organicCount < skipIfAtLeast) tools.push("check-top");
  if (suggestCount < 3) tools.push("suggest");
  if (paaCount < 1) tools.push("paa");
  if (aiSerpTargets.length > 0) tools.push("ai-serp");
  if (needCheckH) tools.push("check-h");
  if (needIndexation) tools.push("indexation");
  if (tools.length === 0) {
    return { skipped: true, reason: "surfaces_complete" };
  }

  const collected = await collectArsenkinPilotSurfaces({
    caseId: input.caseId,
    auditRunId: input.auditRunId,
    queriesRu: input.queriesRu,
    queriesUae: input.queriesUae,
    fixturesOnly: process.env.ARSENKIN_PILOT_FIXTURES === "1",
    tools,
    aiSerpTargets: tools.includes("ai-serp") ? aiSerpTargets : undefined,
    urlsEnrichment:
      tools.includes("check-h") || tools.includes("indexation") ? urlsEnrichment : undefined,
  });

  const existingKeys = new Set(
    existingRows.map(
      (r) =>
        `${r.engine}|${r.surface}|${r.region}|${r.language}|${r.queryId}|${r.rank}|${r.url}`
    )
  );
  const fresh = collected.drafts.filter(
    (d) =>
      !existingKeys.has(
        `${d.engine}|${d.surface}|${d.region}|${d.language}|${d.queryId}|${d.rank}|${d.url}`
      )
  );
  const persisted = await persistSerpObservations(fresh);
  return {
    skipped: false,
    mode: collected.mode,
    persisted: persisted.length,
    bySurface: collected.bySurface,
  };
}
