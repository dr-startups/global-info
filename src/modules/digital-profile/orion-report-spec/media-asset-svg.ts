import sharp from "sharp";
import { COLORS, FONT_STACK, FS, truncateToWidth } from "../serp-snapshot/layout";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type ImageGridItem = {
  title: string;
  domain: string;
  previewBase64?: string;
  unavailableNote?: string;
};

async function tryFetchImagePreview(url: string): Promise<string | undefined> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 2_000_000) return undefined;
    const png = await sharp(buf).rotate().resize(320, 200, { fit: "inside" }).png().toBuffer();
    return png.toString("base64");
  } catch {
    return undefined;
  }
}

export async function buildImageGridItems(
  items: Array<{ title: string; domain?: string; imageUrl?: string }>
): Promise<ImageGridItem[]> {
  const out: ImageGridItem[] = [];
  for (const item of items.slice(0, 6)) {
    const domain = item.domain ?? "";
    let previewBase64: string | undefined;
    if (item.imageUrl) {
      previewBase64 = await tryFetchImagePreview(item.imageUrl);
    }
    out.push({
      title: item.title,
      domain,
      previewBase64,
      unavailableNote: previewBase64 ? undefined : "Изображение недоступно для предпросмотра",
    });
  }
  return out;
}

export function buildImageGridSvg(input: { title: string; items: ImageGridItem[] }): string {
  const width = 1200;
  const height = 680;
  const cols = 3;
  const cellW = 360;
  const cellH = 200;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="100%" height="100%" fill="${COLORS.pageBg}"/>`,
    `<text x="40" y="48" font-family="${FONT_STACK}" font-size="22" fill="${COLORS.text}">${esc(input.title)}</text>`,
  ];
  input.items.forEach((item, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = 40 + col * (cellW + 16);
    const y = 80 + row * (cellH + 16);
    parts.push(`<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" rx="8" fill="${COLORS.panel}" stroke="${COLORS.panelBorder}"/>`);
    if (item.previewBase64) {
      parts.push(
        `<image href="data:image/png;base64,${item.previewBase64}" x="${x + 8}" y="${y + 8}" width="${cellW - 16}" height="${cellH - 56}" preserveAspectRatio="xMidYMid meet"/>`
      );
    } else {
      parts.push(`<rect x="${x + 8}" y="${y + 8}" width="${cellW - 16}" height="${cellH - 56}" fill="#f8fafc" stroke="${COLORS.panelBorder}"/>`);
      const note = truncateToWidth(item.unavailableNote ?? "", cellW - 24, 11);
      parts.push(
        `<text x="${x + 16}" y="${y + 48}" font-family="${FONT_STACK}" font-size="11" fill="${COLORS.muted}">${esc(note)}</text>`
      );
    }
    parts.push(
      `<text x="${x + 12}" y="${y + cellH - 28}" font-family="${FONT_STACK}" font-size="12" fill="${COLORS.text}">${esc(truncateToWidth(item.title, cellW - 24, 12))}</text>`
    );
    if (item.domain) {
      parts.push(
        `<text x="${x + 12}" y="${y + cellH - 12}" font-family="${FONT_STACK}" font-size="11" fill="${COLORS.urlGreen}">${esc(truncateToWidth(item.domain, cellW - 24, 11))}</text>`
      );
    }
  });
  parts.push("</svg>");
  return parts.join("");
}

export function buildVideoCardsSvg(input: {
  title: string;
  items: Array<{ label: string; domain?: string; context?: string }>;
}): string {
  const width = 1200;
  const height = Math.min(560, 120 + input.items.length * 110);
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="100%" height="100%" fill="${COLORS.pageBg}"/>`,
    `<text x="40" y="48" font-family="${FONT_STACK}" font-size="22" fill="${COLORS.text}">${esc(input.title)}</text>`,
  ];
  input.items.slice(0, 4).forEach((item, idx) => {
    const y = 80 + idx * 100;
    parts.push(`<rect x="40" y="${y}" width="1120" height="88" rx="8" fill="${COLORS.panel}" stroke="${COLORS.panelBorder}"/>`);
    parts.push(`<polygon points="60,${y + 24} 60,${y + 64} 92,${y + 44}" fill="${COLORS.brandA}"/>`);
    parts.push(
      `<text x="110" y="${y + 34}" font-family="${FONT_STACK}" font-size="15" fill="${COLORS.text}">${esc(truncateToWidth(item.label, 700, 15))}</text>`
    );
    if (item.domain) {
      parts.push(
        `<text x="110" y="${y + 54}" font-family="${FONT_STACK}" font-size="12" fill="${COLORS.urlGreen}">${esc(item.domain)}</text>`
      );
    }
    if (item.context) {
      parts.push(
        `<text x="110" y="${y + 72}" font-family="${FONT_STACK}" font-size="11" fill="${COLORS.muted}">${esc(truncateToWidth(item.context, 900, 11))}</text>`
      );
    }
  });
  parts.push("</svg>");
  return parts.join("");
}

export function buildKnowledgePanelSvg(input: {
  title: string;
  summary: string;
  facts: string[];
}): string {
  const width = 1200;
  const height = 420;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="100%" height="100%" fill="${COLORS.pageBg}"/>`,
    `<rect x="40" y="40" width="1120" height="340" rx="12" fill="${COLORS.panel}" stroke="${COLORS.panelBorder}"/>`,
    `<text x="64" y="84" font-family="${FONT_STACK}" font-size="22" fill="${COLORS.text}">${esc(input.title)}</text>`,
    `<text x="64" y="118" font-family="${FONT_STACK}" font-size="14" fill="${COLORS.muted}">${esc(truncateToWidth(input.summary, 1000, 14))}</text>`,
  ];
  input.facts.slice(0, 4).forEach((fact, idx) => {
    parts.push(
      `<text x="64" y="${160 + idx * 28}" font-family="${FONT_STACK}" font-size="13" fill="${COLORS.text}">• ${esc(truncateToWidth(fact, 900, 13))}</text>`
    );
  });
  parts.push("</svg>");
  return parts.join("");
}

export async function svgToPngBase64(svg: string): Promise<string> {
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return png.toString("base64");
}
