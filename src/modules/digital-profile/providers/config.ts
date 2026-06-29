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

function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const raw = (value ?? "").trim();
  if (raw === "") return fallback; // Number("") === 0 — must fall back, not clamp.
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Stage N2 — real Google strategy (no scraping option exists by design). */
export type GoogleProviderStrategy = "custom_search" | "external_serp" | "disabled";

function toGoogleStrategy(value: string | undefined): GoogleProviderStrategy {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "custom_search" || v === "external_serp") return v;
  return "disabled";
}

/**
 * Allowlisted external SERP provider names. Only these enum values are accepted;
 * arbitrary URLs are never read from env (SSRF guard). Adapters are not wired up
 * yet — selecting one resolves to a clear "not implemented" provider error.
 */
export const ALLOWED_EXTERNAL_SERP_PROVIDERS = ["serpapi", "serper", "zenserp", "searchapi"] as const;

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
    /** Legacy Stage H2 master-switch-gated flag. */
    enabled: boolean;
    /**
     * Stage N2 — dedicated switch for the real Google connector (independent of
     * the H2 master switch), mirroring the Yandex real flag.
     */
    realEnabled: boolean;
    /**
     * Stage N2 — provider strategy. `custom_search` = Google Programmable Search
     * JSON API; `external_serp` = a separately-selected paid SERP API (skeleton);
     * `disabled` = no real Google. NEVER browser scraping.
     */
    provider: GoogleProviderStrategy;
    apiKey?: string;
    engineId?: string;
    /** Stage N2 — Custom Search tuning. */
    timeoutMs: number;
    maxQueriesPerAudit: number;
    resultsPerQuery: number;
    gl: string;
    hl: string;
    /** Stage N2 — external SERP provider (future-ready; enum name + key only). */
    external: {
      provider?: string;
      apiKey?: string;
      timeoutMs: number;
    };
  };
  yandex: {
    /** Legacy master-switch-gated flag (Stage H2, XML GET endpoint). */
    enabled: boolean;
    /**
     * Stage N1 — dedicated switch for the official Yandex Cloud Search API v2
     * (POST /v2/web/search, Api-Key header). Independent of the H2 master switch.
     */
    realEnabled: boolean;
    apiKey?: string;
    folderId?: string;
    region?: string;
    /** Stage N1 — Cloud Search API v2 tuning. */
    timeoutMs: number;
    maxQueriesPerAudit: number;
    resultsPerQuery: number;
    localization: string;
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
    realEnabled: envBool(process.env.DIGITAL_PROFILE_GOOGLE_REAL_ENABLED, false),
    provider: toGoogleStrategy(process.env.GOOGLE_SEARCH_PROVIDER),
    apiKey: envStr(process.env.GOOGLE_SEARCH_API_KEY),
    engineId: envStr(process.env.GOOGLE_SEARCH_ENGINE_ID),
    timeoutMs: envInt(process.env.GOOGLE_SEARCH_TIMEOUT_MS, 15000, 1000, 60000),
    maxQueriesPerAudit: envInt(process.env.GOOGLE_SEARCH_MAX_QUERIES_PER_AUDIT, 3, 1, 20),
    resultsPerQuery: envInt(process.env.GOOGLE_SEARCH_RESULTS_PER_QUERY, 10, 1, 50),
    gl: (envStr(process.env.GOOGLE_SEARCH_GL) ?? "ru").toLowerCase(),
    hl: (envStr(process.env.GOOGLE_SEARCH_HL) ?? "ru").toLowerCase(),
    external: {
      // Only an enum provider NAME is read from env — never an arbitrary URL
      // (prevents SSRF). The concrete adapter is selected separately.
      provider: envStr(process.env.GOOGLE_EXTERNAL_SERP_PROVIDER)?.toLowerCase(),
      apiKey: envStr(process.env.GOOGLE_EXTERNAL_SERP_API_KEY),
      timeoutMs: envInt(process.env.GOOGLE_EXTERNAL_SERP_TIMEOUT_MS, 15000, 1000, 60000),
    },
  },
  yandex: {
    enabled: envBool(process.env.DIGITAL_PROFILE_YANDEX_ENABLED, false),
    realEnabled: envBool(process.env.DIGITAL_PROFILE_YANDEX_REAL_ENABLED, false),
    apiKey: envStr(process.env.YANDEX_SEARCH_API_KEY),
    folderId: envStr(process.env.YANDEX_SEARCH_FOLDER_ID),
    region: envStr(process.env.YANDEX_SEARCH_REGION) ?? "ru",
    timeoutMs: envInt(process.env.YANDEX_SEARCH_TIMEOUT_MS, 15000, 1000, 60000),
    maxQueriesPerAudit: envInt(process.env.YANDEX_SEARCH_MAX_QUERIES_PER_AUDIT, 5, 1, 20),
    resultsPerQuery: envInt(process.env.YANDEX_SEARCH_RESULTS_PER_QUERY, 10, 1, 50),
    localization: envStr(process.env.YANDEX_SEARCH_LOCALIZATION) ?? "ru",
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
    const g = providerConfig.google;
    const missing: string[] = [];
    if (g.provider === "disabled") {
      // Strategy not selected — the single thing that must be set first.
      missing.push("GOOGLE_SEARCH_PROVIDER");
      return missing;
    }
    if (g.provider === "custom_search") {
      if (!g.apiKey) missing.push("GOOGLE_SEARCH_API_KEY");
      if (!g.engineId) missing.push("GOOGLE_SEARCH_ENGINE_ID");
      return missing;
    }
    // external_serp
    if (!g.external.provider) missing.push("GOOGLE_EXTERNAL_SERP_PROVIDER");
    else if (!g.external.apiKey) missing.push("GOOGLE_EXTERNAL_SERP_API_KEY");
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
  // Stage N1: Yandex real availability is gated solely by its dedicated flag
  // (DIGITAL_PROFILE_YANDEX_REAL_ENABLED), independent of the H2 master switch.
  if (name === "YANDEX") {
    return {
      name,
      ...computeAvailability(name, {
        masterEnabled: true,
        enabled: providerConfig.yandex.realEnabled,
        hasKeys: missingConfigKeys(name).length === 0,
      }),
    };
  }
  // Stage N2 — Google real availability is gated solely by its dedicated flag
  // (DIGITAL_PROFILE_GOOGLE_REAL_ENABLED) + a selected strategy, independent of
  // the H2 master switch (mirrors the Yandex real model).
  return {
    name,
    ...computeAvailability(name, {
      masterEnabled: true,
      enabled: providerConfig.google.realEnabled && providerConfig.google.provider !== "disabled",
      hasKeys: missingConfigKeys(name).length === 0,
    }),
  };
}

export type ProviderKind = "MOCK" | "REAL";

export interface ProviderStatus {
  name: ProviderName;
  /** Stage N1 — label so the UI can show Mock vs Real connectors side by side. */
  kind: ProviderKind;
  /** Human label, e.g. "Yandex Search Real". */
  label: string;
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
  GOOGLE:
    "Google real search. Strategy via GOOGLE_SEARCH_PROVIDER: custom_search (Programmable Search JSON API) or external_serp (separately-selected paid SERP API). No scraping.",
  YANDEX: "Yandex Search API (XML).",
};

const REAL_LABELS: Record<ProviderName, string> = {
  WIKIPEDIA: "Wikipedia",
  GOOGLE: "Google Search Real",
  YANDEX: "Yandex Search Real",
};

export function getProviderStatus(name: ProviderName): ProviderStatus {
  const availability = getProviderAvailability(name);
  const missing = missingConfigKeys(name);
  const cfgEnabled =
    name === "WIKIPEDIA"
      ? providerConfig.wikipedia.enabled
      : name === "GOOGLE"
        ? providerConfig.google.realEnabled
        : providerConfig.yandex.realEnabled;
  return {
    name,
    kind: "REAL",
    label: REAL_LABELS[name],
    enabled: cfgEnabled,
    configured: missing.length === 0,
    status: availability.status,
    missingConfigKeys: missing,
    // supportsRealCalls is only true when enabled AND fully configured.
    supportsRealCalls:
      name !== "WIKIPEDIA" ? cfgEnabled && missing.length === 0 : availability.status === "ENABLED",
    notes: PROVIDER_NOTES[name],
    capabilities: getProviderCapabilities(name),
  };
}

/** Mock connectors are always available and never call out or need keys. */
function getMockProviderStatus(name: ProviderName, label: string): ProviderStatus {
  return {
    name,
    kind: "MOCK",
    label,
    enabled: true,
    configured: true,
    status: "ENABLED",
    missingConfigKeys: [],
    supportsRealCalls: false,
    notes: "Deterministic mock connector. No network, no API key.",
    capabilities: getProviderCapabilities(name),
  };
}

export function listProviderStatus(): ProviderStatus[] {
  return [
    getMockProviderStatus("YANDEX", "Yandex Search Mock"),
    getMockProviderStatus("GOOGLE", "Google Search Mock"),
    getProviderStatus("WIKIPEDIA"),
    getProviderStatus("GOOGLE"),
    getProviderStatus("YANDEX"),
  ];
}

/** @deprecated use listProviderStatus(); kept for older callers. */
export function listProviderAvailability(): ProviderAvailability[] {
  return [
    getProviderAvailability("WIKIPEDIA"),
    getProviderAvailability("GOOGLE"),
    getProviderAvailability("YANDEX"),
  ];
}
