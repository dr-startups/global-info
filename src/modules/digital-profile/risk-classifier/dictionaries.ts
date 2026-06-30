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

// ---------------------------------------------------------------------------
// Stage N1.3 — search-result classifier dictionaries.
//
// Deterministic only (no LLM). Terms are grouped per theme and graded as
// "strong" (a clear, specific adverse/risk signal) vs "weak" (a topic hint that
// alone only warrants LOW confidence / manual review). A single weak hit must
// never produce an adverse highlight on its own.
// ---------------------------------------------------------------------------

export interface ClassifierThemeDict {
  /** Strong, specific signals (RU + EN). One strong hit ⇒ at least MEDIUM. */
  strong: string[];
  /** Weak topical hints (RU + EN). One weak hit alone ⇒ LOW only. */
  weak: string[];
}

export const sanctionsDict: ClassifierThemeDict = {
  strong: [
    "санкц",
    "санкционн",
    "под санкциями",
    "блокирующие санкции",
    "sanction",
    "sanctioned",
    "ofac",
    "sdn list",
    "specially designated",
  ],
  weak: [],
};

export const criminalDict: ClassifierThemeDict = {
  strong: [
    "уголовное дело",
    "уголовн",
    "приговор",
    "осужден",
    "осуждён",
    "арест",
    "задержан",
    "в розыске",
    "розыск",
    "criminal case",
    "criminal charges",
    "convicted",
    "conviction",
    "arrest",
    "indicted",
    "indictment",
    "felony",
    "wanted",
  ],
  weak: ["преступлен", "criminal"],
};

export const adverseMediaDict: ClassifierThemeDict = {
  strong: [
    "мошенничеств",
    "мошенник",
    "афера",
    "коррупц",
    "взятк",
    "хищени",
    "отмывани",
    "fraud",
    "scam",
    "corruption",
    "bribe",
    "bribery",
    "embezzlement",
    "money laundering",
  ],
  weak: [
    "скандал",
    "разоблачен",
    "компромат",
    "обвинен",
    "обвиняем",
    "scandal",
    "accused",
    "allegation",
    "exposed",
  ],
};

export const legalDisputeDict: ClassifierThemeDict = {
  strong: [
    "судебное дело",
    "судебный",
    "арбитражный суд",
    "арбитражн",
    "иск к",
    "истец",
    "ответчик",
    "дело №",
    "дело n",
    "исполнительное производство",
    "пристав",
    "фссп",
    "kad.arbitr",
    "sudact",
    "mos-gorsud",
    "lawsuit",
    "litigation",
    "court ruling",
    "court case",
    "plaintiff",
    "defendant",
    "fssp",
    "arbitr",
  ],
  weak: ["суд", "иск", "court"],
};

/** Business-registry / directory hosts — informational, not legal risk on their own. */
export const corporateRegistryDomains = [
  "rusprofile.ru",
  "klerk.ru",
  "audit-it.ru",
  "audit-it.com",
  "kontur.ru",
  "focus.kontur",
  "sravni.ru",
  "egrul",
  "egrip",
  "spark-interfax",
  "list-org.com",
  "checko.ru",
  "zachestnyibiznes.ru",
  "companies.rbc.ru",
  "tbank.ru/business",
];

/** Weak registry/business terms that must not alone imply legal/adverse risk. */
export const weakRegistryTerms = [
  "ип ",
  " инн ",
  "инн:",
  "огрн",
  "rusprofile",
  "klerk",
  "audit-it",
  "контур",
  "sravni",
  "ликвидирован",
  "прекратил деятельность",
  "предприниматель",
  "регистрация",
  "ооо ",
  "зао ",
  "пао ",
];

/** Authority / biography contexts that are not adverse without strong risk terms. */
export const authorityBiographyHints = [
  "известные ученые",
  "семь искусств",
  "ииет ран",
  "истина мгу",
  "история сыродела",
  "ученый",
  "академик",
  "профессор",
  "dissertation",
  "scientist",
];

export const bankruptcyDict: ClassifierThemeDict = {
  strong: ["банкрот", "несостоятельност", "bankrupt", "bankruptcy", "insolvency"],
  weak: [],
};

export const investigationDict: ClassifierThemeDict = {
  strong: [],
  weak: ["расследован", "investigation", "probe"],
};

export const pepDict: ClassifierThemeDict = {
  strong: ["politically exposed", "public official", "member of parliament"],
  weak: pepKeywords,
};

/** Hostname hints used to pick neutral/relevant classifications (not negativity). */
export const wikipediaDomains = ["wikipedia.org", "wikidata.org"];
export const socialDomains = [
  "linkedin.com",
  "facebook.com",
  "vk.com",
  "ok.ru",
  "instagram.com",
  "twitter.com",
  "x.com",
  "t.me",
  "telegram.me",
];
export const corporateHints = [
  "ооо ",
  "оао ",
  "пао ",
  "зао ",
  "ltd",
  "llc",
  "gmbh",
  "inc.",
  "corporation",
  "corporate profile",
  "company profile",
  "официальный сайт компании",
];
export const newsDomainHints = [
  "news",
  "rbc.ru",
  "tass.ru",
  "ria.ru",
  "kommersant",
  "vedomosti",
  "reuters.com",
  "bloomberg.com",
  "bbc.",
  "lenta.ru",
];
export const biographyHints = ["биография", "biography", "профиль", "profile of"];
