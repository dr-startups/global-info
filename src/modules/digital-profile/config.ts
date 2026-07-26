/**
 * Configuration and feature flag for the Digital Profile Audit module.
 *
 * The module is fully isolated behind `DIGITAL_PROFILE_ENABLED`. When disabled,
 * routes/services/UI must short-circuit (see `isDigitalProfileEnabled`).
 */

import type { ReportPriceItem } from "./types";
import type { StorageDriver } from "./storage/types";

import { boolSetting } from "./config/defaults";

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
  /**
   * Ручной запуск отдельного агента — режим отладки (шаг 11.2, пункт 2).
   *
   * Агенты не самостоятельные кнопки, а внутренние шаги одного оркеструемого
   * прогона. Перечисление их панелью запуска и породило привычку «дожимать»
   * отчёт руками: заказчик жал повтор по нескольку раз, пока сбор не двигался.
   * Наблюдение (статусы, диагностика, история) остаётся всегда; управление
   * включается явно.
   */
  manualAgentRun: boolean;
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
  /**
   * REMEDIATION §8.1 — карточка подготовки ORION Golden на странице кейса.
   * Выключен по умолчанию; основной путь — unified-сбор, панель качества и
   * восстановление/пересборка. Кнопки легаси-отчёта отсюда убраны вместе с
   * самим контуром (шаг 13, B6): он отставлен на сервере и отвечал 410.
   */
  legacyReportUiEnabled: boolean;
  /**
   * REMEDIATION §4.1 — when true, unified REPORT_READY is blocked unless the
   * canonical GPT layer applied at least one fragment (or stage-1 analysis).
   * Off by default.
   */
  requireAiReport: boolean;
  /** R10 — ORION Golden 3-layer agent architecture (parallel to R9 storyboard). */
  orionGoldenEnabled: boolean;
  orionGptAutoAnalyst: boolean;
  /** REMEDIATION §2.4 — LLM disambiguation of AMBIGUOUS (ORION_GPT_IDENTITY=1). */
  orionGptIdentity: boolean;
  /** REMEDIATION §3.3 — LLM theme suggestions for uncategorized (ORION_GPT_THEMES=1). */
  orionGptThemes: boolean;
}

function envLocale(value: string | undefined): "ru" | "en" {
  const v = value?.trim().toLowerCase().slice(0, 2);
  return v === "en" ? "en" : "ru";
}

/** Работаем ли мы на Railway (площадка выставляет это сама). */
const ON_RAILWAY = Boolean(process.env.RAILWAY_ENVIRONMENT?.trim());

/**
 * Где лежат артефакты.
 *
 * Путь зависит от площадки, а не от секрета, поэтому переменная не нужна: на
 * Railway том монтируется в `/data`, локально артефакты лежат в рабочей копии.
 * Переопределение оставлено на случай другой раскладки тома.
 */
const STORAGE_ROOT =
  process.env.DIGITAL_PROFILE_STORAGE_ROOT ??
  process.env.DIGITAL_PROFILE_STORAGE_DIR ??
  (ON_RAILWAY ? "/data/digital-profile" : "./storage/digital-profile");

// One canonical signed-URL TTL governs all private download links.
const SIGNED_URL_TTL_SECONDS = Number(
  process.env.DIGITAL_PROFILE_STORAGE_SIGNED_URL_TTL_SECONDS ??
    process.env.DIGITAL_PROFILE_SIGNED_URL_TTL ??
    900
);

export const digitalProfileConfig: DigitalProfileConfig = {
  enabled: boolSetting("DIGITAL_PROFILE_ENABLED"),
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
  // Демо-агенты выключены: рабочий продукт собирает отчёт настоящими
  // источниками. Офлайн-контур и смоки включают их сами, явной переменной.
  mockAgents: boolSetting("DIGITAL_PROFILE_MOCK_AGENTS"),
  // По умолчанию выключен вне mock-режима: на реальном кейсе ручной запуск
  // отдельного агента — отладка, а не рабочий ход. В mock-режиме оставлен,
  // чтобы офлайн-контур и смоки продолжали работать без переменных окружения.
  manualAgentRun: envBool(
    process.env.DIGITAL_PROFILE_MANUAL_AGENT_RUN,
    boolSetting("DIGITAL_PROFILE_MOCK_AGENTS")
  ),
  // Canonical: RENDERER_URL. DIGITAL_PROFILE_RENDERER_URL is accepted as an alias.
  //
  // Адрес зависит от площадки, а не от секрета: на Railway сервисы видят друг
  // друга по внутреннему имени, локально рендерер поднят рядом.
  rendererUrl:
    process.env.RENDERER_URL ??
    process.env.DIGITAL_PROFILE_RENDERER_URL ??
    (ON_RAILWAY ? "http://renderer.railway.internal:8080" : "http://localhost:8080"),
  reportTemplateVersion:
    process.env.DIGITAL_PROFILE_REPORT_TEMPLATE_VERSION ?? "report-template-v3",
  defaultLocale: envLocale(process.env.DIGITAL_PROFILE_DEFAULT_LOCALE),
  aiAnalyst: {
    // Включён: без него клиентский текст вырождается в детерминированный
    // шаблон. Без OPENAI_API_KEY слой сам отступает к шаблону, поэтому
    // «включено по умолчанию» ничего не ломает и ничего не тратит.
    enabled: boolSetting("DIGITAL_PROFILE_AI_ANALYST_ENABLED"),
    provider:
      (process.env.DIGITAL_PROFILE_AI_ANALYST_PROVIDER ?? "openai").trim().toLowerCase() === "openai"
        ? "openai"
        : "openai",
    model: process.env.DIGITAL_PROFILE_AI_ANALYST_MODEL?.trim() || "gpt-5.5",
    timeoutMs: envInt(process.env.DIGITAL_PROFILE_AI_ANALYST_TIMEOUT_MS, 60000, 1000, 180000),
    maxInputItems: envInt(process.env.DIGITAL_PROFILE_AI_ANALYST_MAX_INPUT_ITEMS, 120, 20, 500),
    // REMEDIATION §4.5 — stage-1 default 12000 (was 8000). Reasoning models spend
    // part of the budget on reasoning tokens; truncation triggers one adaptive retry.
    maxOutputTokens: envInt(
      process.env.DIGITAL_PROFILE_AI_ANALYST_MAX_OUTPUT_TOKENS,
      12000,
      200,
      32000
    ),
    openAiApiKey: process.env.OPENAI_API_KEY?.trim() || undefined,
  },
  legacyReportUiEnabled: envBool(process.env.DIGITAL_PROFILE_LEGACY_REPORT_UI, false),
  // Canonical REPORT_READY AI gate (off by default — opt-in strictness).
  requireAiReport: envBool(process.env.DIGITAL_PROFILE_REQUIRE_AI_REPORT, false),
  // Это и есть текущий формат отчёта — он нужен и в проде.
  orionGoldenEnabled: boolSetting("DIGITAL_PROFILE_ORION_GOLDEN_ENABLED"),
  // Разбирает очередь ручной проверки сам. Выключенным он оставляет работу
  // человеку — ровно то, чего в продукте быть не должно.
  orionGptAutoAnalyst: boolSetting("ORION_GPT_AUTO_ANALYST"),
  /** Optional §2.4 — LLM AMBIGUOUS disambiguation (default off; never on Railway by default). */
  orionGptIdentity: envBool(process.env.ORION_GPT_IDENTITY, false),
  /** Optional §3.3 — LLM theme suggestion for uncategorized (default off). */
  orionGptThemes: envBool(process.env.ORION_GPT_THEMES, false),
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
