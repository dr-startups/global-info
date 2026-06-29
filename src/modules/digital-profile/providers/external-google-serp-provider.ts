/**
 * Stage N2 — external Google SERP provider (skeleton).
 *
 * Future-ready interface for a separately-selected paid SERP API (e.g. a
 * provider chosen by the operator). It is intentionally NOT wired to any concrete
 * vendor: no network call is made until a real adapter is implemented and the
 * operator explicitly selects it.
 *
 * Safety:
 *  - Only an allowlisted enum provider NAME is accepted (no arbitrary URLs from
 *    env → SSRF guard).
 *  - Never falls back to mock results: an unselected/unimplemented provider
 *    resolves to a structured NOT_CONFIGURED / FAILED result, never silent mock.
 */

import { ALLOWED_EXTERNAL_SERP_PROVIDERS, providerConfig } from "./config";
import type { ProviderRunResult, SearchProviderRequest } from "./types";

export class ExternalGoogleSerpProvider {
  readonly name = "GOOGLE" as const;

  /** Resolves what state the external strategy is in (no network). */
  status(): { state: "NOT_SELECTED" | "UNKNOWN_PROVIDER" | "NOT_CONFIGURED" | "READY"; message: string } {
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
    return { state: "READY", message: "External SERP provider selected." };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async search(_request: SearchProviderRequest): Promise<ProviderRunResult> {
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
    // Selected + keyed but no concrete adapter is implemented yet. We surface a
    // clear, non-retryable error — and crucially do NOT silently use mock data.
    return {
      status: "FAILED",
      provider: this.name,
      results: [],
      error: {
        code: "PROVIDER_REQUEST_FAILED",
        message: `External SERP provider "${providerConfig.google.external.provider}" is selected but not implemented in this build.`,
        retryable: false,
        provider: this.name,
      },
    };
  }
}

export const externalGoogleSerpProvider = new ExternalGoogleSerpProvider();
