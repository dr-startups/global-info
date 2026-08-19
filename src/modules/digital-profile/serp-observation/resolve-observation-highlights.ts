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

/**
 * Soft bio / registry / encyclopedia domains — never red-frame on weak blob hits.
 * Forbes/Klerk bios were false-positive «Тема N» in PDF (41).
 */
const SOFT_PROFILE_DOMAIN_RE =
  /forbes\.|klerk\.|tadviser\.|wikipedia\.|linkedin\.|rusprofile\.|audit-it\.|zachestnyibiznes\.|labyrinth\.|instagram\.|facebook\.|x\.com|twitter\.|youtube\.|imslp\./i;

/** Strong adverse signals — enough alone, including on soft profile domains. */
const STRONG_ADVERSE_BLOB_RE =
  /adverse|undesirable|нежелат|негативн|санкц|sanction|\bofac\b|корруп|corrupt|мошен|fraud|арест|arrest|уголов|\bcriminal\b|lawsuit|\bpep\b|watchlist|\brca\b|компромат|rucriminal|cybercriminal|acompromat|rupep|opensanctions|defense\s+industry|оборонн(?:ая|ой)\s+промыш/i;

/**
 * Weaker signals — only for non-soft domains (avoid «associate» / «политич» on bios).
 */
const WEAK_ADVERSE_BLOB_RE =
  /offshore|офшор|молдав|лнр|лднр|бенефициар|негатив|компромат/i;

type ThemeRule = { key: string; title: string; match: RegExp };

const THEME_RULES: ThemeRule[] = [
  {
    key: "criminal",
    title: "Криминальные / судебные материалы",
    match: /rucriminal|cybercriminal|acompromat|compromat|уголов|арест|\bcriminal\b|lawsuit/i,
  },
  {
    key: "sanctions",
    title: "Санкционный контур и связанные лица",
    match: /санкц|sanction|\bofac\b|watchlist|defense\s+industry|оборонн/i,
  },
  {
    key: "pep",
    title: "Сигналы PEP / RCA",
    match: /rupep|\bpep\b|\brca\b/i,
  },
  {
    key: "adverse_media",
    title: "Негативные публикации на агрегаторах",
    match: /негатив|adverse|компромат|нежелат/i,
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

/**
 * Drop mojibake / keyboard-mash snippets (seen on some rupep Serper rows:
 * «Аяццмтщшорёп», DOB 11.55.1840) so synthetic SERP stays client-readable.
 */
export function sanitizeSerpSnippet(snippet: string | null | undefined): string {
  const t = String(snippet ?? "").trim();
  if (!t) return "";
  // Impossible calendar month/day (e.g. 11.55.1840, 49.4856)
  if (/\b\d{1,2}\.(?:[3-9]\d|1[3-9]|2[5-9])\.\d{2,4}\b/.test(t)) return "";
  if (/\b(?:Pdg|Ywffp)\b/i.test(t)) return "";
  // Long consonant runs atypical for Russian/English prose
  if (/[бвгджзйклмнпрстфхцчшщъь]{7,}/iu.test(t)) return "";
  if (/[bcdfghjklmnpqrstvwxz]{8,}/i.test(t)) return "";
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  if (t.length >= 18 && letters / t.length < 0.5) return "";
  return t;
}

/**
 * Что решение по прочитанной странице говорит о строке выдачи.
 *
 * Только по прочитанным страницам: непрочитанная решения не приносит, и
 * подставлять вместо него честное «не знаем» модели значило бы гасить
 * словарную метку тем, что страницу не открыли.
 */
export type ObservationVerdict = {
  tone: "adverse" | "neutral" | "supportive";
  /** Есть ли дословная цитата: нежелательный вывод без неё рамку не назначает. */
  quoted: boolean;
  subjectMatch: "subject" | "likely" | "other" | "unclear";
  /** Кластерный ярлык сюжета — язык резюме; без него легенда берёт словарь. */
  themeLabel?: string;
};

/** `evidenceRef → решение по прочитанной странице`. */
export type ObservationVerdictByRef = Record<string, ObservationVerdict>;

/**
 * Собрать карту решений для визуального слоя из артефакта чтения ссылок.
 *
 * Связь краски со словами держится на одном ключе: `evidenceRef` решения обязан
 * совпасть с тем, которым визуальный слой называет строку (`inventory:<id>`).
 * Разъедутся — рамки молча вернутся к словарю: дека соберётся, ворота пройдут,
 * и заметить это будет негде. Поэтому сборка карты — названная функция со
 * своим тестом, а не выражение внутри подготовки отчёта.
 */
export function observationVerdictsForVisuals(artifact: {
  summary?: { themes?: Array<{ theme?: string; evidenceRefs?: string[] }> };
  verdicts?: Array<{
    evidenceRef?: string;
    tone?: string;
    subjectMatch?: string;
    quotes?: Array<{ text?: string }>;
    readFailure?: string;
  }>;
}): ObservationVerdictByRef {
  const themeLabelByRef = new Map<string, string>();
  for (const theme of artifact.summary?.themes ?? []) {
    const label = String(theme.theme ?? "").trim();
    if (!label) continue;
    for (const ref of theme.evidenceRefs ?? []) themeLabelByRef.set(String(ref), label);
  }
  const out: ObservationVerdictByRef = {};
  for (const v of artifact.verdicts ?? []) {
    const ref = String(v.evidenceRef ?? "");
    // Непрочитанная страница решения не приносит — словарь заголовка всё, что
    // о ней есть.
    if (!ref || v.readFailure) continue;
    const label = themeLabelByRef.get(ref);
    out[ref] = {
      tone: (v.tone as ObservationVerdict["tone"]) ?? "neutral",
      quoted: (v.quotes ?? []).some((q) => String(q?.text ?? "").trim().length > 0),
      subjectMatch: (v.subjectMatch as ObservationVerdict["subjectMatch"]) ?? "unclear",
      ...(label ? { themeLabel: label } : {}),
    };
  }
  return out;
}

/**
 * Негативна ли строка — один ответ на весь отчёт.
 *
 * Решение по прочитанной странице сильнее заголовка выдачи: словарь ключевых
 * слов работает по двум строкам, которые показал поисковик, и на них
 * телеинтервью получало метку «уголовное дело», а страница санкционного списка
 * без этих слов — зелёную. То же правило уже применяет дека к своим оценкам;
 * пока снимок выдачи считал по-своему, один лист мог нести красную рамку,
 * которую текст рядом опровергал.
 *
 * Словарь остаётся ответом там, где страницу не читали, — и только там.
 */
export function classifyObservationHighlight(
  obs: PersistedSerpObservation,
  verdict?: ObservationVerdict
): {
  isHighlighted: boolean;
  riskTheme: string | null;
  themeTitle: string | null;
} {
  const url = obs.url ?? "";
  const domain = obs.domain ?? domainOf(url);
  const blob = `${obs.title ?? ""} ${obs.snippet ?? ""} ${url} ${domain}`;

  if (verdict) {
    // Материал о другом человеке не подтверждает ничего о субъекте. Строка при
    // этом рисуется: снимок воспроизводит выдачу, и спрятать её значило бы
    // нарисовать страницу, которой поисковик не показывал.
    if (verdict.subjectMatch === "other") {
      return { isHighlighted: false, riskTheme: null, themeTitle: null };
    }
    if (verdict.tone === "neutral" || verdict.tone === "supportive") {
      return { isHighlighted: false, riskTheme: null, themeTitle: null };
    }
    if (verdict.tone === "adverse" && verdict.quoted) {
      const label = verdict.themeLabel?.trim();
      if (label) return { isHighlighted: true, riskTheme: label.toLowerCase(), themeTitle: label };
      const theme = themeForBlob(blob);
      return { isHighlighted: true, riskTheme: theme.key, themeTitle: theme.title };
    }
    // Нежелательный вывод без цитаты ничего не назначает: то же правило, по
    // которому такой вывод понижается в самом решении.
  }

  const byDomain = ADVERSE_DOMAIN_RE.test(url) || ADVERSE_DOMAIN_RE.test(domain);
  const softProfile = SOFT_PROFILE_DOMAIN_RE.test(url) || SOFT_PROFILE_DOMAIN_RE.test(domain);
  const strongBlob = STRONG_ADVERSE_BLOB_RE.test(blob);
  const weakBlob = !softProfile && WEAK_ADVERSE_BLOB_RE.test(blob);

  if (!byDomain && !strongBlob && !weakBlob) {
    return { isHighlighted: false, riskTheme: null, themeTitle: null };
  }
  // Soft bios: only domain-list adverse or strong keywords (not weak blob).
  if (softProfile && !byDomain && !strongBlob) {
    return { isHighlighted: false, riskTheme: null, themeTitle: null };
  }
  const theme = themeForBlob(blob);
  return { isHighlighted: true, riskTheme: theme.key, themeTitle: theme.title };
}

function toLoadedResult(
  obs: PersistedSerpObservation,
  verdictByRef?: ObservationVerdictByRef
): LoadedResult {
  const hl = classifyObservationHighlight(obs, verdictByRef?.[obs.id]);
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
  language: SerpLanguage = "ru",
  verdictByRef?: ObservationVerdictByRef
): { loaded: LoadedResult[]; grouping: ThemeGrouping } {
  const loaded = observations.map((o) => toLoadedResult(o, verdictByRef));
  const grouping = buildConsistentThemeGrouping(loaded, language);
  return { loaded, grouping };
}

export function observationToResultView(
  obs: PersistedSerpObservation,
  grouping: ThemeGrouping,
  verdictByRef?: ObservationVerdictByRef
): ResultView {
  const loaded = toLoadedResult(obs, verdictByRef);
  const mark = grouping.highlights.get(obs.id);
  return {
    rank: obs.rank,
    title: obs.title ?? obs.domain ?? "Результат поиска",
    url: obs.url ?? "",
    domain: obs.domain ?? domainOf(obs.url),
    snippet: sanitizeSerpSnippet(obs.snippet),
    classification: loaded.classification,
    isHighlighted: Boolean(mark) || loaded.isHighlighted,
    themeNumber: mark?.themeNumber,
    themeLabel: mark?.themeLabel,
  };
}
