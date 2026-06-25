/**
 * Synthetic SERP snapshot service (Stage H3 — skeleton).
 *
 * IMPORTANT: this is NOT a live browser screenshot of a search engine results
 * page. It builds a safe, self-attributed snapshot from already-stored organic
 * search_results (API data we already have). The output is explicitly labelled
 * as synthetic so it can never be passed off as a real SERP capture.
 *
 * On H3 we only produce a structured HTML-like snapshot model + a surface item
 * reference (source=SYNTHETIC_SNAPSHOT). Rendering it to PNG/JPEG is deferred to
 * a later stage; no Playwright/Puppeteer is introduced.
 */

import { prisma } from "@/server/prisma/client";
import { NotFoundError } from "../http/errors";
import { recordAudit } from "./audit-log-service";
import { createSearchSurfaceItem } from "./search-surface-service";
import type { ActorContext } from "./case-service";
import type { SearchSurfaceItem } from "../search-surfaces/types";

export const SYNTHETIC_CAPTION =
  "Synthetic snapshot generated from API results, not a live SERP screenshot.";

export interface SyntheticSnapshotModel {
  caption: string;
  engine: string;
  generatedAt: string;
  rows: { rank: number | null; title: string | null; url: string; domain: string | null }[];
}

/** Builds a snapshot model from stored organic results for an engine. */
export async function buildSyntheticSnapshotModel(
  caseId: string,
  engine: "GOOGLE" | "YANDEX",
  limit = 10
): Promise<SyntheticSnapshotModel> {
  const found = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: { id: true },
  });
  if (!found) throw new NotFoundError("Case not found");

  const results = await prisma.searchResult.findMany({
    where: { caseId, engine },
    orderBy: [{ rank: "asc" }, { createdAt: "asc" }],
    take: limit,
    select: { rank: true, title: true, url: true },
  });

  return {
    caption: SYNTHETIC_CAPTION,
    engine,
    generatedAt: new Date().toISOString(),
    rows: results.map((r) => {
      let domain: string | null = null;
      try {
        domain = new URL(r.url).hostname.replace(/^www\./, "");
      } catch {
        domain = null;
      }
      return { rank: r.rank, title: r.title, url: r.url, domain };
    }),
  };
}

/**
 * Records a synthetic snapshot as a SERP_SCREENSHOT surface item (source
 * SYNTHETIC_SNAPSHOT). The model is stored in rawMetadata; it is clearly marked
 * synthetic and never claims to be a real screenshot.
 */
export async function createSyntheticSnapshot(
  caseId: string,
  engine: "GOOGLE" | "YANDEX",
  ctx: ActorContext = {}
): Promise<SearchSurfaceItem> {
  const model = await buildSyntheticSnapshotModel(caseId, engine);
  const { item } = await createSearchSurfaceItem(
    caseId,
    {
      type: "SERP_SCREENSHOT",
      source: "SYNTHETIC_SNAPSHOT",
      provider: engine,
      title: `Synthetic ${engine} snapshot`,
      snippet: SYNTHETIC_CAPTION,
      classification: "SYNTHETIC",
      demo: false,
      rawMetadata: { synthetic: true, model },
    },
    ctx
  );
  await recordAudit({
    caseId,
    action: "SEARCH_SURFACE_ADDED",
    actorId: ctx.actorId,
    metadata: { surfaceId: item.id, synthetic: true, engine },
  });
  return item;
}
