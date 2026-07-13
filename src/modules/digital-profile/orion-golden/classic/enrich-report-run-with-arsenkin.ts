/**
 * Enrich a classic First36 report run with Arsenkin check-top / suggest / paa
 * observations (idempotent: skips when enough arsenkin rows already exist).
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
  bySurface?: { organic: number; autocomplete: number; paa: number };
};

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
    },
  });
  const organicCount = existingRows.filter((r) => r.surface === "organic").length;
  const paaCount = existingRows.filter((r) => r.surface === "paa").length;
  const suggestCount = existingRows.filter((r) => r.surface === "autocomplete").length;
  if (organicCount >= skipIfAtLeast && paaCount > 0 && suggestCount > 0) {
    return {
      skipped: true,
      reason: `already_enriched organic=${organicCount} paa=${paaCount} suggest=${suggestCount}`,
    };
  }

  const tools: Array<"check-top" | "suggest" | "paa"> = [];
  if (organicCount < skipIfAtLeast) tools.push("check-top");
  if (suggestCount < 1) tools.push("suggest");
  if (paaCount < 1) tools.push("paa");
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
  });

  // Avoid unique collisions with previously attached rows.
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
