/**
 * Step 05.2(a) — publication dates from provider payloads.
 *
 * Both connectors carry a date and both threw it away: Yandex returns
 * `<modtime>20240826T183701</modtime>` inside the raw document XML, Serper
 * returns a human string (`"Aug 25, 2024"`, `"2 days ago"`) that only reached
 * `rawMetadata`. Nothing downstream ever saw a date, so the report could not
 * state when anything happened — a hard requirement for due diligence, where
 * a 2014 dispute and a 2024 arrest carry very different weight.
 *
 * Pure module: no network, no clock reads except the injectable `now`.
 */

/** Yandex document timestamp: `YYYYMMDDThhmmss` (document local time, no zone). */
const YANDEX_MODTIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const RELATIVE_RE =
  /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;

/** `Mon DD, YYYY` / `DD Mon YYYY` / `Mon YYYY`. */
const ABSOLUTE_RE =
  /^(?:(\d{1,2})\s+)?([a-z]{3,9})\.?\s+(?:(\d{1,2}),?\s+)?(\d{4})$/i;

const RELATIVE_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

/** Rejects timestamps that cannot be a real publication date. */
function plausible(date: Date, now: Date): boolean {
  if (Number.isNaN(date.getTime())) return false;
  const year = date.getUTCFullYear();
  // The web predates neither 1990 nor tomorrow; a day of slack covers time zones.
  if (year < 1990) return false;
  if (date.getTime() > now.getTime() + 86_400_000) return false;
  return true;
}

/** Parses `<modtime>` from a Yandex document block. Returns an ISO string or null. */
export function parseYandexModTime(block: string, now: Date = new Date()): string | null {
  const raw = /<modtime>([^<]+)<\/modtime>/i.exec(String(block ?? ""))?.[1]?.trim();
  if (!raw) return null;
  const m = YANDEX_MODTIME_RE.exec(raw);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  );
  return plausible(date, now) ? date.toISOString() : null;
}

/**
 * Parses a Serper date string. Handles absolute (`Aug 25, 2024`, `25 Aug 2024`,
 * `Aug 2024`) and relative (`2 days ago`) forms; anything else yields null
 * rather than a guess.
 */
export function parseSerperDate(value: string | undefined, now: Date = new Date()): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;

  const rel = RELATIVE_RE.exec(text);
  if (rel) {
    const amount = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms = RELATIVE_MS[unit];
    if (!ms || !Number.isFinite(amount)) return null;
    const date = new Date(now.getTime() - amount * ms);
    return plausible(date, now) ? date.toISOString() : null;
  }

  const abs = ABSOLUTE_RE.exec(text);
  if (abs) {
    const [, dayBefore, monthWord, dayAfter, year] = abs;
    const month = MONTHS[monthWord!.slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    const day = Number(dayBefore ?? dayAfter ?? 1);
    if (!Number.isFinite(day) || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(Number(year), month, day));
    return plausible(date, now) ? date.toISOString() : null;
  }

  // ISO or anything Date understands unambiguously.
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const date = new Date(text);
    return plausible(date, now) ? date.toISOString() : null;
  }

  return null;
}

/**
 * Recovers a publication date from a stored metadata blob.
 *
 * Order: the normalised field first, then the provider-native leftovers that
 * older rows already carry — Serper's human `date` string and the raw Yandex
 * document XML. That makes previously collected evidence dateable without a
 * backfill migration.
 */
export function publishedAtOf(
  rawMetadata: unknown,
  now: Date = new Date()
): string | null {
  if (!rawMetadata || typeof rawMetadata !== "object") return null;
  const blob = rawMetadata as Record<string, unknown>;

  const direct = typeof blob.publishedAt === "string" ? blob.publishedAt.trim() : "";
  if (direct) {
    const date = new Date(direct);
    if (plausible(date, now)) return date.toISOString();
  }

  if (typeof blob.date === "string") {
    const parsed = parseSerperDate(blob.date, now);
    if (parsed) return parsed;
  }

  if (typeof blob.raw === "string") {
    const parsed = parseYandexModTime(blob.raw, now);
    if (parsed) return parsed;
  }

  return null;
}

/** Formats an ISO timestamp as `YYYY-MM-DD` for client-facing copy. */
export function toDisplayDate(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}
