/**
 * Deterministic theme grouper for SERP snapshots (Stage S1 — NO LLM).
 *
 * Groups negative/risky stored results into a small set of themes for the
 * left-column table and assigns each highlighted result a stable "Тема N" /
 * "Theme N" label. Determinism: identical input always yields identical themes,
 * ordering and labels (sort by count desc, then first-seen order).
 */

import { serpSnapshotConfig } from "./config";
import type {
  LoadedResult,
  SerpLanguage,
  SnapshotTheme,
  ThemeGrouping,
} from "./types";

const THEME_COLOR = "#d1342f";

/**
 * Human titles for risk-theme keys (Stage N1.3) and legacy classification keys.
 * Keys are matched case-insensitively in `titleForKey`.
 */
const CLASSIFICATION_LABELS: Record<SerpLanguage, Record<string, string>> = {
  ru: {
    // N1.3 risk-theme keys
    sanctions: "Санкционные списки",
    pep: "Публичные должностные лица (PEP)",
    political_exposure: "Политическая значимость (PEP)",
    legal_dispute: "Судебные и правовые споры",
    adverse_media: "Негативные публикации в СМИ",
    criminal: "Криминальные материалы",
    reputation: "Репутационные источники",
    business_conflict: "Деловые конфликты",
    other: "Потенциально негативные публикации",
    // legacy classifier theme keys
    pep_rca: "Публичные должностные лица (PEP)",
    legal: "Судебные и правовые материалы",
    criminal_allegation: "Криминальные материалы",
    politics: "Политическая значимость",
    offshore: "Офшорные структуры",
    compliance_database: "Базы комплаенс-проверки",
    // legacy enum classifications
    ADVERSE_MEDIA: "Негативные публикации в СМИ",
    LEGAL: "Судебные и правовые материалы",
    SANCTIONS: "Санкционные списки",
    PEP: "Публичные должностные лица (PEP)",
    NEGATIVE: "Негативные упоминания",
    HIGH_RISK: "Материалы повышенного риска",
    CRIMINAL: "Криминальные материалы",
  },
  en: {
    sanctions: "Sanctions lists",
    pep: "Politically exposed persons (PEP)",
    political_exposure: "Political exposure (PEP)",
    legal_dispute: "Legal disputes & court records",
    adverse_media: "Adverse media coverage",
    criminal: "Criminal records",
    reputation: "Reputation sources",
    business_conflict: "Business conflicts",
    other: "Potentially negative publications",
    pep_rca: "Politically exposed persons (PEP)",
    legal: "Legal & court records",
    criminal_allegation: "Criminal records",
    politics: "Political exposure",
    offshore: "Offshore structures",
    compliance_database: "Compliance screening databases",
    ADVERSE_MEDIA: "Adverse media coverage",
    LEGAL: "Legal & court records",
    SANCTIONS: "Sanctions lists",
    PEP: "Politically exposed persons (PEP)",
    NEGATIVE: "Negative mentions",
    HIGH_RISK: "High-risk materials",
    CRIMINAL: "Criminal records",
  },
};

const FALLBACK_TITLE: Record<SerpLanguage, string> = {
  ru: "Потенциально негативные публикации",
  en: "Potentially negative publications",
};

const THEME_WORD: Record<SerpLanguage, string> = { ru: "Тема", en: "Theme" };

/** Message shown in the left table when no negatives were found. */
export const NO_NEGATIVES_MESSAGE: Record<SerpLanguage, string> = {
  ru: "Нежелательные публикации не обнаружены",
  en: "No adverse publications found",
};

export function themeLabel(language: SerpLanguage, themeNumber: number): string {
  return `${THEME_WORD[language]} ${themeNumber}`;
}

/**
 * True when a result should get a red frame. Stage N1.3: the decision is resolved
 * upstream (manual > findings > auto MEDIUM/HIGH > legacy enum) and carried on the
 * loaded row, so grouping no longer re-derives risk from the raw classification.
 */
export function isNegative(result: LoadedResult): boolean {
  return result.isHighlighted === true;
}

/** Human-readable theme title for a grouping key (theme key or legacy enum). */
function titleForKey(key: string, language: SerpLanguage): string {
  const labels = CLASSIFICATION_LABELS[language];
  return (
    labels[key] ??
    labels[key.toLowerCase()] ??
    labels[key.toUpperCase()] ??
    FALLBACK_TITLE[language]
  );
}

interface Bucket {
  groupKey: string;
  title: string;
  resultIds: string[];
  firstSeen: number;
}

/**
 * Groups the negative results from all engines into deterministic themes.
 * `results` should be the combined YANDEX + GOOGLE list (order matters only for
 * stable tie-breaking).
 */
export function groupThemes(
  results: LoadedResult[],
  language: SerpLanguage
): ThemeGrouping {
  const maxThemes = serpSnapshotConfig.maxThemes;
  const buckets = new Map<string, Bucket>();
  let order = 0;

  for (const r of results) {
    if (!isNegative(r)) continue;
    // Group by the resolved risk theme (Stage N1.3), falling back to the raw
    // classification or "other" when no theme is available.
    const themeKey =
      (r.riskTheme && r.riskTheme.trim() !== "" && r.riskTheme.trim()) ||
      (r.classification && r.classification.trim() !== "" && r.classification.trim()) ||
      "other";
    const groupKey = themeKey.toLowerCase();

    let bucket = buckets.get(groupKey);
    if (!bucket) {
      bucket = {
        groupKey,
        title: r.themeTitle ?? titleForKey(themeKey, language),
        resultIds: [],
        firstSeen: order++,
      };
      buckets.set(groupKey, bucket);
    }
    bucket.resultIds.push(r.id);
  }

  // Deterministic ordering: count desc, then first-seen asc.
  const ordered = [...buckets.values()].sort((a, b) => {
    const byCount = b.resultIds.length - a.resultIds.length;
    if (byCount !== 0) return byCount;
    return a.firstSeen - b.firstSeen;
  });

  const selected = ordered.slice(0, maxThemes);

  const themes: SnapshotTheme[] = selected.map((b, i) => ({
    themeNumber: i + 1,
    themeLabel: themeLabel(language, i + 1),
    title: b.title,
    count: b.resultIds.length,
    resultIds: b.resultIds,
    color: THEME_COLOR,
  }));

  const highlights = new Map<string, { themeNumber: number; themeLabel: string }>();
  for (const theme of themes) {
    for (const id of theme.resultIds) {
      highlights.set(id, {
        themeNumber: theme.themeNumber,
        themeLabel: theme.themeLabel,
      });
    }
  }

  return { themes, highlights, highlightedCount: highlights.size };
}
