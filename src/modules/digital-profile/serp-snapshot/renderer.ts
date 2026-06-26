/**
 * SVG renderer + PNG rasterizer for ORION-style SERP snapshots (Stage S1).
 *
 * `buildSerpSnapshotSvg(viewModel)` builds a fully self-contained, deterministic
 * SVG string (all text escaped/truncated/wrapped, no raw HTML, no external image
 * URLs, no external fonts — system font stack only). `renderSerpSnapshotPng`
 * rasterizes it with sharp. No browser / Playwright is involved.
 */

import sharp from "sharp";
import { serpSnapshotConfig } from "./config";
import {
  COLORS,
  FONT_STACK,
  FS,
  computeLayout,
  truncateToWidth,
  wrapToWidth,
  type Rect,
  type SnapshotLayout,
} from "./layout";
import type {
  SerpEngineView,
  SerpSnapshotViewModel,
  SnapshotTheme,
} from "./types";

// ---------------------------------------------------------------------------
// SVG primitives (all user text passes through esc())
// ---------------------------------------------------------------------------

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function n(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}

interface TextOpts {
  size: number;
  fill: string;
  weight?: number | "bold";
  anchor?: "start" | "middle" | "end";
  opacity?: number;
}

function svgText(x: number, y: number, content: string, o: TextOpts): string {
  const attrs = [
    `x="${n(x)}"`,
    `y="${n(y)}"`,
    `font-family="${FONT_STACK}"`,
    `font-size="${o.size}"`,
    `fill="${o.fill}"`,
    o.weight ? `font-weight="${o.weight}"` : "",
    o.anchor ? `text-anchor="${o.anchor}"` : "",
    o.opacity != null ? `opacity="${o.opacity}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<text ${attrs}>${esc(content)}</text>`;
}

interface RectOpts {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  rx?: number;
  opacity?: number;
}

function svgRect(x: number, y: number, w: number, h: number, o: RectOpts = {}): string {
  const attrs = [
    `x="${n(x)}"`,
    `y="${n(y)}"`,
    `width="${n(Math.max(0, w))}"`,
    `height="${n(Math.max(0, h))}"`,
    o.rx != null ? `rx="${o.rx}"` : "",
    o.fill ? `fill="${o.fill}"` : `fill="none"`,
    o.stroke ? `stroke="${o.stroke}"` : "",
    o.strokeWidth != null ? `stroke-width="${o.strokeWidth}"` : "",
    o.opacity != null ? `opacity="${o.opacity}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<rect ${attrs} />`;
}

function svgCircle(cx: number, cy: number, r: number, fill: string): string {
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${fill}" />`;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader(vm: SerpSnapshotViewModel, L: SnapshotLayout): string {
  const h = L.header;
  const parts: string[] = [];

  // Decorative corner (abstract red/blue triangles — NOT a third-party logo).
  const c = h.x + h.w;
  parts.push(
    `<polygon points="${n(c - 46)},${n(h.y)} ${n(c)},${n(h.y)} ${n(c)},${n(h.y + 46)}" fill="${COLORS.brandA}" />`
  );
  parts.push(
    `<polygon points="${n(c - 26)},${n(h.y)} ${n(c)},${n(h.y)} ${n(c)},${n(h.y + 26)}" fill="${COLORS.brandB}" />`
  );

  // Small section label + engine markers.
  parts.push(svgText(h.x, h.y + 14, "01", { size: FS.headerLabel, fill: COLORS.headerLabel, weight: "bold" }));
  parts.push(svgText(h.x + 24, h.y + 14, vm.language === "ru" ? "Ссылки" : "Links", { size: FS.headerLabel, fill: COLORS.headerLabel }));

  parts.push(svgCircle(h.x + 8, h.y + 36, 9, COLORS.yandex));
  parts.push(svgText(h.x + 8, h.y + 40, "Я", { size: 11, fill: "#ffffff", anchor: "middle", weight: "bold" }));
  parts.push(svgCircle(h.x + 30, h.y + 36, 9, COLORS.google));
  parts.push(svgText(h.x + 30, h.y + 40, "G", { size: 11, fill: "#ffffff", anchor: "middle", weight: "bold" }));

  // Right-side block: date + brand.
  const rightW = 280;
  parts.push(
    svgText(c - 56, h.y + 22, vm.dateLabel, { size: FS.date, fill: COLORS.muted, anchor: "end" })
  );
  parts.push(
    svgText(c - 56, h.y + 44, "Digital Profile Audit", {
      size: FS.brand,
      fill: COLORS.brandA,
      anchor: "end",
      weight: "bold",
    })
  );

  // Title (wrapped, max 2 lines), left of the right block.
  const titleW = h.w - rightW - 60;
  const titleLines = wrapToWidth(vm.title, titleW, FS.title, 2);
  let ty = h.y + 64;
  for (const line of titleLines) {
    parts.push(svgText(h.x, ty, line, { size: FS.title, fill: COLORS.text, weight: "bold" }));
    ty += 26;
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Left column: themes table
// ---------------------------------------------------------------------------

function renderThemesTable(vm: SerpSnapshotViewModel, L: SnapshotLayout): string {
  const r = L.leftCol;
  const parts: string[] = [];
  parts.push(svgRect(r.x, r.y, r.w, r.h, { fill: COLORS.panel, stroke: COLORS.panelBorder, rx: 10, strokeWidth: 1 }));

  const padX = 14;
  const countColW = 120;
  const titleColW = r.w - padX * 2 - countColW;
  const headerH = 56;

  // Header row.
  parts.push(svgRect(r.x, r.y, r.w, headerH, { fill: "#f9fafb", rx: 10 }));
  parts.push(svgRect(r.x, r.y + headerH - 1, r.w, 1, { fill: COLORS.panelBorder }));
  const hTitle = vm.language === "ru" ? "Темы нежелательных публикаций" : "Themes of adverse publications";
  const hCount = vm.language === "ru" ? "Кол-во публикаций" : "Publications";
  // Title header (may wrap to 2 lines).
  const hTitleLines = wrapToWidth(hTitle, titleColW + countColW - 10, FS.tableHeader, 2);
  let hy = r.y + 22;
  for (const line of hTitleLines) {
    parts.push(svgText(r.x + padX, hy, line, { size: FS.tableHeader, fill: COLORS.muted, weight: "bold" }));
    hy += 16;
  }
  const hCountLines = wrapToWidth(hCount, countColW - 8, FS.tableHeader, 2);
  let hcy = r.y + 22;
  for (const line of hCountLines) {
    parts.push(
      svgText(r.x + r.w - padX, hcy, line, { size: FS.tableHeader, fill: COLORS.muted, weight: "bold", anchor: "end" })
    );
    hcy += 16;
  }

  if (vm.noNegatives || vm.themes.length === 0) {
    const msg =
      vm.language === "ru"
        ? "Нежелательные публикации не обнаружены"
        : "No adverse publications found";
    const lines = wrapToWidth(msg, r.w - padX * 2, FS.tableCell, 3);
    let my = r.y + headerH + 48;
    for (const line of lines) {
      parts.push(svgText(r.x + r.w / 2, my, line, { size: FS.tableCell, fill: COLORS.muted, anchor: "middle" }));
      my += 22;
    }
    return parts.join("\n");
  }

  // Rows (adaptive height).
  let y = r.y + headerH;
  const numColW = 28;
  for (const theme of vm.themes) {
    const titleLines = wrapToWidth(theme.title, titleColW - numColW - 6, FS.tableCell, 2);
    const rowH = Math.max(46, 16 + titleLines.length * 20);
    if (y + rowH > r.y + r.h) break;

    // Count cell background (light blue).
    parts.push(
      svgRect(r.x + r.w - padX - countColW, y + 8, countColW, rowH - 16, {
        fill: COLORS.countBg,
        stroke: COLORS.countBorder,
        rx: 6,
        strokeWidth: 1,
      })
    );
    // Theme number badge.
    parts.push(svgCircle(r.x + padX + 9, y + rowH / 2, 11, theme.color));
    parts.push(
      svgText(r.x + padX + 9, y + rowH / 2 + 4, String(theme.themeNumber), {
        size: 12,
        fill: "#ffffff",
        anchor: "middle",
        weight: "bold",
      })
    );
    // Title lines.
    let ly = y + (rowH - titleLines.length * 20) / 2 + 15;
    for (const line of titleLines) {
      parts.push(svgText(r.x + padX + numColW, ly, line, { size: FS.tableCell, fill: COLORS.text }));
      ly += 20;
    }
    // Count value.
    parts.push(
      svgText(r.x + r.w - padX - countColW / 2, y + rowH / 2 + 6, String(theme.count), {
        size: FS.count,
        fill: COLORS.highlight,
        anchor: "middle",
        weight: "bold",
      })
    );
    // Row divider.
    parts.push(svgRect(r.x + padX, y + rowH, r.w - padX * 2, 1, { fill: COLORS.panelBorder }));
    y += rowH;
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Right area: two SERP cards
// ---------------------------------------------------------------------------

const RESULT_TAG_W = 22;
const LINE_TITLE = 21;
const LINE_URL = 17;
const LINE_SNIPPET = 16;
const BLOCK_PAD = 8;
const BLOCK_GAP = 12;

function tabsFor(language: "ru" | "en"): string[] {
  return language === "ru"
    ? ["Поиск", "Картинки", "Видео", "Новости", "Карты"]
    : ["Search", "Images", "Video", "News", "Maps"];
}

function renderEngineCard(
  view: SerpEngineView,
  rect: Rect,
  vm: SerpSnapshotViewModel
): string {
  const parts: string[] = [];
  parts.push(svgRect(rect.x, rect.y, rect.w, rect.h, { fill: COLORS.panel, stroke: COLORS.panelBorder, rx: 10, strokeWidth: 1 }));

  const innerX = rect.x + 14;
  const innerW = rect.w - 28;
  let y = rect.y + 14;

  // Search bar.
  const barH = 40;
  parts.push(svgRect(innerX, y, innerW, barH, { fill: "#f9fafb", stroke: COLORS.panelBorder, rx: 20, strokeWidth: 1 }));
  const isYandex = view.engine === "YANDEX";
  parts.push(svgCircle(innerX + 22, y + barH / 2, 11, isYandex ? COLORS.yandex : COLORS.google));
  parts.push(
    svgText(innerX + 22, y + barH / 2 + 4, isYandex ? "Я" : "G", {
      size: 13,
      fill: "#ffffff",
      anchor: "middle",
      weight: "bold",
    })
  );
  parts.push(
    svgText(innerX + 44, y + barH / 2 + 5, truncateToWidth(view.query, innerW - 110, FS.searchQuery), {
      size: FS.searchQuery,
      fill: COLORS.text,
    })
  );
  // Magnifier hint on the right of the bar.
  parts.push(
    `<circle cx="${n(innerX + innerW - 22)}" cy="${n(y + barH / 2 - 1)}" r="5" fill="none" stroke="${COLORS.muted}" stroke-width="2" />`
  );
  y += barH + 14;

  // Tabs row.
  let tx = innerX;
  tabsFor(vm.language).forEach((tab, i) => {
    const active = i === 0;
    parts.push(
      svgText(tx, y, tab, {
        size: FS.tab,
        fill: active ? COLORS.tabActive : COLORS.muted,
        weight: active ? "bold" : undefined,
      })
    );
    if (active) {
      parts.push(svgRect(tx, y + 6, view.engine === "YANDEX" ? 34 : 38, 2, { fill: isYandex ? COLORS.yandex : COLORS.google }));
    }
    tx += tab.length * FS.tab * 0.62 + 18;
  });
  y += 22;

  if (view.empty || view.results.length === 0) {
    const msg = vm.language === "ru" ? "Нет сохранённых результатов" : "No stored results";
    parts.push(
      svgText(rect.x + rect.w / 2, rect.y + rect.h / 2, msg, {
        size: FS.tableCell,
        fill: COLORS.muted,
        anchor: "middle",
      })
    );
    return parts.join("\n");
  }

  const bottom = rect.y + rect.h - 8;
  for (const res of view.results) {
    const contentX = res.isHighlighted ? innerX + RESULT_TAG_W + 10 : innerX;
    const contentW = res.isHighlighted ? innerW - RESULT_TAG_W - 20 : innerW;
    const faviconW = 22;
    const textW = contentW - faviconW;

    const snippetLines = wrapToWidth(res.snippet, contentW, FS.resultSnippet, 2);
    const blockH =
      BLOCK_PAD + LINE_TITLE + LINE_URL + snippetLines.length * LINE_SNIPPET + BLOCK_PAD;

    if (y + blockH > bottom) break;

    if (res.isHighlighted) {
      // Red rounded frame around the whole result block.
      parts.push(
        svgRect(innerX, y, innerW, blockH, {
          fill: COLORS.highlightFill,
          stroke: COLORS.highlight,
          rx: 8,
          strokeWidth: 2,
        })
      );
      // Vertical theme tag on the left.
      parts.push(svgRect(innerX, y, RESULT_TAG_W, blockH, { fill: COLORS.highlight, rx: 6 }));
      const cx = innerX + RESULT_TAG_W / 2;
      const cy = y + blockH / 2;
      parts.push(
        `<text x="${n(cx)}" y="${n(cy)}" font-family="${FONT_STACK}" font-size="${FS.themeTag}" fill="#ffffff" font-weight="bold" text-anchor="middle" transform="rotate(-90 ${n(cx)} ${n(cy)})">${esc(res.themeLabel ?? "")}</text>`
      );
    }

    let ry = y + BLOCK_PAD + 14;
    // Favicon placeholder + title.
    parts.push(svgRect(contentX, ry - 12, 16, 16, { fill: COLORS.favicon, rx: 3 }));
    parts.push(
      svgText(contentX + faviconW, ry, truncateToWidth(res.title, textW, FS.resultTitle), {
        size: FS.resultTitle,
        fill: COLORS.link,
      })
    );
    ry += LINE_URL;
    // URL / domain.
    parts.push(
      svgText(contentX, ry, truncateToWidth(res.url || res.domain, contentW, FS.resultUrl), {
        size: FS.resultUrl,
        fill: COLORS.urlGreen,
      })
    );
    ry += LINE_SNIPPET;
    // Snippet.
    for (const line of snippetLines) {
      parts.push(svgText(contentX, ry, line, { size: FS.resultSnippet, fill: COLORS.muted }));
      ry += LINE_SNIPPET;
    }

    y += blockH + BLOCK_GAP;
  }

  return parts.join("\n");
}

function renderRightArea(vm: SerpSnapshotViewModel, L: SnapshotLayout): string {
  const parts: string[] = [];
  const label = vm.language === "ru" ? "Примеры поиска в Яндексе и Google" : "Search examples in Yandex and Google";
  parts.push(svgText(L.rightArea.x, L.rightLabelY, label, { size: FS.sectionLabel, fill: COLORS.text, weight: "bold" }));
  parts.push(renderEngineCard(vm.engines.yandex, L.cardYandex, vm));
  parts.push(renderEngineCard(vm.engines.google, L.cardGoogle, vm));
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

function renderFooter(vm: SerpSnapshotViewModel, L: SnapshotLayout): string {
  const parts: string[] = [];
  parts.push(
    svgText(L.pad, L.footerY, vm.footerNote, { size: FS.footer, fill: COLORS.muted, opacity: 0.85 })
  );
  // Stage N1.2 — secrets-free source attribution, right-aligned on the same row.
  if (vm.sourceLabel) {
    parts.push(
      svgText(vm.width - L.pad, L.footerY, vm.sourceLabel, {
        size: FS.footer,
        fill: COLORS.muted,
        anchor: "end",
        opacity: 0.85,
      })
    );
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Builds a deterministic, self-contained SVG string for the view model. */
export function buildSerpSnapshotSvg(vm: SerpSnapshotViewModel): string {
  const L = computeLayout(vm.width, vm.height);
  const body = [
    svgRect(0, 0, vm.width, vm.height, { fill: COLORS.pageBg }),
    renderHeader(vm, L),
    renderThemesTable(vm, L),
    renderRightArea(vm, L),
    renderFooter(vm, L),
  ].join("\n");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${vm.width}" height="${vm.height}" viewBox="0 0 ${vm.width} ${vm.height}">`,
    body,
    `</svg>`,
  ].join("\n");
}

/** Rasterizes the view model to PNG/JPEG bytes using sharp (no browser). */
export async function renderSerpSnapshotPng(vm: SerpSnapshotViewModel): Promise<Buffer> {
  const svg = buildSerpSnapshotSvg(vm);
  const pipeline = sharp(Buffer.from(svg), { density: 96 });
  if (serpSnapshotConfig.format === "jpg") {
    return pipeline.jpeg({ quality: 90 }).toBuffer();
  }
  return pipeline.png({ compressionLevel: 9 }).toBuffer();
}
