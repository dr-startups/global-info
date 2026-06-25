/**
 * Google Programmable Search provider — SAFE PLACEHOLDER for Stage H1.
 *
 * H1 contract: validate config only. Never performs a real call, never scrapes.
 * - disabled            -> ProviderRunResult { status: "DISABLED" }
 * - enabled, no keys    -> ProviderRunResult { status: "NOT_CONFIGURED" }
 * - enabled, with keys  -> still returns DISABLED here (real call lands in H2).
 *
 * TODO(H2): implement the official Custom Search JSON API call + normalize().
 */

import { getProviderAvailability } from "./config";
import type { SearchProvider } from "./search-provider";
import type {
  AvailabilityStatus,
  ProviderRunResult,
  SearchProviderRequest,
  SearchProviderResult,
} from "./types";
import { domainOf } from "./types";

export class GoogleSearchProvider implements SearchProvider {
  readonly name = "GOOGLE" as const;

  availability(): { status: AvailabilityStatus; message?: string } {
    const a = getProviderAvailability("GOOGLE");
    return { status: a.status, message: a.message };
  }

  enabled(): boolean {
    return this.availability().status === "ENABLED";
  }

  validateConfig(): { ok: boolean; message?: string } {
    const a = this.availability();
    return { ok: a.status === "ENABLED", message: a.message };
  }

  async search(_request: SearchProviderRequest): Promise<ProviderRunResult> {
    const a = this.availability();
    if (a.status === "DISABLED") {
      return {
        status: "DISABLED",
        provider: this.name,
        results: [],
        error: {
          code: "PROVIDER_DISABLED",
          message: a.message ?? "Google connector is disabled.",
          retryable: false,
          provider: this.name,
        },
      };
    }
    if (a.status === "NOT_CONFIGURED") {
      return {
        status: "NOT_CONFIGURED",
        provider: this.name,
        results: [],
        error: {
          code: "PROVIDER_NOT_CONFIGURED",
          message: a.message ?? "Google API credentials are missing.",
          retryable: false,
          provider: this.name,
        },
      };
    }
    // Enabled + configured, but real calls are intentionally deferred to H2.
    return {
      status: "DISABLED",
      provider: this.name,
      results: [],
      error: {
        code: "PROVIDER_DISABLED",
        message: "Google live search is not implemented yet (planned for H2).",
        retryable: false,
        provider: this.name,
      },
    };
  }

  // TODO(H2): map Custom Search "items" -> SearchProviderResult[].
  normalize(raw: unknown, request: SearchProviderRequest): SearchProviderResult[] {
    const items = (raw as { items?: Array<Record<string, unknown>> })?.items ?? [];
    return items.map((item, i) => {
      const url = String(item.link ?? "");
      return {
        provider: this.name,
        query: request.query,
        region: request.region,
        language: request.language,
        rank: i + 1,
        title: String(item.title ?? ""),
        snippet: String(item.snippet ?? ""),
        url,
        domain: domainOf(url),
        rawMetadata: item,
        capturedAt: new Date().toISOString(),
      };
    });
  }
}

export const googleSearchProvider = new GoogleSearchProvider();
