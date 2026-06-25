/**
 * Risk keyword/domain dictionaries (Stage I).
 *
 * Deliberately conservative and easy to extend. Matching is substring/word-based
 * over lower-cased text; these lists drive cautious "mentions found" signals, not
 * conclusions. Add terms here without touching the classifier logic.
 */

export const negativeKeywordsRu = [
  "скандал",
  "мошенник",
  "мошенничество",
  "афера",
  "обман",
  "коррупц",
  "взятк",
  "расследован",
  "обвинен",
  "компромат",
  "разоблачен",
  "уголовн",
  "арест",
  "приговор",
];

export const negativeKeywordsEn = [
  "scandal",
  "fraud",
  "fraudster",
  "scam",
  "corruption",
  "bribe",
  "investigation",
  "accused",
  "allegation",
  "exposed",
  "convicted",
  "arrest",
  "indicted",
  "money laundering",
];

export const sanctionsKeywords = [
  "санкц",
  "под санкциями",
  "sanction",
  "sanctioned",
  "ofac",
  "sdn list",
  "блокирующие санкции",
];

export const pepKeywords = [
  "депутат",
  "министр",
  "губернатор",
  "чиновник",
  "сенатор",
  "политик",
  "pep",
  "politically exposed",
  "public official",
  "member of parliament",
];

export const offshoreKeywords = [
  "офшор",
  "оффшор",
  "offshore",
  "offshore leaks",
  "panama papers",
  "pandora papers",
  "paradise papers",
  "shell company",
  "подставная компания",
];

export const legalKeywords = [
  "суд",
  "иск",
  "арбитраж",
  "истец",
  "ответчик",
  "court",
  "lawsuit",
  "litigation",
  "plaintiff",
  "defendant",
  "арбитражн",
];

export const bankruptcyKeywords = [
  "банкрот",
  "несостоятельност",
  "bankrupt",
  "bankruptcy",
  "insolvency",
];

export const criminalAllegationKeywords = [
  "уголовн",
  "преступлен",
  "criminal",
  "felony",
  "indictment",
  "convicted",
  "обвиняемый",
];

/** Known reputation/"compromat" style domains (substring match on hostname). */
export const reputationDomains = [
  "compromat",
  "rospres",
  "kompromat",
  "criminalnaya",
  "theins.ru/criminal",
  "ck-region",
];

/** Authoritative/neutral domains used to lower confidence of negativity. */
export const neutralSafeDomains = [
  "wikipedia.org",
  "linkedin.com",
  "gov.",
  "tass.ru",
  "reuters.com",
  "bloomberg.com",
];

export function matchesAny(haystack: string, needles: string[]): string[] {
  const hay = haystack.toLowerCase();
  return needles.filter((n) => hay.includes(n.toLowerCase()));
}

export const allNegativeKeywords = [...negativeKeywordsRu, ...negativeKeywordsEn];
