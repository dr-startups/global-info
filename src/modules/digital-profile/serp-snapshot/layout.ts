/**
 * Pure layout geometry + deterministic text-fitting helpers for the SERP
 * snapshot SVG (Stage S1). No I/O, no rendering — only numbers and string
 * shaping so the renderer stays a thin SVG serializer and the layout is fully
 * deterministic for a given width/height.
 */

/** Average glyph width as a fraction of font size (system sans approximation). */
const CHAR_W_FACTOR = 0.52;

export const FONT_STACK =
  "'DejaVu Sans','Segoe UI',Arial,Helvetica,'Liberation Sans',sans-serif";

export const COLORS = {
  text: "#1f2937",
  muted: "#6b7280",
  link: "#1a56db",
  urlGreen: "#15803d",
  panel: "#ffffff",
  panelBorder: "#e5e7eb",
  pageBg: "#f3f4f6",
  headerLabel: "#6b7280",
  countBg: "#e0f2fe",
  countBorder: "#bae6fd",
  highlight: "#d1342f",
  highlightFill: "#fff5f5",
  amber: "#d97706",
  amberFill: "#fffbeb",
  tabActive: "#1f2937",
  yandex: "#ff0000",
  google: "#4285f4",
  brandA: "#1a56db",
  brandB: "#d1342f",
  favicon: "#cbd5e1",
} as const;

export const FS = {
  headerLabel: 14,
  title: 22,
  date: 14,
  brand: 16,
  sectionLabel: 16,
  tableHeader: 13,
  tableCell: 15,
  count: 18,
  searchQuery: 16,
  tab: 13,
  resultTitle: 16,
  resultUrl: 13,
  resultSnippet: 13,
  themeTag: 12,
  footer: 11,
} as const;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SnapshotLayout {
  width: number;
  height: number;
  pad: number;
  header: Rect;
  leftCol: Rect;
  rightArea: Rect;
  rightLabelY: number;
  cardYandex: Rect;
  cardGoogle: Rect;
  footerY: number;
}

const PAD = 28;
const FOOTER_H = 26;
const HEADER_H = 92;
const LEFT_COL_W = 432;
const COL_GAP = 24;
const RIGHT_LABEL_H = 30;

export function computeLayout(width: number, height: number): SnapshotLayout {
  const header: Rect = { x: PAD, y: PAD, w: width - 2 * PAD, h: HEADER_H };
  const contentTop = header.y + header.h + 16;
  const contentBottom = height - FOOTER_H - 10;

  const leftCol: Rect = {
    x: PAD,
    y: contentTop,
    w: LEFT_COL_W,
    h: contentBottom - contentTop,
  };

  const rightX = leftCol.x + leftCol.w + COL_GAP;
  const rightArea: Rect = {
    x: rightX,
    y: contentTop,
    w: width - rightX - PAD,
    h: contentBottom - contentTop,
  };

  const cardsY = rightArea.y + RIGHT_LABEL_H;
  const cardsH = rightArea.y + rightArea.h - cardsY;
  const cardW = (rightArea.w - COL_GAP) / 2;

  const cardYandex: Rect = { x: rightArea.x, y: cardsY, w: cardW, h: cardsH };
  const cardGoogle: Rect = {
    x: rightArea.x + cardW + COL_GAP,
    y: cardsY,
    w: cardW,
    h: cardsH,
  };

  return {
    width,
    height,
    pad: PAD,
    header,
    leftCol,
    rightArea,
    rightLabelY: rightArea.y + 18,
    cardYandex,
    cardGoogle,
    footerY: height - FOOTER_H + 6,
  };
}

// ---------------------------------------------------------------------------
// Text fitting (deterministic, char-width approximation)
// ---------------------------------------------------------------------------

export function estTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * CHAR_W_FACTOR;
}

export function maxCharsForWidth(widthPx: number, fontSize: number): number {
  return Math.max(1, Math.floor(widthPx / (fontSize * CHAR_W_FACTOR)));
}

/** Truncate to fit `widthPx` at `fontSize`, appending an ellipsis if cut. */
export function truncateToWidth(
  text: string,
  widthPx: number,
  fontSize: number
): string {
  const t = String(text ?? "");
  const max = maxCharsForWidth(widthPx, fontSize);
  if (t.length <= max) return t;
  if (max <= 1) return "…";
  return t.slice(0, max - 1).trimEnd() + "…";
}

/**
 * Word-wrap into at most `maxLines` lines fitting `widthPx`. The last line is
 * ellipsized when content overflows. Falls back to hard-splitting long tokens.
 */
export function wrapToWidth(
  text: string,
  widthPx: number,
  fontSize: number,
  maxLines: number
): string[] {
  const max = maxCharsForWidth(widthPx, fontSize);
  const words = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = "";

  const pushHardSplit = (word: string) => {
    let rest = word;
    while (rest.length > max) {
      if (lines.length >= maxLines) return;
      lines.push(rest.slice(0, max - 1) + "…");
      rest = rest.slice(max - 1);
    }
    current = rest;
  };

  for (const word of words) {
    if (lines.length >= maxLines) break;
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= max) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
      if (lines.length >= maxLines) break;
    }
    if (word.length > max) {
      pushHardSplit(word);
    } else {
      current = word;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);

  // If there is leftover content beyond maxLines, ellipsize the last line.
  if (lines.length === maxLines) {
    const consumed = lines.join(" ").length;
    const totalLen = words.join(" ").length;
    if (totalLen > consumed) {
      const last = lines[maxLines - 1];
      lines[maxLines - 1] =
        last.length >= max ? last.slice(0, max - 1) + "…" : last + "…";
    }
  }
  return lines;
}
