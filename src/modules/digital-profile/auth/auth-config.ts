/**
 * Auth configuration for the Digital Profile module (Stage M1).
 *
 * Auth is OFF by default so the local demo / smoke flow keeps working. When
 * enabled, a session secret is required; in production a missing or default
 * secret is a hard error (fail-closed).
 *
 * Env:
 *   DIGITAL_PROFILE_AUTH_ENABLED=true|false      (default false)
 *   DIGITAL_PROFILE_SESSION_SECRET=<random>      (required when enabled)
 *   DIGITAL_PROFILE_DEMO_ADMIN_EMAIL=...         (seed only)
 *   DIGITAL_PROFILE_DEMO_ADMIN_PASSWORD=...      (seed only, demo-only)
 */

const DEFAULT_SECRET = "change-me-in-production";

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
    enabled: envBool(process.env.DIGITAL_PROFILE_AUTH_ENABLED, false),
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
 * Fail-closed safety check. Call before issuing/trusting sessions. In production
 * with auth enabled, refuse to run on the default/empty session secret.
 */
export function assertAuthConfigSafe(): void {
  const cfg = getAuthConfig();
  if (!cfg.enabled) return;
  if (
    process.env.NODE_ENV === "production" &&
    (cfg.sessionSecret === DEFAULT_SECRET || cfg.sessionSecret.length < 16)
  ) {
    throw new Error(
      "DIGITAL_PROFILE_SESSION_SECRET must be set to a strong value (>=16 chars) " +
        "when DIGITAL_PROFILE_AUTH_ENABLED=true in production."
    );
  }
}
