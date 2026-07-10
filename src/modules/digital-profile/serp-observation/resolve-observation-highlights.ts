/**
 * Resolve red-frame highlights for provider-first SerpObservation rows.
 * Reuses Stage S1 theme-grouper; no LLM, no CAPTCHA/proxy.
 */

import { buildConsistentThemeGrouping } from "../serp-snapshot/snapshot-consistency";
import type { LoadedResult, ResultView, SerpEngine, SerpLanguage, ThemeGrouping } from "../serp-snapshot/types";
import type { PersistedSerpObservation } from "./types";

/** Domains that should always get a red frame in ORION-style SERP snapshots. */
const ADVERSE_DOMAIN_RE =
  /rucriminal\.|cybercriminal\.|acompromat\.|rucompromat\.|compromat\.|rupep\.|opensanctions\.|ofac\.|justice\.gov|home\.treasury\.gov/i;

const ADVERSE_BLOB_RE =
  /adverse|negative|undesirable|нежелат|негатив|санкц|sanction|ofac|корруп|corrupt|мошен|fraud|арест|arrest|уголов|criminal|суд|lawsuit|\bpep\b|watchlist|rca|компромат|offshore|офшор|политич|молдав|лнр|лднр|оборон|defense\s+industry|бенефициар|associated|associate/i;

type ThemeRule = { key: string; title: string; match: RegExp };

const THEME_RULES: ThemeRule[] = [
  {
    key: "criminal",
    title: "Криминальные / судебные материалы",
    match: /rucriminal|cybercriminal|acompromat|compromat|уголов|арест|criminal|суд|lawsuit/i,
  },
  {
    key: "sanctions",
    title: "Санкционный контур и связанные лица",
    match: /санкц|sanction|ofac|махмудов|makhmudov|бокарев|bokarev|трансмаш|watchlist/i,
  },
  {
    key: "pep",
    title: "Сигналы PEP / RCA",
    match: /rupep|\bpep\b|rca|политич|political/i,
  },
  {
    key: "adverse_media",
    title: "Негативные публикации на агрегаторах",
    match: /негатив|adverse|компромат|reputation/i,
  },
];

function domainOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function themeForBlob(blob: string): { key: string; title: string } {
  for (const rule of THEME_RULES) {
    if (rule.match.test(blob)) return { key: rule.key, title: rule.title };
  }
  return { key: "other", title: "Потенциально негативные публикации" };
}

export function classifyObservationHighlight(obs: PersistedSerpObservation): {
  isHighlighted: boolean;
  riskTheme: string | null;
  themeTitle: string | null;
} {
  const url = obs.url ?? "";
  const domain = obs.domain ?? domainOf(url);
  const blob = `${obs.title ?? ""} ${obs.snippet ?? ""} ${url} ${domain}`;
  const byDomain = ADVERSE_DOMAIN_RE.test(url) || ADVERSE_DOMAIN_RE.test(domain);
  const byBlob = ADVERSE_BLOB_RE.test(blob);
  if (!byDomain && !byBlob) {
    return { isHighlighted: false, riskTheme: null, themeTitle: null };
  }
  const theme = themeForBlob(blob);
  return { isHighlighted: true, riskTheme: theme.key, themeTitle: theme.title };
}

function toLoadedResult(obs: PersistedSerpObservation): LoadedResult {
  const hl = classifyObservationHighlight(obs);
  const engine: SerpEngine = obs.engine === "YANDEX" ? "YANDEX" : "GOOGLE";
  return {
    id: obs.id,
    engine,
    rank: obs.rank,
    title: obs.title,
    url: obs.url ?? "",
    domain: obs.domain,
    snippet: obs.snippet,
    classification: hl.isHighlighted ? "ADVERSE_MEDIA" : "NEUTRAL",
    riskTheme: hl.riskTheme,
    region: obs.region,
    language: obs.language,
    source: obs.provider,
    createdAt: obs.capturedAt,
    isHighlighted: hl.isHighlighted,
    themeTitle: hl.themeTitle,
  };
}

export function buildObservationThemeGrouping(
  observations: PersistedSerpObservation[],
  language: SerpLanguage = "ru"
): { loaded: LoadedResult[]; grouping: ThemeGrouping } {
  const loaded = observations.map(toLoadedResult);
  const grouping = buildConsistentThemeGrouping(loaded, language);
  return { loaded, grouping };
}

export function observationToResultView(
  obs: PersistedSerpObservation,
  grouping: ThemeGrouping
): ResultView {
  const loaded = toLoadedResult(obs);
  const mark = grouping.highlights.get(obs.id);
  return {
    rank: obs.rank,
    title: obs.title ?? obs.domain ?? "Результат поиска",
    url: obs.url ?? "",
    domain: obs.domain ?? domainOf(obs.url),
    snippet: obs.snippet ?? "",
    classification: loaded.classification,
    isHighlighted: Boolean(mark) || loaded.isHighlighted,
    themeNumber: mark?.themeNumber,
    themeLabel: mark?.themeLabel,
  };
}
