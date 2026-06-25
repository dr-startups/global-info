/**
 * Configuration and feature flag for the Digital Profile Audit module.
 *
 * The module is fully isolated behind `DIGITAL_PROFILE_ENABLED`. When disabled,
 * routes/services/UI must short-circuit (see `isDigitalProfileEnabled`).
 */

import type { ReportPriceItem } from "./types";

function envBool(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export interface DigitalProfileConfig {
  enabled: boolean;
  storageDir: string;
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
}

export const digitalProfileConfig: DigitalProfileConfig = {
  enabled: envBool(process.env.DIGITAL_PROFILE_ENABLED, false),
  storageDir:
    process.env.DIGITAL_PROFILE_STORAGE_DIR ?? "./storage/digital-profile",
  signedUrl: {
    // Canonical: DIGITAL_PROFILE_SIGNED_URL_SECRET. DIGITAL_PROFILE_SIGNING_SECRET
    // is accepted as an alias for convenience.
    secret:
      process.env.DIGITAL_PROFILE_SIGNED_URL_SECRET ??
      process.env.DIGITAL_PROFILE_SIGNING_SECRET ??
      "change-me-in-production",
    ttlSeconds: Number(process.env.DIGITAL_PROFILE_SIGNED_URL_TTL ?? 600),
  },
  priceCurrency: process.env.DIGITAL_PROFILE_PRICE_CURRENCY ?? "EUR",
  mockAgents: envBool(process.env.DIGITAL_PROFILE_MOCK_AGENTS, true),
  // Canonical: RENDERER_URL. DIGITAL_PROFILE_RENDERER_URL is accepted as an alias.
  rendererUrl:
    process.env.RENDERER_URL ??
    process.env.DIGITAL_PROFILE_RENDERER_URL ??
    "http://localhost:8080",
  reportTemplateVersion:
    process.env.DIGITAL_PROFILE_REPORT_TEMPLATE_VERSION ?? "report-template-v1",
};

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
