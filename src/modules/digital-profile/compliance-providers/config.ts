/**
 * Stage C1 — compliance provider configuration (no secrets in exports).
 */

import type { ComplianceProviderName, ComplianceProviderStatus } from "./types";

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
  if (raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export const complianceProviderConfig = {
  realEnabled: envBool(process.env.DIGITAL_PROFILE_COMPLIANCE_REAL_ENABLED, false),
  dowJones: {
    enabled: envBool(process.env.DOW_JONES_ENABLED, false),
    apiBaseUrl: envStr(process.env.DOW_JONES_API_BASE_URL),
    clientId: envStr(process.env.DOW_JONES_CLIENT_ID),
    clientSecret: envStr(process.env.DOW_JONES_CLIENT_SECRET),
    timeoutMs: envInt(process.env.DOW_JONES_TIMEOUT_MS, 20_000, 1000, 120_000),
  },
  lexisnexis: {
    enabled: envBool(process.env.LEXISNEXIS_ENABLED, false),
    apiBaseUrl: envStr(process.env.LEXISNEXIS_API_BASE_URL),
    clientId: envStr(process.env.LEXISNEXIS_CLIENT_ID),
    clientSecret: envStr(process.env.LEXISNEXIS_CLIENT_SECRET),
    timeoutMs: envInt(process.env.LEXISNEXIS_TIMEOUT_MS, 20_000, 1000, 120_000),
  },
  worldCheck: {
    enabled: envBool(process.env.WORLD_CHECK_ENABLED, false),
    apiBaseUrl: envStr(process.env.WORLD_CHECK_API_BASE_URL),
    apiKey: envStr(process.env.WORLD_CHECK_API_KEY),
    apiSecret: envStr(process.env.WORLD_CHECK_API_SECRET),
    groupId: envStr(process.env.WORLD_CHECK_GROUP_ID),
    timeoutMs: envInt(process.env.WORLD_CHECK_TIMEOUT_MS, 20_000, 1000, 120_000),
  },
} as const;

const LABELS: Record<ComplianceProviderName, string> = {
  DOW_JONES: "Dow Jones Compliance Real",
  LEXISNEXIS: "LexisNexis Compliance Real",
  WORLD_CHECK: "World-Check Real",
  MANUAL_IMPORT: "Manual Compliance Import",
};

const NOTES: Record<ComplianceProviderName, string> = {
  DOW_JONES:
    "Dow Jones Risk & Compliance. Official API only when contracted and configured. Manual import always available.",
  LEXISNEXIS:
    "LexisNexis / Bridger. Official API only when contracted and configured. Manual import always available.",
  WORLD_CHECK:
    "LSEG World-Check. Official API only when contracted and configured. Manual import always available.",
  MANUAL_IMPORT:
    "Analyst manual import from compliance databases. All hits are potential matches requiring review.",
};

export function missingComplianceConfigKeys(name: ComplianceProviderName): string[] {
  if (name === "MANUAL_IMPORT") return [];
  if (name === "DOW_JONES") {
    const c = complianceProviderConfig.dowJones;
    const missing: string[] = [];
    if (!complianceProviderConfig.realEnabled) missing.push("DIGITAL_PROFILE_COMPLIANCE_REAL_ENABLED");
    if (!c.enabled) missing.push("DOW_JONES_ENABLED");
    if (!c.apiBaseUrl) missing.push("DOW_JONES_API_BASE_URL");
    if (!c.clientId) missing.push("DOW_JONES_CLIENT_ID");
    if (!c.clientSecret) missing.push("DOW_JONES_CLIENT_SECRET");
    return missing;
  }
  if (name === "LEXISNEXIS") {
    const c = complianceProviderConfig.lexisnexis;
    const missing: string[] = [];
    if (!complianceProviderConfig.realEnabled) missing.push("DIGITAL_PROFILE_COMPLIANCE_REAL_ENABLED");
    if (!c.enabled) missing.push("LEXISNEXIS_ENABLED");
    if (!c.apiBaseUrl) missing.push("LEXISNEXIS_API_BASE_URL");
    if (!c.clientId) missing.push("LEXISNEXIS_CLIENT_ID");
    if (!c.clientSecret) missing.push("LEXISNEXIS_CLIENT_SECRET");
    return missing;
  }
  // WORLD_CHECK
  const c = complianceProviderConfig.worldCheck;
  const missing: string[] = [];
  if (!complianceProviderConfig.realEnabled) missing.push("DIGITAL_PROFILE_COMPLIANCE_REAL_ENABLED");
  if (!c.enabled) missing.push("WORLD_CHECK_ENABLED");
  if (!c.apiBaseUrl) missing.push("WORLD_CHECK_API_BASE_URL");
  if (!c.apiKey) missing.push("WORLD_CHECK_API_KEY");
  if (!c.apiSecret) missing.push("WORLD_CHECK_API_SECRET");
  if (!c.groupId) missing.push("WORLD_CHECK_GROUP_ID");
  return missing;
}

function providerEnabled(name: ComplianceProviderName): boolean {
  if (name === "MANUAL_IMPORT") return true;
  if (name === "DOW_JONES") {
    return complianceProviderConfig.realEnabled && complianceProviderConfig.dowJones.enabled;
  }
  if (name === "LEXISNEXIS") {
    return complianceProviderConfig.realEnabled && complianceProviderConfig.lexisnexis.enabled;
  }
  return complianceProviderConfig.realEnabled && complianceProviderConfig.worldCheck.enabled;
}

export function getComplianceProviderStatus(name: ComplianceProviderName): ComplianceProviderStatus {
  if (name === "MANUAL_IMPORT") {
    return {
      name,
      kind: "MANUAL",
      label: LABELS[name],
      enabled: true,
      configured: true,
      status: "ENABLED",
      missingConfigKeys: [],
      supportsRealCalls: false,
      notes: NOTES[name],
    };
  }
  const missing = missingComplianceConfigKeys(name);
  const enabled = providerEnabled(name);
  let status: ComplianceProviderStatus["status"] = "DISABLED";
  if (enabled && missing.length === 0) status = "ENABLED";
  else if (enabled && missing.length > 0) status = "NOT_CONFIGURED";
  return {
    name,
    kind: "REAL",
    label: LABELS[name],
    enabled,
    configured: missing.length === 0,
    status,
    missingConfigKeys: missing,
    supportsRealCalls: enabled && missing.length === 0,
    notes: NOTES[name],
  };
}

export function listComplianceProviderStatus(): ComplianceProviderStatus[] {
  return (
    ["DOW_JONES", "LEXISNEXIS", "WORLD_CHECK", "MANUAL_IMPORT"] as ComplianceProviderName[]
  ).map(getComplianceProviderStatus);
}
