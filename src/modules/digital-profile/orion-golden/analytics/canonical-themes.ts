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
 * Universal taxonomy. Keywords are language/pattern based — never subject-specific.
 */
export const CANONICAL_THEME_DEFS: CanonicalThemeDef[] = [
  {
    themeId: "criminal_judicial",
    labelRu: "Криминальные и судебные материалы",
    severityWeight: 1,
    keywords:
      /уголов|criminal|арест|arrest|обыск|розыск|прокур|следств|sledstvie|rucriminal|компромат|суд(?!острое)|court|contempt|litigant|тюрем|prison|fraud|мошенн/iu,
    legacyThemeIds: ["criminal_legal"],
  },
  {
    themeId: "corruption_integrity",
    labelRu: "Коррупционные и этические риски",
    severityWeight: 1,
    // No JS \b around Cyrillic — \b is ASCII-word only and misses «ФБК».
    keywords:
      /коррупц|corrupt|взятк|bribe|откат|kickback|(?:^|[^\p{L}\p{N}])фбк(?=[^\p{L}\p{N}]|$)|(?:^|[^\p{L}\p{N}])fbk(?=[^\p{L}\p{N}]|$)|незаконн\w*\s+обогащ|conflict of interest|конфликт интересов|неформальн\w*\s+влиян|этическ/iu,
    legacyThemeIds: [],
  },
  {
    themeId: "sanctions_pep_rca_compliance",
    labelRu: "Санкции, PEP, RCA и compliance-сигналы",
    severityWeight: 0.95,
    keywords:
      /\bpep\b|\brca\b|watch.?list|санкц|sanction|world.?check|dow.?jones|lexis|rupep|ofac|treasury|комплаенс|compliance/iu,
    legacyThemeIds: ["pep_rca_watchlist"],
  },
  {
    themeId: "political_public_exposure",
    labelRu: "Политические связи и публичная экспозиция",
    severityWeight: 0.85,
    keywords:
      /полит|politic|депутат|парти|выбор|electoral|минист|правительств|govern|парламент|parliament|putin|кремл|kremlin|favourite|favorite/iu,
    legacyThemeIds: ["political_exposure"],
  },
  {
    themeId: "business_ownership_associates",
    labelRu: "Деловые связи, владение и контрагенты",
    severityWeight: 0.55,
    keywords:
      /бизнесмен|businessman|предпринимател|инвестор|investor|соучредител|co-?founder|партнер|associate|владел|ownership|бенефициар|beneficia/iu,
    legacyThemeIds: ["business_profile", "family_associates"],
  },
  {
    themeId: "offshore_financial_transparency",
    labelRu: "Офшоры и финансовая прозрачность",
    severityWeight: 0.8,
    keywords:
      /офшор|offshore|кипр|cyprus|\bbvi\b|панам|panama|opencorporates|источник\w*\s+средств|source of funds|yacht|яхт/iu,
    legacyThemeIds: ["offshore_corporate"],
  },
  {
    themeId: "regulatory",
    labelRu: "Регуляторные расследования и ограничения",
    severityWeight: 0.85,
    keywords:
      /регулятор|regulator|лиценз|licence|license|надзор|фсб|fsb|national security|оборон|defen[cs]e|спецслужб|security service/iu,
    legacyThemeIds: ["security_scrutiny"],
  },
  {
    themeId: "reputational_scandal",
    labelRu: "Репутационные скандалы и негативные сюжеты",
    severityWeight: 0.75,
    keywords:
      /скандал|scandal|рыбк|rybka|navalny|навальн|секс.?скандал|компромат|разоблач|leak|расследован\w*\s+журналист/iu,
    legacyThemeIds: [],
  },
  {
    themeId: "family_personal_risk_relevant",
    labelRu: "Семейные и личные связи (риск-релевантные)",
    severityWeight: 0.45,
    keywords: /жена|супруг|spouse|дети|сын|дочь|семья|family|дети\b|children/iu,
    legacyThemeIds: ["family_associates"],
  },
  {
    themeId: "identity_mismatch",
    labelRu: "Ошибочная идентификация и однофамильцы",
    severityWeight: 0.3,
    keywords:
      /однофамил|namesake|другой\s+субъект|wrong subject|other subject|путаниц|misidentif|композитор|дворянск/iu,
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
