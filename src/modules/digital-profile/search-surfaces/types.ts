/**
 * Search surface types (Stage H3).
 *
 * A "search surface" is any element of a search experience beyond plain organic
 * results: suggestions/autocomplete, related queries, image/video results,
 * knowledge blocks, SERP screenshots and manual notes. Every item is
 * evidence-first (provider, query, region, language, capturedAt, rawMetadata,
 * demo flag) and is reviewed before it can feed the report.
 */

export type SearchSurfaceType =
  | "ORGANIC_RESULT"
  | "SUGGESTION"
  | "RELATED_QUERY"
  | "IMAGE_RESULT"
  | "VIDEO_RESULT"
  | "KNOWLEDGE_BLOCK"
  | "SERP_SCREENSHOT"
  | "MANUAL_NOTE";

export type SearchSurfaceSource =
  | "MOCK"
  | "REAL_GOOGLE"
  | "REAL_YANDEX"
  | "REAL_WIKIPEDIA"
  | "MANUAL_IMPORT"
  | "SYNTHETIC_SNAPSHOT";

export type SurfaceReviewStatus = "PENDING" | "REVIEWED" | "DISMISSED";

export interface SearchSurfaceItem {
  id: string;
  caseId: string;
  type: SearchSurfaceType;
  provider: string | null;
  source: SearchSurfaceSource;
  query: string | null;
  region: string | null;
  language: string | null;
  title: string | null;
  snippet: string | null;
  url: string | null;
  domain: string | null;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  videoUrl: string | null;
  rank: number | null;
  classification: string | null;
  riskTheme: string | null;
  rawMetadata: unknown;
  capturedAt: Date;
  demo: boolean;
  reviewStatus: SurfaceReviewStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Input shape for creating a surface item (manual or agent). */
export interface SearchSurfaceInput {
  type: SearchSurfaceType;
  source: SearchSurfaceSource;
  provider?: string | null;
  query?: string | null;
  region?: string | null;
  language?: string | null;
  title?: string | null;
  snippet?: string | null;
  url?: string | null;
  domain?: string | null;
  imageUrl?: string | null;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  rank?: number | null;
  classification?: string | null;
  riskTheme?: string | null;
  rawMetadata?: unknown;
  demo?: boolean;
}

export interface SearchSurfaceFilters {
  type?: SearchSurfaceType;
  source?: SearchSurfaceSource;
  provider?: string;
}

// ---------------------------------------------------------------------------
// Provider capabilities (what each provider can deliver, and how)
// ---------------------------------------------------------------------------

export type CapabilityMethod =
  | "OFFICIAL_API"
  | "MANUAL_IMPORT"
  | "NOT_SUPPORTED"
  | "SYNTHETIC";

export interface SurfaceCapability {
  supported: boolean;
  method: CapabilityMethod;
}

export interface ProviderCapabilities {
  organicSearch: SurfaceCapability;
  imageSearch: SurfaceCapability;
  videoSearch: SurfaceCapability;
  suggestions: SurfaceCapability;
  relatedQueries: SurfaceCapability;
  knowledgeBlock: SurfaceCapability;
  screenshots: SurfaceCapability;
  manualImport: SurfaceCapability;
}
