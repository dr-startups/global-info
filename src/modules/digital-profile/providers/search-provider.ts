/**
 * Common SERP provider interface (Google/Yandex). Wikipedia is modelled
 * separately because its output is a page-existence check, not ranked results.
 *
 * Every provider must be safe-by-default: when disabled or unconfigured it
 * returns a structured ProviderRunResult (DISABLED / NOT_CONFIGURED), never a
 * thrown error and never a fake/scraped call.
 */

import type {
  AvailabilityStatus,
  ProviderRunResult,
  SearchProviderName,
  SearchProviderRequest,
  SearchProviderResult,
} from "./types";
import type { ProviderCapabilities } from "../search-surfaces/types";

/**
 * Result of a surface-specific method (image/video/suggestions/related). On H3
 * the official adapters only support organic search, so these resolve to
 * NOT_SUPPORTED rather than scraping.
 */
export interface SurfaceMethodResult {
  status: "OFFICIAL_API" | "NOT_SUPPORTED";
  provider: SearchProviderName;
  method: "OFFICIAL_API" | "NOT_SUPPORTED";
  results: SearchProviderResult[];
}

export interface SearchProvider {
  readonly name: SearchProviderName;

  /** Availability derived from config (no network). */
  availability(): { status: AvailabilityStatus; message?: string };

  /** True when the provider is fully configured and enabled. */
  enabled(): boolean;

  /** Throws/returns a structured error description if config is invalid. */
  validateConfig(): { ok: boolean; message?: string };

  /** Execute an organic search. Must resolve (never reject) with a ProviderRunResult. */
  search(request: SearchProviderRequest): Promise<ProviderRunResult>;

  /** Map a raw provider payload into normalized results. */
  normalize(raw: unknown, request: SearchProviderRequest): SearchProviderResult[];

  /** Declared surface capabilities (no network). */
  capabilities(): ProviderCapabilities;

  /** Surface-specific methods (NOT_SUPPORTED on H3 unless the API supports it). */
  searchImages(request: SearchProviderRequest): Promise<SurfaceMethodResult>;
  searchVideos(request: SearchProviderRequest): Promise<SurfaceMethodResult>;
  getSuggestions(request: SearchProviderRequest): Promise<SurfaceMethodResult>;
  getRelatedQueries(request: SearchProviderRequest): Promise<SurfaceMethodResult>;
}
