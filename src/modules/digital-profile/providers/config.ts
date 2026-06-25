/**
 * Configuration for real external connectors (Stage H).
 *
 * Safety model:
 *  - DIGITAL_PROFILE_REAL_CONNECTORS_ENABLED is a master switch for paid/keyed
 *    SERP providers (Google/Yandex). It does NOT gate Wikipedia.
 *  - Wikipedia is a public, official, free API and has its own independent flag
 *    (DIGITAL_PROFILE_WIKIPEDIA_ENABLED, default true).
 *  - A provider with a missing API key resolves to NOT_CONFIGURED (never a crash,
 *    never a fake call).
 */

import type { AvailabilityStatus } from "./types";

function envBool(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envStr(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v && v.length > 0 ? v : undefined;
}

export interface ProviderConfig {
  /** Master switch for keyed SERP providers (Google/Yandex). */
  realConnectorsEnabled: boolean;
  wikipedia: {
    enabled: boolean;
    /** Languages to check, in priority order. */
    languages: string[];
    /** Wikimedia requires a descriptive User-Agent. */
    userAgent: string;
    /** Minimum delay between Wikipedia HTTP calls (rate-limit hook), ms. */
    minRequestIntervalMs: number;
  };
  google: {
    enabled: boolean;
    apiKey?: string;
    engineId?: string;
  };
  yandex: {
    enabled: boolean;
    apiKey?: string;
    folderId?: string;
  };
}

export const providerConfig: ProviderConfig = {
  realConnectorsEnabled: envBool(process.env.DIGITAL_PROFILE_REAL_CONNECTORS_ENABLED, false),
  wikipedia: {
    enabled: envBool(process.env.DIGITAL_PROFILE_WIKIPEDIA_ENABLED, true),
    languages: (envStr(process.env.DIGITAL_PROFILE_WIKIPEDIA_LANGS) ?? "ru,en")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    userAgent:
      envStr(process.env.DIGITAL_PROFILE_WIKIPEDIA_USER_AGENT) ??
      "GlobalInfo-DigitalProfile/1.0 (compliance audit; contact: admin@example.com)",
    minRequestIntervalMs: Number(process.env.DIGITAL_PROFILE_WIKIPEDIA_MIN_INTERVAL_MS ?? 250),
  },
  google: {
    enabled: envBool(process.env.DIGITAL_PROFILE_GOOGLE_ENABLED, false),
    apiKey: envStr(process.env.GOOGLE_SEARCH_API_KEY),
    engineId: envStr(process.env.GOOGLE_SEARCH_ENGINE_ID),
  },
  yandex: {
    enabled: envBool(process.env.DIGITAL_PROFILE_YANDEX_ENABLED, false),
    apiKey: envStr(process.env.YANDEX_SEARCH_API_KEY),
    folderId: envStr(process.env.YANDEX_SEARCH_FOLDER_ID),
  },
};

export interface ProviderAvailability {
  name: "WIKIPEDIA" | "GOOGLE" | "YANDEX";
  status: AvailabilityStatus;
  message?: string;
}

/** Resolves the availability of a provider from config (no network calls). */
export function getProviderAvailability(
  name: "WIKIPEDIA" | "GOOGLE" | "YANDEX"
): ProviderAvailability {
  if (name === "WIKIPEDIA") {
    return providerConfig.wikipedia.enabled
      ? { name, status: "ENABLED" }
      : { name, status: "DISABLED", message: "Wikipedia connector is disabled." };
  }

  const cfg = name === "GOOGLE" ? providerConfig.google : providerConfig.yandex;
  if (!providerConfig.realConnectorsEnabled || !cfg.enabled) {
    return { name, status: "DISABLED", message: `${name} connector is disabled.` };
  }
  const hasKeys =
    name === "GOOGLE"
      ? Boolean(providerConfig.google.apiKey && providerConfig.google.engineId)
      : Boolean(providerConfig.yandex.apiKey && providerConfig.yandex.folderId);
  if (!hasKeys) {
    return {
      name,
      status: "NOT_CONFIGURED",
      message: `${name} API credentials are missing.`,
    };
  }
  return { name, status: "ENABLED" };
}

export function listProviderAvailability(): ProviderAvailability[] {
  return [
    getProviderAvailability("WIKIPEDIA"),
    getProviderAvailability("GOOGLE"),
    getProviderAvailability("YANDEX"),
  ];
}
