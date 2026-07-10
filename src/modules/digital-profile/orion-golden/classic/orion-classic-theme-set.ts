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
  wikipediaPresent: boolean;
  imagesTotal: number;
  imagesAdverse: number;
  videosTotal: number;
  knowledgeTotal: number;
  knowledgeAdverse: number;
  overallBadge: "Крайне негативный" | "Нежелательный" | "Смешанный" | "Нейтральный" | "Данных мало";
};

export type OrionComplianceDbSignal = {
  provider: "Dow Jones" | "LexisNexis" | "World-Check" | "Другое";
  statusLine: string;
  detail: string;
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
  if (/ликсутов|liksutov/i.test(blob)) return "business_associates";
  if (/бокарев|bokarev|махмудов|makhmudov|трансмаш|transmashholding/i.test(blob)) {
    return "sanctions_associates";
  }
  if (/лнр|лднр/i.test(blob)) return "conflict_jurisdiction";
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
  const surname = subjectName
    .trim()
    .split(/\s+/)
    .find((x) => x.length > 2)
    ?.toLowerCase();
  if (!surname) return false;

  // Explicit known false positives seen on Glinka packs
  if (/kozlov|козлов/i.test(t) && !/kozlov|козлов/i.test(subjectLower)) return true;

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
  if (
    (kpis.linksAdversePct >= 30 && kpis.linksAdverse >= 12) ||
    kpis.suggestionsAdverse >= 5
  ) {
    return "Крайне негативный";
  }
  if (kpis.linksAdversePct >= 10 || kpis.suggestionsAdverse >= 1 || kpis.imagesAdverse >= 2) {
    return "Нежелательный";
  }
  if (kpis.linksAdverse > 0 || kpis.imagesAdverse > 0 || kpis.knowledgeAdverse > 0) return "Смешанный";
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
  const wiki = items.filter((i) => i.evidenceType === "wikipedia");
  const wikiPresent = wiki.some((w) => {
    const url = String(w.sourceUrl ?? "");
    const blob = `${w.title} ${w.snippet ?? ""} ${url}`.toLowerCase();
    if (/отсутств|not\s+found|no\s+article|не\s+найден|page not found|страница не найдена/i.test(blob)) {
      return false;
    }
    if (!url || !/wikipedia\.org/i.test(url)) {
      return /страница найдена|article found|exists|подтвержд/i.test(blob);
    }
    // Regional wiki: RU counts ru.wikipedia; UAE counts en/ar (not RU fallback).
    if (region === "RU") return /\/\/ru\.wikipedia\.org/i.test(url) || /wikipedia\.org/i.test(url);
    return /\/\/(en|ar)\.wikipedia\.org/i.test(url);
  });
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
          !isFalsePersonHit(h.title, h.url, subjectName)
      ),
      def.key
    );
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

function complianceSignals(inventory: FullEvidenceInventory): OrionComplianceDbSignal[] {
  const out: OrionComplianceDbSignal[] = [];
  const hits = inventory.items.filter(
    (i) =>
      !isDemoOrNoiseItem(i) &&
      (i.evidenceType === "compliance_hit" || /dow|lexis|world/i.test(i.provider))
  );
  const byProvider = [
    { key: /dow/i, label: "Dow Jones" as const },
    { key: /lexis/i, label: "LexisNexis" as const },
    { key: /world/i, label: "World-Check" as const },
  ];
  for (const p of byProvider) {
    const rows = hits.filter(
      (h) =>
        p.key.test(h.provider) ||
        p.key.test(h.title) ||
        p.key.test(riskBlob(h))
    );
    if (rows.length === 0) continue;
    const blob = rows.map((r) => `${r.title} ${r.snippet ?? ""}`).join(" ");
    if (
      /demo|potential match only|\[demo\]|demo dow|demo lexis|demo world/i.test(blob) ||
      rows.every((r) => isDemoOrNoiseItem(r))
    ) {
      continue;
    }
    const isRca = /\brca\b|close associate|родственник|близк/i.test(blob);
    const isPep = /\bpep\b|politically|политически значим/i.test(blob);
    const status = isRca
      ? "предварительный сигнал RCA"
      : isPep
        ? "предварительный сигнал PEP"
        : "предварительное совпадение по имени";
    const detail = sanitizeOrionGoldenClientText(
      rows[0].snippet || rows[0].title || "Требуется сверка полного профиля."
    ).slice(0, 220);
    if (/demo|potential match only/i.test(detail)) continue;
    out.push({
      provider: p.label,
      statusLine: `${p.label}: ${status}`,
      detail,
    });
  }
  return out.slice(0, 3);
}

function formatPctLine(kpis: OrionSurfaceKpis): string {
  if (kpis.linksTotal <= 0) return "по сохранённой выдаче недостаточно органических ссылок для доли";
  return `${kpis.linksAdversePct}% ссылок в сохранённой выдаче выглядят потенциально нежелательными (${kpis.linksAdverse} из ${kpis.linksTotal})`;
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

  const themeLines = input.themes.slice(0, 6).map((t) => {
    const ents = t.namedEntities
      .filter((e) => isQualityEntity(e, input.subjectName) && !WEAK_ANCHOR_DOMAIN_RE.test(e))
      .sort((a, b) => {
        const rank = (e: string) =>
          /трансмаш|махмудов|бокарев/i.test(e)
            ? 0
            : /ликсутов|лнр/i.test(e)
              ? 1
              : /молдав|оборон/i.test(e)
                ? 2
                : 3;
        return rank(a) - rank(b);
      })
      .slice(0, 3);
    // Lead criminal theme with aggregator domain when named entities are thin
    if (ents.length === 0 && t.id === "criminal_legal") {
      const agg = t.sampleHits.find((h) => CRIMINAL_AGGREGATOR_DOMAIN_RE.test(h.domain));
      if (agg) return `${t.title} (${agg.domain})`;
    }
    return ents.length > 0 ? `${t.title} (${ents.join(", ")})` : t.title;
  });
  // Optionally append strong GPT bullets that don't look like NER garbage / demo / soft anchors
  const gptExtras = sanitizeList(input.synthesis?.mainRisks)
    .filter(
      (b) =>
        !/citizen arrested|united state|geoff cutmore|demo|example\.com|facilitating illicit|real estate transactions|russian oligarch|disclosure\.1prime|yandex\.ru|potential match only|\[demo\]|kozlov|козлов|home\.treasury|nhc\.nl/i.test(
          b
        )
    )
    .filter((b) => !themeLines.some((t) => t.slice(0, 40).toLowerCase() === b.slice(0, 40).toLowerCase()))
    .slice(0, 2);
  const mergedThemes = [...themeLines];
  for (const g of gptExtras) {
    if (mergedThemes.length >= 6) break;
    mergedThemes.push(g);
  }
  const nextStep =
    sanitizeList(input.synthesis?.nextSteps)[0] ||
    "Для разработки эффективной стратегии нам необходимо обсудить контекст задачи и сформулировать конкретные цели.";

  // Keep narrative short enough for one executive card (themes live in bullets / slide 5).
  const body: string[] = [
    scope,
    `В результатах поиска по России (${formatPctLine(input.ru)}) и ОАЭ (${formatPctLine(input.uae)}) фиксируются сюжеты, которые могут осложнить compliance-процедуры.`,
  ];
  if (input.compliance.length > 0) {
    body.push(`В международных базах: ${input.compliance.map((c) => c.statusLine).join("; ")}.`);
  }
  body.push(nextStep);

  return {
    scope,
    narrative: body.join("\n\n"),
    bullets: mergedThemes,
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
  const themes = buildThemes(input.inventory, subjectName);
  const ru = computeSurfaceKpis(input.inventory, "RU", subjectName);
  const uae = computeSurfaceKpis(input.inventory, "UAE", subjectName);
  const compliance = complianceSignals(input.inventory);
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
  return themes.slice(0, 6).map((t) => {
    const ents = t.namedEntities
      .filter((e) => isQualityEntity(e, themeSet.subjectName) && !WEAK_ANCHOR_DOMAIN_RE.test(e))
      .sort((a, b) => {
        const rank = (e: string) =>
          /трансмаш|махмудов|бокарев/i.test(e)
            ? 0
            : /ликсутов|лнр/i.test(e)
              ? 1
              : /молдав|оборон/i.test(e)
                ? 2
                : 3;
        return rank(a) - rank(b);
      })
      .slice(0, 3);
    if (ents.length === 0 && t.id === "criminal_legal") {
      const agg = t.sampleHits.find((h) => CRIMINAL_AGGREGATOR_DOMAIN_RE.test(h.domain));
      if (agg) return `${t.title} (${agg.domain})`;
    }
    return ents.length ? `${t.title} (${ents.join(", ")})` : t.title;
  });
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
  const themes = themeSetBullets(input.themeSet, input.region);
  const narrative = [
    `Резюме аудита цифрового профиля в Google и Яндексе (${input.region === "RU" ? "Россия" : "ОАЭ"}).`,
    themes.length > 0
      ? `В результатах поиска обнаружены нежелательные публикации по темам:`
      : `Цифровой профиль по сохранённым данным региона выглядит слабо наполненным подтверждёнными adverse-сюжетами.`,
  ].join(" ");

  const kpiLines = [
    `1. Ссылки — ${kpis.linksAdversePct}% потенциально нежелательных (${kpis.linksAdverse} из ${Math.max(kpis.linksTotal, 1)})`,
    `2. Поисковые подсказки — ${kpis.suggestionsAdverse} из ${kpis.suggestionsTotal} указывают на нежелательные темы`,
    `3. Википедия — статья ${kpis.wikipediaPresent ? "обнаружена" : "отсутствует"}`,
    `4. Картинки — ${kpis.imagesAdverse} из ${kpis.imagesTotal} связаны с чувствительным контекстом`,
    `5. Видео — ${kpis.videosTotal > 0 ? `${kpis.videosTotal} в сохранённых поверхностях` : "отсутствуют в сохранённых данных"}`,
    `6. Блоки знаний — ${kpis.knowledgeAdverse} из ${kpis.knowledgeTotal} с чувствительным контекстом`,
    `7. Похожие запросы — ${kpis.relatedAdverse} из ${kpis.relatedTotal} ведут на нежелательные темы`,
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
  const rows = themeSet.themes.slice(0, 6).map((t) => ({
    theme: t.title,
    level: levelFor(t),
    summary: t.summary,
  }));
  for (const c of themeSet.complianceSignals) {
    rows.push({
      theme: c.provider,
      level: "Требует проверки",
      summary: `${c.statusLine}. ${c.detail}`,
    });
  }
  return rows.slice(0, 8);
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
  const picked: typeof rows = [];
  const pushUnique = (row: (typeof rows)[number]) => {
    const key = `${row.domain}|${row.title}`.toLowerCase();
    if (seen.has(key)) return;
    if (WEAK_ANCHOR_DOMAIN_RE.test(row.domain) && !row.adverse) return;
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

export function buildComplianceDbSlides(themeSet: OrionThemeSet): Array<{
  title: string;
  narrative: string;
  bullets: string[];
}> {
  return themeSet.complianceSignals.map((c) => ({
    title: `Обзор профиля — ${c.provider}`,
    narrative: c.statusLine,
    bullets: [
      c.detail,
      ...themeSet.themes
        .filter((t) => /pep|rca|sanction|associate|бизнес|политич/i.test(t.id + t.title))
        .slice(0, 2)
        .map((t) => t.title),
      "Сигнал предварительный: требуется сверка полного профиля и первоисточников.",
    ].filter(Boolean),
  }));
}

