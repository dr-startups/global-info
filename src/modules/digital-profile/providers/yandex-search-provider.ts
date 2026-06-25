/**
 * Yandex Search API provider — SAFE PLACEHOLDER for Stage H1.
 *
 * H1 contract: validate config only. Never performs a real call, never scrapes.
 * - disabled            -> ProviderRunResult { status: "DISABLED" }
 * - enabled, no keys    -> ProviderRunResult { status: "NOT_CONFIGURED" }
 * - enabled, with keys  -> still returns DISABLED here (real call lands in H2).
 *
 * TODO(H2): implement the official Yandex Search API call + normalize().
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

export class YandexSearchProvider implements SearchProvider {
  readonly name = "YANDEX" as const;

  availability(): { status: AvailabilityStatus; message?: string } {
    const a = getProviderAvailability("YANDEX");
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
          message: a.message ?? "Yandex connector is disabled.",
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
          message: a.message ?? "Yandex API credentials are missing.",
          retryable: false,
          provider: this.name,
        },
      };
    }
    return {
      status: "DISABLED",
      provider: this.name,
      results: [],
      error: {
        code: "PROVIDER_DISABLED",
        message: "Yandex live search is not implemented yet (planned for H2).",
        retryable: false,
        provider: this.name,
      },
    };
  }

  // TODO(H2): map Yandex XML/JSON response -> SearchProviderResult[].
  normalize(_raw: unknown, _request: SearchProviderRequest): SearchProviderResult[] {
    void domainOf;
    return [];
  }
}

export const yandexSearchProvider = new YandexSearchProvider();
