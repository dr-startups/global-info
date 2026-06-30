/**
 * Stage R1.1.2 — SERP snapshot highlight/theme consistency helpers.
 *
 * Pure functions: theme table is rebuilt only from highlighted rows present
 * in the visible snapshot row set.
 */

import { groupThemes } from "./theme-grouper";
import type { LoadedResult, SerpLanguage, ThemeGrouping } from "./types";

/**
 * Theme table source of truth = highlighted rows in the visible snapshot set.
 * Invariant: themeCount > 0 iff visible highlighted rows exist.
 */
export function buildConsistentThemeGrouping(
  visibleRows: LoadedResult[],
  language: SerpLanguage
): ThemeGrouping {
  const visibleHighlighted = visibleRows.filter((r) => r.isHighlighted);
  if (visibleHighlighted.length === 0) {
    return { themes: [], highlights: new Map(), highlightedCount: 0 };
  }
  return groupThemes(visibleRows, language);
}

/** Returns true when theme/highlight counts are mutually consistent. */
export function assertSnapshotHighlightInvariant(grouping: ThemeGrouping): boolean {
  if (grouping.themes.length === 0) {
    return grouping.highlightedCount === 0 && grouping.highlights.size === 0;
  }
  if (grouping.highlightedCount === 0) return false;
  const themeIds = new Set<string>();
  for (const t of grouping.themes) {
    for (const id of t.resultIds) themeIds.add(id);
  }
  if (themeIds.size === 0) return false;
  for (const id of grouping.highlights.keys()) {
    if (!themeIds.has(id)) return false;
  }
  return true;
}
