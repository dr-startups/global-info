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
import { getProviderCapabilities } from "./capabilities";

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
  /** HTTP timeout for keyed provider calls, ms. */
  timeoutMs: number;
  /** Default cap on results returned per provider run. */
  maxResults: number;
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
    region?: string;
  };
}

export const providerConfig: ProviderConfig = {
  realConnectorsEnabled: envBool(process.env.DIGITAL_PROFILE_REAL_CONNECTORS_ENABLED, false),
  timeoutMs: Number(process.env.DIGITAL_PROFILE_PROVIDER_TIMEOUT_MS ?? 15000),
  maxResults: Number(process.env.DIGITAL_PROFILE_PROVIDER_MAX_RESULTS ?? 20),
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
    region: envStr(process.env.YANDEX_SEARCH_REGION),
  },
};

export type ProviderName = "WIKIPEDIA" | "GOOGLE" | "YANDEX";

export interface ProviderAvailability {
  name: ProviderName;
  status: AvailabilityStatus;
  message?: string;
}

/**
 * Pure availability resolver — unit-testable without touching process.env.
 * `masterEnabled` is the realConnectorsEnabled switch (ignored for Wikipedia).
 */
export function computeAvailability(
  name: ProviderName,
  input: { masterEnabled: boolean; enabled: boolean; hasKeys: boolean }
): { status: AvailabilityStatus; message?: string } {
  if (name === "WIKIPEDIA") {
    return input.enabled
      ? { status: "ENABLED" }
      : { status: "DISABLED", message: "Wikipedia connector is disabled." };
  }
  if (!input.masterEnabled || !input.enabled) {
    return { status: "DISABLED", message: `${name} connector is disabled.` };
  }
  if (!input.hasKeys) {
    return { status: "NOT_CONFIGURED", message: `${name} API credentials are missing.` };
  }
  return { status: "ENABLED" };
}

/** Config keys required by a provider that are currently missing (no values). */
export function missingConfigKeys(name: ProviderName): string[] {
  if (name === "GOOGLE") {
    const missing: string[] = [];
    if (!providerConfig.google.apiKey) missing.push("GOOGLE_SEARCH_API_KEY");
    if (!providerConfig.google.engineId) missing.push("GOOGLE_SEARCH_ENGINE_ID");
    return missing;
  }
  if (name === "YANDEX") {
    const missing: string[] = [];
    if (!providerConfig.yandex.apiKey) missing.push("YANDEX_SEARCH_API_KEY");
    if (!providerConfig.yandex.folderId) missing.push("YANDEX_SEARCH_FOLDER_ID");
    return missing;
  }
  return [];
}

/** Resolves the availability of a provider from config (no network calls). */
export function getProviderAvailability(name: ProviderName): ProviderAvailability {
  if (name === "WIKIPEDIA") {
    return {
      name,
      ...computeAvailability(name, {
        masterEnabled: true,
        enabled: providerConfig.wikipedia.enabled,
        hasKeys: true,
      }),
    };
  }
  const cfg = name === "GOOGLE" ? providerConfig.google : providerConfig.yandex;
  return {
    name,
    ...computeAvailability(name, {
      masterEnabled: providerConfig.realConnectorsEnabled,
      enabled: cfg.enabled,
      hasKeys: missingConfigKeys(name).length === 0,
    }),
  };
}

export interface ProviderStatus {
  name: ProviderName;
  kind: "REAL";
  enabled: boolean;
  configured: boolean;
  status: AvailabilityStatus;
  missingConfigKeys: string[];
  supportsRealCalls: boolean;
  notes: string;
  capabilities: import("../search-surfaces/types").ProviderCapabilities;
}

const PROVIDER_NOTES: Record<ProviderName, string> = {
  WIKIPEDIA: "Public MediaWiki/REST API. No API key required.",
  GOOGLE: "Google Programmable Search (Custom Search JSON API).",
  YANDEX: "Yandex Search API (XML).",
};

export function getProviderStatus(name: ProviderName): ProviderStatus {
  const availability = getProviderAvailability(name);
  const missing = missingConfigKeys(name);
  const cfgEnabled =
    name === "WIKIPEDIA"
      ? providerConfig.wikipedia.enabled
      : name === "GOOGLE"
        ? providerConfig.google.enabled
        : providerConfig.yandex.enabled;
  return {
    name,
    kind: "REAL",
    enabled: cfgEnabled,
    configured: missing.length === 0,
    status: availability.status,
    missingConfigKeys: missing,
    supportsRealCalls: name !== "WIKIPEDIA",
    notes: PROVIDER_NOTES[name],
    capabilities: getProviderCapabilities(name),
  };
}

export function listProviderStatus(): ProviderStatus[] {
  return [getProviderStatus("WIKIPEDIA"), getProviderStatus("GOOGLE"), getProviderStatus("YANDEX")];
}

/** @deprecated use listProviderStatus(); kept for older callers. */
export function listProviderAvailability(): ProviderAvailability[] {
  return [
    getProviderAvailability("WIKIPEDIA"),
    getProviderAvailability("GOOGLE"),
    getProviderAvailability("YANDEX"),
  ];
}
