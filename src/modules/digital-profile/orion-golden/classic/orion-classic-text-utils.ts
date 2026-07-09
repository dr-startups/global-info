/**
 * R10.11 — Classic ORION audit text helpers (word-boundary truncation, safe bullets).
 */

import { sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";

const META_COUNT_LINE =
  /\b\d+\s*материал(ов|а)?\b|ручной проверк|artifact-backed|секци(й|и)\s+проанализир|очеред(ь|и)\s+ручн|не трактуются как подтверждённ|сохранённая выдача|artifact[- ]backed|исключено\s+\d+|сгруппировано\s+\d+\s*кластер|до\s+дедупликац|encyclopedic\s+eligibility|нейтральн(ого|ый)\s+цифров(ого|ый)\s+профил/i;

const INCOMPLETE_CAVEAT =
  /(?:это\s+может\s+быть\s+связано\s+с|связано\s+с|может\s+быть\s+связано\s+с)\s*[:—–-]?\s*$/i;

const KEYWORD_DUMP =
  /\b(accused|indicted|arrest|ofac|sanction)\b.*\b(accused|indicted|arrest|ofac|sanction|арест|уголовн)/i;

const NUMBERED_PREFIX =
  /^(?:ключевой\s+риск|рекомендация|риск|вывод|finding|recommendation)\s*\d+\s*[:.—–-]?\s*/i;

/** Soft-split long text into complete paragraphs/sentences without mid-thought ellipsis. */
export function splitCompleteChunks(text: string, maxLen: number): string[] {
  const clean = sanitizeOrionGoldenClientText(text).replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  const paragraphs = clean.split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const pushCurrent = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  const appendSentence = (sentence: string) => {
    const s = sentence.trim();
    if (!s) return;
    if (!current) {
      if (s.length <= maxLen) {
        current = s;
        return;
      }
      // Oversized single sentence: cut on word boundary but prefer ending on punctuation earlier
      const slice = s.slice(0, maxLen);
      const punct = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("; "), slice.lastIndexOf("! "));
      if (punct > Math.floor(maxLen * 0.5)) {
        chunks.push(slice.slice(0, punct + 1).trim());
        appendSentence(s.slice(punct + 1));
      } else {
        const sp = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\u00a0"));
        const cut = sp > Math.floor(maxLen * 0.45) ? sp : maxLen;
        chunks.push(slice.slice(0, cut).trim());
        appendSentence(s.slice(cut));
      }
      return;
    }
    if (`${current} ${s}`.length <= maxLen) {
      current = `${current} ${s}`;
      return;
    }
    pushCurrent();
    appendSentence(s);
  };

  for (const para of paragraphs) {
    if (current && `${current}\n\n${para}`.length > maxLen) {
      pushCurrent();
    }
    if (!current && para.length <= maxLen) {
      current = para;
      continue;
    }
    const sentences = para.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g) ?? [para];
    for (const sentence of sentences) appendSentence(sentence);
    if (current && paragraphs.length > 1) {
      // Keep paragraph breaks between chunks when possible
      pushCurrent();
    }
  }
  pushCurrent();
  return chunks.filter(Boolean);
}

export function truncateAtWordBoundary(text: string, maxLen: number): string {
  const clean = sanitizeOrionGoldenClientText(text);
  if (clean.length <= maxLen) return clean;
  // Prefer ending on a completed sentence rather than ellipsis mid-clause
  const slice = clean.slice(0, maxLen);
  const punct = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
  if (punct > Math.floor(maxLen * 0.55)) {
    return slice.slice(0, punct + 1).trim();
  }
  const lastSpace = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\u00a0"));
  if (lastSpace > Math.floor(maxLen * 0.45)) {
    return slice.slice(0, lastSpace).trim();
  }
  const soft = slice.replace(/[^\s]{1,12}$/, "").trim();
  if (soft.length > Math.floor(maxLen * 0.4)) return soft;
  return slice.trim();
}

/** Drop process/meta lines and incomplete caveat stubs from client executive text. */
export function sanitizeExecutiveClientText(text: string, maxLen = 2200): string {
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
      return line.replace(/\s*(?:это\s+может\s+быть\s+связано\s+с|связано\s+с)\s*[:—–-]?\s*$/i, "").trim();
    })
    .filter((line) => line.length >= 12)
    .join("\n\n");

  // Prefer split+join of complete chunks over a single hard ellipsis cut
  const chunks = splitCompleteChunks(cleaned, maxLen);
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return chunks[0];
  // Keep as much as fits in maxLen across complete chunks
  let out = chunks[0];
  for (let i = 1; i < chunks.length; i++) {
    const next = `${out}\n\n${chunks[i]}`;
    if (next.length > maxLen) break;
    out = next;
  }
  return out;
}

export function stripNumberedClientPrefix(text: string): string {
  return text.replace(NUMBERED_PREFIX, "").trim();
}

export function isMetaProcessBullet(text: string): boolean {
  const t = text.trim();
  return META_COUNT_LINE.test(t) || INCOMPLETE_CAVEAT.test(t) || KEYWORD_DUMP.test(t);
}

export function isClientActionRecommendation(text: string): boolean {
  const t = text.trim();
  if (!t || isMetaProcessBullet(t)) return false;
  if (/исключено\s+\d+|материал\(ов\)|encyclopedic|artifact-backed|очеред(ь|и)\s+ручн/i.test(t)) {
    return false;
  }
  // Prefer actionable verbs / verification language
  return /сверить|проверить|получить|сопоставить|зафиксировать|подтвердить|уточнить|запросить|использовать|исключить|сохранять|оценить|подготовить/i.test(
    t
  )
    ? true
    : t.length >= 40 && !/кластер\(ов\)|дедупликац/i.test(t);
}

export function asClientBullet(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    // Prefer summary over title — titles often are "Ключевой риск N"
    const candidate = [rec.summary, rec.text, rec.title, rec.theme, rec.label, rec.query]
      .find((v) => typeof v === "string" && v.trim());
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

export function sanitizeClassicBullets(bullets: string[], maxLen = 280): string[] {
  return bullets
    .map((b) => stripNumberedClientPrefix(asClientBullet(b)))
    .map((b) => truncateAtWordBoundary(b, maxLen))
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
