/**
 * Run-scoped SERP observations (provider-first).
 * Observations are never URL-deduped across queries/ranks.
 * Canonical SearchDocument is optional identity only.
 */

export const SYNTHETIC_API_SERP_CAPTION =
  "Синтетический снимок на основе сохранённых результатов API";

/** Typed provider outcome — CAPTCHA must never collapse into NO_RESULTS. */
export type SerpProviderStatus =
  | "OK"
  | "NO_RESULTS"
  | "PROVIDER_BLOCKED_CAPTCHA"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_FAILED"
  | "PROVIDER_RATE_LIMITED";

export type SerpObservationProvider = "serper" | "yandex" | "dataforseo" | "arsenkin";
export type SerpObservationEngine = "GOOGLE" | "YANDEX" | "MULTI";
export type SerpObservationSurface =
  | "organic"
  | "images"
  | "videos"
  | "autocomplete"
  | "related"
  | "knowledge_graph"
  | "paa"
  | "ai_answer"
  | "page_meta"
  | "indexation";

export type SerpObservationDraft = {
  caseId: string;
  auditRunId: string;
  queryId: string;
  queryText: string;
  /** Optional parent query for nested PAA depth. */
  parentQueryId?: string | null;
  /** Async provider task that produced this observation. */
  providerTaskId?: string | null;
  provider: SerpObservationProvider;
  engine: SerpObservationEngine;
  surface: SerpObservationSurface;
  region: string;
  language: string;
  device?: string;
  rank: number;
  url: string;
  title: string | null;
  snippet: string | null;
  domain: string | null;
  providerStatus: SerpProviderStatus;
  rawPayloadJson?: Record<string, unknown> | null;
  capturedAt: Date;
};

export type PersistedSerpObservation = SerpObservationDraft & {
  id: string;
  searchDocumentId: string | null;
};

export type SerperOrganicIngestResult =
  | {
      status: "OK";
      auditRunId: string;
      queryId: string;
      observations: SerpObservationDraft[];
    }
  | {
      status: Exclude<SerpProviderStatus, "OK">;
      auditRunId: string;
      queryId: string;
      observations: [];
      message?: string;
    };
