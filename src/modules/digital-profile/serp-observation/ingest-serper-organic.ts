import { serperOrganicWithExtras } from "../providers/serper-surfaces";
import type { SearchProviderRequest } from "../providers/types";
import type { OrionRegionCode } from "../search-surfaces/orion-query-plan";
import { classifyProviderFetchOutcome } from "./provider-status";
import { mapSerperOrganicToObservationDrafts } from "./map-serper-organic";
import { buildSerpQueryId } from "./query-id";
import type { SerperOrganicIngestResult } from "./types";

/**
 * Vertical slice: fetch Serper Google organic → observation drafts for one auditRunId.
 * Does not open a browser. CAPTCHA → PROVIDER_BLOCKED_CAPTCHA (not NO_RESULTS).
 * No infinite retry.
 */
export async function ingestSerperOrganicObservations(input: {
  caseId: string;
  auditRunId: string;
  queryText: string;
  region: OrionRegionCode;
  language: string;
  subjectFullName?: string;
  limit?: number;
  /** Injected for tests — skips live Serper call. */
  fetchFn?: typeof serperOrganicWithExtras;
}): Promise<SerperOrganicIngestResult> {
  const queryId = buildSerpQueryId({
    auditRunId: input.auditRunId,
    provider: "serper",
    engine: "GOOGLE",
    region: input.region,
    language: input.language,
    queryText: input.queryText,
    surface: "organic",
  });

  const request: SearchProviderRequest = {
    caseId: input.caseId,
    subjectFullName: input.subjectFullName ?? input.queryText,
    aliases: [],
    query: input.queryText,
    language: input.language,
    limit: input.limit ?? 10,
  };

  const fetchFn = input.fetchFn ?? serperOrganicWithExtras;
  const batch = await fetchFn(request, input.region, input.limit ?? 10);

  if (batch.status === "NOT_CONFIGURED") {
    return {
      status: "PROVIDER_NOT_CONFIGURED",
      auditRunId: input.auditRunId,
      queryId,
      observations: [],
      message: batch.error,
    };
  }

  const organicItems = batch.items.filter((i) => i.kind === "organic");
  const classified = classifyProviderFetchOutcome({
    configured: true,
    errorMessage: batch.status === "FAILED" ? batch.error ?? "FAILED" : null,
    rawBodyText: batch.error ?? null,
    organicCount: organicItems.length,
  });

  if (classified === "PROVIDER_BLOCKED_CAPTCHA") {
    return {
      status: "PROVIDER_BLOCKED_CAPTCHA",
      auditRunId: input.auditRunId,
      queryId,
      observations: [],
      message: batch.error ?? "Provider blocked by CAPTCHA",
    };
  }

  if (classified === "PROVIDER_FAILED" || classified === "PROVIDER_RATE_LIMITED") {
    return {
      status: classified,
      auditRunId: input.auditRunId,
      queryId,
      observations: [],
      message: batch.error,
    };
  }

  if (classified === "NO_RESULTS") {
    return {
      status: "NO_RESULTS",
      auditRunId: input.auditRunId,
      queryId,
      observations: [],
    };
  }

  const observations = mapSerperOrganicToObservationDrafts({
    caseId: input.caseId,
    auditRunId: input.auditRunId,
    queryText: input.queryText,
    region: input.region,
    language: input.language,
    items: organicItems,
    providerStatus: "OK",
  });

  return {
    status: "OK",
    auditRunId: input.auditRunId,
    queryId,
    observations,
  };
}
