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

const CLASSIFICATION_LABELS: Record<SerpLanguage, Record<string, string>> = {
  ru: {
    ADVERSE_MEDIA: "Негативные публикации в СМИ",
    LEGAL: "Судебные и правовые материалы",
    SANCTIONS: "Санкционные списки",
    PEP: "Публичные должностные лица (PEP)",
    NEGATIVE: "Негативные упоминания",
    HIGH_RISK: "Материалы повышенного риска",
    CRIMINAL: "Криминальные материалы",
  },
  en: {
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

function normalizeClassification(value: string): string {
  return value.trim().toUpperCase();
}

/** True when a result counts as negative/risky per the configured classes. */
export function isNegative(result: LoadedResult): boolean {
  return serpSnapshotConfig.highlightClassifications.includes(
    normalizeClassification(result.classification)
  );
}

/** Human-readable theme title for a grouping key. */
function titleForKey(
  key: { kind: "theme"; value: string } | { kind: "class"; value: string },
  language: SerpLanguage
): string {
  if (key.kind === "theme") return key.value;
  return CLASSIFICATION_LABELS[language][key.value] ?? FALLBACK_TITLE[language];
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
    // Group by explicit riskTheme when present, else by classification.
    const key =
      r.riskTheme && r.riskTheme.trim() !== ""
        ? ({ kind: "theme", value: r.riskTheme.trim() } as const)
        : ({ kind: "class", value: normalizeClassification(r.classification) } as const);
    const groupKey = `${key.kind}:${key.value.toLowerCase()}`;

    let bucket = buckets.get(groupKey);
    if (!bucket) {
      bucket = {
        groupKey,
        title: titleForKey(key, language),
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
