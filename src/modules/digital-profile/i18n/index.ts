/**
 * i18n core for the Digital Profile admin UI (Stage L1).
 *
 * Pure, framework-agnostic helpers. The React layer (i18n-provider) wraps these.
 * Missing keys never throw — they fall back to the key (so the UI never breaks).
 */

import type { Dictionary, Locale } from "./types";
import { LOCALES } from "./types";
import { en } from "./dictionaries/en";
import { ru } from "./dictionaries/ru";

export type { Dictionary, Locale } from "./types";
export { LOCALES } from "./types";

const DICTIONARIES: Record<Locale, Dictionary> = { en, ru };

const LOCALE_TAG: Record<Locale, string> = { en: "en-US", ru: "ru-RU" };

/** Coerces an arbitrary value (e.g. "ru-RU", "EN", null) to a supported Locale. */
export function normalizeLocale(value: unknown): Locale {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase().slice(0, 2);
    if ((LOCALES as string[]).includes(v)) return v as Locale;
  }
  return getDefaultLocale();
}

/** Default locale: DIGITAL_PROFILE_DEFAULT_LOCALE env, else "ru". */
export function getDefaultLocale(): Locale {
  const raw = process.env.DIGITAL_PROFILE_DEFAULT_LOCALE?.trim().toLowerCase().slice(0, 2);
  if (raw && (LOCALES as string[]).includes(raw)) return raw as Locale;
  return "ru";
}

export function getDictionary(locale: Locale): Dictionary {
  return DICTIONARIES[locale] ?? DICTIONARIES[getDefaultLocale()];
}

function resolvePath(dict: Dictionary, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, dict);
}

/**
 * Translate a dot-path key against a dictionary, with {param} interpolation.
 * Falls back to the key itself when missing — never throws.
 */
export function t(
  dictionary: Dictionary,
  key: string,
  params?: Record<string, string | number>
): string {
  const value = resolvePath(dictionary, key);
  let text = typeof value === "string" ? value : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return text;
}

export function formatDateTime(date: Date | string | number | null | undefined, locale: Locale): string {
  if (date == null) return "—";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  // ru -> 25.06.2026, 20:03:05 ; en -> Jun 25, 2026, 8:03 PM
  const options: Intl.DateTimeFormatOptions =
    locale === "ru"
      ? { dateStyle: "short", timeStyle: "medium" }
      : { dateStyle: "medium", timeStyle: "short" };
  try {
    return new Intl.DateTimeFormat(LOCALE_TAG[locale], options).format(d);
  } catch {
    return d.toLocaleString();
  }
}

/** value is a share in [0..1]. ru -> "29 %", en -> "29%". */
export function formatPercent(value: number, locale: Locale): string {
  const pct = Math.round((Number.isFinite(value) ? value : 0) * 100);
  return locale === "ru" ? `${pct} %` : `${pct}%`;
}

export function formatCount(value: number, locale: Locale): string {
  try {
    return new Intl.NumberFormat(LOCALE_TAG[locale]).format(value);
  } catch {
    return String(value);
  }
}

/** Localized message for an API error code (never leaks stack traces). */
export function getLocalizedApiError(
  errorCode: string | null | undefined,
  locale: Locale,
  fallback?: string
): string {
  const dict = getDictionary(locale);
  const code = (errorCode ?? "UNKNOWN") as keyof Dictionary["errors"];
  const message = dict.errors[code];
  if (message) return message;
  return fallback ?? dict.errors.UNKNOWN;
}

type EnumGroup = keyof Dictionary["enums"];

/** Localized label for an enum value; falls back to a humanized value. */
export function enumLabel(
  locale: Locale,
  group: EnumGroup,
  value: string | null | undefined
): string {
  if (!value) return "—";
  const dict = getDictionary(locale);
  return dict.enums[group][value] ?? value.replace(/_/g, " ");
}

/** Localized label for a report template version (value itself never changes). */
export function templateLabel(locale: Locale, version: string | null | undefined): string {
  if (!version) return "—";
  const dict = getDictionary(locale);
  return dict.templates[version] ?? version;
}
