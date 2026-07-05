/**
 * Configuration and feature flag for the Digital Profile Audit module.
 *
 * The module is fully isolated behind `DIGITAL_PROFILE_ENABLED`. When disabled,
 * routes/services/UI must short-circuit (see `isDigitalProfileEnabled`).
 */

import type { ReportPriceItem } from "./types";
import type { StorageDriver } from "./storage/types";

function envBool(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function envInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

const KNOWN_DRIVERS: StorageDriver[] = ["local", "s3", "r2", "supabase"];
function envDriver(value: string | undefined): StorageDriver {
  const v = (value ?? "").trim().toLowerCase();
  return (KNOWN_DRIVERS as string[]).includes(v) ? (v as StorageDriver) : "local";
}

export interface DigitalProfileConfig {
  enabled: boolean;
  storageDir: string;
  /** Stage M2 storage abstraction config. `root` mirrors `storageDir`. */
  storage: {
    driver: StorageDriver;
    root: string;
    /** Optional base URL for a public CDN/bucket (unused by the local driver). */
    publicBaseUrl: string | null;
    signedUrlTtlSeconds: number;
  };
  signedUrl: {
    secret: string;
    ttlSeconds: number;
  };
  priceCurrency: string;
  /** Mock mode: agents must not call external APIs. Defaults to true until Stage H. */
  mockAgents: boolean;
  /** Base URL of the PPTX/PDF renderer microservice. */
  rendererUrl: string;
  /** Default report template version used by the renderer. */
  reportTemplateVersion: string;
  /** Default Admin UI locale ("ru" | "en"); UI-only, falls back to "ru". */
  defaultLocale: "ru" | "en";
  /** Stage R8.3 — AI analyst narrative provider config. */
  aiAnalyst: {
    enabled: boolean;
    provider: "openai";
    model: string;
    timeoutMs: number;
    maxInputItems: number;
    maxOutputTokens: number;
    openAiApiKey?: string;
  };
  orionPipelineStore: "file" | "db";
  orionV2UiEnabled: boolean;
  /**
   * R9.5c — user-facing ORION v2 reports must be GPT-5.5-backed.
   * When true, generation is blocked unless the AI analyst is fully configured.
   */
  orionV2RequireAi: boolean;
  /**
   * R9.5c — deterministic fallback for ORION v2 is allowed ONLY for explicit
   * dev/test/local QA. In production/preview it must stay false so a fallback
   * never silently produces a user-facing client report.
   */
  orionV2AllowDeterministicFallback: boolean;
}

/** Client-safe booleans describing ORION v2 AI readiness. Never exposes secrets. */
export interface OrionV2AiReadiness {
  hasOpenAiKey: boolean;
  aiEnabled: boolean;
  requireAi: boolean;
  fallbackAllowed: boolean;
  provider: "openai";
  model: string;
  /** True only when AI is fully configured to run GPT-5.5 analysis. */
  ready: boolean;
}

function envLocale(value: string | undefined): "ru" | "en" {
  const v = value?.trim().toLowerCase().slice(0, 2);
  return v === "en" ? "en" : "ru";
}

const STORAGE_ROOT =
  process.env.DIGITAL_PROFILE_STORAGE_ROOT ??
  process.env.DIGITAL_PROFILE_STORAGE_DIR ??
  "./storage/digital-profile";

// One canonical signed-URL TTL governs all private download links.
const SIGNED_URL_TTL_SECONDS = Number(
  process.env.DIGITAL_PROFILE_STORAGE_SIGNED_URL_TTL_SECONDS ??
    process.env.DIGITAL_PROFILE_SIGNED_URL_TTL ??
    900
);

export const digitalProfileConfig: DigitalProfileConfig = {
  enabled: envBool(process.env.DIGITAL_PROFILE_ENABLED, false),
  // Back-compat alias: storageDir === storage.root.
  storageDir: STORAGE_ROOT,
  storage: {
    driver: envDriver(process.env.DIGITAL_PROFILE_STORAGE_DRIVER),
    root: STORAGE_ROOT,
    publicBaseUrl:
      process.env.DIGITAL_PROFILE_STORAGE_PUBLIC_BASE_URL?.trim() || null,
    signedUrlTtlSeconds: SIGNED_URL_TTL_SECONDS,
  },
  signedUrl: {
    // Canonical: DIGITAL_PROFILE_SIGNED_URL_SECRET. DIGITAL_PROFILE_SIGNING_SECRET
    // is accepted as an alias for convenience.
    secret:
      process.env.DIGITAL_PROFILE_SIGNED_URL_SECRET ??
      process.env.DIGITAL_PROFILE_SIGNING_SECRET ??
      "change-me-in-production",
    ttlSeconds: SIGNED_URL_TTL_SECONDS,
  },
  priceCurrency: process.env.DIGITAL_PROFILE_PRICE_CURRENCY ?? "EUR",
  mockAgents: envBool(process.env.DIGITAL_PROFILE_MOCK_AGENTS, true),
  // Canonical: RENDERER_URL. DIGITAL_PROFILE_RENDERER_URL is accepted as an alias.
  rendererUrl:
    process.env.RENDERER_URL ??
    process.env.DIGITAL_PROFILE_RENDERER_URL ??
    "http://localhost:8080",
  reportTemplateVersion:
    process.env.DIGITAL_PROFILE_REPORT_TEMPLATE_VERSION ?? "report-template-v3",
  defaultLocale: envLocale(process.env.DIGITAL_PROFILE_DEFAULT_LOCALE),
  aiAnalyst: {
    enabled: envBool(process.env.DIGITAL_PROFILE_AI_ANALYST_ENABLED, false),
    provider:
      (process.env.DIGITAL_PROFILE_AI_ANALYST_PROVIDER ?? "openai").trim().toLowerCase() === "openai"
        ? "openai"
        : "openai",
    model: process.env.DIGITAL_PROFILE_AI_ANALYST_MODEL?.trim() || "gpt-5.5",
    timeoutMs: envInt(process.env.DIGITAL_PROFILE_AI_ANALYST_TIMEOUT_MS, 60000, 1000, 180000),
    maxInputItems: envInt(process.env.DIGITAL_PROFILE_AI_ANALYST_MAX_INPUT_ITEMS, 120, 20, 500),
    // Reasoning models spend part of this budget on reasoning tokens, so keep it
    // generous — a truncated response yields invalid JSON and forces fallback.
    maxOutputTokens: envInt(process.env.DIGITAL_PROFILE_AI_ANALYST_MAX_OUTPUT_TOKENS, 8000, 200, 32000),
    openAiApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
  },
  orionPipelineStore:
    String(process.env.DIGITAL_PROFILE_ORION_PIPELINE_STORE ?? "").trim().toLowerCase() === "db"
      ? "db"
      : "file",
  orionV2UiEnabled: envBool(
    process.env.DIGITAL_PROFILE_ORION_V2_UI_ENABLED,
    process.env.NODE_ENV !== "production"
  ),
  // Default: required in production/preview-like envs, relaxed only in local/test.
  orionV2RequireAi: envBool(
    process.env.DIGITAL_PROFILE_ORION_V2_REQUIRE_AI,
    process.env.NODE_ENV === "production"
  ),
  // Default: allowed only outside production/preview (smoke/local QA).
  orionV2AllowDeterministicFallback: envBool(
    process.env.DIGITAL_PROFILE_ORION_V2_ALLOW_DETERMINISTIC_FALLBACK,
    process.env.NODE_ENV !== "production"
  ),
};

/**
 * Returns client-safe ORION v2 AI readiness booleans. Never returns the API key
 * value itself — only whether one is present and whether the analyst can run.
 */
export function describeOrionV2AiReadiness(): OrionV2AiReadiness {
  const ai = digitalProfileConfig.aiAnalyst;
  const hasOpenAiKey = Boolean(ai.openAiApiKey && ai.openAiApiKey.trim().length > 0);
  const aiEnabled = ai.enabled;
  const providerOk = ai.provider === "openai";
  return {
    hasOpenAiKey,
    aiEnabled,
    requireAi: digitalProfileConfig.orionV2RequireAi,
    fallbackAllowed: digitalProfileConfig.orionV2AllowDeterministicFallback,
    provider: "openai",
    model: ai.model,
    ready: hasOpenAiKey && aiEnabled && providerOk,
  };
}

/** Master feature flag check. Use this everywhere before exposing the module. */
export function isDigitalProfileEnabled(): boolean {
  return digitalProfileConfig.enabled;
}

/**
 * Pricing catalog for static commercial report pages.
 * Kept separate from report logic so prices can be edited without touching code
 * that builds the report. Amounts are integers in the configured currency.
 */
export const reportPricing: ReportPriceItem[] = [
  {
    code: "BASIC_AUDIT",
    label: "Digital Profile Audit — Basic",
    amount: 490,
    currency: digitalProfileConfig.priceCurrency,
    note: "Open-source search, screenshots, summary report.",
  },
  {
    code: "STANDARD_AUDIT",
    label: "Digital Profile Audit — Standard",
    amount: 1290,
    currency: digitalProfileConfig.priceCurrency,
    note: "Adds compliance database screening and risk findings.",
  },
  {
    code: "ENTERPRISE_AUDIT",
    label: "Digital Profile Audit — Enterprise",
    amount: 2900,
    currency: digitalProfileConfig.priceCurrency,
    note: "Full audit with manual analyst review and ongoing monitoring.",
  },
];
