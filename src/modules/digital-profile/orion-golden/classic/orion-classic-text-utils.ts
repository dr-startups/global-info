/**
 * R10.11 — Classic ORION audit text helpers (word-boundary truncation, safe bullets).
 */

import { sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";

const META_COUNT_LINE =
  /\b\d+\s*материал(ов|а)?\b|ручной проверк|artifact-backed|секци(й|и)\s+проанализир|очеред(ь|и)\s+ручн|не трактуются как подтверждённ|сохранённая выдача|artifact[- ]backed/i;

const INCOMPLETE_CAVEAT =
  /(?:это\s+может\s+быть\s+связано\s+с|связано\s+с|может\s+быть\s+связано\s+с)\s*[:—–-]?\s*$/i;

export function truncateAtWordBoundary(text: string, maxLen: number): string {
  const clean = sanitizeOrionGoldenClientText(text);
  if (clean.length <= maxLen) return clean;
  const slice = clean.slice(0, maxLen);
  const lastSpace = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\u00a0"));
  if (lastSpace > Math.floor(maxLen * 0.45)) {
    return `${slice.slice(0, lastSpace).trim()}…`;
  }
  // Prefer cutting before a long trailing token rather than mid-word
  const soft = slice.replace(/[^\s]{1,12}$/, "").trim();
  if (soft.length > Math.floor(maxLen * 0.4)) return `${soft}…`;
  return `${slice.trim()}…`;
}

/** Drop process/meta lines and incomplete caveat stubs from client executive text. */
export function sanitizeExecutiveClientText(text: string, maxLen = 1400): string {
  const cleaned = sanitizeOrionGoldenClientText(text)
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !META_COUNT_LINE.test(line))
    .map((line) => {
      if (INCOMPLETE_CAVEAT.test(line)) {
        return line.replace(INCOMPLETE_CAVEAT, "").trim().replace(/[:—–-]\s*$/, "").trim();
      }
      // Drop trailing dangling connectors after truncation artifacts
      return line.replace(/\s*(?:это\s+может\s+быть\s+связано\s+с|связано\s+с)\s*[:—–-]?\s*$/i, "").trim();
    })
    .filter((line) => line.length >= 12)
    .join("\n\n");

  return truncateAtWordBoundary(cleaned, maxLen);
}

export function isMetaProcessBullet(text: string): boolean {
  return META_COUNT_LINE.test(text) || INCOMPLETE_CAVEAT.test(text.trim());
}

export function asClientBullet(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const candidate = [rec.title, rec.summary, rec.text, rec.theme, rec.label, rec.query]
      .find((v) => typeof v === "string" && v.trim());
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

export function sanitizeClassicBullets(bullets: string[], maxLen = 220): string[] {
  return bullets
    .map((b) => truncateAtWordBoundary(asClientBullet(b), maxLen))
    .filter((b) => Boolean(b) && !/\[object Object\]/i.test(b))
    .filter((b) => !isMetaProcessBullet(b));
}

export function chunkItems<T>(items: T[], perChunk: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += perChunk) {
    out.push(items.slice(i, i + perChunk));
  }
  return out;
}
