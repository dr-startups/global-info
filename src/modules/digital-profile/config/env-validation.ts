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

import { offlineEnrichmentEnvWarning } from "./offline-enrichment-guard";

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

/** Готовность одного сборщика и, если он выключен, чего именно не хватает. */
export interface CapabilityReadiness {
  capability: string;
  ready: boolean;
  /** Только имена переменных, никогда значения. */
  detail: string;
}

/**
 * Готовность сборщиков по конфигурации.
 *
 * Появилось после того, как на стенде молча отключились Google и ORION.
 * Настоящая причина каждый раз одна и та же: включение сборщика собрано из
 * цепочки переменных, и пропуск любого звена превращает агента в
 * `NOT_CONFIGURED` — тихо, потому что для самого агента это законный исход.
 * Пропущенное звено легко не заметить: у ORION их пять.
 *
 * Здесь цепочки записаны данными и один раз, а не пересказываются в переписке.
 * Сводка печатается на старте, поэтому вопрос «почему агент выключен»
 * закрывается логом запуска.
 */
export function describeCapabilityReadiness(env: Env = process.env): CapabilityReadiness[] {
  const out: CapabilityReadiness[] = [];
  const has = (name: string) => Boolean((env[name] ?? "").trim());
  const missing = (...names: string[]) => names.filter((n) => !has(n));

  // Arsenkin. До сих пор эта проверка отсутствовала вовсе — при том что
  // интеграция платная и без неё отчёт теряет пять поверхностей.
  const arsenkinOn = bool(env.ARSENKIN_ENABLED);
  out.push({
    capability: "Arsenkin (5 агентов обогащения)",
    ready: arsenkinOn && has("ARSENKIN_API_TOKEN"),
    detail: !arsenkinOn
      ? "ARSENKIN_ENABLED не равен true"
      : has("ARSENKIN_API_TOKEN")
        ? "готов"
        : "нет ARSENKIN_API_TOKEN",
  });

  // Google/ORION через внешний SERP. Ключ читается из
  // GOOGLE_EXTERNAL_SERP_API_KEY либо из псевдонима SERPER_API_KEY.
  const serpProvider = (env.GOOGLE_EXTERNAL_SERP_PROVIDER ?? "").trim().toLowerCase();
  const serpKey = has("GOOGLE_EXTERNAL_SERP_API_KEY") || has("SERPER_API_KEY");
  const serpReady = serpProvider === "serper" && serpKey;
  out.push({
    capability: "ORION Search Profile (поверхности Google)",
    ready: serpReady,
    detail: serpReady
      ? "готов"
      : serpProvider !== "serper"
        ? 'GOOGLE_EXTERNAL_SERP_PROVIDER должен быть "serper"'
        : "нет GOOGLE_EXTERNAL_SERP_API_KEY (или псевдонима SERPER_API_KEY)",
  });

  const googleStrategy = (env.GOOGLE_SEARCH_PROVIDER ?? "").trim().toLowerCase();
  const googleReady =
    bool(env.DIGITAL_PROFILE_GOOGLE_REAL_ENABLED) &&
    (googleStrategy === "external_serp"
      ? serpReady
      : googleStrategy === "custom_search" &&
        missing("GOOGLE_SEARCH_API_KEY", "GOOGLE_SEARCH_ENGINE_ID").length === 0);
  out.push({
    capability: "Google Search (настоящий коннектор)",
    ready: googleReady,
    detail: googleReady
      ? "готов"
      : !bool(env.DIGITAL_PROFILE_GOOGLE_REAL_ENABLED)
        ? "DIGITAL_PROFILE_GOOGLE_REAL_ENABLED не равен true"
        : googleStrategy !== "external_serp" && googleStrategy !== "custom_search"
          ? 'GOOGLE_SEARCH_PROVIDER должен быть "external_serp" или "custom_search"'
          : googleStrategy === "custom_search"
            ? `нет ${missing("GOOGLE_SEARCH_API_KEY", "GOOGLE_SEARCH_ENGINE_ID").join(", ")}`
            : "внешний SERP не настроен (см. строку ORION)",
  });

  const yandexReady =
    bool(env.DIGITAL_PROFILE_YANDEX_REAL_ENABLED) &&
    missing("YANDEX_SEARCH_API_KEY", "YANDEX_SEARCH_FOLDER_ID").length === 0;
  out.push({
    capability: "Yandex Search (Cloud Search API v2)",
    ready: yandexReady,
    detail: yandexReady
      ? "готов"
      : !bool(env.DIGITAL_PROFILE_YANDEX_REAL_ENABLED)
        ? "DIGITAL_PROFILE_YANDEX_REAL_ENABLED не равен true"
        : `нет ${missing("YANDEX_SEARCH_API_KEY", "YANDEX_SEARCH_FOLDER_ID").join(", ")}`,
  });

  const aiReady = bool(env.DIGITAL_PROFILE_AI_ANALYST_ENABLED) && has("OPENAI_API_KEY");
  out.push({
    capability: "AI-аналитик (текст отчёта)",
    ready: aiReady,
    detail: aiReady
      ? "готов"
      : !bool(env.DIGITAL_PROFILE_AI_ANALYST_ENABLED)
        ? "DIGITAL_PROFILE_AI_ANALYST_ENABLED не равен true"
        : "нет OPENAI_API_KEY",
  });

  const rendererReady = has("RENDERER_URL") || has("DIGITAL_PROFILE_RENDERER_URL");
  out.push({
    capability: "Отрисовка PPTX/PDF",
    ready: rendererReady,
    detail: rendererReady ? "готов" : "нет RENDERER_URL",
  });

  return out;
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

  // Stage R8.3 / REMEDIATION §4.1 — AI analyst narrative config.
  const aiEnabled = bool(env.DIGITAL_PROFILE_AI_ANALYST_ENABLED);
  const isProd = (env.NODE_ENV ?? "").toLowerCase() === "production";
  if (!aiEnabled && isProd) {
    warnings.push(
      "DIGITAL_PROFILE_AI_ANALYST_ENABLED is false in production — клиентские отчёты будут детерминированными."
    );
  }
  if (aiEnabled) {
    const provider = (env.DIGITAL_PROFILE_AI_ANALYST_PROVIDER ?? "openai").trim().toLowerCase();
    if (provider !== "openai") {
      warnings.push(
        "DIGITAL_PROFILE_AI_ANALYST_PROVIDER is not 'openai'; deterministic fallback will be used."
      );
    }
    if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY.trim().length === 0) {
      warnings.push(
        "DIGITAL_PROFILE_AI_ANALYST_ENABLED=true but OPENAI_API_KEY is missing; deterministic fallback will be used."
      );
    }
  }

  // Strict canonical gate: require AI report layer (default off).
  if (bool(env.DIGITAL_PROFILE_REQUIRE_AI_REPORT)) {
    if (!aiEnabled) {
      const msg =
        "DIGITAL_PROFILE_REQUIRE_AI_REPORT=true but DIGITAL_PROFILE_AI_ANALYST_ENABLED is false.";
      if (isProd) errors.push(msg);
      else warnings.push(msg);
    } else if (!env.OPENAI_API_KEY || env.OPENAI_API_KEY.trim().length === 0) {
      const msg =
        "DIGITAL_PROFILE_REQUIRE_AI_REPORT=true but OPENAI_API_KEY is missing.";
      if (isProd) errors.push(msg);
      else warnings.push(msg);
    }
  }

  // Arsenkin: интеграция платная, и до сих пор её здесь не проверяли вовсе.
  // Включённый флаг без токена — самый дорогой из тихих отказов: прогон дойдёт
  // до обогащения и там встанет.
  if (bool(env.ARSENKIN_ENABLED) && !env.ARSENKIN_API_TOKEN?.trim()) {
    errors.push("ARSENKIN_ENABLED=true, но ARSENKIN_API_TOKEN не задан.");
  }
  if (!bool(env.ARSENKIN_ENABLED)) {
    warnings.push(
      "ARSENKIN_ENABLED не равен true — пять агентов обогащения Arsenkin выключены, отчёт соберётся без их поверхностей."
    );
  }

  // REMEDIATION §8.2 — silent offline enrichment in deploy-like envs.
  const offlineWarn = offlineEnrichmentEnvWarning(env);
  if (offlineWarn) warnings.push(offlineWarn);

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

  // Сводка готовности — первым делом. Выключенный сборщик виден сразу и с
  // указанием недостающей переменной, а не через прогон, который вернул
  // неполный отчёт.
  for (const c of describeCapabilityReadiness(env)) {
    console.warn(
      `[digital-profile][env] ${c.ready ? "ГОТОВ  " : "ВЫКЛ   "} ${c.capability} — ${c.detail}`
    );
  }

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
