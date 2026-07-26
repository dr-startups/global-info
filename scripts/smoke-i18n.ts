/**
 * Smoke test for the Digital Profile Admin UI i18n core (Stage L1).
 *
 * Pure (no server, no DB, no React). Verifies dictionaries, helpers, enum/error
 * localization and date/percent formatting. Run: `npm run smoke:i18n`.
 */

import {
  LOCALES,
  enumLabel,
  formatCount,
  formatDateTime,
  formatPercent,
  getDefaultLocale,
  getDictionary,
  getLocalizedApiError,
  normalizeLocale,
  t,
  templateLabel,
  type Dictionary,
  type Locale,
} from "../src/modules/digital-profile/i18n";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Collect all leaf key paths of a dictionary object. */
function leafPaths(obj: unknown, prefix = ""): string[] {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
      leafPaths(v, prefix ? `${prefix}.${k}` : k)
    );
  }
  return [prefix];
}

console.log("i18n smoke test\n");

// 1) Default locale is ru (env unset).
console.log("default locale");
check("getDefaultLocale() === 'ru'", getDefaultLocale() === "ru");
check("LOCALES === [en, ru]", JSON.stringify(LOCALES) === JSON.stringify(["en", "ru"]));

// 2) normalizeLocale handles tags / casing / junk.
console.log("\nnormalizeLocale");
check("'ru-RU' -> ru", normalizeLocale("ru-RU") === "ru");
check("'EN' -> en", normalizeLocale("EN") === "en");
check("'fr' -> ru (default)", normalizeLocale("fr") === "ru");
check("null -> ru (default)", normalizeLocale(null) === "ru");

// 3) Both dictionaries expose the exact same key set.
console.log("\ndictionary parity");
const en = getDictionary("en");
const ru = getDictionary("ru");
const enKeys = new Set(leafPaths(en));
const ruKeys = new Set(leafPaths(ru));
const missingInRu = [...enKeys].filter((k) => !ruKeys.has(k));
const missingInEn = [...ruKeys].filter((k) => !enKeys.has(k));
check("ru has all en keys", missingInRu.length === 0, missingInRu.join(", "));
check("en has all ru keys", missingInEn.length === 0, missingInEn.join(", "));

// Every leaf is a non-empty string in both locales.
function allNonEmpty(d: Dictionary): boolean {
  return leafPaths(d).every((p) => {
    const v = p.split(".").reduce<unknown>((a, part) => (a as Record<string, unknown>)?.[part], d);
    return typeof v === "string" && v.length > 0;
  });
}
check("en: all values non-empty strings", allNonEmpty(en));
check("ru: all values non-empty strings", allNonEmpty(ru));

// 4) t() resolves nested keys, interpolates params, falls back to key.
console.log("\nt() lookup");
check("t(page.title) resolves", t(ru, "page.title").length > 0);
check(
  "t(unified.goldenDone, params) interpolates",
  t(en, "unified.goldenDone", { pages: 50 }).includes("50") &&
    !t(en, "unified.goldenDone", { pages: 50 }).includes("{pages}")
);
check("missing key returns the key itself", t(ru, "does.not.exist") === "does.not.exist");

// 5) Error code localization (no stack traces).
console.log("\nerror localization");
check(
  "MODULE_DISABLED (ru) localized",
  getLocalizedApiError("MODULE_DISABLED", "ru").includes("Digital Profile")
);
check(
  "RENDERER_UNAVAILABLE (en) localized",
  getLocalizedApiError("RENDERER_UNAVAILABLE", "en").toLowerCase().includes("renderer")
);
check(
  "unknown code (ru) falls back to UNKNOWN",
  getLocalizedApiError("WAT", "ru") === ru.errors.UNKNOWN
);

// 6) Enum + template labels.
console.log("\nenum / template labels");
check("status DRAFT (ru) === Черновик", enumLabel("ru", "status", "DRAFT") === "Черновик");
check("status DRAFT (en) === Draft", enumLabel("en", "status", "DRAFT") === "Draft");
check("risk HIGH (ru) === Высокий", enumLabel("ru", "risk", "HIGH") === "Высокий");
check(
  "unknown enum value humanized",
  enumLabel("en", "status", "SOME_NEW_VALUE") === "SOME NEW VALUE"
);
check(
  "template report-template-v3 (ru) localized",
  templateLabel("ru", "report-template-v3").includes("v3")
);
check(
  "unknown template falls back to value",
  templateLabel("en", "report-template-v9") === "report-template-v9"
);

// 7) Date / percent / count formatting.
console.log("\nformatting");
const sample = new Date("2026-06-25T17:03:05Z");
const ruDate = formatDateTime(sample, "ru");
const enDate = formatDateTime(sample, "en");
check("ru date contains 2026", ruDate.includes("2026"), ruDate);
check("en date contains 2026", enDate.includes("2026"), enDate);
check("invalid date -> —", formatDateTime("not-a-date", "en") === "—");
check("percent ru has space (29 %)", formatPercent(0.29, "ru") === "29 %", formatPercent(0.29, "ru"));
check("percent en no space (29%)", formatPercent(0.29, "en") === "29%", formatPercent(0.29, "en"));
check("formatCount produces a string", typeof formatCount(12345, "ru") === "string");

// 8) Locales array round-trips.
console.log("\nlocale round-trip");
for (const l of LOCALES as Locale[]) {
  check(`getDictionary(${l}) is defined`, !!getDictionary(l));
}

console.log("");
if (failures > 0) {
  console.error(`i18n smoke FAILED: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("i18n smoke PASSED ✅");
