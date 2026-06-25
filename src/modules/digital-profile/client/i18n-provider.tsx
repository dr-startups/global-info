"use client";

/**
 * Client-side i18n for the Digital Profile admin UI (Stage L1).
 *
 * Resolution order on first load: ?lang= query param -> localStorage -> browser
 * language -> default (ru). The chosen locale persists to localStorage and the
 * URL is left untouched. UI-only — no API/schema/renderer changes.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  enumLabel,
  formatCount,
  formatDateTime,
  formatPercent,
  getDefaultLocale,
  getDictionary,
  getLocalizedApiError,
  normalizeLocale,
  t as translate,
  templateLabel,
  type Dictionary,
  type Locale,
} from "../i18n";

const STORAGE_KEY = "digitalProfile.locale";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  dictionary: Dictionary;
  t: (key: string, params?: Record<string, string | number>) => string;
  tStatus: (value: string | null | undefined) => string;
  tRisk: (value: string | null | undefined) => string;
  tKind: (value: string | null | undefined) => string;
  tSource: (value: string | null | undefined) => string;
  tTemplate: (version: string | null | undefined) => string;
  tError: (code: string | null | undefined, fallback?: string) => string;
  fmtDate: (date: Date | string | number | null | undefined) => string;
  fmtPercent: (share: number) => string;
  fmtCount: (value: number) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function resolveInitialLocale(): Locale {
  if (typeof window === "undefined") return getDefaultLocale();
  try {
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("lang");
    if (fromQuery) return normalizeLocale(fromQuery);
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return normalizeLocale(stored);
    if (navigator.language) return normalizeLocale(navigator.language);
  } catch {
    // ignore (SSR/private mode); fall through to default
  }
  return getDefaultLocale();
}

export function DigitalProfileI18nProvider({ children }: { children: ReactNode }) {
  // Deterministic first render (default) -> adjust on mount to avoid hydration drift.
  const [locale, setLocaleState] = useState<Locale>(getDefaultLocale());

  useEffect(() => {
    setLocaleState(resolveInitialLocale());
  }, []);

  const setLocale = useCallback((next: Locale) => {
    const normalized = normalizeLocale(next);
    setLocaleState(normalized);
    try {
      window.localStorage.setItem(STORAGE_KEY, normalized);
    } catch {
      // ignore persistence failures (private mode etc.)
    }
  }, []);

  const value = useMemo<I18nContextValue>(() => {
    const dictionary = getDictionary(locale);
    return {
      locale,
      setLocale,
      dictionary,
      t: (key, params) => translate(dictionary, key, params),
      tStatus: (v) => enumLabel(locale, "status", v),
      tRisk: (v) => enumLabel(locale, "risk", v),
      tKind: (v) => enumLabel(locale, "kind", v),
      tSource: (v) => enumLabel(locale, "source", v),
      tTemplate: (v) => templateLabel(locale, v),
      tError: (code, fallback) => getLocalizedApiError(code, locale, fallback),
      fmtDate: (date) => formatDateTime(date, locale),
      fmtPercent: (share) => formatPercent(share, locale),
      fmtCount: (n) => formatCount(n, locale),
    };
  }, [locale, setLocale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useDigitalProfileI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    throw new Error(
      "useDigitalProfileI18n must be used within a DigitalProfileI18nProvider"
    );
  }
  return ctx;
}
