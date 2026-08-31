/**
 * Stage C1 — compliance provider configuration (no secrets in exports).
 */

import { boolSetting } from "../config/defaults";
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

/**
 * Адрес облачного сервиса OpenSanctions.
 *
 * Он же умолчание и он же признак «работаем с чужим облаком»: ключ обязателен
 * ровно тогда, когда запрос уходит сюда. Значение объявлено один раз — иначе
 * условие «адрес равен умолчанию» и само умолчание разойдутся, и требование
 * ключа тихо перестанет срабатывать.
 */
export const OPEN_SANCTIONS_CLOUD_API_BASE_URL = "https://api.opensanctions.org";

export const complianceProviderConfig = {
  realEnabled: envBool(process.env.DIGITAL_PROFILE_COMPLIANCE_REAL_ENABLED, false),
  /**
   * OpenSanctions — открытый агрегатор санкционных списков, PEP и розыска
   * (шаг 04.3). Ключ нужен облачному сервису и обязателен ровно там;
   * самостоятельно поднятый `yente` работает без него.
   *
   * Умолчание переключателя записано вместе с остальными — в
   * `config/defaults.ts`, и читается общим разбором: локальный `envBool` читал
   * непонятое значение как «выключено», то есть опечатка молча убирала раздел
   * комплаенса из отчёта.
   */
  openSanctions: {
    enabled: boolSetting("OPEN_SANCTIONS_ENABLED"),
    apiBaseUrl: envStr(process.env.OPEN_SANCTIONS_API_BASE_URL) ?? OPEN_SANCTIONS_CLOUD_API_BASE_URL,
    webBaseUrl: envStr(process.env.OPEN_SANCTIONS_WEB_BASE_URL) ?? "https://www.opensanctions.org",
    apiKey: envStr(process.env.OPEN_SANCTIONS_API_KEY),
    dataset: envStr(process.env.OPEN_SANCTIONS_DATASET) ?? "default",
    /** Ниже этого счёта совпадение аналитику не показывается. */
    minScore: Math.min(
      1,
      Math.max(0, Number(envStr(process.env.OPEN_SANCTIONS_MIN_SCORE) ?? "0.7"))
    ),
    timeoutMs: envInt(process.env.OPEN_SANCTIONS_TIMEOUT_MS, 20_000, 1000, 120_000),
  },
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
  OPEN_SANCTIONS: "OpenSanctions",
  DOW_JONES: "Dow Jones Compliance Real",
  LEXISNEXIS: "LexisNexis Compliance Real",
  WORLD_CHECK: "World-Check Real",
  MANUAL_IMPORT: "Manual Compliance Import",
};

const NOTES: Record<ComplianceProviderName, string> = {
  OPEN_SANCTIONS:
    "Открытый агрегатор санкционных перечней, списков PEP и розыска. Не заменяет глубину LexisNexis по судебным и медийным записям: отсутствие совпадения означает «не найден в санкционных перечнях и списках PEP», а не «проверен всюду». Совпадения всегда требуют сверки аналитиком.",
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
  if (name === "OPEN_SANCTIONS") {
    /*
     * Разрешение — ключ, а не флаг, но только для облака.
     *
     * Самостоятельно поднятый `yente` отвечает по своему адресу анонимно, и
     * требовать ключ безусловно значило бы объявить ненастроенным работающий
     * экземпляр. А вот запрос в чужое облако без ключа не «вернёт понятную
     * ошибку», как здесь считалось: на прогоне 91 он унёс туда ФИО, дату
     * рождения и гражданство живого человека и получил 401. Ключ обязателен
     * ровно тогда, когда адрес равен облачному умолчанию.
     */
    const c = complianceProviderConfig.openSanctions;
    if (!c.apiBaseUrl) return ["OPEN_SANCTIONS_API_BASE_URL"];
    if (c.apiBaseUrl === OPEN_SANCTIONS_CLOUD_API_BASE_URL && !c.apiKey) {
      return ["OPEN_SANCTIONS_API_KEY"];
    }
    return [];
  }
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
  // Единственный источник, не требующий контракта, поэтому и общим рубильником
  // платных подписок он не выключается.
  if (name === "OPEN_SANCTIONS") return complianceProviderConfig.openSanctions.enabled;
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

/**
 * Все провайдеры — исчерпывающим перечнем, выведенным из карты названий.
 *
 * Здесь стоял литеральный список с приведением `as ComplianceProviderName[]`, и
 * приведение молчало ровно там, где нужен голос: новый провайдер в типе
 * компилятор требует дописать в `LABELS` и `NOTES` (это `Record` по объединению),
 * а в список — нет. Провайдер, забытый в списке, не появился бы ни в кабинете,
 * ни в проверках, которые считают базы по этому перечню.
 */
export const COMPLIANCE_PROVIDER_NAMES = Object.keys(LABELS) as ComplianceProviderName[];

export function listComplianceProviderStatus(): ComplianceProviderStatus[] {
  return COMPLIANCE_PROVIDER_NAMES.map(getComplianceProviderStatus);
}
