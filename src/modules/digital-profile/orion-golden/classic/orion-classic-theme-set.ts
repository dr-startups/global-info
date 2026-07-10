/**
 * R10.12 — ORION-style ThemeSet + regional surface KPIs.
 * Deterministic packaging of inventory into the story ORION puts on slides 3–7/23–24.
 */

import { classifyAutocompleteQuery } from "../../evidence-quality/autocomplete-class";
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
  ];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const n = nested as Record<string, unknown>;
    const auto = n.auto && typeof n.auto === "object" ? (n.auto as Record<string, unknown>) : null;
    parts.push(String(n.classification ?? ""), String(auto?.theme ?? ""), String(auto?.classification ?? ""));
  }
  return parts.join(" ").toLowerCase();
}

const ADVERSE_RE =
  /adverse|negative|undesirable|нежелат|негатив|санкц|sanction|ofac|корруп|corrupt|мошен|fraud|арест|arrest|уголов|criminal|суд|lawsuit|pep|watchlist|rca|компромат|offshore|офшор|политич|молдав|лднр|лнр|индустриальн|бенефициар|associated|associate/i;

function isAdverseItem(item: FullEvidenceInventory["items"][number]): boolean {
  const et = item.evidenceType.toLowerCase();
  if (et === "risk_finding" || et === "compliance_hit") return true;
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
    match: /\bлнр\b|\bлднр\b|donetsk|lugansk|украин|ukraine|crimea|крым/i,
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
    title: "Уголовно-правовая / судебная лексика в открытых источниках",
    match: /arrest|арест|уголов|criminal|indict|accused|приговор|мошен|fraud|court|суд/i,
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
  const blob = `${riskBlob(item)} ${item.sourceUrl ?? ""}`;
  for (const def of THEME_DEFS) {
    if (def.key === "other_adverse") continue;
    if (def.match.test(blob)) return def.key;
  }
  const label = humanizeRiskTheme(
    String((item.rawMetadata ?? {}).themeLabel ?? item.classification ?? "")
  ).toLowerCase();
  if (/санкц/.test(label)) return "sanctions_associates";
  if (/политич|pep/.test(label)) return "political_exposure";
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
    /\[DEMO\]|Demo DOW JONES|Demo WORLD CHECK|potential match only|demo screening/i.test(blob) ||
    /example\.com|localhost|127\.0\.0\.1/i.test(url)
  );
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

function isWeakMediaDomain(domain: string): boolean {
  return /youtube\.|wixsite\.|instagram\.|facebook\.|tiktok\.|t\.me\b|vk\.com|ok\.ru|plehanovka/i.test(
    domain
  );
}

function isGovPortalDomain(domain: string): boolean {
  return /kremlin\.ru|gov\.ru|president\.|whitehouse\.|gov\.uk/i.test(domain);
}

function preferredThemeSample(
  sample: OrionThemeEvidenceHit[],
  themeKey: ThemeBucketKey
): OrionThemeEvidenceHit | undefined {
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
  if (e.length < 4 || e.length > 80) return false;
  if (isChargeOrSubjectLabel(e, subjectName)) return false;
  const tokens = e.split(/\s+/);
  if (tokens.every(isGarbageEntityToken)) return false;
  if (tokens.length === 1 && isGarbageEntityToken(tokens[0])) return false;
  // Prefer multi-word brands / orgs / known sources
  if (
    /rupep|peps|tadviser|forbes|рбк|rusal|en\+|базов|транс|маз|ликсутов|бокарев|махмудов|opensanctions|justice\.gov|lexisnexis|dow jones|world-check|dossier/i.test(
      e
    )
  ) {
    return true;
  }
  // Domain-like anchors
  if (/\.(org|gov|com|ru|net)\b/i.test(e) && !isWeakMediaDomain(e)) return true;
  // Strong org forms only — avoid Title Case charge phrases (3+ English words)
  if (/[«»"]|\bАО\b|\bПАО\b|\bООО\b/i.test(e)) return true;
  if (/^[A-Z]{2,}$/.test(e)) return true;
  // Allow 2-token proper names that are not charge labels (e.g. "Open Sanctions" already caught)
  if (tokens.length === 2 && tokens.every((t) => /^[A-ZА-ЯЁ]/.test(t)) && !tokens.some(isGarbageEntityToken)) {
    return true;
  }
  return false;
}

function extractNamedEntities(text: string, subjectName: string): string[] {
  const out: string[] = [];
  const re =
    /\b(?:АО\s+«[^»]+»|ПАО\s+«[^»]+»|ООО\s+«[^»]+»|Базовый элемент|En\+ Group|Rusal|РУСАЛ|rupep\.org|PEPS|TAdviser|Forbes|РБК|LexisNexis|Dow Jones|World-Check|OpenSanctions|justice\.gov|Transmashholding|Трансмашхолдинг|Dossier Center)\b/gi;
  for (const m of text.match(re) ?? []) {
    const t = m.trim();
    if (!isQualityEntity(t, subjectName)) continue;
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
    if (out.length >= 5) break;
  }
  return out;
}

/** Prefer real source domains as theme anchors (ORION style), not NER charge labels. */
function themeAnchorEntities(
  hits: OrionThemeEvidenceHit[],
  named: string[],
  subjectName: string
): string[] {
  const out: string[] = [];
  for (const hit of hits) {
    const d = (hit.domain || "").trim();
    if (!d || isWeakMediaDomain(d) || /\.example$/i.test(d)) continue;
    if (!out.some((x) => x.toLowerCase() === d.toLowerCase())) out.push(d);
    if (out.length >= 3) break;
  }
  for (const ent of named) {
    if (!isQualityEntity(ent, subjectName)) continue;
    if (!out.some((x) => x.toLowerCase() === ent.toLowerCase())) out.push(ent);
    if (out.length >= 4) break;
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
    const et = item.evidenceType.toLowerCase();
    if (et !== "search_result" && et !== "risk_finding" && et !== "compliance_hit") continue;
    if (!isAdverseItem(item) && et === "search_result") {
      // Keep strong corporate registry identities only when classification already marked risk-ish
      const cls = String(item.classification ?? "").toLowerCase();
      if (!/adverse|sanction|pep|risk|negative|undesirable|compliance/i.test(cls)) continue;
    }
    const key = themeKeyOf(item);
    // Skip pure corporate identity from becoming the only story unless explicitly adverse
    if (key === "corporate" && !isAdverseItem(item)) continue;
    // Skip weak "other_adverse" anchored only on soft media unless classification is strong
    if (key === "other_adverse" && et === "search_result" && !/sanction|pep|arrest|criminal|ofac|компромат/i.test(riskBlob(item))) {
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
    if (!bucket.hits.some((h) => h.url && hit.url && h.url === hit.url)) {
      bucket.hits.push(hit);
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
    const sample = bucket.hits
      .filter((h) => h.domain && !/\.example$/i.test(h.domain))
      .filter((h) => {
        // Keep gov portals / weak media out of PEP/sanctions sampleHits (false "typical anchors").
        if (def.key === "pep_rca" || def.key === "sanctions_associates") {
          return !isGovPortalDomain(h.domain) && !isWeakMediaDomain(h.domain);
        }
        return true;
      })
      .slice(0, 3);
    // Keep the theme even if only weak/gov hits exist — but without a false typical anchor.
    if (sample.length === 0 && def.key !== "pep_rca" && def.key !== "sanctions_associates") continue;
    if (sample.length === 0 && bucket.hits.length === 0) continue;
    const preferredSample = sample.length > 0 ? preferredThemeSample(sample, def.key) : undefined;
    const named = themeAnchorEntities(
      sample.length > 0
        ? sample.filter((h) => !isGovPortalDomain(h.domain) || def.key === "political_exposure")
        : [],
      bucket.entities.filter((e) => isQualityEntity(e, subjectName)),
      subjectName
    );
    const summaryParts = [
      named.length > 0
        ? `В сюжетной линии фигурируют: ${named.join(", ")}.`
        : def.key === "pep_rca"
          ? "Предварительные сигналы PEP/RCA в комплаенс-контексте; требуется сверка полного профиля."
          : "",
      preferredSample
        ? `Типичный якорь: ${preferredSample.domain || "источник"} — «${preferredSample.title}».`
        : "",
    ].filter(Boolean);
    cards.push({
      id: def.key,
      title: def.title,
      summary: summaryParts.join(" ") || def.title,
      count: bucket.hits.length,
      regions: [...bucket.regions],
      namedEntities: named,
      sampleHits: sample,
    });
  }

  return cards.sort((a, b) => b.count - a.count).slice(0, 6);
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
    if (/demo|potential match only|\[demo\]/i.test(blob)) continue;
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

  const themeLines =
    input.themes.slice(0, 6).map((t) => {
      const ents = t.namedEntities.filter((e) => isQualityEntity(e, input.subjectName)).slice(0, 3);
      return ents.length > 0 ? `${t.title} (${ents.join(", ")})` : t.title;
    });
  // Optionally append strong GPT bullets that don't look like NER garbage
  const gptExtras = sanitizeList(input.synthesis?.mainRisks)
    .filter(
      (b) =>
        !/citizen arrested|united state|geoff cutmore|demo|example\.com|facilitating illicit|real estate transactions|russian oligarch/i.test(
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
    const ents = t.namedEntities.filter((e) => isQualityEntity(e, themeSet.subjectName)).slice(0, 3);
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
        !isDemoOrNoiseItem(i)
    )
    .map((i) => ({
      pos: positionOfItem(i) || 999,
      domain: domainOf(i.sourceUrl) || "источник",
      title: sanitizeOrionGoldenClientText(i.title).slice(0, 70),
      adverse: isAdverseItem(i),
      query: (i.query || "").trim(),
    }))
    .sort((a, b) => a.pos - b.pos);

  // Prefer unique domains across top queries
  const seen = new Set<string>();
  const picked: typeof rows = [];
  for (const row of rows) {
    const key = `${row.domain}|${row.title}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(row);
    if (picked.length >= maxRows) break;
  }

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
    // Prefer stronger domains first within the theme
    const hits = [...theme.sampleHits].sort((a, b) => {
      const score = (d: string) =>
        /rupep|opensanctions|justice\.gov|tadviser|peps|dossier|ofac/i.test(d)
          ? 0
          : isWeakMediaDomain(d) || isGovPortalDomain(d)
            ? 2
            : 1;
      return score(a.domain) - score(b.domain);
    });
    for (const hit of hits.slice(0, 3)) {
      if (region && hit.region !== region && hit.region !== "GLOBAL") continue;
      if (!hit.domain || /\.example$/i.test(hit.domain) || /example\.com/i.test(hit.url ?? "")) continue;
      if (isWeakMediaDomain(hit.domain)) continue;
      if (
        (theme.id === "pep_rca" || theme.id === "sanctions_associates") &&
        isGovPortalDomain(hit.domain)
      ) {
        continue;
      }
      if (/demo|potential match only/i.test(`${hit.title} ${hit.snippet ?? ""}`)) continue;
      const snip = hit.snippet ? ` — ${hit.snippet.slice(0, 110)}` : "";
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

