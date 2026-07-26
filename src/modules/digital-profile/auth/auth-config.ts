/**
 * Auth configuration for the Digital Profile module (Stage M1 / R10.10a).
 *
 * Auth is OFF by default for local demo / smoke. Production and staging-like
 * environments are fail-closed: synthetic SUPER_ADMIN is never accepted, and
 * DIGITAL_PROFILE_AUTH_ENABLED must be true for ORION admin surfaces.
 *
 * Env:
 *   DIGITAL_PROFILE_AUTH_ENABLED=true|false      (default false)
 *   DIGITAL_PROFILE_SESSION_SECRET=<random>      (required when enabled)
 *   DIGITAL_PROFILE_AUTH_ALLOW_SYNTHETIC=true    (local/dev bypass only)
 *   DIGITAL_PROFILE_DEPLOY_LIKE=true             (force deploy-like fail-closed)
 *   DIGITAL_PROFILE_DEMO_ADMIN_EMAIL=...         (seed only)
 *   DIGITAL_PROFILE_DEMO_ADMIN_PASSWORD=...      (seed only, demo-only)
 */

const DEFAULT_SECRET = "change-me-in-production";

import { boolSetting } from "../config/defaults";

function envBool(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export interface AuthConfig {
  enabled: boolean;
  sessionSecret: string;
  demoAdminEmail: string;
  demoAdminPassword: string;
}

export function getAuthConfig(): AuthConfig {
  return {
    // Вход обязателен по умолчанию: незакрытая админка — это не «удобная
    // настройка по умолчанию», а открытый доступ к делам клиентов. Локальный
    // контур отключает её явной переменной.
    enabled: boolSetting("DIGITAL_PROFILE_AUTH_ENABLED"),
    sessionSecret:
      process.env.DIGITAL_PROFILE_SESSION_SECRET?.trim() || DEFAULT_SECRET,
    demoAdminEmail:
      process.env.DIGITAL_PROFILE_DEMO_ADMIN_EMAIL?.trim() ||
      "superadmin@demo.local",
    demoAdminPassword:
      process.env.DIGITAL_PROFILE_DEMO_ADMIN_PASSWORD || "demo-Admin-12345",
  };
}

export function isAuthEnabled(): boolean {
  return getAuthConfig().enabled;
}

/**
 * True for production / staging-like runtimes where synthetic auth must never
 * be used. Explicit DIGITAL_PROFILE_DEPLOY_LIKE=true forces this on.
 */
export function isDeployLikeEnvironment(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (envBool(env.DIGITAL_PROFILE_DEPLOY_LIKE, false)) return true;
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv === "production") return true;
  const appEnv = (env.APP_ENV ?? env.RAILWAY_ENVIRONMENT ?? env.VERCEL_ENV ?? "")
    .trim()
    .toLowerCase();
  return ["production", "prod", "staging", "preview"].includes(appEnv);
}

/**
 * Local/dev-only synthetic SUPER_ADMIN bypass. Never allowed in deploy-like
 * environments even if the flag is set.
 */
export function isSyntheticAuthBypassAllowed(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (isDeployLikeEnvironment(env)) return false;
  if (getAuthConfig().enabled) return false;
  // Default: allow synthetic only outside deploy-like when auth is off
  // (preserves local smoke). Explicit false disables it.
  if (env.DIGITAL_PROFILE_AUTH_ALLOW_SYNTHETIC != null) {
    return envBool(env.DIGITAL_PROFILE_AUTH_ALLOW_SYNTHETIC, false);
  }
  return true;
}

/**
 * Fail-closed safety check. Call before issuing/trusting sessions. In production
 * with auth enabled, refuse to run on the default/empty session secret.
 */
export function assertAuthConfigSafe(): void {
  const cfg = getAuthConfig();
  if (!cfg.enabled) return;
  if (
    isDeployLikeEnvironment() &&
    (cfg.sessionSecret === DEFAULT_SECRET || cfg.sessionSecret.length < 16)
  ) {
    throw new Error(
      "DIGITAL_PROFILE_SESSION_SECRET must be set to a strong value (>=16 chars) " +
        "when DIGITAL_PROFILE_AUTH_ENABLED=true in production/staging."
    );
  }
}
