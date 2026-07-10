import { domainOf } from "../providers/types";
import type { SearchProviderResult } from "../providers/types";
import { buildSerpQueryId } from "./query-id";
import type { SerpObservationDraft, SerpProviderStatus } from "./types";

/**
 * Map Yandex Search API organic results → observation drafts.
 * Does NOT dedupe URLs across queries or ranks.
 */
export function mapYandexOrganicToObservationDrafts(input: {
  caseId: string;
  auditRunId: string;
  queryText: string;
  region: string;
  language: string;
  results: SearchProviderResult[];
  providerStatus?: SerpProviderStatus;
  capturedAt?: Date;
}): SerpObservationDraft[] {
  const capturedAt = input.capturedAt ?? new Date();
  const queryId = buildSerpQueryId({
    auditRunId: input.auditRunId,
    provider: "yandex",
    engine: "YANDEX",
    region: input.region,
    language: input.language,
    queryText: input.queryText,
    surface: "organic",
  });

  return input.results
    .filter((r) => Boolean(r.url?.trim()))
    .map((r, idx) => {
      const url = String(r.url).trim();
      return {
        caseId: input.caseId,
        auditRunId: input.auditRunId,
        queryId,
        queryText: input.queryText,
        provider: "yandex" as const,
        engine: "YANDEX" as const,
        surface: "organic" as const,
        region: input.region,
        language: r.language || input.language,
        rank: typeof r.rank === "number" ? r.rank : idx + 1,
        url,
        title: r.title?.trim() ? r.title : null,
        snippet: r.snippet?.trim() ? r.snippet : null,
        domain: r.domain || domainOf(url),
        providerStatus: input.providerStatus ?? "OK",
        rawPayloadJson: {
          source: "yandex",
          surface: "organic",
          rank: r.rank,
          metadata: r.rawMetadata ?? null,
        },
        capturedAt,
      };
    });
}
