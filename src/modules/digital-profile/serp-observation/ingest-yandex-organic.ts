import { yandexSearchProvider } from "../providers/yandex-search-provider";
import type {
  ProviderRunResult,
  SearchProviderRequest,
  SearchProviderResult,
} from "../providers/types";
import type { OrionRegionCode } from "../search-surfaces/orion-query-plan";
import { classifyProviderFetchOutcome } from "./provider-status";
import { mapYandexOrganicToObservationDrafts } from "./map-yandex-organic";
import { buildSerpQueryId } from "./query-id";
import type { SerperOrganicIngestResult } from "./types";

export type YandexOrganicIngestResult = SerperOrganicIngestResult;

type YandexSearchFn = (request: SearchProviderRequest) => Promise<ProviderRunResult>;

/**
 * Official Yandex Search API → observation drafts for one auditRunId.
 * No browser scraping. CAPTCHA is not expected from the official API.
 */
export async function ingestYandexOrganicObservations(input: {
  caseId: string;
  auditRunId: string;
  queryText: string;
  region: OrionRegionCode;
  language: string;
  subjectFullName?: string;
  limit?: number;
  /** Injected for tests — skips live Yandex call. */
  searchFn?: YandexSearchFn;
}): Promise<YandexOrganicIngestResult> {
  const queryId = buildSerpQueryId({
    auditRunId: input.auditRunId,
    provider: "yandex",
    engine: "YANDEX",
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
    region: input.region === "UAE" ? "international" : "ru",
    language: input.language,
    limit: input.limit ?? 10,
  };

  const searchFn = input.searchFn ?? ((req) => yandexSearchProvider.search(req));
  const run = await searchFn(request);
  const errMsg = run.error?.message ?? "";

  if (run.status === "NOT_CONFIGURED" || run.status === "DISABLED") {
    return {
      status: "PROVIDER_NOT_CONFIGURED",
      auditRunId: input.auditRunId,
      queryId,
      observations: [],
      message: errMsg || run.status,
    };
  }

  const results: SearchProviderResult[] = run.results ?? [];
  const classified = classifyProviderFetchOutcome({
    configured: true,
    errorMessage: run.status === "FAILED" ? errMsg || run.status : null,
    rawBodyText: errMsg || null,
    organicCount: results.length,
  });

  if (classified === "PROVIDER_BLOCKED_CAPTCHA") {
    return {
      status: "PROVIDER_BLOCKED_CAPTCHA",
      auditRunId: input.auditRunId,
      queryId,
      observations: [],
      message: errMsg || "Provider blocked by CAPTCHA",
    };
  }

  if (classified === "PROVIDER_FAILED" || classified === "PROVIDER_RATE_LIMITED") {
    return {
      status: classified,
      auditRunId: input.auditRunId,
      queryId,
      observations: [],
      message: errMsg || run.status,
    };
  }

  if (classified === "NO_RESULTS" && run.status !== "SUCCESS") {
    return {
      status: "NO_RESULTS",
      auditRunId: input.auditRunId,
      queryId,
      observations: [],
    };
  }

  if (results.length === 0) {
    return {
      status: "NO_RESULTS",
      auditRunId: input.auditRunId,
      queryId,
      observations: [],
    };
  }

  const observations = mapYandexOrganicToObservationDrafts({
    caseId: input.caseId,
    auditRunId: input.auditRunId,
    queryText: input.queryText,
    region: input.region,
    language: input.language,
    results,
    providerStatus: "OK",
  });

  return {
    status: "OK",
    auditRunId: input.auditRunId,
    queryId,
    observations,
  };
}
