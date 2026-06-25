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

export interface SearchProvider {
  readonly name: SearchProviderName;

  /** Availability derived from config (no network). */
  availability(): { status: AvailabilityStatus; message?: string };

  /** True when the provider is fully configured and enabled. */
  enabled(): boolean;

  /** Throws/returns a structured error description if config is invalid. */
  validateConfig(): { ok: boolean; message?: string };

  /** Execute a search. Must resolve (never reject) with a ProviderRunResult. */
  search(request: SearchProviderRequest): Promise<ProviderRunResult>;

  /** Map a raw provider payload into normalized results. */
  normalize(raw: unknown, request: SearchProviderRequest): SearchProviderResult[];
}
