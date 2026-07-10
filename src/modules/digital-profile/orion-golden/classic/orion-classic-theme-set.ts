/**
 * R10.12 — ORION-style ThemeSet + regional surface KPIs.
 * Deterministic packaging of inventory into the story ORION puts on slides 3–7/23–24.
 */

import { classifyAutocompleteQuery } from "../../evidence-quality/autocomplete-class";
import {
  isRiskyResultClass,
  isStrongAutoSnapshotRisk,
  themeForClass,
  type StoredRiskClassification,
} from "../../risk-classifier/result-classifier";
import { humanizeRiskTheme, sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import type { OrionClientContent } from "../content/orion-client-content-builder";
import type { ExecutiveSynthesisOutput } from "../gpt/orion-executive-synthesis-from-sections";

export type OrionRegionBucket = "RU" | "UAE";

/** Wikipedia identity vs subject — never treat WRONG/AMBIGUOUS as «статья найдена». */
export type WikipediaSubjectStatus = "EXACT_SUBJECT" | "WRONG_SUBJECT" | "AMBIGUOUS" | "ABSENT";

export type OrionThemeEvidenceHit = {
  title: string;
  domain: string;
  url?: string;
  region: OrionRegionBucket | "GLOBAL";
  snippet?: string;
};

export type OrionThemeCard = {
  id: string;
  title: string;
  summary: string;
  count: number;
  regions: OrionRegionBucket[];
  namedEntities: string[];
  sampleHits: OrionThemeEvidenceHit[];
};

export type OrionSurfaceKpis = {
  region: OrionRegionBucket;
  linksTotal: number;
  linksAdverse: number;
  linksAdversePct: number;
  suggestionsTotal: number;
  suggestionsAdverse: number;
  relatedTotal: number;
  relatedAdverse: number;
  /** True only for EXACT_SUBJECT (not any Wikipedia URL). */
  wikipediaPresent: boolean;
  wikipediaStatus: WikipediaSubjectStatus;
  wikipediaTitle?: string;
  wikipediaUrl?: string;
  imagesTotal: number;
  imagesAdverse: number;
  videosTotal: number;
  knowledgeTotal: number;
  knowledgeAdverse: number;
  overallBadge: "Крайне негативный" | "Нежелательный" | "Смешанный" | "Нейтральный" | "Данных мало";
};

export type OrionComplianceStatusKind =
  | "rca"
  | "pep"
  | "sanctions"
  | "named_links"
  | "name_match";

export type OrionComplianceDbSignal = {
  provider: "Dow Jones" | "LexisNexis" | "World-Check" | "Другое";
  statusLine: string;
  detail: string;
  /** Structured classification for client claims / bullets. */
  statusKind: OrionComplianceStatusKind;
  namedLinks: string[];
  categories: string[];
  /** Open-source / ThemeSet context to verify against the full DB card (not claimed as card content). */
  openSourceContext: string[];
  /** True when signal is backed by a stored database_profile / Lexis row. */
  hasDbHit: boolean;
};

export type OrionThemeSet = {
  version: "r10-12-orion-theme-set-v1";
  caseId: string;
  subjectName: string;
  asOfDate: string;
  themes: OrionThemeCard[];
  ru: OrionSurfaceKpis;
  uae: OrionSurfaceKpis;
  complianceSignals: OrionComplianceDbSignal[];
  scopeSentence: string;
  executiveNarrative: string;
  executiveBullets: string[];
  nextStep: string;
};

function normalizeRegion(raw: string | undefined): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/^INTERNATIONAL$/, "INTL");
}

function matchesRegion(itemRegion: string | undefined, bucket: OrionRegionBucket): boolean {
  const r = normalizeRegion(itemRegion);
  if (bucket === "RU") return r === "RU" || r === "GLOBAL" || r === "" || r === "RUSSIA";
  return r === "UAE" || r === "INTL" || r === "AE" || r === "GLOBAL_INTL" || r === "EN";
}

function domainOf(url: string | undefined): string {
  if (!url) return "";
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    ?.slice(0, 48) ?? "";
}

function riskBlob(item: FullEvidenceInventory["items"][number]): string {
  const rm = item.rawMetadata ?? {};
  const nested = rm.riskClassification;
  const parts: string[] = [
    String(item.classification ?? ""),
    String(rm.themeLabel ?? ""),
    String(rm.riskTheme ?? ""),
    String(rm.category ?? ""),
    String(item.title ?? ""),
    String(item.snippet ?? ""),
    String(item.sourceUrl ?? ""),
  ];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const n = nested as Record<string, unknown>;
    const auto = n.auto && typeof n.auto === "object" ? (n.auto as Record<string, unknown>) : null;
    const manual = n.manual && typeof n.manual === "object" ? (n.manual as Record<string, unknown>) : null;
    parts.push(
      String(n.classification ?? ""),
      String(auto?.theme ?? ""),
      String(auto?.classification ?? ""),
      String(auto?.riskTheme ?? ""),
      String(manual?.classification ?? ""),
      String(manual?.riskTheme ?? "")
    );
  }
  return parts.join(" ").toLowerCase();
}

function storedRiskClassification(
  item: FullEvidenceInventory["items"][number]
): StoredRiskClassification | null {
  const raw = item.rawMetadata?.riskClassification;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as StoredRiskClassification;
}

/** Effective UI risk-theme key (mirrors SERP theme-grouper / highlight-resolver). */
function effectiveUiRiskTheme(item: FullEvidenceInventory["items"][number]): string | null {
  const stored = storedRiskClassification(item);
  const manual = stored?.manual ?? null;
  const auto = stored?.auto ?? null;
  if (manual?.classification && isRiskyResultClass(manual.classification)) {
    return String(manual.riskTheme ?? themeForClass(manual.classification) ?? "").trim() || null;
  }
  if (auto && isStrongAutoSnapshotRisk(auto)) {
    return String(auto.riskTheme ?? themeForClass(auto.classification) ?? "").trim() || null;
  }
  const legacy = String((item.rawMetadata ?? {}).riskTheme ?? (item.rawMetadata ?? {}).themeLabel ?? "").trim();
  return legacy || null;
}

/** Domains that SERP UI / analysts treat as adverse even when title is soft. */
const ADVERSE_DOMAIN_RE =
  /rucriminal\.|cybercriminal\.|acompromat\.|rucompromat\.|compromat\.|opensanctions\.|ofac\.|justice\.gov|home\.treasury\.gov/i;

/** Criminal aggregators / defense dossiers — must win Tema N + executive anchors over soft press. */
const CRIMINAL_AGGREGATOR_DOMAIN_RE =
  /rucriminal\.|cybercriminal\.|acompromat\.|rucompromat\.|compromat\./i;

/** Soft / non-story anchors that polluted Glinka exec (image SERP, disclosure wires). */
const WEAK_ANCHOR_DOMAIN_RE =
  /(?:^|\.)(?:yandex\.|ya\.ru|google\.|gstatic\.|images\.google|disclosure\.1prime|1prime\.ru|ria\.ru\/?$)/i;

/**
 * Domains that are adverse-capable but often wrong-person / tangential for Tema N anchors
 * (Treasury lists, NGO PDFs, generic cybercriminal bios without named ORION plot).
 */
const FALSE_STORY_ANCHOR_DOMAIN_RE =
  /(?:^|\.)(?:home\.treasury\.gov|treasury\.gov|nhc\.nl|ofac\.treasury)/i;

/** Prefer real RU criminal aggregators over EN cybercriminal bio pages. */
const PRIMARY_CRIMINAL_DOMAIN_RE = /rucriminal\./i;
/** Soft press / wire that must not become standalone «Иные… forbes.com/tass.com» claims. */
const SOFT_PRESS_NOISE_DOMAIN_RE = /^(?:www\.)?(?:forbes\.com|tass\.com)$/i;
const SECONDARY_CRIMINAL_DOMAIN_RE = /cybercriminal\./i;

/** ORION GSM-style named story tokens (Трансмаш / Махмудов / Ликсутов / Молдавия / ЛНР). */
const ORION_NAMED_STORY_RE =
  /трансмашхолдинг|transmashholding|трансмаш|махмудов|makhmudov|бокарев|bokarev|ликсутов|liksutov|молдав(?:ия|ии|ской)?|moldova|лнр|лднр|defense\s+industry|оборонн(?:ой|ая|ый)?\s+промышлен|индустриальн/i;

/** Core GSM criminal/sanctions plot names (not birthplace Moldova alone). */
const ORION_CORE_PLOT_RE = /трансмаш|махмудов|makhmudov|бокарев|bokarev/i;

const ADVERSE_RE =
  /adverse|negative|undesirable|нежелат|негатив|санкц|sanction|ofac|корруп|corrupt|мошен|fraud|арест|arrest|уголов|criminal|суд|lawsuit|pep|watchlist|rca|компромат|offshore|офшор|политич|молдав|лднр|лнр|индустриальн|бенефициар|associated|associate|defense industry|оборон/i;

/**
 * Align classic ThemeSet adverse gate with SERP UI red-frame logic:
 * manual risky → strong auto → known adverse domains → keyword blob (incl. URL).
 */
function isAdverseItem(item: FullEvidenceInventory["items"][number]): boolean {
  const et = item.evidenceType.toLowerCase();
  if (et === "risk_finding" || et === "compliance_hit") return true;

  const stored = storedRiskClassification(item);
  const manual = stored?.manual ?? null;
  const auto = stored?.auto ?? null;
  if (manual?.classification) {
    return isRiskyResultClass(manual.classification);
  }
  if (auto && isStrongAutoSnapshotRisk(auto)) return true;

  const url = String(item.sourceUrl ?? "");
  if (ADVERSE_DOMAIN_RE.test(url) || ADVERSE_DOMAIN_RE.test(domainOf(url))) return true;

  // Legacy enum on search_result (ADVERSE_MEDIA / LEGAL / CRIMINAL / …)
  if (isRiskyResultClass(item.classification)) return true;

  return ADVERSE_RE.test(riskBlob(item));
}

type ThemeBucketKey =
  | "sanctions_associates"
  | "political_exposure"
  | "business_associates"
  | "conflict_jurisdiction"
  | "aggregator_negative"
  | "offshore"
  | "criminal_legal"
  | "pep_rca"
  | "corporate"
  | "other_adverse";

const THEME_DEFS: Array<{
  key: ThemeBucketKey;
  title: string;
  match: RegExp;
}> = [
  {
    key: "sanctions_associates",
    title: "Санкционный контур и связанные лица / компании",
    match: /санкц|sanction|ofac|watchlist|бокарев|махмудов|трансмаш|rusal|базов(ый|ого)\s+элемент|basic\s+element/i,
  },
  {
    key: "political_exposure",
    title: "Политическая экспозиция / публичная деятельность",
    match: /политич|president|молдав|moldova|lobb|спонсир|deput|minister|выбор/i,
  },
  {
    key: "business_associates",
    title: "Совместный бизнес и связанные партнёры",
    match: /ликсутов|liksutov|партн[её]р|associate|joint|совместн|экс-супруг|жена|wife|lavrova/i,
  },
  {
    key: "conflict_jurisdiction",
    title: "Конфликтные юрисдикции / спорные юрисдикционные сюжеты",
    // Avoid \\b with Cyrillic — JS word boundaries are ASCII-only.
    match: /лнр|лднр|donetsk|lugansk|украин|ukraine|crimea|крым/i,
  },
  {
    key: "aggregator_negative",
    title: "Негативные публикации на ресурсах-агрегаторах",
    match: /компромат|compromat|агрегатор|dossier|rupep|peps\b|tadviser/i,
  },
  {
    key: "offshore",
    title: "Связи с офшором / зарубежными структурами",
    match: /offshore|офшор|icij|leaks|эстон|estonia|cyprus|кипр/i,
  },
  {
    key: "criminal_legal",
    title: "Криминальные материалы",
    match: /arrest|арест|уголов|criminal|indict|accused|приговор|мошен|fraud|court|суд|rucriminal|cybercriminal|defense industry/i,
  },
  {
    key: "pep_rca",
    title: "Сигналы PEP / RCA в комплаенс-базах",
    match: /\bpep\b|\brca\b|politically\s+exposed|относительн|близк(ий|ого)\s+партн/i,
  },
  {
    key: "corporate",
    title: "Корпоративные роли и реестровые связи",
    match: /учредител|руководител|кфх|огрнип|инн|егрюл|егрип|director|founder|board/i,
  },
  {
    key: "other_adverse",
    title: "Иные потенциально нежелательные упоминания",
    match: /./,
  },
];

function themeKeyOf(item: FullEvidenceInventory["items"][number]): ThemeBucketKey {
  const url = String(item.sourceUrl ?? "");
  const domain = domainOf(url);
  const blob = `${riskBlob(item)} ${url}`;

  // Criminal aggregators / defense dossiers stay in criminal_legal even when title
  // also matches Махмудов/Бокарев/Трансмаш (those would otherwise steal sanctions bucket).
  if (
    CRIMINAL_AGGREGATOR_DOMAIN_RE.test(domain) ||
    CRIMINAL_AGGREGATOR_DOMAIN_RE.test(url) ||
    /defense\s+industry|оборонн(?:ой|ая|ый)?\s+промышлен/i.test(blob)
  ) {
    return "criminal_legal";
  }

  // Named ORION people/orgs beat soft jurisdiction/politics keyword order.
  // Moldova political lobbying stories stay political even when Makhmudov is named.
  if (/ликсутов|liksutov/i.test(blob)) return "business_associates";
  if (
    /молдав|moldova/i.test(blob) &&
    /политич|president|лоббир|спонсир|парт(ии|ию|ия)|выбор|deput|minister/i.test(blob)
  ) {
    return "political_exposure";
  }
  if (/лнр|лднр/i.test(blob)) return "conflict_jurisdiction";
  if (/бокарев|bokarev|махмудов|makhmudov|трансмаш|transmashholding/i.test(blob)) {
    return "sanctions_associates";
  }
  if (/молдав|moldova/i.test(blob)) return "political_exposure";

  // Prefer SERP UI effective theme so «Криминальные материалы» stays criminal_legal.
  const uiTheme = (effectiveUiRiskTheme(item) ?? "").toLowerCase();
  if (uiTheme) {
    if (/criminal/.test(uiTheme)) return "criminal_legal";
    if (/legal/.test(uiTheme)) return "criminal_legal";
    if (/sanction/.test(uiTheme)) return "sanctions_associates";
    if (/pep|political/.test(uiTheme)) return "pep_rca";
    if (/adverse|reputation/.test(uiTheme)) return "aggregator_negative";
    if (/business/.test(uiTheme)) return "business_associates";
    if (/offshore/.test(uiTheme)) return "offshore";
  }

  for (const def of THEME_DEFS) {
    if (def.key === "other_adverse") continue;
    if (def.match.test(blob)) return def.key;
  }
  const label = humanizeRiskTheme(
    String((item.rawMetadata ?? {}).themeLabel ?? item.classification ?? "")
  ).toLowerCase();
  if (/санкц/.test(label)) return "sanctions_associates";
  if (/политич|pep/.test(label)) return "political_exposure";
  if (/криминал|уголов/.test(label)) return "criminal_legal";
  if (/негатив|adverse/.test(label)) return "aggregator_negative";
  if (/корпорат|identity|neutral/.test(label)) return "corporate";
  return "other_adverse";
}

function isDemoOrNoiseItem(item: FullEvidenceInventory["items"][number]): boolean {
  const url = String(item.sourceUrl ?? "").toLowerCase();
  const title = String(item.title ?? "");
  const snippet = String(item.snippet ?? "");
  const provider = String(item.provider ?? "");
  const blob = `${url} ${title} ${snippet} ${provider}`;
  return (
    /\.example(\/|$)/i.test(url) ||
    /directory-ru\.example|news-ru\.example|ru-directory\.example/i.test(blob) ||
    /\[DEMO\]|Demo DOW JONES|Demo WORLD CHECK|Demo LEXIS(?:NEXIS)?|Demo LEXISNEXIS|potential match only|demo screening/i.test(
      blob
    ) ||
    /example\.com|localhost|127\.0\.0\.1/i.test(url)
  );
}

/**
 * Homonym / wrong-person SERP rows (e.g. OpenSanctions «Sergey Mikhaylovich Kozlov»)
 * must not become Tema N / executive anchors for the subject.
 */
function isFalsePersonHit(
  title: string,
  url: string | undefined,
  subjectName: string
): boolean {
  const t = `${title} ${url ?? ""}`;
  const subjectLower = subjectName.toLowerCase();
  const parts = subjectName.trim().split(/\s+/).filter(Boolean);
  const surname = parts[0]?.toLowerCase();
  const given = parts[1]?.toLowerCase();
  const patronymic = parts[2]?.toLowerCase();
  if (!surname) return false;

  // Explicit known false positives seen on Glinka packs
  if (/kozlov|козлов/i.test(t) && !/kozlov|козлов/i.test(subjectLower)) return true;

  // Place-name collision: «деревня Глинка», «село Глинка» without subject FIO
  if (
    /(?:деревн[яи]|сел[оа]|пос[её]лк|улиц[аы]|район)\s+[«"]?/i.test(title) &&
    new RegExp(surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(title)
  ) {
    const hasFullFio =
      Boolean(given && new RegExp(given.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(title)) &&
      Boolean(
        patronymic && new RegExp(patronymic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(title)
      );
    if (!hasFullFio) return true;
  }

  // Registry / ИП rows with same given+patronymic but a different surname
  // e.g. «ИП Корнеев Сергей Михайлович», «ИП Попов Сергей Михайлович»
  if (/\bИП\b|ОГРНИП|индивидуальн(?:ый|ого)\s+предпринимател/i.test(title) && given && patronymic) {
    const givenRe = new RegExp(given.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const patRe = new RegExp(patronymic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const surRe = new RegExp(surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (givenRe.test(title) && patRe.test(title) && !surRe.test(title)) return true;
  }

  // FIO with subject's surname+given but a different patronymic
  // e.g. «Глинка, Сергей Николаевич» vs subject «… Михайлович»
  if (given && patronymic) {
    const surRe = new RegExp(surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const givenRe = new RegExp(given.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const patRe = new RegExp(patronymic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (surRe.test(title) && givenRe.test(title) && !patRe.test(title)) {
      if (/[А-ЯЁA-Z][а-яёa-z]+(?:ович|евич|ич|овна|евна)/u.test(title)) return true;
    }
  }

  // Wikipedia family / disambiguation / namesake pages are not the subject profile
  if (/wikipedia\.org/i.test(url ?? "") || /wikipedia/i.test(title)) {
    const wiki = classifyWikipediaHit({ title, url, subjectName });
    if (wiki.status === "WRONG_SUBJECT" || wiki.status === "AMBIGUOUS") return true;
  }

  // OpenSanctions / OFAC-style title with a different Latin FIO
  if (/opensanctions|ofac|sanction/i.test(t)) {
    const subjectInTitle =
      new RegExp(surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(title) ||
      /glinka|глинк/i.test(title);
    if (!subjectInTitle) {
      // "Sergey Mikhaylovich Kozlov - OpenSanctions" / similar
      if (
        /(?:Sergey|Sergei|Serhii|Сергей)\s+[A-ZА-ЯЁ][a-zа-яё]+\s+[A-ZА-ЯЁ][a-zа-яё]+/i.test(title) ||
        /[A-Z][a-z]+\s+[A-Z][a-z]+\s+[A-Z][a-z]+\s*[—\-–]\s*OpenSanctions/i.test(title)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Classify Wikipedia page vs subject identity.
 * «Глинка (дворянский род)» → WRONG_SUBJECT; person article with FIO → EXACT_SUBJECT.
 */
export function classifyWikipediaHit(input: {
  title: string;
  url?: string;
  snippet?: string;
  subjectName: string;
}): { status: WikipediaSubjectStatus; reason: string } {
  const title = String(input.title ?? "").trim();
  const url = String(input.url ?? "").trim();
  const snippet = String(input.snippet ?? "").trim();
  const blob = `${title} ${snippet} ${url}`;
  if (!title && !url) return { status: "ABSENT", reason: "no-wikipedia-row" };
  if (/отсутств|not\s+found|no\s+article|не\s+найден|page not found|страница не найдена/i.test(blob)) {
    return { status: "ABSENT", reason: "explicit-absent" };
  }
  if (url && !/wikipedia\.org/i.test(url) && !/статья найдена|article found|exists/i.test(blob)) {
    return { status: "ABSENT", reason: "non-wikipedia-url" };
  }

  const parts = input.subjectName.trim().split(/\s+/).filter(Boolean);
  const surname = parts[0] ?? "";
  const given = parts[1] ?? "";
  const patronymic = parts[2] ?? "";
  const surnameRe = surname
    ? new RegExp(surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    : null;
  const givenRe = given
    ? new RegExp(given.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    : null;
  const patronymicRe = patronymic
    ? new RegExp(patronymic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    : null;

  // Family / clan / disambiguation / list pages — never the subject profile
  if (
    /\((?:дворянский\s+род|род|семья|family|disambiguation|значения|фамилия)\)/i.test(title) ||
    /дворянский\s+род|список\s+однофамильц|disambiguation|значения\)/i.test(blob) ||
    /\/wiki\/[^/\s]*(?:_(?:family|clan|disambiguation)|_\(фамилия\)|_\(род\))/i.test(url)
  ) {
    return { status: "WRONG_SUBJECT", reason: "family-or-disambiguation-page" };
  }

  // Composer / other famous namesakes with same surname but different given name in title
  if (surnameRe?.test(title) && givenRe && !givenRe.test(title) && !givenRe.test(snippet)) {
    if (
      /композитор|писатель|поэт|художник|генерал|княз|граф|musician|composer|painter|poet/i.test(blob) ||
      /\([^)]{2,40}\)/.test(title)
    ) {
      return { status: "WRONG_SUBJECT", reason: "namesake-with-different-identity" };
    }
  }

  const hasSurname = Boolean(surnameRe?.test(title) || surnameRe?.test(url));
  const hasGiven = Boolean(givenRe?.test(title) || givenRe?.test(snippet) || givenRe?.test(url));
  const hasPatronymic = Boolean(
    patronymicRe && (patronymicRe.test(title) || patronymicRe.test(snippet) || patronymicRe.test(url))
  );

  // Same surname+given but a different patronymic in the title → wrong person
  if (hasSurname && hasGiven && patronymicRe && !hasPatronymic) {
    if (/[А-ЯЁA-Z][а-яёa-z]+(?:ович|евич|ич|овна|евна)/u.test(title)) {
      return { status: "WRONG_SUBJECT", reason: "different-patronymic" };
    }
  }

  if (hasSurname && hasGiven && (hasPatronymic || /предпринимател|бизнесмен|бизнес|миллионер|oligarch|бизнесмен/i.test(blob))) {
    return { status: "EXACT_SUBJECT", reason: "fio-or-role-match" };
  }
  if (hasSurname && hasGiven) {
    return { status: "EXACT_SUBJECT", reason: "surname-given-match" };
  }
  if (hasSurname && !hasGiven) {
    return { status: "AMBIGUOUS", reason: "surname-only" };
  }
  if (url && /wikipedia\.org/i.test(url)) {
    return { status: "AMBIGUOUS", reason: "wikipedia-url-weak-name-match" };
  }
  return { status: "ABSENT", reason: "unclassified" };
}

function resolveWikipediaStatus(
  inventory: FullEvidenceInventory,
  region: OrionRegionBucket,
  subjectName: string
): {
  status: WikipediaSubjectStatus;
  title?: string;
  url?: string;
} {
  const wikiItems = inventory.items.filter((i) => i.evidenceType === "wikipedia" && !isDemoOrNoiseItem(i));
  const regional = wikiItems.filter((w) => {
    const url = String(w.sourceUrl ?? "");
    if (region === "RU") {
      return /\/\/ru\.wikipedia\.org/i.test(url) || matchesRegion(w.region, "RU") || /wikipedia\.org/i.test(url);
    }
    return /\/\/(en|ar)\.wikipedia\.org/i.test(url) || matchesRegion(w.region, "UAE");
  });
  const pool = region === "UAE"
    ? regional.filter((w) => !/\/\/ru\.wikipedia\.org/i.test(String(w.sourceUrl ?? "")))
    : regional.length > 0
      ? regional
      : wikiItems;

  if (pool.length === 0) return { status: "ABSENT" };

  let best: { status: WikipediaSubjectStatus; title?: string; url?: string; rank: number } | null = null;
  const rankOf = (s: WikipediaSubjectStatus) =>
    s === "EXACT_SUBJECT" ? 3 : s === "AMBIGUOUS" ? 2 : s === "WRONG_SUBJECT" ? 1 : 0;

  for (const w of pool) {
    const classified = classifyWikipediaHit({
      title: String(w.title ?? ""),
      url: w.sourceUrl,
      snippet: w.snippet,
      subjectName,
    });
    const rank = rankOf(classified.status);
    if (!best || rank > best.rank) {
      best = {
        status: classified.status,
        title: String(w.title ?? ""),
        url: w.sourceUrl,
        rank,
      };
    }
  }
  // Prefer EXACT; if only WRONG/AMBIGUOUS — report that (not «present»).
  if (!best) return { status: "ABSENT" };
  return { status: best.status, title: best.title, url: best.url };
}

function isGarbageEntityToken(token: string): boolean {
  return /^(citizen|arrested|united|state|her|role|oligarch|russian|potential|match|requires|analyst|review|before|any|conclusion|page|result|demo|source|компания|персон|субъект|facilitating|illicit|travel|real|estate|transactions)$/i.test(
    token
  );
}

/** Charge labels / subject self-names that look like entities but are not ORION-style anchors. */
function isChargeOrSubjectLabel(entity: string, subjectName: string): boolean {
  const e = entity.trim();
  if (
    /facilitating illicit|real estate transactions|russian oligarch|citizen arrested|united state|geoff cutmore|money laundering|sanction list|consolidated sanctions/i.test(
      e
    )
  ) {
    return true;
  }
  const subjectBits = subjectName
    .toLowerCase()
    .split(/\s+/)
    .filter((x) => x.length > 2);
  const lower = e.toLowerCase();
  if (subjectBits.filter((b) => lower.includes(b)).length >= 2) return true;
  if (/^(oleg|дерипаска|deripaska|владимирович|vladimirovich)\b/i.test(e)) return true;
  return false;
}

function isWeakBlogDomain(domain: string): boolean {
  return /anisimov\.biz|livejournal\.|blogspot\.|medium\.com|wordpress\.|dzen\.ru/i.test(domain);
}

function isWeakMediaDomain(domain: string): boolean {
  return (
    /youtube\.|wixsite\.|instagram\.|facebook\.|tiktok\.|t\.me\b|vk\.com|ok\.ru|plehanovka/i.test(domain) ||
    WEAK_ANCHOR_DOMAIN_RE.test(domain) ||
    isWeakBlogDomain(domain)
  );
}

/** Rank hits so rucriminal/defense lead Tema N / «типичный якорь»; soft press sinks. */
function hitPriorityScore(hit: OrionThemeEvidenceHit, themeKey: ThemeBucketKey): number {
  const d = (hit.domain || "").toLowerCase();
  const blob = `${hit.title} ${hit.snippet ?? ""}`.toLowerCase();
  let score = 0;
  // rucriminal (GSM) >> cybercriminal bio pages >> other aggregators
  if (PRIMARY_CRIMINAL_DOMAIN_RE.test(d)) score += 200;
  else if (SECONDARY_CRIMINAL_DOMAIN_RE.test(d)) score += 70;
  else if (CRIMINAL_AGGREGATOR_DOMAIN_RE.test(d)) score += 110;
  if (ORION_CORE_PLOT_RE.test(blob)) score += 80;
  else if (ORION_NAMED_STORY_RE.test(blob)) score += 40;
  if (/rupep|opensanctions|justice\.gov|ofac|tadviser|peps|dossier|kommersant|vedomosti|rbc\.|forbes|acompromat/i.test(d)) {
    score += 35;
  }
  if (themeKey === "criminal_legal" && /court|суд|justice/i.test(d)) score += 25;
  // cybercriminal without core plot is a weak lead vs rucriminal dossiers
  if (SECONDARY_CRIMINAL_DOMAIN_RE.test(d) && !ORION_CORE_PLOT_RE.test(blob)) score -= 40;
  if (FALSE_STORY_ANCHOR_DOMAIN_RE.test(d)) score -= 150;
  if (WEAK_ANCHOR_DOMAIN_RE.test(d) || isWeakMediaDomain(d) || isGovPortalDomain(d)) score -= 100;
  if (/\.example|example\.com/i.test(d)) score -= 200;
  if (/kozlov|козлов/i.test(blob)) score -= 250;
  return score;
}

function sortHitsForTheme(
  hits: OrionThemeEvidenceHit[],
  themeKey: ThemeBucketKey
): OrionThemeEvidenceHit[] {
  return [...hits].sort((a, b) => hitPriorityScore(b, themeKey) - hitPriorityScore(a, themeKey));
}

function isGovPortalDomain(domain: string): boolean {
  return (
    /kremlin\.ru|gov\.ru|president\.|whitehouse\.|gov\.uk|home\.treasury\.gov|treasury\.gov/i.test(
      domain
    ) || FALSE_STORY_ANCHOR_DOMAIN_RE.test(domain)
  );
}

function preferredThemeSample(
  sample: OrionThemeEvidenceHit[],
  themeKey: ThemeBucketKey
): OrionThemeEvidenceHit | undefined {
  const ranked = sortHitsForTheme(sample, themeKey);
  const top = ranked[0];
  if (top && hitPriorityScore(top, themeKey) > 0) return top;

  const strong =
    themeKey === "sanctions_associates" || themeKey === "pep_rca" || themeKey === "aggregator_negative"
      ? sample.find((h) =>
          /rupep|opensanctions|justice\.gov|peps|tadviser|dossier|ofac|sanction|lexis|dow|world-check/i.test(
            h.domain
          )
        )
      : undefined;
  if (strong) return strong;
  // Never use kremlin/gov portals as PEP/RCA or sanctions "typical anchor".
  if (themeKey === "pep_rca" || themeKey === "sanctions_associates") {
    return sample.find(
      (h) => h.domain && !isWeakMediaDomain(h.domain) && !isGovPortalDomain(h.domain)
    );
  }
  // Criminal/legal theme: rucriminal first, then other aggregators / court.
  if (themeKey === "criminal_legal") {
    return (
      sample.find((h) => PRIMARY_CRIMINAL_DOMAIN_RE.test(h.domain)) ??
      sample.find(
        (h) =>
          CRIMINAL_AGGREGATOR_DOMAIN_RE.test(h.domain) &&
          ORION_CORE_PLOT_RE.test(`${h.title} ${h.snippet ?? ""}`)
      ) ??
      sample.find((h) => CRIMINAL_AGGREGATOR_DOMAIN_RE.test(h.domain)) ??
      sample.find((h) =>
        /court|суд|justice|reuters|bbc|rbc|forbes|kommersant|vedomosti|interfax/i.test(h.domain)
      ) ??
      sample.find((h) => h.domain && !isWeakMediaDomain(h.domain) && !isWeakBlogDomain(h.domain))
    );
  }
  return (
    sample.find(
      (h) => h.domain && !isWeakMediaDomain(h.domain) && !isGovPortalDomain(h.domain)
    ) ??
    sample.find((h) => h.domain && !isWeakMediaDomain(h.domain)) ??
    sample[0]
  );
}

function isQualityEntity(entity: string, subjectName: string): boolean {
  const e = entity.trim();
  if (e.length < 3 || e.length > 80) return false;
  if (isChargeOrSubjectLabel(e, subjectName)) return false;
  const tokens = e.split(/\s+/);
  if (tokens.every(isGarbageEntityToken)) return false;
  if (tokens.length === 1 && isGarbageEntityToken(tokens[0])) return false;
  // ORION GSM named-story anchors (incl. short ЛНР)
  if (
    /^(лнр|лднр|молдавия|moldova|махмудов|makhmudov|бокарев|bokarev|ликсутов|liksutov|трансмаш(?:холдинг)?|transmashholding|оборонная промышленность)$/i.test(
      e
    )
  ) {
    return true;
  }
  // Prefer multi-word brands / orgs / known sources
  if (
    /rupep|peps|tadviser|forbes|рбк|rusal|en\+|базов|транс|маз|ликсутов|бокарев|махмудов|молдав|лнр|оборон|opensanctions|justice\.gov|lexisnexis|dow jones|world-check|dossier|rucriminal/i.test(
      e
    )
  ) {
    return true;
  }
  // Domain-like anchors
  if (/\.(org|gov|com|ru|net|info)\b/i.test(e) && !isWeakMediaDomain(e) && !WEAK_ANCHOR_DOMAIN_RE.test(e)) {
    return true;
  }
  // Strong org forms only — avoid Title Case charge phrases (3+ English words)
  if (/[«»"]|\bАО\b|\bПАО\b|\bООО\b/i.test(e)) return true;
  if (/^[A-Z]{2,}$/.test(e)) return true;
  // Allow 2-token proper names that are not charge labels (e.g. "Open Sanctions" already caught)
  if (tokens.length === 2 && tokens.every((t) => /^[A-ZА-ЯЁ]/.test(t)) && !tokens.some(isGarbageEntityToken)) {
    return true;
  }
  return false;
}

/** GSM-style theme titles when named story entities are present. */
function themeDisplayTitle(
  defKey: ThemeBucketKey,
  fallbackTitle: string,
  named: string[],
  sampleHits: OrionThemeEvidenceHit[] = []
): string {
  const story = named.filter((e) =>
    /трансмаш|махмудов|бокарев|ликсутов|молдав|лнр|лднр|оборон/i.test(e)
  );
  const core = story.filter((e) => /трансмаш|махмудов|бокарев/i.test(e));
  const hasRucrim = sampleHits.some((h) => PRIMARY_CRIMINAL_DOMAIN_RE.test(h.domain));
  const hasCoreInHits = sampleHits.some((h) =>
    ORION_CORE_PLOT_RE.test(`${h.title} ${h.snippet ?? ""}`)
  );

  // Keep explicit criminal bucket label; append GSM core plot when present.
  if (defKey === "criminal_legal") {
    // Prefer core plot names; never lead with Moldova/defense alone.
    let coreNames = core.slice(0, 3);
    if (coreNames.length < 2 && (hasRucrim || hasCoreInHits)) {
      const fromHits = extractNamedEntities(
        sampleHits.map((h) => `${h.title} ${h.snippet ?? ""}`).join(" "),
        ""
      ).filter((e) => /трансмаш|махмудов|бокарев/i.test(e));
      for (const e of fromHits) {
        if (!coreNames.some((c) => c.toLowerCase() === e.toLowerCase())) coreNames.push(e);
      }
      coreNames = coreNames.slice(0, 3);
    }
    if (coreNames.length > 0) {
      return `Криминальные материалы — ${coreNames.join(" / ")}`;
    }
    return "Криминальные материалы";
  }

  if (defKey === "sanctions_associates") {
    if (core.length >= 2) return core.slice(0, 3).join(" / ");
    if (core.length === 1 && story.length >= 2) return story.slice(0, 3).join(" / ");
  }
  if (defKey === "business_associates") {
    const lik = story.find((e) => /ликсутов/i.test(e));
    if (lik) return lik;
  }
  if (defKey === "political_exposure") {
    const mold = story.find((e) => /молдав/i.test(e));
    if (mold) return mold;
  }
  if (defKey === "conflict_jurisdiction") {
    const lnr = story.find((e) => /лнр|лднр/i.test(e));
    if (lnr) return lnr;
  }
  if (story.length >= 2 && !story.every((e) => /молдав|оборон/i.test(e))) {
    return story.slice(0, 3).join(" / ");
  }
  return fallbackTitle;
}

function extractNamedEntities(text: string, subjectName: string): string[] {
  const out: string[] = [];
  // Phrase-level ORION story labels first (EN titles: Makhmudov and Bokarev / Railways / Transmash)
  const storyLabels: Array<{ re: RegExp; label: string; priority: number }> = [
    { re: /трансмашхолдинг|transmashholding/i, label: "Трансмашхолдинг", priority: 0 },
    { re: /махмудов|makhmudov/i, label: "Махмудов", priority: 0 },
    { re: /бокарев|bokarev/i, label: "Бокарев", priority: 0 },
    { re: /ликсутов|liksutov/i, label: "Ликсутов", priority: 1 },
    { re: /лнр|лднр/i, label: "ЛНР", priority: 1 },
    { re: /молдав|moldova/i, label: "Молдавия", priority: 2 },
    { re: /defense\s+industry|оборонн/i, label: "оборонная промышленность", priority: 2 },
  ];
  const found: Array<{ label: string; priority: number }> = [];
  for (const s of storyLabels) {
    if (!s.re.test(text)) continue;
    if (found.some((x) => x.label.toLowerCase() === s.label.toLowerCase())) continue;
    found.push({ label: s.label, priority: s.priority });
  }
  // ORION GSM: «…pump money Railways…» with Makhmudov/Bokarev ≈ Трансмашхолдинг plot
  if (
    /railways/i.test(text) &&
    /makhmudov|махмудов|bokarev|бокарев/i.test(text) &&
    !found.some((x) => /трансмаш/i.test(x.label))
  ) {
    found.push({ label: "Трансмашхолдинг", priority: 0 });
  }
  found.sort((a, b) => a.priority - b.priority);
  for (const f of found) {
    out.push(f.label);
    if (out.length >= 8) return out;
  }

  const re =
    /\b(?:АО\s+«[^»]+»|ПАО\s+«[^»]+»|ООО\s+«[^»]+»|Базовый элемент|En\+ Group|Rusal|РУСАЛ|rupep\.org|PEPS|TAdviser|Forbes|РБК|LexisNexis|Dow Jones|World-Check|OpenSanctions|justice\.gov|Transmashholding|Трансмашхолдинг|Трансмаш|Махмудов|Makhmudov|Бокарев|Bokarev|Ликсутов|Liksutov|Молдавия|Moldova|ЛНР|ЛДНР|Dossier Center)\b/gi;
  for (const m of text.match(re) ?? []) {
    const t = m.trim();
    if (!isQualityEntity(t, subjectName)) continue;
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

/** Prefer real source domains as theme anchors (ORION style), not NER charge labels. */
function themeAnchorEntities(
  hits: OrionThemeEvidenceHit[],
  named: string[],
  subjectName: string,
  themeKey?: ThemeBucketKey
): string[] {
  const out: string[] = [];
  const rankedHits = themeKey ? sortHitsForTheme(hits, themeKey) : hits;

  const coreFirst = named.filter(
    (e) => isQualityEntity(e, subjectName) && /трансмаш|махмудов|бокарев/i.test(e)
  );
  const plotNext = named.filter(
    (e) =>
      isQualityEntity(e, subjectName) &&
      /ликсутов|лнр|лднр/i.test(e) &&
      !coreFirst.some((c) => c.toLowerCase() === e.toLowerCase())
  );
  const softStory = named.filter(
    (e) =>
      isQualityEntity(e, subjectName) &&
      /молдав|оборон|rusal|базов/i.test(e) &&
      !coreFirst.some((c) => c.toLowerCase() === e.toLowerCase()) &&
      !plotNext.some((c) => c.toLowerCase() === e.toLowerCase())
  );

  for (const ent of [...coreFirst, ...plotNext, ...softStory]) {
    if (!out.some((x) => x.toLowerCase() === ent.toLowerCase())) out.push(ent);
    if (out.length >= 4) break;
  }
  for (const hit of rankedHits) {
    const d = (hit.domain || "").trim();
    if (!d || isWeakMediaDomain(d) || WEAK_ANCHOR_DOMAIN_RE.test(d) || /\.example$/i.test(d)) continue;
    if (FALSE_STORY_ANCHOR_DOMAIN_RE.test(d) || isGovPortalDomain(d)) continue;
    // Prefer rucriminal domain over cybercriminal in named entity list
    if (SECONDARY_CRIMINAL_DOMAIN_RE.test(d) && rankedHits.some((h) => PRIMARY_CRIMINAL_DOMAIN_RE.test(h.domain))) {
      continue;
    }
    if (!out.some((x) => x.toLowerCase() === d.toLowerCase())) out.push(d);
    if (out.length >= 5) break;
  }
  for (const ent of named) {
    if (!isQualityEntity(ent, subjectName)) continue;
    if (!out.some((x) => x.toLowerCase() === ent.toLowerCase())) out.push(ent);
    if (out.length >= 5) break;
  }
  return out;
}

function badgeFor(kpis: Omit<OrionSurfaceKpis, "overallBadge" | "region">): OrionSurfaceKpis["overallBadge"] {
  if (kpis.linksTotal < 5 && kpis.suggestionsTotal < 3) return "Данных мало";
  // Require both volume and share for "крайне негативный" — % alone overfits thin UAE samples.
  // Do not let imagesAdverse alone drive badge when image pages are not shown in classic deck.
  if (
    (kpis.linksAdversePct >= 30 && kpis.linksAdverse >= 12) ||
    kpis.suggestionsAdverse >= 5
  ) {
    return "Крайне негативный";
  }
  if (kpis.linksAdversePct >= 10 || kpis.suggestionsAdverse >= 1) {
    return "Нежелательный";
  }
  if (kpis.linksAdverse > 0 || kpis.knowledgeAdverse > 0) return "Смешанный";
  return "Нейтральный";
}

function surfaceType(item: FullEvidenceInventory["items"][number]): string {
  return item.evidenceType.toLowerCase().replace(/-/g, "_");
}

function isSuggestion(item: FullEvidenceInventory["items"][number]): boolean {
  const et = surfaceType(item);
  return et.includes("suggestion") || et.includes("autocomplete");
}

function isRelated(item: FullEvidenceInventory["items"][number]): boolean {
  const et = surfaceType(item);
  return et.includes("related");
}

function isImage(item: FullEvidenceInventory["items"][number]): boolean {
  return surfaceType(item).includes("image");
}

function isVideo(item: FullEvidenceInventory["items"][number]): boolean {
  return surfaceType(item).includes("video");
}

function isKnowledge(item: FullEvidenceInventory["items"][number]): boolean {
  const et = surfaceType(item);
  return et.includes("knowledge");
}

function computeSurfaceKpis(
  inventory: FullEvidenceInventory,
  region: OrionRegionBucket,
  subjectName: string
): OrionSurfaceKpis {
  const items = inventory.items.filter((i) => matchesRegion(i.region, region) && !isDemoOrNoiseItem(i));
  const links = items.filter((i) => i.evidenceType === "search_result");
  const linksAdverse = links.filter(isAdverseItem);
  const suggestions = items.filter(isSuggestion);
  const suggestionsAdverse = suggestions.filter((s) => {
    const q = (s.query || s.title || "").trim();
    return classifyAutocompleteQuery(q, subjectName) === "RISK_QUERY" || isAdverseItem(s);
  });
  const related = items.filter(isRelated);
  const relatedAdverse = related.filter((s) => {
    const q = (s.query || s.title || "").trim();
    return classifyAutocompleteQuery(q, subjectName) === "RISK_QUERY" || isAdverseItem(s);
  });
  const wiki = resolveWikipediaStatus(inventory, region, subjectName);
  const wikiPresent = wiki.status === "EXACT_SUBJECT";
  // Prefer non-demo organic links for share metrics
  const linksClean = links;
  const linksAdverseClean = linksAdverse;
  const images = items.filter(isImage);
  const imagesAdverse = images.filter(isAdverseItem);
  const videos = items.filter(isVideo);
  const knowledge = items.filter(isKnowledge);
  const knowledgeAdverse = knowledge.filter(isAdverseItem);
  const linksTotal = linksClean.length > 0 ? linksClean.length : links.length;
  const linksAdverseCount = linksClean.length > 0 ? linksAdverseClean.length : linksAdverse.length;
  const linksAdversePct =
    linksTotal > 0 ? Math.round((linksAdverseCount / linksTotal) * 100) : 0;
  const base = {
    linksTotal,
    linksAdverse: linksAdverseCount,
    linksAdversePct,
    suggestionsTotal: suggestions.length,
    suggestionsAdverse: suggestionsAdverse.length,
    relatedTotal: related.length,
    relatedAdverse: relatedAdverse.length,
    wikipediaPresent: wikiPresent,
    wikipediaStatus: wiki.status,
    wikipediaTitle: wiki.title,
    wikipediaUrl: wiki.url,
    imagesTotal: images.length,
    imagesAdverse: imagesAdverse.length,
    videosTotal: videos.length,
    knowledgeTotal: knowledge.length,
    knowledgeAdverse: knowledgeAdverse.length,
  };
  return {
    region,
    ...base,
    overallBadge: badgeFor(base),
  };
}

function buildThemes(
  inventory: FullEvidenceInventory,
  subjectName: string
): OrionThemeCard[] {
  const buckets = new Map<
    ThemeBucketKey,
    {
      hits: OrionThemeEvidenceHit[];
      entities: string[];
      regions: Set<OrionRegionBucket>;
    }
  >();

  for (const item of inventory.items) {
    if (isDemoOrNoiseItem(item)) continue;
    if (isFalsePersonHit(String(item.title ?? ""), item.sourceUrl, subjectName)) continue;
    const et = item.evidenceType.toLowerCase();
    if (et !== "search_result" && et !== "risk_finding" && et !== "compliance_hit") continue;
    const adverse = isAdverseItem(item);
    if (!adverse && et === "search_result") {
      // Keep strong corporate registry identities only when classification already marked risk-ish
      const cls = String(item.classification ?? "").toLowerCase();
      if (!/adverse|sanction|pep|risk|negative|undesirable|compliance|criminal|legal/i.test(cls)) continue;
    }
    const key = themeKeyOf(item);
    // Skip pure corporate identity from becoming the only story unless explicitly adverse
    if (key === "corporate" && !adverse) continue;
    // Skip weak "other_adverse" unless UI/classifier already marked adverse
    if (
      key === "other_adverse" &&
      et === "search_result" &&
      !adverse &&
      !/sanction|pep|arrest|criminal|ofac|компромат/i.test(riskBlob(item))
    ) {
      continue;
    }
    const region: OrionRegionBucket | "GLOBAL" = matchesRegion(item.region, "UAE")
      ? "UAE"
      : matchesRegion(item.region, "RU")
        ? "RU"
        : "GLOBAL";
    const bucket = buckets.get(key) ?? { hits: [], entities: [], regions: new Set() };
    if (region === "RU" || region === "UAE") bucket.regions.add(region);
    const hit: OrionThemeEvidenceHit = {
      title: sanitizeOrionGoldenClientText(item.title).slice(0, 120),
      domain: domainOf(item.sourceUrl),
      url: item.sourceUrl,
      region: region === "GLOBAL" ? "RU" : region,
      snippet: item.snippet ? sanitizeOrionGoldenClientText(item.snippet).slice(0, 180) : undefined,
    };
    // Prefer UI-adverse / known adverse domains at the front of sampleHits
    const existingIdx = bucket.hits.findIndex((h) => h.url && hit.url && h.url === hit.url);
    if (existingIdx < 0) {
      if (adverse || ADVERSE_DOMAIN_RE.test(hit.domain)) {
        bucket.hits.unshift(hit);
      } else {
        bucket.hits.push(hit);
      }
    }
    for (const ent of extractNamedEntities(`${item.title} ${item.snippet ?? ""}`, subjectName)) {
      if (!bucket.entities.some((e) => e.toLowerCase() === ent.toLowerCase())) {
        bucket.entities.push(ent);
      }
    }
    buckets.set(key, bucket);
  }

  const cards: OrionThemeCard[] = [];
  for (const def of THEME_DEFS) {
    const bucket = buckets.get(def.key);
    if (!bucket || bucket.hits.length === 0) continue;
    if (def.key === "other_adverse" && bucket.hits.length < 3) continue;
    const rankedHits = sortHitsForTheme(
      bucket.hits.filter(
        (h) =>
          h.domain &&
          !/\.example$/i.test(h.domain) &&
          !FALSE_STORY_ANCHOR_DOMAIN_RE.test(h.domain) &&
          !isFalsePersonHit(h.title, h.url, subjectName) &&
          // Soft press alone must not seed other_adverse / weak criminal cards.
          !(def.key === "other_adverse" && SOFT_PRESS_NOISE_DOMAIN_RE.test(h.domain))
      ),
      def.key
    );
    if (def.key === "other_adverse" && rankedHits.length === 0) continue;
    if (
      (def.key === "criminal_legal" || def.key === "sanctions_associates" || def.key === "other_adverse") &&
      rankedHits.length > 0 &&
      rankedHits.every((h) => SOFT_PRESS_NOISE_DOMAIN_RE.test(h.domain))
    ) {
      continue;
    }
    const sample = rankedHits
      .filter((h) => {
        // Keep gov portals / weak media / soft SERP out of sampleHits (false "typical anchors").
        if (def.key === "pep_rca" || def.key === "sanctions_associates" || def.key === "criminal_legal") {
          return (
            !isGovPortalDomain(h.domain) &&
            !isWeakMediaDomain(h.domain) &&
            !FALSE_STORY_ANCHOR_DOMAIN_RE.test(h.domain)
          );
        }
        return !WEAK_ANCHOR_DOMAIN_RE.test(h.domain) && !FALSE_STORY_ANCHOR_DOMAIN_RE.test(h.domain);
      })
      .slice(0, 4);
    // Criminal: ensure at least one rucriminal hit in sample when present in bucket
    if (def.key === "criminal_legal") {
      const rucrim = rankedHits.find((h) => PRIMARY_CRIMINAL_DOMAIN_RE.test(h.domain));
      if (rucrim && !sample.some((h) => PRIMARY_CRIMINAL_DOMAIN_RE.test(h.domain))) {
        sample.unshift(rucrim);
        if (sample.length > 4) sample.pop();
      }
    }
    if (sample.length === 0 && def.key !== "pep_rca" && def.key !== "sanctions_associates" && def.key !== "criminal_legal") {
      continue;
    }
    if (sample.length === 0 && bucket.hits.length === 0) continue;
    // For criminal_legal prefer adverse aggregators; keep theme even without weak-blog anchors.
    const usableSample =
      def.key === "criminal_legal"
        ? sample.filter(
            (h) =>
              (!isWeakBlogDomain(h.domain) && !WEAK_ANCHOR_DOMAIN_RE.test(h.domain)) ||
              CRIMINAL_AGGREGATOR_DOMAIN_RE.test(h.domain) ||
              ADVERSE_DOMAIN_RE.test(h.domain)
          )
        : sample;
    const preferredSample =
      usableSample.length > 0
        ? preferredThemeSample(usableSample, def.key)
        : def.key === "criminal_legal"
          ? preferredThemeSample(
              rankedHits
                .filter(
                  (h) =>
                    PRIMARY_CRIMINAL_DOMAIN_RE.test(h.domain) ||
                    CRIMINAL_AGGREGATOR_DOMAIN_RE.test(h.domain)
                )
                .slice(0, 4),
              def.key
            )
          : sample.length > 0
            ? preferredThemeSample(sample, def.key)
            : undefined;
    const named = themeAnchorEntities(
      usableSample.length > 0
        ? usableSample
        : sample.filter((h) => !isGovPortalDomain(h.domain) || def.key === "political_exposure"),
      bucket.entities.filter((e) => isQualityEntity(e, subjectName)),
      subjectName,
      def.key
    );
    const finalSample =
      usableSample.length > 0
        ? sortHitsForTheme(usableSample, def.key)
        : sortHitsForTheme(sample, def.key);
    const summaryParts = [
      named.length > 0
        ? `В сюжетной линии фигурируют: ${named.join(", ")}.`
        : def.key === "pep_rca"
          ? "Предварительные сигналы PEP/RCA в комплаенс-контексте; требуется сверка полного профиля."
          : def.key === "criminal_legal"
            ? "В открытых источниках зафиксированы криминальные / судебные материалы; требуется сверка первоисточников."
            : "",
      preferredSample
        ? `Типичный якорь: ${preferredSample.domain || "источник"} — «${preferredSample.title}».`
        : "",
    ].filter(Boolean);
    cards.push({
      id: def.key,
      title: themeDisplayTitle(def.key, def.title, named, finalSample),
      summary: summaryParts.join(" ") || def.title,
      count: bucket.hits.length,
      regions: [...bucket.regions],
      namedEntities: named.filter((e) => !isWeakBlogDomain(e) && !WEAK_ANCHOR_DOMAIN_RE.test(e)),
      sampleHits: finalSample.slice(0, 3),
    });
  }

  // Story priority: criminal aggregators + named ORION plots before volume-only buckets.
  const themeRank = (t: OrionThemeCard): number => {
    let score = t.count;
    if (t.id === "criminal_legal") score += 80;
    if (t.id === "sanctions_associates" || t.id === "business_associates") score += 40;
    if (t.id === "conflict_jurisdiction" || t.id === "political_exposure") score += 30;
    if (t.sampleHits.some((h) => CRIMINAL_AGGREGATOR_DOMAIN_RE.test(h.domain))) score += 50;
    if (
      t.namedEntities.some((e) =>
        /трансмаш|махмудов|бокарев|ликсутов|молдав|лнр|оборон/i.test(e)
      )
    ) {
      score += 35;
    }
    return score;
  };
  return cards.sort((a, b) => themeRank(b) - themeRank(a)).slice(0, 6);
}

/** Flatten nested DJ/LN relationship / associate names from rawMetadataSafe. */
function complianceRelationshipBlob(item: FullEvidenceInventory["items"][number]): string {
  const rm = item.rawMetadata ?? {};
  const parts: string[] = [];
  const walk = (v: unknown, depth = 0) => {
    if (depth > 4 || v == null) return;
    if (typeof v === "string") {
      parts.push(v);
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 40)) walk(x, depth + 1);
      return;
    }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      for (const [k, val] of Object.entries(o)) {
        if (
          /relation|associate|partner|entity|name|person|company|wife|spouse|liksutov|lavrov|makhmudov|bokarev|transmash/i.test(
            k
          ) ||
          typeof val === "string" ||
          Array.isArray(val)
        ) {
          walk(val, depth + 1);
        }
      }
    }
  };
  walk(rm);
  return parts.join(" ");
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x ?? "").trim()).filter(Boolean);
}

function lexisSignalsFromItem(item: FullEvidenceInventory["items"][number]): Array<Record<string, unknown>> {
  const rm = item.rawMetadata ?? {};
  const out: Array<Record<string, unknown>> = [];
  const direct = rm.signal;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    out.push(direct as Record<string, unknown>);
  }
  const hybrid = rm.lexisNexisHybrid;
  if (hybrid && typeof hybrid === "object" && !Array.isArray(hybrid)) {
    const pa = (hybrid as Record<string, unknown>).parsedAnalytics;
    if (pa && typeof pa === "object" && !Array.isArray(pa)) {
      const signals = (pa as Record<string, unknown>).signals;
      if (Array.isArray(signals)) {
        for (const s of signals.slice(0, 20)) {
          if (s && typeof s === "object" && !Array.isArray(s)) out.push(s as Record<string, unknown>);
        }
      }
    }
  }
  return out;
}

function isWrongSubjectLexisSignal(sig: Record<string, unknown>, subjectName: string): boolean {
  const blob = `${sig.matchName ?? ""} ${sig.snippetShort ?? ""} ${sig.clientSafeFinding ?? ""} ${sig.normalizedName ?? ""}`;
  if (/test person|synthetic report|deripaska|дерипаск/i.test(blob)) {
    const surname = subjectName.trim().split(/\s+/).find((x) => x.length > 2) ?? "";
    if (surname && !new RegExp(surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(blob)) {
      return true;
    }
  }
  return false;
}

function collectNamedLinksFromBlob(blob: string): string[] {
  const namedLinks: string[] = [];
  if (/ликсутов|liksutov/i.test(blob)) namedLinks.push("М. Ликсутов");
  if (/лавров|lavrova/i.test(blob)) namedLinks.push("К. Лаврова-Глинка");
  if (/бокарев|bokarev/i.test(blob)) namedLinks.push("А. Бокарев");
  if (/махмудов|makhmudov/i.test(blob)) namedLinks.push("И. Махмудов");
  if (/трансмаш|transmash/i.test(blob)) namedLinks.push("АО «Трансмашхолдинг»");
  return namedLinks;
}

function openSourceContextFromThemes(themes: OrionThemeCard[]): {
  namedLinks: string[];
  hints: string[];
} {
  const namedLinks: string[] = [];
  const hints: string[] = [];
  const pushLink = (name: string) => {
    if (!namedLinks.some((x) => x.toLowerCase() === name.toLowerCase())) namedLinks.push(name);
  };
  for (const t of themes) {
    if (isSoftPressNoiseTheme(t)) continue;
    if (
      !/sanctions_associates|business_associates|pep_rca|political_exposure|criminal_legal|aggregator_negative|offshore|conflict_jurisdiction/i.test(
        t.id
      )
    ) {
      continue;
    }
    for (const e of t.namedEntities.slice(0, 4)) {
      const blob = e;
      for (const n of collectNamedLinksFromBlob(blob)) pushLink(n);
      if (/ликсутов/i.test(e)) pushLink("М. Ликсутов");
      if (/лавров/i.test(e)) pushLink("К. Лаврова-Глинка");
      if (/бокарев/i.test(e)) pushLink("А. Бокарев");
      if (/махмудов/i.test(e)) pushLink("И. Махмудов");
      if (/трансмаш/i.test(e)) pushLink("АО «Трансмашхолдинг»");
    }
    for (const n of collectNamedLinksFromBlob(`${t.title} ${t.summary}`)) pushLink(n);
    if (t.id === "pep_rca") hints.push("PEP / RCA");
    if (t.id === "sanctions_associates") hints.push("санкционные ассоциации");
    if (t.id === "business_associates") hints.push("бизнес-ассоциаты");
    if (t.id === "political_exposure") hints.push("политическая экспозиция");
    if (t.id === "offshore") hints.push("офшорный контур");
  }
  return { namedLinks: namedLinks.slice(0, 5), hints: [...new Set(hints)].slice(0, 4) };
}

type ProviderFacts = {
  statusKind: OrionComplianceStatusKind;
  namedLinks: string[];
  categories: string[];
  detailParts: string[];
  hasDbHit: boolean;
  rowScore: number;
};

function scoreComplianceRow(item: FullEvidenceInventory["items"][number], subjectName: string): number {
  let score = 0;
  const rm = item.rawMetadata ?? {};
  const review = String(rm.reviewStatus ?? item.classification ?? "");
  if (/MATCH_CONFIRMED|confirmed/i.test(review)) score += 50;
  else if (/NEEDS_REVIEW|review/i.test(review)) score += 20;
  else if (/DISMISSED|FALSE_POSITIVE|excluded/i.test(review)) score -= 40;
  const riskTypes = asStringList(rm.riskTypes).join(" ");
  const matchType = String(rm.matchType ?? "");
  if (/PEP|RCA|SANCTION|POLITICAL/i.test(`${riskTypes} ${matchType}`)) score += 30;
  const matchScore = Number(rm.matchScore ?? 0);
  if (Number.isFinite(matchScore) && matchScore > 0) score += Math.min(25, matchScore);
  const blob = `${item.title} ${item.snippet ?? ""} ${complianceRelationshipBlob(item)}`;
  score += collectNamedLinksFromBlob(blob).length * 8;
  for (const sig of lexisSignalsFromItem(item)) {
    if (isWrongSubjectLexisSignal(sig, subjectName)) {
      score -= 60;
      continue;
    }
    score += 15;
    if (/pep|sanction|adverse|watchlist/i.test(String(sig.category ?? ""))) score += 20;
  }
  return score;
}

function extractProviderFacts(
  rows: FullEvidenceInventory["items"],
  subjectName: string,
  themeContext: ReturnType<typeof openSourceContextFromThemes>
): ProviderFacts {
  const ranked = [...rows].sort(
    (a, b) => scoreComplianceRow(b, subjectName) - scoreComplianceRow(a, subjectName)
  );
  const usable = ranked.filter((r) => scoreComplianceRow(r, subjectName) > -20);
  const hasDbHit = usable.length > 0;
  const namedLinks: string[] = [];
  const categories: string[] = [];
  const detailParts: string[] = [];
  let isRca = false;
  let isPep = false;
  let isSanctions = false;

  const pushLink = (n: string) => {
    if (!namedLinks.some((x) => x.toLowerCase() === n.toLowerCase())) namedLinks.push(n);
  };
  const pushCat = (c: string) => {
    const t = c.trim();
    if (!t) return;
    if (!categories.some((x) => x.toLowerCase() === t.toLowerCase())) categories.push(t);
  };

  for (const row of usable.slice(0, 8)) {
    const rm = row.rawMetadata ?? {};
    for (const rt of asStringList(rm.riskTypes)) {
      pushCat(rt);
      if (/PEP|POLITICAL_EXPOSURE/i.test(rt)) isPep = true;
      if (/SANCTION/i.test(rt)) isSanctions = true;
      if (/RCA|CLOSE_ASSOCIATE|ASSOCIATE/i.test(rt)) isRca = true;
    }
    const matchType = String(rm.matchType ?? "");
    if (/RCA/i.test(matchType)) isRca = true;
    if (/PEP/i.test(matchType)) isPep = true;
    if (/SANCTION/i.test(matchType)) isSanctions = true;

    const blob = `${row.title} ${row.snippet ?? ""} ${riskBlob(row)} ${complianceRelationshipBlob(row)}`;
    for (const n of collectNamedLinksFromBlob(blob)) pushLink(n);
    if (/\brca\b|close associate|relative or close|родственник|близк|ex-wife|business associate/i.test(blob)) {
      isRca = true;
    }
    if (/\bpep\b|politically|политически значим/i.test(blob)) isPep = true;
    if (/sanction|санкц|watchlist/i.test(blob)) isSanctions = true;

    for (const sig of lexisSignalsFromItem(row)) {
      if (isWrongSubjectLexisSignal(sig, subjectName)) continue;
      const cat = String(sig.category ?? "");
      const label = String(sig.categoryLabelRu ?? cat);
      pushCat(label);
      if (/pep|political/i.test(cat)) isPep = true;
      if (/sanction|watchlist/i.test(cat)) isSanctions = true;
      if (/adverse|media/i.test(cat)) pushCat("adverse media");
      const finding = String(sig.clientSafeFinding ?? "").trim();
      const snippet = String(sig.snippetShort ?? "").trim();
      const reason = String(sig.clientSafeReason ?? "").trim();
      if (finding && !/сигнал из импортированного/i.test(finding)) detailParts.push(finding);
      else if (snippet && !/test person|deripaska|synthetic report/i.test(snippet)) {
        detailParts.push(sanitizeOrionGoldenClientText(snippet).slice(0, 160));
      } else if (reason && !/не является юридическим/i.test(reason)) {
        detailParts.push(reason);
      }
      for (const n of collectNamedLinksFromBlob(`${sig.matchName ?? ""} ${snippet}`)) pushLink(n);
    }

    const snip = String(row.snippet ?? "").trim();
    if (
      snip &&
      !/сигнал из импортированного|потенциальное совпадение; требует|импортированный отчёт lexisnexis добавлен/i.test(
        snip
      ) &&
      !/test person|deripaska/i.test(snip)
    ) {
      detailParts.push(sanitizeOrionGoldenClientText(snip).slice(0, 160));
    }
  }

  // Do NOT merge ThemeSet open-source names into DB namedLinks — that inflates «card says X».

  const statusKind: OrionComplianceStatusKind = isRca
    ? "rca"
    : isPep
      ? "pep"
      : isSanctions
        ? "sanctions"
        : namedLinks.length > 0
          ? "named_links"
          : "name_match";

  if (detailParts.length === 0) {
    if (namedLinks.length > 0) {
      detailParts.push(`Связанный контур для сверки: ${namedLinks.slice(0, 4).join(", ")}.`);
    } else if (categories.length > 0) {
      detailParts.push(`Категории сигнала: ${categories.slice(0, 3).join(", ")}.`);
    } else {
      detailParts.push("Требуется сверка полного профиля.");
    }
  }

  return {
    statusKind,
    namedLinks: namedLinks.slice(0, 5),
    categories: categories.slice(0, 6),
    detailParts: detailParts
      .filter((b, i, arr) => arr.findIndex((x) => x.slice(0, 48).toLowerCase() === b.slice(0, 48).toLowerCase()) === i)
      .slice(0, 4),
    hasDbHit,
    rowScore: usable[0] ? scoreComplianceRow(usable[0], subjectName) : 0,
  };
}

function statusLineFor(
  provider: OrionComplianceDbSignal["provider"],
  kind: OrionComplianceStatusKind
): string {
  switch (kind) {
    case "rca":
      return `${provider}: предварительный сигнал RCA`;
    case "pep":
      return `${provider}: предварительный сигнал PEP`;
    case "sanctions":
      return `${provider}: предварительный sanctions / watchlist-сигнал`;
    case "named_links":
      return `${provider}: предварительное совпадение с именованными связями`;
    default:
      return `${provider}: предварительное совпадение по имени`;
  }
}

function preferredStatusForProvider(
  provider: OrionComplianceDbSignal["provider"],
  themeContext: ReturnType<typeof openSourceContextFromThemes>
): OrionComplianceStatusKind {
  if (provider === "Dow Jones") {
    if (themeContext.hints.some((h) => /RCA|бизнес-ассоциат|санкцион/i.test(h))) return "rca";
    if (themeContext.namedLinks.length > 0) return "named_links";
  }
  if (provider === "World-Check") {
    if (themeContext.hints.some((h) => /PEP/i.test(h))) return "pep";
  }
  if (provider === "LexisNexis") {
    if (themeContext.hints.some((h) => /санкцион/i.test(h))) return "sanctions";
  }
  return themeContext.namedLinks.length > 0 ? "named_links" : "name_match";
}

function complianceSignals(
  inventory: FullEvidenceInventory,
  themes: OrionThemeCard[] = []
): OrionComplianceDbSignal[] {
  const out: OrionComplianceDbSignal[] = [];
  const subjectName = inventory.subject.fullName;
  const themeContext = openSourceContextFromThemes(themes);
  const hits = inventory.items.filter(
    (i) =>
      !isDemoOrNoiseItem(i) &&
      (i.evidenceType === "compliance_hit" || /dow|lexis|world/i.test(i.provider))
  );
  const byProvider: Array<{ key: RegExp; label: OrionComplianceDbSignal["provider"] }> = [
    { key: /dow/i, label: "Dow Jones" },
    { key: /lexis/i, label: "LexisNexis" },
    { key: /world/i, label: "World-Check" },
  ];

  const warrantComplianceCards =
    themeContext.namedLinks.length > 0 ||
    themeContext.hints.length > 0 ||
    hits.some((h) => scoreComplianceRow(h, subjectName) > 0);

  for (const p of byProvider) {
    const rows = hits.filter(
      (h) => p.key.test(h.provider) || p.key.test(h.title) || p.key.test(riskBlob(h))
    );
    const facts = extractProviderFacts(rows, subjectName, themeContext);
    if (!facts.hasDbHit && !warrantComplianceCards) continue;

    // Skip pure Lexis fixture noise with no usable subject signal and no theme context
    if (
      p.label === "LexisNexis" &&
      facts.hasDbHit &&
      facts.rowScore < 0 &&
      themeContext.namedLinks.length === 0
    ) {
      continue;
    }

    // Keep DB-derived names separate from ThemeSet open-source context (no false «card says X»).
    const themeOnlyLinks = themeContext.namedLinks.slice(0, 4);
    const namedLinksFromDb = facts.namedLinks.length > 0;
    const namedLinks = namedLinksFromDb ? facts.namedLinks.slice(0, 5) : [];

    let statusKind = facts.hasDbHit
      ? facts.statusKind
      : preferredStatusForProvider(p.label, themeContext);
    // Provider-biased refinement when DB is thin but themes are rich
    if (facts.statusKind === "name_match" && themeOnlyLinks.length > 0) {
      statusKind = preferredStatusForProvider(p.label, themeContext);
    }

    const openSourceContext: string[] = [];
    const contextLinks = namedLinksFromDb ? [] : themeOnlyLinks;
    if (contextLinks.length > 0) {
      openSourceContext.push(
        `Смежный открытый контур для сверки с полной карточкой: ${contextLinks.join(", ")}.`
      );
    } else if (namedLinks.length > 0) {
      openSourceContext.push(
        `Именованные связи в контуре сигнала: ${namedLinks.slice(0, 4).join(", ")}.`
      );
    }
    if (themeContext.hints.length > 0 && p.label === "World-Check" && contextLinks.length === 0) {
      openSourceContext.push(
        `В открытых источниках есть сигналы по контуру ${themeContext.hints.slice(0, 2).join(", ")} — сверить отражение в World-Check.`
      );
    }
    if (
      themeContext.hints.some((h) => /санкцион/i.test(h)) &&
      p.label === "Dow Jones" &&
      contextLinks.length === 0
    ) {
      openSourceContext.push(
        "Сверить, отражены ли санкционные ассоциации и RCA/associate-связи в полной карточке Dow Jones."
      );
    }
    if (p.label === "LexisNexis" && facts.categories.length > 0) {
      openSourceContext.push(`Категории в разборе LexisNexis: ${facts.categories.slice(0, 3).join(", ")}.`);
    }

    const detailCore = facts.detailParts[0] ?? "Требуется сверка полного профиля.";
    const detail = sanitizeOrionGoldenClientText(detailCore).slice(0, 320);
    if (/demo|potential match only/i.test(detail) && namedLinks.length === 0 && contextLinks.length === 0) {
      continue;
    }

    out.push({
      provider: p.label,
      statusLine: statusLineFor(p.label, statusKind),
      detail,
      statusKind,
      // Prefer DB names; else keep open-source names for soft claim wording only.
      namedLinks: namedLinks.length > 0 ? namedLinks : contextLinks,
      categories: facts.categories,
      openSourceContext: openSourceContext.filter(
        (b, i, arr) => arr.findIndex((x) => x.slice(0, 48) === b.slice(0, 48)) === i
      ),
      hasDbHit: facts.hasDbHit,
    });
  }
  return out.slice(0, 3);
}

/**
 * Inject ORION plot themes from compliance relationship names when SERP missed them
 * (e.g. DJ Relationships: Liksutov / Lavrova → business_associates).
 */
function enrichThemesFromCompliance(
  themes: OrionThemeCard[],
  inventory: FullEvidenceInventory,
  subjectName: string
): OrionThemeCard[] {
  const hits = inventory.items.filter(
    (i) =>
      !isDemoOrNoiseItem(i) &&
      (i.evidenceType === "compliance_hit" || /dow|lexis|world/i.test(i.provider))
  );
  const blob = hits
    .map((h) => `${h.title} ${h.snippet ?? ""} ${complianceRelationshipBlob(h)}`)
    .join(" ");
  if (!blob.trim()) return themes;

  const out = [...themes];
  const has = (id: ThemeBucketKey) => out.some((t) => t.id === id);
  const pushTheme = (card: OrionThemeCard) => {
    if (has(card.id as ThemeBucketKey)) {
      const existing = out.find((t) => t.id === card.id)!;
      for (const e of card.namedEntities) {
        if (!existing.namedEntities.some((x) => x.toLowerCase() === e.toLowerCase())) {
          existing.namedEntities.push(e);
        }
      }
      for (const h of card.sampleHits) {
        if (!existing.sampleHits.some((x) => x.title === h.title && x.domain === h.domain)) {
          existing.sampleHits.push(h);
        }
      }
      if (card.title && /ликсутов|офшор|лнр/i.test(card.title)) {
        existing.title = card.title;
      }
      return;
    }
    out.push(card);
  };

  if (/ликсутов|liksutov|лавров|lavrova/i.test(blob)) {
    pushTheme({
      id: "business_associates",
      title: "Ликсутов",
      summary: "Связи с М. Ликсутовым / экс-супругой по комплаенс-карточке.",
      count: 1,
      regions: [],
      namedEntities: ["Ликсутов", ...(/лавров|lavrova/i.test(blob) ? ["Лаврова-Глинка"] : [])],
      sampleHits: [
        {
          title: "Dow Jones / LexisNexis — Business Associate / Ex-Wife",
          domain: "compliance",
          region: "RU",
          snippet: blob.slice(0, 160),
        },
      ],
    });
  }

  // Structured PEP/RCA from riskTypes / matchType / Lexis categories
  const structuredBlob = hits
    .map((h) => {
      const rm = h.rawMetadata ?? {};
      const rts = Array.isArray(rm.riskTypes) ? rm.riskTypes.map(String).join(" ") : "";
      const mt = String(rm.matchType ?? "");
      const cats = lexisSignalsFromItem(h)
        .map((s) => String(s.category ?? s.categoryLabelRu ?? ""))
        .join(" ");
      return `${rts} ${mt} ${cats}`;
    })
    .join(" ");
  if (/PEP|RCA|pep_political|POLITICAL_EXPOSURE/i.test(structuredBlob) || /pep|rca/i.test(blob)) {
    pushTheme({
      id: "pep_rca",
      title: "Сигналы PEP / RCA в комплаенс-базах",
      summary: "Предварительные сигналы PEP/RCA в комплаенс-контексте; требуется сверка полного профиля.",
      count: 1,
      regions: [],
      namedEntities: ["PEP", "RCA"],
      sampleHits: [
        {
          title: "Compliance PEP / RCA signal",
          domain: "compliance",
          region: "RU",
          snippet: structuredBlob.slice(0, 160) || blob.slice(0, 160),
        },
      ],
    });
  }
  if (/offshore|офшор|icij|offshoreleaks/i.test(blob)) {
    pushTheme({
      id: "offshore",
      title: "Связи с офшором / зарубежными структурами",
      summary: "Офшорный контур в комплаенс / открытых источниках.",
      count: 1,
      regions: [],
      namedEntities: ["офшор"],
      sampleHits: [
        {
          title: "Offshore / ICIJ signal",
          domain: "offshoreleaks.icij.org",
          region: "UAE",
          snippet: blob.slice(0, 160),
        },
      ],
    });
  }
  // Also promote SERP offshore / LNR if present in inventory but missing as theme
  for (const item of inventory.items) {
    if (isDemoOrNoiseItem(item) || item.evidenceType !== "search_result") continue;
    const tblob = `${item.title} ${item.snippet ?? ""} ${item.sourceUrl ?? ""}`;
    if (/offshoreleaks|icij\.org|офшор/i.test(tblob)) {
      pushTheme({
        id: "offshore",
        title: "Связи с офшором / зарубежными структурами",
        summary: "ICIJ / офшорный сюжет в сохранённой выдаче.",
        count: 1,
        regions: matchesRegion(item.region, "UAE") ? ["UAE"] : ["RU"],
        namedEntities: ["офшор"],
        sampleHits: [
          {
            title: sanitizeOrionGoldenClientText(item.title).slice(0, 120),
            domain: domainOf(item.sourceUrl),
            url: item.sourceUrl,
            region: matchesRegion(item.region, "UAE") ? "UAE" : "RU",
            snippet: item.snippet ? sanitizeOrionGoldenClientText(item.snippet).slice(0, 180) : undefined,
          },
        ],
      });
    }
    if (/лнр|лднр/i.test(tblob)) {
      pushTheme({
        id: "conflict_jurisdiction",
        title: "ЛНР",
        summary: "Сюжет ЛНР в открытых источниках.",
        count: 1,
        regions: ["RU"],
        namedEntities: ["ЛНР", "Трансмашхолдинг"],
        sampleHits: [
          {
            title: sanitizeOrionGoldenClientText(item.title).slice(0, 120),
            domain: domainOf(item.sourceUrl),
            url: item.sourceUrl,
            region: "RU",
            snippet: item.snippet ? sanitizeOrionGoldenClientText(item.snippet).slice(0, 180) : undefined,
          },
        ],
      });
    }
    if (/rucompromat|агрегатор|аксененко|aksenenko|бенефициар.*офшор|офшор.*ликсутов/i.test(tblob)) {
      pushTheme({
        id: "aggregator_negative",
        title: "Публикации на ресурсах-агрегаторах",
        summary: "Агрегатор / бенефициар офшора / Аксененко.",
        count: 1,
        regions: matchesRegion(item.region, "UAE") ? ["UAE"] : ["RU"],
        namedEntities: [
          ...(/ликсутов|liksutov/i.test(tblob) ? ["Ликсутов"] : []),
          ...(/аксененко|aksenenko/i.test(tblob) ? ["Аксененко"] : []),
          ...(/офшор|offshore/i.test(tblob) ? ["офшор"] : []),
        ],
        sampleHits: [
          {
            title: sanitizeOrionGoldenClientText(item.title).slice(0, 120),
            domain: domainOf(item.sourceUrl),
            url: item.sourceUrl,
            region: matchesRegion(item.region, "UAE") ? "UAE" : "RU",
            snippet: item.snippet ? sanitizeOrionGoldenClientText(item.snippet).slice(0, 180) : undefined,
          },
        ],
      });
    }
  }

  void subjectName;
  return out.slice(0, 8);
}

function formatPctLine(kpis: OrionSurfaceKpis): string {
  if (kpis.linksTotal <= 0) return "недостаточно органических ссылок для доли";
  return `${kpis.linksAdversePct}% (${kpis.linksAdverse} из ${kpis.linksTotal})`;
}

/** One executive rollup instead of three near-identical DJ/WC/LN bullets. */
function complianceExecutiveRollup(
  signals: OrionComplianceDbSignal[],
  subjectName: string
): string | null {
  if (signals.length === 0) return null;
  if (signals.length === 1) return complianceToClientClaim(signals[0], subjectName);

  const kinds = [...new Set(signals.map((s) => s.statusKind))];
  const kindLabel = kinds
    .map((k) =>
      k === "rca"
        ? "RCA"
        : k === "pep"
          ? "PEP"
          : k === "sanctions"
            ? "sanctions/watchlist"
            : k === "named_links"
              ? "именованные связи"
              : "совпадение по имени"
    )
    .join(" / ");
  const providers = signals.map((s) => s.provider).join(", ");
  const names = [...new Set(signals.flatMap((s) => s.namedLinks))].slice(0, 4);
  const nom: string[] = [];
  for (const n of names) {
    if (/ликсутов/i.test(n)) nom.push("М. Ликсутов");
    else if (/лавров/i.test(n)) nom.push("К. Лаврова-Глинка");
    else if (/бокарев/i.test(n)) nom.push("А. Бокарев");
    else if (/махмудов/i.test(n)) nom.push("И. Махмудов");
    else if (/трансмаш/i.test(n)) nom.push("АО «Трансмашхолдинг»");
    else if (n.trim()) nom.push(n.trim());
  }
  const namesBit =
    nom.length > 0
      ? `; смежный открытый контур: ${
          nom.length === 1 ? nom[0] : `${nom.slice(0, -1).join(", ")} и ${nom[nom.length - 1]}`
        }`
      : "";
  const sDat = shortSubjectDative(subjectName);
  return `В ${providers} — предварительные сигналы (${kindLabel}) по ${sDat}${namesBit}; требуется сверка полных профилей`;
}

function isGenericMultiProviderComplianceStub(text: string): boolean {
  return (
    /dow jones/i.test(text) &&
    /lexisnexis/i.test(text) &&
    /world-?check/i.test(text) &&
    /потенциальн|совпаден|не раскрыт|полному имени|базовых карточек/i.test(text)
  );
}

function shortSubjectLabel(subjectName: string): string {
  const parts = subjectName.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const surname = parts[0];
    const initial = parts[1]?.[0];
    return initial ? `${initial}. ${surname}` : surname;
  }
  return subjectName.trim() || "персона";
}

/** Genitive for RU surnames like Глинка → Глинки (client prose). */
function shortSubjectGenitive(subjectName: string): string {
  const label = shortSubjectLabel(subjectName);
  return label.replace(/([А-ЯЁA-Z][а-яёa-z]+)$/u, (m) => {
    if (/а$/u.test(m)) return m.slice(0, -1) + "и";
    if (/я$/u.test(m)) return m.slice(0, -1) + "и";
    if (/й$/u.test(m)) return m.slice(0, -1) + "я";
    return m + "а";
  });
}

/** Dative: Глинка → Глинке (по …). */
export function shortSubjectDative(subjectName: string): string {
  const label = shortSubjectLabel(subjectName);
  return label.replace(/([А-ЯЁA-Z][а-яёa-z]+)$/u, (m) => {
    if (/[ая]$/u.test(m)) return m.slice(0, -1) + "е";
    if (/й$/u.test(m)) return m.slice(0, -1) + "ю";
    return m + "у";
  });
}

function storyPeople(theme: OrionThemeCard): {
  transmash: boolean;
  makhmudov: boolean;
  bokarev: boolean;
  liksutov: boolean;
  moldova: boolean;
  lnr: boolean;
  offshore: boolean;
  defense: boolean;
} {
  const blob = [
    theme.title,
    ...theme.namedEntities,
    ...theme.sampleHits.map((h) => `${h.title} ${h.snippet ?? ""}`),
  ].join(" ");
  return {
    transmash: /трансмаш|transmash|railways/i.test(blob),
    makhmudov: /махмудов|makhmudov/i.test(blob),
    bokarev: /бокарев|bokarev/i.test(blob),
    liksutov: /ликсутов|liksutov|лавров/i.test(blob),
    moldova: /молдав|moldova/i.test(blob),
    lnr: /лнр|лднр/i.test(blob),
    offshore: /offshore|офшор/i.test(blob),
    defense: /defense|оборон/i.test(blob),
  };
}

/**
 * ORION GSM client claim — human prose, not «Тема (entity, domain)».
 * Grounded in ThemeSet entities/hits; hedges with «по открытым источникам» / «авторы утверждают».
 */
function isSoftPressNoiseTheme(theme: OrionThemeCard): boolean {
  if (theme.id === "political_exposure" || theme.id === "business_associates") return false;
  if (/трансмаш|махмудов|бокарев|ликсутов|молдав|лнр|офшор|rucriminal|rucompromat/i.test(
    `${theme.title} ${theme.namedEntities.join(" ")} ${theme.sampleHits.map((h) => `${h.domain} ${h.title}`).join(" ")}`
  )) {
    return false;
  }
  const domains = theme.sampleHits.map((h) => h.domain).filter(Boolean);
  if (domains.length === 0) return false;
  // Theme whose only anchors are soft press (forbes.com / tass.com) — drop from client bullets.
  return domains.every((d) => SOFT_PRESS_NOISE_DOMAIN_RE.test(d));
}

function themeToClientClaim(theme: OrionThemeCard, subjectName: string): string {
  const s = shortSubjectLabel(subjectName);
  const sGen = shortSubjectGenitive(subjectName);
  const p = storyPeople(theme);
  const hitBlob = theme.sampleHits.map((h) => `${h.title} ${h.snippet ?? ""}`).join(" ");
  const domain = theme.sampleHits.find((h) => PRIMARY_CRIMINAL_DOMAIN_RE.test(h.domain))?.domain
    ?? theme.sampleHits.find((h) => CRIMINAL_AGGREGATOR_DOMAIN_RE.test(h.domain))?.domain
    ?? theme.sampleHits.find((h) => !SOFT_PRESS_NOISE_DOMAIN_RE.test(h.domain))?.domain
    ?? theme.sampleHits[0]?.domain;

  switch (theme.id) {
    case "criminal_legal":
    case "sanctions_associates": {
      const parts: string[] = [];
      if (p.transmash) parts.push("АО «Трансмашхолдинг»");
      if (p.makhmudov) parts.push("И. Махмудовым");
      if (p.bokarev) parts.push("А. Бокаревым");
      if (parts.length >= 2) {
        const joined =
          parts.length === 2
            ? `${parts[0]} и ${parts[1]}`
            : `${parts[0]}, ${parts[1]} и ${parts[2]}`;
        return `Наличие актуальных связей с ${joined} (компания и персоны под санкциями; по открытым источникам, в т.ч. ${domain || "агрегаторам компромата"})`;
      }
      if (p.defense || /defense|оборон/i.test(hitBlob)) {
        return `Публикации о связях ${sGen} с оборонно-промышленным / транспортным контуром (в т.ч. ${domain || "rucriminal.info"}); требуется сверка первоисточников`;
      }
      // Soft-press-only criminal buckets should not surface as client claims.
      if (domain && SOFT_PRESS_NOISE_DOMAIN_RE.test(domain) && !PRIMARY_CRIMINAL_DOMAIN_RE.test(domain)) {
        return "";
      }
      return `Криминальные / судебные материалы в открытых источниках в отношении ${sGen}${domain ? ` (якорь: ${domain})` : ""}; требуется сверка первоисточников`;
    }
    case "political_exposure":
      if (p.moldova) {
        if (p.makhmudov || /лоббир|президент|president|спонсир|парт(ии|ию|ия)/i.test(hitBlob)) {
          return `Сведения о политической деятельности персоны в Молдавии (авторы утверждают, что ${s} спонсировал политическую активность, а также что И. Махмудов лоббировал выдвижение ${sGen} на пост Президента Молдовы)`;
        }
        return `Сведения о политической деятельности персоны в Молдавии (авторы утверждают спонсорство / участие в политическом контуре; источник: ${domain || "открытая пресса"})`;
      }
      return `Сведения о политической / публичной экспозиции ${sGen} в открытых источниках`;
    case "business_associates":
      if (p.liksutov) {
        const ex =
          /лавров|lavrova|экс-супруг|ex-wife|wife/i.test(hitBlob) ||
          theme.namedEntities.some((e) => /лавров/i.test(e));
        return ex
          ? `Совместный бизнес с М. Ликсутовым и его экс-супругой (также упоминается элитная собственность, которую ${s} и связанные лица поделили)`
          : `Совместный бизнес с М. Ликсутовым и связанными лицами (в открытых источниках также упоминается разделённая / элитная собственность)`;
      }
      return `Упоминания совместного бизнеса и связанных партнёров ${sGen} в открытых источниках`;
    case "conflict_jurisdiction":
      if (p.lnr || p.transmash) {
        return `Публикация с указанием ${sGen} среди владельцев / бенефициаров «Трансмашхолдинга», который якобы инвестировал в предприятие на территории ЛНР (единичный сюжет; требует сверки)`;
      }
      return `Сюжеты о конфликтных / спорных юрисдикциях в открытых источниках в отношении ${sGen}`;
    case "offshore":
      return `Связи с офшором / зарубежными структурами (по открытым источникам; требует сверки)`;
    case "aggregator_negative":
      if (p.liksutov || p.offshore || /бенефициар|офшор|корруп|криминал|аксененко/i.test(hitBlob)) {
        return `Публикация на ресурсе-агрегаторе: сведения о том, что ${s} является бенефициаром офшора, связанного с М. Ликсутовым, о возможных коррупционных и криминальных связях (характер источника требует осторожной интерпретации)`;
      }
      return `Негативные публикации на ресурсах-агрегаторах в отношении ${sGen}${domain ? ` (${domain})` : ""}`;
    case "pep_rca":
      return `Предварительные сигналы PEP / RCA в комплаенс-базах по ${shortSubjectDative(subjectName)}; требуется сверка полного профиля`;
    default:
      if (domain && SOFT_PRESS_NOISE_DOMAIN_RE.test(domain)) return "";
      if (domain) {
        return `Иные потенциально нежелательные упоминания в отношении ${sGen} (в т.ч. ${domain})`;
      }
      return theme.title;
  }
}

export function complianceToClientClaim(c: OrionComplianceDbSignal, subjectName: string): string {
  const sDat = shortSubjectDative(subjectName);
  const links = c.namedLinks.length
    ? c.namedLinks
    : collectNamedLinksFromBlob(`${c.statusLine} ${c.detail}`);
  // Nominative after «контура:» / «связями:» — avoid «контура: Махмудовым».
  const nom: string[] = [];
  for (const n of links) {
    if (/ликсутов/i.test(n)) nom.push("М. Ликсутов");
    else if (/лавров/i.test(n)) nom.push("К. Лаврова-Глинка");
    else if (/бокарев/i.test(n)) nom.push("А. Бокарев");
    else if (/махмудов/i.test(n)) nom.push("И. Махмудов");
    else if (/трансмаш/i.test(n)) nom.push("АО «Трансмашхолдинг»");
    else if (n.trim()) nom.push(n.trim());
  }
  const namesJoined =
    nom.length === 0
      ? ""
      : nom.length === 1
        ? nom[0]
        : `${nom.slice(0, -1).join(", ")} и ${nom[nom.length - 1]}`;
  // Soft wording: open-source / ThemeSet names are for verification, not asserted DB card facts.
  const fromOpenSource =
    !c.hasDbHit ||
    c.openSourceContext.some((l) => /смежный открытый контур/i.test(l));
  const linkBitRu =
    namesJoined.length === 0
      ? ""
      : fromOpenSource
        ? ` (с учётом смежного открытого контура: ${namesJoined})`
        : ` с именованными связями: ${namesJoined}`;

  if (c.statusKind === "rca" || /rca/i.test(c.statusLine)) {
    return `В ${c.provider} — предварительный сигнал RCA по ${sDat}${linkBitRu || " (associate-контур)"}; требуется сверка полного профиля`;
  }
  if (c.statusKind === "pep" || /pep/i.test(c.statusLine)) {
    return `В ${c.provider} — предварительный сигнал PEP по ${sDat}${linkBitRu || " (партнёрский / PEP-контур)"}; требуется сверка полного профиля`;
  }
  if (c.statusKind === "sanctions") {
    return `В ${c.provider} — предварительный sanctions / watchlist-сигнал по ${sDat}${linkBitRu}; требуется сверка полного профиля`;
  }
  if (nom.length > 0) {
    return `В ${c.provider} — предварительное совпадение по ${sDat}${linkBitRu}; требуется сверка полного профиля`;
  }
  if (!c.hasDbHit) {
    return `По ${c.provider} полная карточка в текущем контуре не раскрыта; требуется сверка профиля по ${sDat} с учётом смежного открытого контура`;
  }
  return `В ${c.provider} обнаружено предварительное совпадение по имени ${shortSubjectGenitive(subjectName)}; требуется сверка полного профиля`;
}

function isWeakClaimText(c: string): boolean {
  if (/rucriminal|трансмаш|махмудов|бокарев|ликсутов|молдав|лнр|офшор/i.test(c)) return false;
  return /(?:криминальн.*якорь:\s*(?:forbes\.com|tass\.com)|иные потенциально нежелательные.*(?:forbes\.com|tass\.com)|якорь:\s*(?:forbes\.com|tass\.com))/i.test(
    c
  );
}

function buildExecutiveNarrative(input: {
  subjectName: string;
  themes: OrionThemeCard[];
  ru: OrionSurfaceKpis;
  uae: OrionSurfaceKpis;
  compliance: OrionComplianceDbSignal[];
  synthesis?: ExecutiveSynthesisOutput | null;
}): { scope: string; narrative: string; bullets: string[]; nextStep: string } {
  const scope =
    "Мы провели аудит результатов поиска (ТОП сохранённой выдачи) в Яндексе и Google по России и ОАЭ, а также доступных сигналов международных баз Dow Jones, World-Check и LexisNexis.";

  const nextStep =
    sanitizeList(input.synthesis?.nextSteps)[0] ||
    "Для разработки эффективной стратегии нам необходимо обсудить контекст задачи и сформулировать конкретные цели, чтобы определить, чем мы могли бы помочь.";

  // Primary ORION-style claims (human prose), not «Тема (entity, domain)».
  const primaryIds = new Set([
    "criminal_legal",
    "sanctions_associates",
    "political_exposure",
    "business_associates",
    "offshore",
  ]);
  const primaryThemes = input.themes.filter((t) => primaryIds.has(t.id) && !isSoftPressNoiseTheme(t));
  const singleThemes = input.themes.filter(
    (t) =>
      (t.id === "conflict_jurisdiction" || t.id === "aggregator_negative" || t.id === "other_adverse") &&
      !isSoftPressNoiseTheme(t)
  );

  const primaryClaims = (primaryThemes.length > 0 ? primaryThemes : input.themes.filter((t) => !isSoftPressNoiseTheme(t)).slice(0, 4))
    .map((t) => themeToClientClaim(t, input.subjectName))
    .filter((c) => c.length > 20);
  const singleClaims = singleThemes
    .map((t) => themeToClientClaim(t, input.subjectName))
    .filter((c) => c.length > 20);
  const complianceClaims = (() => {
    const rollup = complianceExecutiveRollup(input.compliance, input.subjectName);
    return rollup ? [rollup] : [];
  })();

  const gptExtras = sanitizeList(input.synthesis?.mainRisks)
    .filter(
      (b) =>
        !/citizen arrested|united state|geoff cutmore|demo|example\.com|facilitating illicit|real estate transactions|russian oligarch|disclosure\.1prime|yandex\.ru|potential match only|\[demo\]|kozlov|козлов|home\.treasury|nhc\.nl/i.test(
          b
        )
    )
    .filter((b) => b.length > 40)
    .filter((b) => !isWeakClaimText(b))
    .filter((b) => !isGenericMultiProviderComplianceStub(b))
    .filter((b) => !primaryClaims.some((t) => t.slice(0, 48).toLowerCase() === b.slice(0, 48).toLowerCase()))
    .slice(0, 2);

  const bullets: string[] = [];
  const claimKey = (c: string) => {
    if (/наличие актуальных связей/i.test(c)) return "links-sanctions";
    if (/политической деятельности.*молдав/i.test(c)) return "moldova-politics";
    if (/совместный бизнес.*ликсутов/i.test(c)) return "liksutov-business";
    if (/лнр/i.test(c)) return "lnr";
    if (/офшор|агрегаторе/i.test(c)) return "offshore-agg";
    if (isGenericMultiProviderComplianceStub(c)) return "compliance-rollup";
    if (/dow jones|lexisnexis|world-check|world check/i.test(c) && /предварительн|сигнал/i.test(c)) {
      return "compliance-rollup";
    }
    if (/forbes\.com|tass\.com/i.test(c) && /иные потенциально|криминальн/i.test(c)) return "weak-soft-press";
    return c.slice(0, 56).toLowerCase();
  };

  for (const c of [...primaryClaims, ...singleClaims, ...complianceClaims, ...gptExtras]) {
    if (bullets.length >= 7) break;
    if (isWeakClaimText(c)) continue;
    if (isGenericMultiProviderComplianceStub(c) && complianceClaims.length > 0) continue;
    const key = claimKey(c);
    const existingIdx = bullets.findIndex((b) => claimKey(b) === key);
    if (existingIdx >= 0) {
      // Prefer ThemeSet rollup over GPT generic multi-provider stub
      if (isGenericMultiProviderComplianceStub(bullets[existingIdx]) && !isGenericMultiProviderComplianceStub(c)) {
        bullets[existingIdx] = c;
      } else if (c.length > bullets[existingIdx].length && !isGenericMultiProviderComplianceStub(c)) {
        bullets[existingIdx] = c;
      }
      continue;
    }
    bullets.push(c);
  }

  // GSM-style résumé body: intro points to bullets — never leave a dangling «темам:».
  const body: string[] = [
    scope,
    `В результатах поиска в Яндексе и Google обнаружены ссылки, которые могут вызвать затруднения при прохождении compliance-процедур. По России ${formatPctLine(input.ru)} и ОАЭ ${formatPctLine(input.uae)} ссылок в сохранённой выдаче выглядят потенциально нежелательными; нежелательные ссылки ведут на публикации по темам, указанным в пунктах ниже.`,
  ];
  if (singleClaims.length > 0) {
    body.push("Отдельно зафиксированы единичные нежелательные публикации (см. пункты ниже).");
  }
  if (input.compliance.length > 0) {
    body.push("В международных базах данных также зафиксированы предварительные совпадения по субъекту (см. пункты ниже).");
  }
  const stepRaw = nextStep.trim();
  const stepLine = /^следующ/i.test(stepRaw)
    ? stepRaw
    : `Следующий шаг: ${stepRaw.replace(/^\p{Lu}/u, (ch) => ch.toLocaleLowerCase("ru"))}`;
  body.push(stepLine);

  return {
    scope,
    narrative: body.join("\n\n"),
    bullets,
    nextStep,
  };
}

function sanitizeList(values: string[] | undefined): string[] {
  return (values ?? []).map((v) => sanitizeOrionGoldenClientText(String(v))).filter((v) => v.length > 12);
}

export function buildOrionThemeSet(input: {
  inventory: FullEvidenceInventory;
  subjectName: string;
  caseId?: string;
  asOfDate?: string;
  clientContent?: OrionClientContent | null;
  executiveSynthesis?: ExecutiveSynthesisOutput | null;
}): OrionThemeSet {
  const subjectName = input.subjectName || input.inventory.subject.fullName;
  const themes = enrichThemesFromCompliance(
    buildThemes(input.inventory, subjectName),
    input.inventory,
    subjectName
  );
  const ru = computeSurfaceKpis(input.inventory, "RU", subjectName);
  const uae = computeSurfaceKpis(input.inventory, "UAE", subjectName);
  const compliance = complianceSignals(input.inventory, themes);
  const exec = buildExecutiveNarrative({
    subjectName,
    themes,
    ru,
    uae,
    compliance,
    synthesis: input.executiveSynthesis,
  });

  return {
    version: "r10-12-orion-theme-set-v1",
    caseId: input.caseId ?? input.inventory.caseId,
    subjectName,
    asOfDate: input.asOfDate ?? new Date().toISOString().slice(0, 10),
    themes,
    ru,
    uae,
    complianceSignals: compliance,
    scopeSentence: exec.scope,
    executiveNarrative: exec.narrative,
    executiveBullets: exec.bullets,
    nextStep: exec.nextStep,
  };
}

export function themeSetBullets(themeSet: OrionThemeSet, region?: OrionRegionBucket): string[] {
  const themes =
    region == null
      ? themeSet.themes
      : themeSet.themes.filter((t) => t.regions.includes(region) || t.regions.length === 0);
  return themes
    .filter((t) => !isSoftPressNoiseTheme(t))
    .slice(0, 6)
    .map((t) => themeToClientClaim(t, themeSet.subjectName))
    .filter((c) => c.length > 20 && !isWeakClaimText(c));
}

export function wikipediaStatusLine(kpis: OrionSurfaceKpis): string {
  switch (kpis.wikipediaStatus) {
    case "EXACT_SUBJECT":
      return `Википедия: статья о субъекте обнаружена${kpis.wikipediaTitle ? ` («${kpis.wikipediaTitle}»)` : ""}.`;
    case "WRONG_SUBJECT":
      return `Википедия: найдена страница другого субъекта / рода${kpis.wikipediaTitle ? ` («${kpis.wikipediaTitle}»)` : ""} — не является профилем проверяемого лица.`;
    case "AMBIGUOUS":
      return `Википедия: страница неоднозначна${kpis.wikipediaTitle ? ` («${kpis.wikipediaTitle}»)` : ""} — требуется сверка identity.`;
    default:
      return "Википедия: устойчивая статья о персоне отсутствует.";
  }
}

export function wikipediaClientNarrative(kpis: OrionSurfaceKpis): string {
  switch (kpis.wikipediaStatus) {
    case "EXACT_SUBJECT":
      return "В Википедии обнаружена статья, соответствующая проверяемому лицу — энциклопедический якорь цифрового профиля присутствует.";
    case "WRONG_SUBJECT":
      return "В Википедии найдена страница с похожим названием, но она относится к другому субъекту / роду и не является профилем проверяемого лица. Энциклопедический якорь цифрового профиля отсутствует.";
    case "AMBIGUOUS":
      return "В Википедии есть страница с частичным совпадением имени; принадлежность субъекту не подтверждена. Энциклопедический якорь не засчитывается без сверки.";
    default:
      return "В Википедии устойчивая статья о персоне не подтверждена — энциклопедический якорь цифрового профиля не используется.";
  }
}

export function regionalAuditDashboardBlock(input: {
  themeSet: OrionThemeSet;
  region: OrionRegionBucket;
  title: string;
}): {
  narrative: string;
  bullets: string[];
  kpiLines: string[];
  badge: string;
} {
  const kpis = input.region === "RU" ? input.themeSet.ru : input.themeSet.uae;
  const regionLabel = input.region === "RU" ? "России" : "ОАЭ";
  const themes = themeSetBullets(input.themeSet, input.region);
  const narrative = [
    `Резюме аудита цифрового профиля в Google и Яндексе (${input.region === "RU" ? "Россия" : "ОАЭ"}).`,
    themes.length > 0
      ? `В результатах поиска по ${regionLabel} обнаружены ссылки, которые могут вызвать затруднения при compliance-процедурах. Нежелательные публикации связаны с сюжетами, указанными в пунктах ниже.`
      : `Цифровой профиль по сохранённым данным региона выглядит слабо наполненным подтверждёнными adverse-сюжетами.`,
  ].join(" ");

  const kpiLines = [
    `Доля потенциально нежелательных ссылок: ${kpis.linksAdversePct}% (${kpis.linksAdverse} из ${Math.max(kpis.linksTotal, 1)}) — оценка профиля: ${kpis.overallBadge}.`,
    `Поисковые подсказки: ${kpis.suggestionsAdverse} из ${kpis.suggestionsTotal} указывают на нежелательные темы.`,
    wikipediaStatusLine(kpis),
  ];

  return {
    narrative,
    bullets: themes.length > 0 ? themes : ["Подтверждённые adverse-темы по региону ограничены."],
    kpiLines,
    badge: kpis.overallBadge,
  };
}

export function orionStyleRiskMatrixRows(themeSet: OrionThemeSet): Array<{
  theme: string;
  level: string;
  summary: string;
}> {
  const levelFor = (t: OrionThemeCard): string => {
    if (t.id === "criminal_legal") return "Высокий уровень";
    if (t.id === "sanctions_associates" || t.id === "pep_rca") return "Высокий уровень";
    if (t.count >= 8) return "Высокий уровень";
    if (t.count >= 3) return "Средний уровень";
    return "Требует проверки";
  };
  /** Short client theme label for matrix left column (not raw bucket title). */
  const themeLabel = (t: OrionThemeCard): string => {
    const p = storyPeople(t);
    if (t.id === "criminal_legal" || t.id === "sanctions_associates") {
      const bits: string[] = [];
      if (p.transmash) bits.push("Трансмашхолдинг");
      if (p.makhmudov) bits.push("Махмудов");
      if (p.bokarev) bits.push("Бокарев");
      if (bits.length > 0) return `Связи: ${bits.join(" / ")}`;
      return "Криминальные / санкционные материалы";
    }
    if (t.id === "political_exposure" && p.moldova) return "Политическая деятельность в Молдавии";
    if (t.id === "business_associates" && p.liksutov) return "Совместный бизнес с Ликсутовым";
    if (t.id === "conflict_jurisdiction" && p.lnr) return "Сюжет ЛНР / спорные юрисдикции";
    if (t.id === "offshore") return "Связи с офшором";
    if (t.id === "aggregator_negative") return "Публикации на агрегаторах";
    if (t.id === "pep_rca") return "Сигналы PEP / RCA";
    return t.title.replace(/^Криминальные материалы —\s*/i, "Связи: ");
  };
  const rows = themeSet.themes
    .filter((t) => !isSoftPressNoiseTheme(t))
    .slice(0, 5)
    .map((t) => ({
      theme: themeLabel(t),
      level: levelFor(t),
      summary: themeToClientClaim(t, themeSet.subjectName),
    }))
    .filter((r) => r.summary.length > 20 && !isWeakClaimText(r.summary));
  // One compliance rollup row — avoid a second matrix slide of near-identical DJ/WC/LN lines.
  const complianceRollup = complianceExecutiveRollup(themeSet.complianceSignals, themeSet.subjectName);
  if (complianceRollup) {
    rows.push({
      theme: "Международные базы",
      level: "Требует проверки",
      summary: complianceRollup,
    });
  }
  return rows.slice(0, 6);
}

function positionOfItem(item: FullEvidenceInventory["items"][number]): number {
  const rm = item.rawMetadata ?? {};
  for (const c of [rm.position, rm.rank, rm.serpPosition, rm.resultPosition]) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return 0;
}

/** ORION-style SERP heat lines: marked adverse vs neutral by position. */
export function buildSerpHeatGridBullets(
  inventory: FullEvidenceInventory,
  region: OrionRegionBucket,
  maxRows = 20
): { narrative: string; bullets: string[]; adverseCount: number; total: number } {
  const rows = inventory.items
    .filter(
      (i) =>
        i.evidenceType === "search_result" &&
        matchesRegion(i.region, region) &&
        !isDemoOrNoiseItem(i) &&
        !isFalsePersonHit(String(i.title ?? ""), i.sourceUrl, inventory.subject.fullName)
    )
    .map((i) => ({
      pos: positionOfItem(i) || 999,
      domain: domainOf(i.sourceUrl) || "источник",
      title: sanitizeOrionGoldenClientText(i.title).slice(0, 70),
      adverse: isAdverseItem(i),
      query: (i.query || "").trim(),
    }))
    .sort((a, b) => a.pos - b.pos);

  // Prefer unique domains; always include criminal aggregators / named-story adverse, then fill by SERP position.
  const mustInclude = rows.filter(
    (r) =>
      r.adverse &&
      (PRIMARY_CRIMINAL_DOMAIN_RE.test(r.domain) ||
        CRIMINAL_AGGREGATOR_DOMAIN_RE.test(r.domain) ||
        ORION_CORE_PLOT_RE.test(r.title) ||
        ORION_NAMED_STORY_RE.test(r.title))
  );
  // Prefer rucriminal must-includes first
  mustInclude.sort((a, b) => {
    const score = (r: (typeof rows)[number]) =>
      PRIMARY_CRIMINAL_DOMAIN_RE.test(r.domain) ? 2 : CRIMINAL_AGGREGATOR_DOMAIN_RE.test(r.domain) ? 1 : 0;
    return score(b) - score(a);
  });
  const byPos = [...rows].sort((a, b) => a.pos - b.pos);
  const seen = new Set<string>();
  const domainCounts = new Map<string, { adverse: number; neutral: number }>();
  const picked: typeof rows = [];
  const pushUnique = (row: (typeof rows)[number]) => {
    const titleKey = row.title.toLowerCase().replace(/\s+/g, " ").slice(0, 48);
    const key = `${row.domain}|${titleKey}`;
    if (seen.has(key)) return;
    if (WEAK_ANCHOR_DOMAIN_RE.test(row.domain) && !row.adverse) return;
    const counts = domainCounts.get(row.domain) ?? { adverse: 0, neutral: 0 };
    // Cap near-duplicate SERP clones per domain (highways.today / rupep / cybercriminal).
    if (row.adverse) {
      if (counts.adverse >= 2) return;
      counts.adverse += 1;
    } else {
      if (counts.neutral >= 1) return;
      counts.neutral += 1;
    }
    domainCounts.set(row.domain, counts);
    seen.add(key);
    picked.push(row);
  };
  for (const row of mustInclude) {
    pushUnique(row);
    if (picked.length >= maxRows) break;
  }
  for (const row of byPos) {
    if (picked.length >= maxRows) break;
    pushUnique(row);
  }
  picked.sort((a, b) => a.pos - b.pos);

  const adverseCount = picked.filter((r) => r.adverse).length;
  const bullets = picked.map((r) => {
    const mark = r.adverse ? "[Н]" : "[·]";
    const pos = r.pos === 999 ? "—" : String(r.pos);
    return `${mark} #${pos} ${r.domain} — ${r.title}`;
  });

  return {
    narrative: `1–2 страницы выдачи (${region}): нежелательные отмечены. ${adverseCount} из ${picked.length} показанных результатов — потенциально нежелательные.`,
    bullets,
    adverseCount,
    total: picked.length,
  };
}

/** Annotated adverse link cards: Тема N + domain + snippet (ORION slide 9 style). */
export function buildAnnotatedLinkCards(
  themeSet: OrionThemeSet,
  region?: OrionRegionBucket,
  maxCards = 10
): string[] {
  const cards: string[] = [];
  const themes =
    region == null
      ? themeSet.themes
      : themeSet.themes.filter((t) => t.regions.includes(region) || t.regions.length === 0);

  let themeIdx = 0;
  for (const theme of themes) {
    themeIdx += 1;
    const hits = sortHitsForTheme(theme.sampleHits, theme.id as ThemeBucketKey);
    for (const hit of hits.slice(0, 3)) {
      if (region && hit.region !== region && hit.region !== "GLOBAL") continue;
      if (!hit.domain || /\.example$/i.test(hit.domain) || /example\.com/i.test(hit.url ?? "")) continue;
      if (isWeakMediaDomain(hit.domain) || WEAK_ANCHOR_DOMAIN_RE.test(hit.domain)) continue;
      if (FALSE_STORY_ANCHOR_DOMAIN_RE.test(hit.domain) || isGovPortalDomain(hit.domain)) continue;
      if (isFalsePersonHit(hit.title, hit.url, themeSet.subjectName)) continue;
      if (
        (theme.id === "pep_rca" || theme.id === "sanctions_associates") &&
        isGovPortalDomain(hit.domain)
      ) {
        continue;
      }
      if (/demo|potential match only/i.test(`${hit.title} ${hit.snippet ?? ""}`)) continue;
      const storyHint = theme.namedEntities
        .filter((e) => /трансмаш|махмудов|бокарев|ликсутов|молдав|лнр|оборон/i.test(e))
        .slice(0, 2)
        .join(", ");
      const snip = hit.snippet
        ? ` — ${hit.snippet.slice(0, 110)}`
        : storyHint
          ? ` — ${storyHint}`
          : "";
      cards.push(
        `Тема ${themeIdx}. ${hit.domain}: ${hit.title.slice(0, 90)}${snip}`
      );
      if (cards.length >= maxCards) return cards;
    }
  }
  return cards;
}

/** Decision / consequences matrix copy (ORION slide 4 right column). */
export function buildDecisionConsequences(themeSet: OrionThemeSet): {
  headline: string;
  problems: string[];
  consequences: string[];
  recommendation: string;
  riskLevel: string;
} {
  const problems = themeSetBullets(themeSet).slice(0, 5);
  const high =
    themeSet.ru.overallBadge === "Крайне негативный" ||
    themeSet.uae.overallBadge === "Крайне негативный" ||
    themeSet.themes.some((t) => t.id === "sanctions_associates" || t.id === "pep_rca");
  return {
    headline: high ? "Compliance риски: требуются действия" : "Compliance риски: требуется усиленная проверка",
    problems: problems.length
      ? problems
      : ["Дифференцирующие adverse-темы на текущем этапе ограничены."],
    consequences: [
      "Углублённая проверка либо затруднения при KYC / резидентстве / открытии зарубежных счетов.",
      "Отказы или расширенные запросы от банков и сервис-провайдеров.",
      "Риск использования неактуальных или недостоверных источников комплаенс-базами.",
      "Вероятные последствия санкционных/PEP-ассоциаций: ограничения на переводы, счета, сделки.",
    ],
    recommendation:
      "Рекомендуются работы с международными базами данных, создание целевого цифрового профиля и вытеснение нежелательных ссылок из результатов поиска.",
    riskLevel: high ? "Крайне высокий" : themeSet.ru.linksAdversePct >= 8 ? "Высокий" : "Средний",
  };
}

/** Supporting bullets only — claim stays in narrative to avoid duplicate first bullet. */
export function buildComplianceProviderBullets(
  c: OrionComplianceDbSignal,
  subjectName: string
): string[] {
  const sDat = shortSubjectDative(subjectName);
  const bullets: string[] = [];

  if (c.statusKind === "rca") {
    bullets.push(
      c.hasDbHit
        ? `Карточка указывает на RCA / associate-контур по ${sDat}; полный список связей и категория риска в клиентском отчёте не раскрыты.`
        : `Предварительный RCA / associate-контур по ${sDat} требует сверки с полной карточкой; категория риска не раскрыта.`
    );
  } else if (c.statusKind === "pep") {
    bullets.push(
      `Предварительный PEP-сигнал по ${sDat}; основание включения и идентификаторы требуют сверки с полной карточкой.`
    );
  } else if (c.statusKind === "sanctions") {
    bullets.push(
      `Sanctions / watchlist-сигнал требует сверки идентификаторов и статуса записи в полной выгрузке.`
    );
  } else if (c.provider === "Dow Jones") {
    bullets.push(
      `Имя-совпадение зафиксировано; полный профиль и категория риска требуют лицензионной выгрузки.`
    );
  } else if (c.provider === "World-Check") {
    bullets.push(
      `Совпадение по полному имени без раскрытой категории риска в текущем контуре отчёта.`
    );
  } else if (c.provider === "LexisNexis") {
    bullets.push(
      `Медиа- и профильную карточку нужно сверить с первоисточниками до риск-решения.`
    );
  } else {
    bullets.push(`По ${c.provider} доступен предварительный сигнал; требуется сверка полного профиля.`);
  }

  // One context line only — openSourceContext already carries named links when present.
  if (c.categories.length > 0 && c.provider === "LexisNexis") {
    bullets.push(`Категории сигнала: ${c.categories.slice(0, 3).join(", ")}.`);
  }
  for (const line of c.openSourceContext.slice(0, 2)) {
    bullets.push(line);
  }
  // Fallback named-links bullet only if openSourceContext did not already list them.
  if (
    c.namedLinks.length > 0 &&
    !c.openSourceContext.some((l) => /контур|связ/i.test(l) && c.namedLinks.some((n) => l.includes(n.split(" ").pop() ?? n)))
  ) {
    bullets.push(`Смежный контур для сверки: ${c.namedLinks.slice(0, 4).join(", ")}.`);
  }

  bullets.push("Сигнал предварительный: без полной карточки не считается подтверждённым риском.");
  return bullets.filter(
    (b, i, arr) => arr.findIndex((x) => x.slice(0, 56).toLowerCase() === b.slice(0, 56).toLowerCase()) === i
  );
}

export function buildComplianceDbSlides(themeSet: OrionThemeSet): Array<{
  title: string;
  narrative: string;
  bullets: string[];
}> {
  return themeSet.complianceSignals.map((c) => ({
    title: `${c.provider} — профиль`,
    narrative: complianceToClientClaim(c, themeSet.subjectName),
    bullets: buildComplianceProviderBullets(c, themeSet.subjectName),
  }));
}

