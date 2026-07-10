import { domainOf } from "../providers/types";
import type { SerperSurfaceItem } from "../providers/serper-surfaces";
import { buildSerpQueryId } from "./query-id";
import type { SerpObservationDraft, SerpProviderStatus } from "./types";

/**
 * Map Serper organic surface items → observation drafts.
 * Does NOT dedupe URLs across queries or ranks — each hit is one observation.
 */
export function mapSerperOrganicToObservationDrafts(input: {
  caseId: string;
  auditRunId: string;
  queryText: string;
  region: string;
  language: string;
  items: SerperSurfaceItem[];
  providerStatus?: SerpProviderStatus;
  capturedAt?: Date;
}): SerpObservationDraft[] {
  const capturedAt = input.capturedAt ?? new Date();
  const queryId = buildSerpQueryId({
    auditRunId: input.auditRunId,
    provider: "serper",
    engine: "GOOGLE",
    region: input.region,
    language: input.language,
    queryText: input.queryText,
    surface: "organic",
  });

  const organic = input.items.filter((i) => i.kind === "organic" && Boolean(i.url?.trim()));
  return organic.map((item, idx) => {
    const url = String(item.url).trim();
    return {
      caseId: input.caseId,
      auditRunId: input.auditRunId,
      queryId,
      queryText: input.queryText,
      provider: "serper",
      engine: "GOOGLE",
      surface: "organic",
      region: input.region,
      language: item.language || input.language,
      rank: typeof item.rank === "number" ? item.rank : idx + 1,
      url,
      title: item.title?.trim() ? item.title : null,
      snippet: item.snippet?.trim() ? item.snippet : null,
      domain: item.domain ?? domainOf(url),
      providerStatus: input.providerStatus ?? "OK",
      rawPayloadJson: {
        source: "serper",
        surface: "organic",
        rank: item.rank,
        metadata: item.rawMetadataSafe ?? null,
      },
      capturedAt,
    };
  });
}

/**
 * Same URL appearing under two queries must yield two drafts (acceptance criterion).
 * Pure helper for tests — concatenates mapped drafts without URL-level merge.
 */
export function mergeObservationDraftsWithoutUrlDedupe(
  batches: SerpObservationDraft[][]
): SerpObservationDraft[] {
  return batches.flat();
}
