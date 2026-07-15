/**
 * Measured, geometry-aware pagination for ORION First36 search-position tables.
 *
 * Single source of truth: TypeScript computes how many rows fit on each slide
 * using an EMU geometry model that mirrors renderer/orion_golden_renderer.py.
 * The Python renderer then renders exactly the rows each (continuation) slide
 * carries — no hidden row cap, no clipping, no character-level word breaks.
 *
 * Hard rules enforced here:
 *  - body font never below 9pt (MIN_BODY_PT);
 *  - title wraps by words to at most `maxTitleLines`, then ellipsis;
 *  - a row never crosses the footer / table region bottom;
 *  - no artificial 6/7/10-row cap — capacity is derived from geometry;
 *  - every dataset row is displayed across the base slide + continuations,
 *    except explicitly excluded rows (recorded with reasons).
 */

/** EMU geometry mirrored from renderer/orion_golden_renderer.py. */
export const RENDERER_GEOMETRY = {
  EMU_PER_PT: 12_700,
  SLIDE_W: 11_704_320,
  SLIDE_H: 7_315_200,
  MARGIN_X: 480_000,
  CONTENT_W: 11_704_320 - 2 * 480_000,
  FOOTER_Y: 7_315_200 - 440_000,
  CONTENT_BOTTOM: 7_315_200 - 700_000,
  /** Deterministic monospace-ish width factor, matches serp-snapshot/layout.ts. */
  CHAR_W_FACTOR: 0.52,
  /** Line leading multiplier for wrapped body text. */
  LINE_LEADING: 1.2,
} as const;

export const MIN_BODY_PT = 9;
export const PREFERRED_BODY_PT = 10;

export type SearchResultRow = {
  /** Normalized query used for grouping (group header shows the human query). */
  queryNormalized: string;
  /** Human-readable query for the group header. */
  queryDisplay: string;
  position: string;
  domain: string;
  title: string;
  /** Client-safe status label (e.g. "Нежелательный", "Нейтральный"). */
  status: string;
  adverse: boolean;
  /** Stable ordering hints. */
  engine?: string;
  capturedAt?: string;
  /** Deterministic tie-breaker (evidence key / url). */
  tieBreaker?: string;
};

export type ExcludedRowReason =
  | "EXACT_DUPLICATE"
  | "WRONG_SUBJECT"
  | "IRRELEVANT"
  | "CLIENT_POLICY";

export type PaginatedRow = SearchResultRow & {
  /** True when this row is the first row of a query group on its page. */
  startsGroup: boolean;
  /** Estimated title line count at the chosen font size (1..maxTitleLines). */
  titleLines: number;
};

export type PaginatedSearchPage = {
  pageIndex: number;
  pageCount: number;
  rows: PaginatedRow[];
  /** Distinct query group headers rendered on this page, in order. */
  groupHeaders: Array<{ queryNormalized: string; queryDisplay: string }>;
  pageDisplayedCount: number;
  pageDisplayedAdverseCount: number;
  /** Chosen body font size for this deck (constant across pages). */
  bodyFontPt: number;
  /** True when a query group continues from the previous page. */
  continuesGroupFromPrevious: boolean;
};

export type SearchPaginationResult = {
  pages: PaginatedSearchPage[];
  datasetCount: number;
  datasetAdverseCount: number;
  deckDisplayedCount: number;
  deckDisplayedAdverseCount: number;
  excludedCount: number;
  excludedReasons: Partial<Record<ExcludedRowReason, number>>;
  bodyFontPt: number;
  /** Whether the whole dataset fits on a single slide (no continuation needed). */
  singleSlide: boolean;
};

export type ColumnProportions = {
  /** Optional compact Q-tag column (0 when queries shown as group headers only). */
  q: number;
  position: number;
  domain: number;
  title: number;
  status: number;
};

/** Recommended proportions without a Q column (query shown as group header). */
export const COLUMN_PROPORTIONS_GROUPED: ColumnProportions = {
  q: 0,
  position: 0.07,
  domain: 0.22,
  title: 0.53,
  status: 0.18,
};

/** Recommended proportions with a compact Q-tag column. */
export const COLUMN_PROPORTIONS_QTAG: ColumnProportions = {
  q: 0.05,
  position: 0.07,
  domain: 0.2,
  title: 0.51,
  status: 0.17,
};

export type PaginateSearchResultsInput = {
  items: SearchResultRow[];
  /** Slide bounds in EMU (defaults to renderer geometry). */
  slideWidth?: number;
  slideHeight?: number;
  /** Vertical EMU bounds available for the table body (below title/intro, above footer). */
  availableBounds?: { top: number; bottom: number };
  fontMetrics?: { charWidthFactor?: number; lineLeading?: number };
  minFontSize?: number;
  preferredFontSize?: number;
  maxTitleLines?: number;
  /** EMU height reserved for a compact per-query group header (16–20pt band). */
  groupHeaderHeight?: number;
  /** EMU vertical padding added to each row on top of text height. */
  rowPadding?: number;
  /** EMU header-row height (column titles). */
  headerRowHeight?: number;
  columns?: ColumnProportions;
  /** When true, group header column shows compact Q-tag instead of full query. */
  useQTag?: boolean;
};

function ptToEmu(pt: number): number {
  return Math.round(pt * RENDERER_GEOMETRY.EMU_PER_PT);
}

function lineHeightEmu(pt: number, leading: number): number {
  return Math.round(pt * RENDERER_GEOMETRY.EMU_PER_PT * leading);
}

/**
 * Word-aware line count for a title within a column width.
 * Never breaks inside a word; an over-long single word occupies its own line.
 */
export function estimateTitleLines(
  title: string,
  columnWidthEmu: number,
  fontPt: number,
  maxLines: number,
  charWidthFactor: number
): number {
  const text = (title ?? "").trim();
  if (!text) return 1;
  const charW = fontPt * RENDERER_GEOMETRY.EMU_PER_PT * charWidthFactor;
  const maxCharsPerLine = Math.max(1, Math.floor(columnWidthEmu / charW));
  const words = text.split(/\s+/).filter(Boolean);
  let lines = 1;
  let current = 0;
  for (const word of words) {
    const wordLen = word.length;
    const add = current === 0 ? wordLen : current + 1 + wordLen;
    if (add <= maxCharsPerLine) {
      current = add;
    } else {
      lines += 1;
      // Over-long word: it still occupies (at least) one line; do not split chars.
      current = Math.min(wordLen, maxCharsPerLine);
      if (lines >= maxLines) return maxLines;
    }
  }
  return Math.min(lines, maxLines);
}

function normalizeQuery(q: string): string {
  return (q ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Deterministic dataset ordering: query group (first appearance) → position →
 * engine → capturedAt → tie-breaker. Adverse rows are never dropped; ordering
 * only affects layout, not inclusion.
 */
function orderRows(items: SearchResultRow[]): SearchResultRow[] {
  const groupOrder = new Map<string, number>();
  let next = 0;
  for (const it of items) {
    const key = normalizeQuery(it.queryNormalized || it.queryDisplay);
    if (!groupOrder.has(key)) groupOrder.set(key, next++);
  }
  const posNum = (p: string): number => {
    const m = String(p ?? "").match(/\d+/);
    return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER;
  };
  return [...items].sort((a, b) => {
    const ga = groupOrder.get(normalizeQuery(a.queryNormalized || a.queryDisplay)) ?? 0;
    const gb = groupOrder.get(normalizeQuery(b.queryNormalized || b.queryDisplay)) ?? 0;
    if (ga !== gb) return ga - gb;
    const pa = posNum(a.position);
    const pb = posNum(b.position);
    if (pa !== pb) return pa - pb;
    const ea = a.engine ?? "";
    const eb = b.engine ?? "";
    if (ea !== eb) return ea < eb ? -1 : 1;
    const ca = a.capturedAt ?? "";
    const cb = b.capturedAt ?? "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    const ta = a.tieBreaker ?? "";
    const tb = b.tieBreaker ?? "";
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
}

/**
 * Paginate search-position rows into base + continuation slides using measured
 * geometry. Guarantees every input row appears on exactly one page.
 */
export function paginateSearchResults(input: PaginateSearchResultsInput): SearchPaginationResult {
  const g = RENDERER_GEOMETRY;
  const charWidthFactor = input.fontMetrics?.charWidthFactor ?? g.CHAR_W_FACTOR;
  const leading = input.fontMetrics?.lineLeading ?? g.LINE_LEADING;
  const minPt = Math.max(MIN_BODY_PT, input.minFontSize ?? MIN_BODY_PT);
  const preferredPt = Math.max(minPt, input.preferredFontSize ?? PREFERRED_BODY_PT);
  const maxTitleLines = Math.max(1, input.maxTitleLines ?? 2);
  const contentW = (input.slideWidth ?? g.SLIDE_W) - 2 * g.MARGIN_X;
  const bounds = input.availableBounds ?? { top: 1_150_000, bottom: g.CONTENT_BOTTOM };
  const availableHeight = Math.max(0, bounds.bottom - bounds.top);
  const groupHeaderHeight = input.groupHeaderHeight ?? ptToEmu(18);
  const rowPadding = input.rowPadding ?? ptToEmu(6);
  const headerRowHeight = input.headerRowHeight ?? ptToEmu(26);
  const columns = input.columns ?? (input.useQTag ? COLUMN_PROPORTIONS_QTAG : COLUMN_PROPORTIONS_GROUPED);
  const titleColWidth = Math.max(1, Math.round(contentW * columns.title));

  // Dedup exact duplicates deterministically; record exclusions.
  const excludedReasons: Partial<Record<ExcludedRowReason, number>> = {};
  const seen = new Set<string>();
  const ordered = orderRows(input.items);
  const dataset: SearchResultRow[] = [];
  for (const row of ordered) {
    const dedupKey = [
      normalizeQuery(row.queryNormalized || row.queryDisplay),
      row.position,
      row.domain,
      (row.title ?? "").trim().toLowerCase(),
    ].join("|");
    if (seen.has(dedupKey)) {
      excludedReasons.EXACT_DUPLICATE = (excludedReasons.EXACT_DUPLICATE ?? 0) + 1;
      continue;
    }
    seen.add(dedupKey);
    dataset.push(row);
  }

  const datasetCount = dataset.length;
  const datasetAdverseCount = dataset.filter((r) => r.adverse).length;
  const excludedCount = Object.values(excludedReasons).reduce((a, b) => a + (b ?? 0), 0);

  const bodyFontPt = preferredPt;
  const lineH = lineHeightEmu(bodyFontPt, leading);

  const rowHeight = (row: SearchResultRow): { height: number; titleLines: number } => {
    const titleLines = estimateTitleLines(row.title, titleColWidth, bodyFontPt, maxTitleLines, charWidthFactor);
    const height = titleLines * lineH + rowPadding;
    return { height, titleLines };
  };

  const pages: PaginatedSearchPage[] = [];
  let current: PaginatedRow[] = [];
  let currentGroups: Array<{ queryNormalized: string; queryDisplay: string }> = [];
  let usedHeight = headerRowHeight;
  let lastGroupKey: string | null = null;
  let pageStartGroupKey: string | null = null;
  let continuesGroup = false;

  const flush = () => {
    if (!current.length && pages.length > 0) return;
    pages.push({
      pageIndex: pages.length,
      pageCount: 0,
      rows: current,
      groupHeaders: currentGroups,
      pageDisplayedCount: current.length,
      pageDisplayedAdverseCount: current.filter((r) => r.adverse).length,
      bodyFontPt,
      continuesGroupFromPrevious: continuesGroup,
    });
  };

  for (const row of dataset) {
    const key = normalizeQuery(row.queryNormalized || row.queryDisplay);
    const startsGroup = key !== lastGroupKey;
    const { height, titleLines } = rowHeight(row);
    const groupCost = startsGroup ? groupHeaderHeight : 0;
    const projected = usedHeight + groupCost + height;

    if (projected > availableHeight && current.length > 0) {
      // Close current page, open a continuation.
      flush();
      continuesGroup = lastGroupKey === key; // same group spilling over
      current = [];
      currentGroups = [];
      usedHeight = headerRowHeight;
      pageStartGroupKey = null;
      // Re-emit group header on the continuation page for the spilling group.
      const reGroup = true;
      if (reGroup) {
        currentGroups.push({ queryNormalized: key, queryDisplay: row.queryDisplay });
        usedHeight += groupHeaderHeight;
      }
      current.push({ ...row, startsGroup: true, titleLines });
      usedHeight += height;
      lastGroupKey = key;
      pageStartGroupKey = key;
      continue;
    }

    if (startsGroup) {
      currentGroups.push({ queryNormalized: key, queryDisplay: row.queryDisplay });
      usedHeight += groupHeaderHeight;
      if (pageStartGroupKey === null) pageStartGroupKey = key;
    }
    current.push({ ...row, startsGroup, titleLines });
    usedHeight += height;
    lastGroupKey = key;
  }
  flush();

  if (pages.length === 0) {
    pages.push({
      pageIndex: 0,
      pageCount: 1,
      rows: [],
      groupHeaders: [],
      pageDisplayedCount: 0,
      pageDisplayedAdverseCount: 0,
      bodyFontPt,
      continuesGroupFromPrevious: false,
    });
  }

  for (const p of pages) p.pageCount = pages.length;

  const deckDisplayedCount = pages.reduce((a, p) => a + p.pageDisplayedCount, 0);
  const deckDisplayedAdverseCount = pages.reduce((a, p) => a + p.pageDisplayedAdverseCount, 0);

  return {
    pages,
    datasetCount,
    datasetAdverseCount,
    deckDisplayedCount,
    deckDisplayedAdverseCount,
    excludedCount,
    excludedReasons,
    bodyFontPt,
    singleSlide: pages.length === 1,
  };
}

/**
 * Client-safe counter copy for a search-position slide, per spec §7.
 * Never says "N из M показанных" unless M rows are actually on the page.
 */
export function buildSearchCounterCopy(input: {
  result: SearchPaginationResult;
  page: PaginatedSearchPage;
}): string {
  const { result, page } = input;
  const { datasetCount, datasetAdverseCount } = result;
  if (result.singleSlide) {
    const lines = [
      `В анализируемом наборе: ${datasetAdverseCount} нежелательных результата из ${datasetCount}.`,
      `На слайде показаны все ${datasetCount} результатов.`,
    ];
    return lines.join(" ");
  }
  if (page.pageIndex === 0) {
    return [
      `В анализируемом наборе: ${datasetAdverseCount} нежелательных результата из ${datasetCount}.`,
      `На этой странице: ${page.pageDisplayedCount} результатов, включая ${page.pageDisplayedAdverseCount} нежелательных.`,
    ].join(" ");
  }
  const shownSoFar = result.pages
    .slice(0, page.pageIndex + 1)
    .reduce((a, p) => a + p.pageDisplayedCount, 0);
  return [
    `Продолжение таблицы.`,
    `На этой странице: ${page.pageDisplayedCount} результатов.`,
    `Всего в разделе показано: ${shownSoFar} из ${datasetCount}.`,
  ].join(" ");
}
