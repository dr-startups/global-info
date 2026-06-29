/**
 * Stage N2 — external Google SERP provider dispatcher.
 *
 * Routes to a separately-selected paid SERP API (enum name from env only — no
 * arbitrary URLs → SSRF guard). Currently implemented: serper.
 * Others (serpapi, zenserp, searchapi) resolve to a clear not-implemented error.
 *
 * Never falls back to mock results on provider errors.
 */

import { ALLOWED_EXTERNAL_SERP_PROVIDERS, providerConfig } from "./config";
import { serperSearch } from "./serper-search-provider";
import type { ProviderRunResult, SearchProviderRequest } from "./types";

export class ExternalGoogleSerpProvider {
  readonly name = "GOOGLE" as const;

  /** Resolves what state the external strategy is in (no network). */
  status(): { state: "NOT_SELECTED" | "UNKNOWN_PROVIDER" | "NOT_CONFIGURED" | "READY" | "NOT_IMPLEMENTED"; message: string } {
    const ext = providerConfig.google.external;
    if (!ext.provider) {
      return {
        state: "NOT_SELECTED",
        message:
          "External SERP provider is not selected (set GOOGLE_EXTERNAL_SERP_PROVIDER to a supported value).",
      };
    }
    if (!(ALLOWED_EXTERNAL_SERP_PROVIDERS as readonly string[]).includes(ext.provider)) {
      return {
        state: "UNKNOWN_PROVIDER",
        message: `External SERP provider "${ext.provider}" is not in the allowlist (${ALLOWED_EXTERNAL_SERP_PROVIDERS.join(", ")}).`,
      };
    }
    if (!ext.apiKey) {
      return {
        state: "NOT_CONFIGURED",
        message: "External SERP provider is selected but its API key is missing.",
      };
    }
    if (ext.provider !== "serper") {
      return {
        state: "NOT_IMPLEMENTED",
        message: `External SERP provider "${ext.provider}" is not implemented in this build (use serper).`,
      };
    }
    return { state: "READY", message: "External SERP provider (serper) ready." };
  }

  async search(request: SearchProviderRequest): Promise<ProviderRunResult> {
    const s = this.status();
    if (s.state === "NOT_SELECTED" || s.state === "UNKNOWN_PROVIDER") {
      return {
        status: "NOT_CONFIGURED",
        provider: this.name,
        results: [],
        error: {
          code: "PROVIDER_NOT_CONFIGURED",
          message: s.message,
          retryable: false,
          provider: this.name,
        },
      };
    }
    if (s.state === "NOT_CONFIGURED") {
      return {
        status: "NOT_CONFIGURED",
        provider: this.name,
        results: [],
        error: {
          code: "PROVIDER_NOT_CONFIGURED",
          message: s.message,
          retryable: false,
          provider: this.name,
        },
      };
    }
    if (s.state === "NOT_IMPLEMENTED") {
      return {
        status: "FAILED",
        provider: this.name,
        results: [],
        error: {
          code: "PROVIDER_REQUEST_FAILED",
          message: s.message,
          retryable: false,
          provider: this.name,
        },
      };
    }
    return serperSearch(request);
  }
}

export const externalGoogleSerpProvider = new ExternalGoogleSerpProvider();
