/**
 * Enrich a classic First36 report run with Arsenkin check-top / suggest / paa / ai-serp
 * / check-h / indexation observations (idempotent).
 */

import { prisma } from "@/server/prisma/client";
import { persistSerpObservations } from "../../serp-observation/persist";
import {
  collectArsenkinPilotSurfaces,
  arsenkinTools,
  isArsenkinConfigured,
  isArsenkinEnabled,
  isArsenkinRequired,
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

export type ArsenkinCoverageRow = { surface: string; engine: string; region: string };

/** Required mode only accepts the concrete First36 surfaces selected by ARSENKIN_TOOLS. */
export function missingMandatoryArsenkinCoverage(
  rows: ArsenkinCoverageRow[],
  tools: readonly string[],
  coverageRows?: Array<{ surface: string; engine: string; region: string; status?: string }>
): string[] {
  const covered = (surface: string, engine: string, region: "RU" | "UAE") => {
    const matchRegion = (r: string) =>
      region === "UAE" ? /UAE|AE|INTL/i.test(r) : !/UAE|AE|INTL/i.test(r);
    if (
      rows.some(
        (row) =>
          row.surface === surface &&
          String(row.engine).toUpperCase() === engine &&
          matchRegion(row.region)
      )
    ) {
      return true;
    }
    // Successful empty API responses are recorded as coverage NO_RESULTS without observations.
    return Boolean(
      coverageRows?.some(
        (row) =>
          row.surface === surface &&
          String(row.engine).toUpperCase() === engine &&
          matchRegion(row.region) &&
          /^(OK|NO_RESULTS)$/i.test(String(row.status ?? "OK"))
      )
    );
  };
  const missing: string[] = [];
  if (
    tools.includes("check-top") &&
    !covered("organic", "GOOGLE", "RU") &&
    !covered("organic", "YANDEX", "RU")
  ) {
    missing.push("check-top:organic:RU");
  }
  if (tools.includes("suggest")) {
    if (!covered("autocomplete", "YANDEX", "RU")) missing.push("suggest:yandex:RU");
    if (!covered("autocomplete", "GOOGLE", "RU")) missing.push("suggest:google:RU");
    if (!covered("autocomplete", "GOOGLE", "UAE")) missing.push("suggest:google:UAE");
  }
  if (tools.includes("paa")) {
    if (!covered("paa", "GOOGLE", "RU")) missing.push("paa:google:RU");
    if (!covered("paa", "GOOGLE", "UAE")) missing.push("paa:google:UAE");
  }
  return missing;
}

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
  const required = isArsenkinRequired();
  const enabledTools = arsenkinTools();
  if (!isArsenkinEnabled()) {
    if (required) throw new Error("ARSENKIN_REQUIRED but ARSENKIN_ENABLED is off");
    return { skipped: true, reason: "ARSENKIN_ENABLED off" };
  }
  if (process.env.ARSENKIN_ENRICH_ON_RENDER === "0") {
    if (required) throw new Error("ARSENKIN_REQUIRED but ARSENKIN_ENRICH_ON_RENDER=0");
    return { skipped: true, reason: "ARSENKIN_ENRICH_ON_RENDER=0" };
  }
  if (required && process.env.ARSENKIN_PILOT_FIXTURES === "1") {
    throw new Error("ARSENKIN_REQUIRED forbids fixture enrichment");
  }
  if (!isArsenkinConfigured() && process.env.ARSENKIN_PILOT_FIXTURES !== "1") {
    if (required) throw new Error("ARSENKIN_REQUIRED but ARSENKIN_API_TOKEN missing");
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
    const existingCoverage = await prisma.surfaceCollectionCoverage.findMany({
      where: { reportRunId: input.auditRunId, provider: "arsenkin" },
      select: { surface: true, engine: true, region: true, status: true },
    });
    const missing = missingMandatoryArsenkinCoverage(
      existingRows,
      enabledTools,
      existingCoverage
    );
    if (required && missing.length > 0) {
      throw new Error(`ARSENKIN_REQUIRED coverage missing: ${missing.join(", ")}`);
    }
    return {
      skipped: true,
      mode: "live",
      persisted: 0,
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
  if (required) {
    for (const tool of enabledTools) {
      if (!tools.includes(tool)) tools.push(tool);
    }
  }
  if (tools.length === 0) {
    const missing = missingMandatoryArsenkinCoverage(existingRows, enabledTools);
    if (required && missing.length > 0) {
      throw new Error(`ARSENKIN_REQUIRED coverage missing: ${missing.join(", ")}`);
    }
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
  const coverageRows = await prisma.surfaceCollectionCoverage.findMany({
    where: { reportRunId: input.auditRunId, provider: "arsenkin" },
    select: { surface: true, engine: true, region: true, status: true },
  });
  const missing = missingMandatoryArsenkinCoverage(
    [...existingRows, ...fresh],
    enabledTools,
    coverageRows
  );
  if (required) {
    if (collected.mode !== "live") throw new Error("ARSENKIN_REQUIRED requires live enrichment");
    if (missing.length > 0) {
      throw new Error(`ARSENKIN_REQUIRED coverage missing: ${missing.join(", ")}`);
    }
  }
  return {
    skipped: false,
    mode: collected.mode,
    persisted: persisted.length,
    bySurface: collected.bySurface,
  };
}
