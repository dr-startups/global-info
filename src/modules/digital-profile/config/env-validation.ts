/**
 * Runtime environment validation (Stage M3).
 *
 * Collects configuration problems WITHOUT ever logging secret values (only the
 * variable names are reported). In development missing/weak config is a warning;
 * in production critical problems are fatal (fail-fast at startup — see
 * `src/instrumentation.ts`).
 *
 * Pure (reads from an injected env map, defaults to process.env) so it can also
 * be exercised by smoke tests.
 */

type Env = Record<string, string | undefined>;

const DEFAULT_SECRET = "change-me-in-production";
const KNOWN_DRIVERS = ["local", "s3", "r2", "supabase"];
const IMPLEMENTED_DRIVERS = ["local"];

export interface EnvValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function bool(value: string | undefined): boolean {
  if (value == null) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function isWeakSecret(value: string | undefined, minLen = 16): boolean {
  const v = (value ?? "").trim();
  return v.length === 0 || v === DEFAULT_SECRET || v.length < minLen;
}

/**
 * Validates the Digital Profile env. Returns errors (critical) + warnings
 * (advisory). Never includes secret values — only variable names.
 */
export function validateDigitalProfileEnv(
  env: Env = process.env
): EnvValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const moduleEnabled = bool(env.DIGITAL_PROFILE_ENABLED);

  // DATABASE_URL is always required to run anything useful.
  if (!env.DATABASE_URL || env.DATABASE_URL.trim().length === 0) {
    errors.push("DATABASE_URL is not set.");
  }

  if (!moduleEnabled) {
    // Module off: nothing else is critical.
    return { ok: errors.length === 0, errors, warnings };
  }

  // Storage driver.
  const driver = (env.DIGITAL_PROFILE_STORAGE_DRIVER ?? "local")
    .trim()
    .toLowerCase();
  if (!KNOWN_DRIVERS.includes(driver)) {
    errors.push(
      `DIGITAL_PROFILE_STORAGE_DRIVER="${driver}" is not a known driver (expected one of: ${KNOWN_DRIVERS.join(", ")}).`
    );
  } else if (!IMPLEMENTED_DRIVERS.includes(driver)) {
    errors.push(
      `DIGITAL_PROFILE_STORAGE_DRIVER="${driver}" is not implemented yet; use "local".`
    );
  }

  // Storage root (has a default, but warn if empty string was passed).
  if (
    env.DIGITAL_PROFILE_STORAGE_ROOT != null &&
    env.DIGITAL_PROFILE_STORAGE_ROOT.trim().length === 0
  ) {
    warnings.push("DIGITAL_PROFILE_STORAGE_ROOT is empty; using the default.");
  }

  // Signed-URL secret (signing private download tokens).
  const signingSecret =
    env.DIGITAL_PROFILE_SIGNED_URL_SECRET ?? env.DIGITAL_PROFILE_SIGNING_SECRET;
  if (isWeakSecret(signingSecret)) {
    const msg =
      "DIGITAL_PROFILE_SIGNED_URL_SECRET must be a strong value (>=16 chars, not the default).";
    errors.push(msg);
  }

  // Auth + session secret.
  if (bool(env.DIGITAL_PROFILE_AUTH_ENABLED)) {
    if (isWeakSecret(env.DIGITAL_PROFILE_SESSION_SECRET)) {
      errors.push(
        "DIGITAL_PROFILE_SESSION_SECRET must be a strong value (>=16 chars, not the default) when DIGITAL_PROFILE_AUTH_ENABLED=true."
      );
    }
  } else {
    warnings.push(
      "DIGITAL_PROFILE_AUTH_ENABLED is false — the app runs without login (every actor is a synthetic SUPER_ADMIN). Enable auth for production."
    );
  }

  // Renderer URL (has a default; warn if missing in a real deploy).
  if (!env.RENDERER_URL && !env.DIGITAL_PROFILE_RENDERER_URL) {
    warnings.push(
      "RENDERER_URL is not set; defaulting to http://localhost:8080 (PPTX/PDF rendering may be unavailable)."
    );
  }

  // Provider keys — only checked when the provider is enabled.
  if (bool(env.DIGITAL_PROFILE_REAL_CONNECTORS_ENABLED)) {
    if (bool(env.DIGITAL_PROFILE_GOOGLE_ENABLED)) {
      if (!env.GOOGLE_SEARCH_API_KEY || !env.GOOGLE_SEARCH_ENGINE_ID) {
        warnings.push(
          "Google provider is enabled but GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_ENGINE_ID are missing; it will resolve to NOT_CONFIGURED."
        );
      }
    }
    if (bool(env.DIGITAL_PROFILE_YANDEX_ENABLED)) {
      if (!env.YANDEX_SEARCH_API_KEY || !env.YANDEX_SEARCH_FOLDER_ID) {
        warnings.push(
          "Yandex provider is enabled but YANDEX_SEARCH_API_KEY / YANDEX_SEARCH_FOLDER_ID are missing; it will resolve to NOT_CONFIGURED."
        );
      }
    }
  }

  // Stage N1 — official Yandex Cloud Search API v2 (independent dedicated flag).
  if (bool(env.DIGITAL_PROFILE_YANDEX_REAL_ENABLED)) {
    if (!env.YANDEX_SEARCH_API_KEY || !env.YANDEX_SEARCH_FOLDER_ID) {
      warnings.push(
        "DIGITAL_PROFILE_YANDEX_REAL_ENABLED=true but YANDEX_SEARCH_API_KEY / YANDEX_SEARCH_FOLDER_ID are missing; the real Yandex provider will resolve to NOT_CONFIGURED."
      );
    }
  }

  // Stage N2 — real Google connector (independent dedicated flag + strategy).
  if (bool(env.DIGITAL_PROFILE_GOOGLE_REAL_ENABLED)) {
    const strategy = (env.GOOGLE_SEARCH_PROVIDER ?? "").trim().toLowerCase();
    if (strategy !== "custom_search" && strategy !== "external_serp") {
      warnings.push(
        "DIGITAL_PROFILE_GOOGLE_REAL_ENABLED=true but GOOGLE_SEARCH_PROVIDER is not set to 'custom_search' or 'external_serp'; the real Google provider will resolve to DISABLED."
      );
    } else if (strategy === "custom_search") {
      if (!env.GOOGLE_SEARCH_API_KEY || !env.GOOGLE_SEARCH_ENGINE_ID) {
        warnings.push(
          "GOOGLE_SEARCH_PROVIDER=custom_search but GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_ENGINE_ID are missing; the real Google provider will resolve to NOT_CONFIGURED."
        );
      }
    } else if (strategy === "external_serp") {
      if (!env.GOOGLE_EXTERNAL_SERP_PROVIDER) {
        warnings.push(
          "GOOGLE_SEARCH_PROVIDER=external_serp but GOOGLE_EXTERNAL_SERP_PROVIDER is not selected; the real Google provider will resolve to NOT_CONFIGURED."
        );
      } else if (!env.GOOGLE_EXTERNAL_SERP_API_KEY && !env.SERPER_API_KEY) {
        warnings.push(
          "GOOGLE_EXTERNAL_SERP_PROVIDER is selected but GOOGLE_EXTERNAL_SERP_API_KEY (or SERPER_API_KEY alias) is missing; the real Google provider will resolve to NOT_CONFIGURED."
        );
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Validates and reports. In production a critical error throws (fail-fast). In
 * development problems are logged as warnings so local work is never blocked.
 * Never logs secret values.
 */
export function runEnvValidation(env: Env = process.env): void {
  const isProd = (env.NODE_ENV ?? "").toLowerCase() === "production";
  const { errors, warnings } = validateDigitalProfileEnv(env);

  for (const w of warnings) {
    console.warn(`[digital-profile][env] WARN: ${w}`);
  }

  if (errors.length === 0) return;

  if (isProd) {
    const message =
      "Invalid Digital Profile configuration:\n - " + errors.join("\n - ");
    throw new Error(message);
  }

  for (const e of errors) {
    console.warn(`[digital-profile][env] (dev) would fail in production: ${e}`);
  }
}
