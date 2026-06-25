"use client";

import { LOCALES, type Locale } from "../i18n";
import { useDigitalProfileI18n } from "./i18n-provider";

/** RU / EN segmented control. Switches the admin UI language without reloading. */
export function LanguageToggle() {
  const { locale, setLocale, dictionary } = useDigitalProfileI18n();
  return (
    <div className="dp-inline" role="group" aria-label={dictionary.language.label}>
      {LOCALES.map((l: Locale) => (
        <button
          key={l}
          type="button"
          className={`dp-btn dp-btn-sm ${locale === l ? "dp-btn-primary" : ""}`}
          aria-pressed={locale === l}
          onClick={() => setLocale(l)}
        >
          {dictionary.language[l]}
        </button>
      ))}
    </div>
  );
}
