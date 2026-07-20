/**
 * REMEDIATION §8.2 — prevent silent offline enrichment in deploy-like envs.
 */

type Env = Record<string, string | undefined>;

/** Machine-readable job.warning + quality-panel key. */
export const OFFLINE_ENRICHMENT_WARNING = "offline-enrichment-mode";

/** Client-facing copy (RU) for the quality panel. */
export const OFFLINE_ENRICHMENT_CLIENT_MESSAGE =
  "Обогащение выполнялось в офлайн-режиме — страницы подсказок/AI будут пустыми";

function bool(value: string | undefined): boolean {
  if (value == null) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Production, Vercel production/preview, or explicit deploy-like flag. */
export function isDeployLikeEnv(env: Env = process.env): boolean {
  const node = (env.NODE_ENV ?? "").toLowerCase();
  const vercel = (env.VERCEL_ENV ?? "").toLowerCase();
  if (node === "production") return true;
  if (vercel === "production" || vercel === "preview") return true;
  if (bool(env.DIGITAL_PROFILE_DEPLOY_LIKE)) return true;
  return false;
}

export function isNetworkCallsDisabled(env: Env = process.env): boolean {
  return String(env.NETWORK_CALLS ?? "").trim() === "0";
}

/** Same semantics as Arsenkin flags: only 1/true enable live enrichment. */
export function isArsenkinEnvEnabled(env: Env = process.env): boolean {
  const v = String(env.ARSENKIN_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * True when a deploy-like environment would silently skip paid enrichment /
 * live network collection.
 */
export function isOfflineEnrichmentMode(env: Env = process.env): boolean {
  if (!isDeployLikeEnv(env)) return false;
  return isNetworkCallsDisabled(env) || !isArsenkinEnvEnabled(env);
}

export function offlineEnrichmentEnvWarning(env: Env = process.env): string | null {
  if (!isOfflineEnrichmentMode(env)) return null;
  const parts: string[] = [];
  if (isNetworkCallsDisabled(env)) parts.push("NETWORK_CALLS=0");
  if (!isArsenkinEnvEnabled(env)) parts.push("ARSENKIN_ENABLED is not enabled");
  return (
    `Deploy-like environment is in offline enrichment mode (${parts.join(", ")}). ` +
    `Suggestion/AI surfaces will be empty. Set ARSENKIN_ENABLED=true and unset NETWORK_CALLS for live enrichment.`
  );
}

/** Ensure the warning token is present on the job warning list (idempotent). */
export function ensureOfflineEnrichmentJobWarning(warnings: string[]): string[] {
  if (warnings.some((w) => w === OFFLINE_ENRICHMENT_WARNING || w.startsWith(`${OFFLINE_ENRICHMENT_WARNING}:`))) {
    return warnings;
  }
  return [...warnings, OFFLINE_ENRICHMENT_WARNING];
}
