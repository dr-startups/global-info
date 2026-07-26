/**
 * Stage 2 — universal evidence-driven theme classification.
 * No subject names / case plots in runtime keywords.
 */

import type { CanonicalThemeId } from "../contracts/canonical-claim";
import { CANONICAL_THEME_IDS } from "../contracts/canonical-claim";

export type CanonicalThemeDef = {
  themeId: CanonicalThemeId;
  labelRu: string;
  /** Severity weight for materiality (0–1). */
  severityWeight: number;
  keywords: RegExp;
  /** Maps legacy finding-themes themeId → this canonical id. */
  legacyThemeIds: string[];
};

/**
 * Word-boundary fragments for any script.
 *
 * JS `\b` is ASCII-only: around Cyrillic it silently matches nothing, so a bare
 * root matches any substring that contains it. That is how «судьба» used to be
 * classified as a criminal/judicial material, «политехнический» as political
 * exposure and «администрация» as a ministry mention. Every root below that is
 * also a prefix (or infix) of unrelated words is wrapped in these.
 */
const B = "(?:^|[^\\p{L}\\p{N}])";
const E = "(?=[^\\p{L}\\p{N}]|$)";

/** Builds a case-insensitive Unicode alternation from readable pattern parts. */
function themeKeywords(parts: readonly string[]): RegExp {
  return new RegExp(parts.join("|"), "iu");
}

/**
 * Universal taxonomy. Keywords are language/pattern based — never subject-specific.
 */
export const CANONICAL_THEME_DEFS: CanonicalThemeDef[] = [
  {
    themeId: "criminal_judicial",
    labelRu: "Криминальные и судебные материалы",
    severityWeight: 1,
    keywords: themeKeywords([
      "уголовн",
      "criminal",
      `${B}арест`,
      "\\barrest",
      "обыск",
      "розыск",
      "прокурор",
      "прокуратур",
      // «следствие» only in the investigative sense — not «вследствие» / «как следствие».
      "(?<!как\\s)(?<!в)следственн",
      "(?<!как\\s)(?<!в)следстви",
      "sledstvie",
      "rucriminal",
      "компромат",
      // «суд» only in judicial forms: «судебный», standalone «суд/суда/суде/суду»,
      // «приговор», «осудить», «подсудимый». Never a prefix of «судьба»/«судостроение».
      "судебн",
      `${B}суд[аеу]?${E}`,
      "приговор",
      "осуди",
      "осужд",
      "подсудим",
      "\\bcourts?\\b",
      "\\bcourtroom\\b",
      "\\blitigation\\b",
      "\\blitigant\\b",
      "\\bcontempt of court\\b",
      "тюрем",
      "\\bprison\\b",
      "\\bfraud\\b",
      "мошенн",
    ]),
    legacyThemeIds: ["criminal_legal"],
  },
  {
    themeId: "corruption_integrity",
    labelRu: "Коррупционные и этические риски",
    severityWeight: 1,
    keywords: themeKeywords([
      "коррупц",
      "corrupt",
      "взятк",
      "\\bbribe",
      `${B}откат${E}`,
      "kickback",
      `${B}фбк${E}`,
      `${B}fbk${E}`,
      "незаконн\\w*\\s+обогащ",
      "conflict of interest",
      "конфликт интересов",
      "неформальн\\w*\\s+влиян",
      "этическ",
    ]),
    legacyThemeIds: [],
  },
  {
    themeId: "sanctions_pep_rca_compliance",
    labelRu: "Санкции, PEP, RCA и compliance-сигналы",
    severityWeight: 0.95,
    keywords: themeKeywords([
      "\\bpep\\b",
      "\\brca\\b",
      "watch.?list",
      "санкц",
      "sanction",
      "world.?check",
      "dow.?jones",
      "\\blexis",
      "rupep",
      "\\bofac\\b",
      "\\btreasury\\b",
      "комплаенс",
      "compliance",
    ]),
    legacyThemeIds: ["pep_rca_watchlist"],
  },
  {
    themeId: "political_public_exposure",
    labelRu: "Политические связи и публичная экспозиция",
    severityWeight: 0.85,
    keywords: themeKeywords([
      // «полити», not «полит» — the latter also matches «политехнический».
      "полити",
      "политбюро",
      "\\bpolitic",
      "депутат",
      // Elections only: «парти» alone matched «партия товара».
      "партийн",
      "предвыборн",
      "избирател",
      `${B}выбор(?:ы|ах|ам|ами|ов)${E}`,
      "electoral",
      // «минист» is an infix of «администрация» — require a word start.
      `${B}минист`,
      "правительств",
      "\\bgovernment\\b",
      "парламент",
      "\\bparliament",
      "\\bputin\\b",
      "кремл",
      "\\bkremlin\\b",
    ]),
    legacyThemeIds: ["political_exposure"],
  },
  {
    themeId: "business_ownership_associates",
    labelRu: "Деловые связи, владение и контрагенты",
    severityWeight: 0.55,
    keywords: themeKeywords([
      "бизнесмен",
      "businessman",
      "предпринимател",
      "инвестор",
      "investor",
      "соучредител",
      "co-?founder",
      "партнер",
      "партнёр",
      "\\bassociate",
      "владел",
      "ownership",
      "бенефициар",
      "beneficia",
    ]),
    legacyThemeIds: ["business_profile", "family_associates"],
  },
  {
    themeId: "offshore_financial_transparency",
    labelRu: "Офшоры и финансовая прозрачность",
    severityWeight: 0.8,
    keywords: themeKeywords([
      "офшор",
      "оффшор",
      "offshore",
      `${B}кипр`,
      "\\bcyprus\\b",
      "\\bbvi\\b",
      `${B}панам`,
      "\\bpanama\\b",
      "opencorporates",
      "источник\\w*\\s+средств",
      "source of funds",
      "\\byacht",
      `${B}яхт`,
    ]),
    legacyThemeIds: ["offshore_corporate"],
  },
  {
    themeId: "regulatory",
    labelRu: "Регуляторные расследования и ограничения",
    severityWeight: 0.85,
    keywords: themeKeywords([
      "регулятор",
      "regulator",
      "лиценз",
      "licence",
      "license",
      "надзор",
      `${B}фсб${E}`,
      `${B}fsb${E}`,
      "national security",
      "оборонн",
      "defen[cs]e ministry",
      "спецслужб",
      "security service",
    ]),
    legacyThemeIds: ["security_scrutiny"],
  },
  {
    themeId: "reputational_scandal",
    labelRu: "Репутационные скандалы и негативные сюжеты",
    severityWeight: 0.75,
    keywords: themeKeywords([
      "скандал",
      "scandal",
      "компромат",
      "разоблач",
      "\\bleak(?:s|ed|ing)?\\b",
      "расследован\\w*\\s+журналист",
      "журналистск\\w*\\s+расследован",
    ]),
    legacyThemeIds: [],
  },
  {
    themeId: "family_personal_risk_relevant",
    labelRu: "Семейные и личные связи (риск-релевантные)",
    severityWeight: 0.45,
    keywords: themeKeywords([
      // «жена» is an infix of «снижена»; «сын»/«дети» need boundaries too.
      `${B}жена${E}`,
      `${B}жены${E}`,
      `${B}жене${E}`,
      "супруг",
      "\\bspouse",
      `${B}дети${E}`,
      `${B}детей${E}`,
      `${B}сын${E}`,
      `${B}сына${E}`,
      `${B}дочь${E}`,
      `${B}дочери${E}`,
      `${B}семья${E}`,
      `${B}семьи${E}`,
      "\\bfamily\\b",
      "\\bchildren\\b",
    ]),
    legacyThemeIds: ["family_associates"],
  },
  {
    themeId: "identity_mismatch",
    labelRu: "Ошибочная идентификация и однофамильцы",
    severityWeight: 0.3,
    keywords: themeKeywords([
      "однофамил",
      "namesake",
      "другой\\s+субъект",
      "wrong subject",
      "other subject",
      "путаниц",
      "misidentif",
    ]),
    legacyThemeIds: [],
  },
];

const LEGACY_TO_CANONICAL = new Map<string, CanonicalThemeId>();
for (const def of CANONICAL_THEME_DEFS) {
  for (const legacy of def.legacyThemeIds) {
    if (!LEGACY_TO_CANONICAL.has(legacy)) LEGACY_TO_CANONICAL.set(legacy, def.themeId);
  }
}

export function isCanonicalThemeId(value: string): value is CanonicalThemeId {
  return (CANONICAL_THEME_IDS as readonly string[]).includes(value);
}

export function mapLegacyThemeId(legacyThemeId: string): CanonicalThemeId | null {
  return LEGACY_TO_CANONICAL.get(legacyThemeId) ?? null;
}

/** Classify evidence text into zero or more canonical themes (multi-label). */
export function classifyCanonicalThemes(text: string): CanonicalThemeId[] {
  const blob = String(text ?? "");
  if (!blob.trim()) return [];
  const hits: CanonicalThemeId[] = [];
  for (const def of CANONICAL_THEME_DEFS) {
    if (def.keywords.test(blob)) hits.push(def.themeId);
  }
  return hits;
}

export function themeSeverityWeight(themeId: CanonicalThemeId): number {
  return CANONICAL_THEME_DEFS.find((d) => d.themeId === themeId)?.severityWeight ?? 0.4;
}

/** Themes that force summary override (cannot vanish on aggregate score alone). */
export const SUMMARY_OVERRIDE_THEMES = new Set<CanonicalThemeId>([
  "criminal_judicial",
  "corruption_integrity",
  "sanctions_pep_rca_compliance",
  "political_public_exposure",
]);

export function themeLabelRu(themeId: CanonicalThemeId): string {
  return CANONICAL_THEME_DEFS.find((d) => d.themeId === themeId)?.labelRu ?? themeId;
}
