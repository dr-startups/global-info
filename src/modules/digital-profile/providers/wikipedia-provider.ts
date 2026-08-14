/**
 * Real Wikipedia connector using the official, public MediaWiki/REST APIs.
 *
 * This is a read-only, evidence-first connector: it returns normalized data plus
 * a raw snapshot, and the AGENT (not the provider) persists evidence. It never
 * auto-publishes anything and performs no scraping — only documented public API
 * endpoints with a descriptive User-Agent, as Wikimedia requires.
 */

import { getProviderAvailability, providerConfig } from "./config";
import type { AvailabilityStatus, ProviderError } from "./types";

export interface WikipediaCandidate {
  title: string;
  pageId: number | null;
  snippet: string;
}

export interface WikipediaLanguageResult {
  language: string;
  exists: boolean;
  matchedTitle: string | null;
  url: string | null;
  extract: string | null;
  notabilityScore: number | null;
  candidates: WikipediaCandidate[];
  rawSnapshot: unknown;
}

export interface WikipediaLookupResult {
  status: "SUCCESS" | "FAILED" | "DISABLED";
  languages: WikipediaLanguageResult[];
  error?: ProviderError;
}

const REQUEST_TIMEOUT_MS = 8000;

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strips the parenthetical disambiguation, e.g. "John Smith (politician)". */
function baseTitle(title: string): string {
  return normalizeName(title.replace(/\s*\([^)]*\)\s*$/, ""));
}

function nameTokens(value: string): string[] {
  return baseTitle(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2);
}

/**
 * Статья о субъекте — та, где названы и фамилия, и имя.
 *
 * Правило сравнения было «одна строка начинается с другой», и оно принимало
 * страницу-разрешение неоднозначностей «Керимов» за статью о Сулеймане
 * Абусаидовиче Керимове: «керимов сулейман абусаидович» действительно
 * начинается с «керимов». В отчёт уходила ссылка на список однофамильцев с
 * подписью «статья найдена» — то есть проверка личности подтверждалась
 * страницей, где о субъекте нет ни слова.
 *
 * Одной фамилии мало; отчество не обязательно — в английской Википедии
 * субъект называется «Suleyman Kerimov», без него.
 */
export function isMatch(title: string, targets: string[]): boolean {
  const titleTokens = new Set(nameTokens(title));
  if (titleTokens.size === 0) return false;
  return targets.some((target) => {
    const tokens = nameTokens(target);
    if (tokens.length === 0) return false;
    if (tokens.length === 1) return titleTokens.has(tokens[0]!);
    return tokens.slice(0, 2).every((t) => titleTokens.has(t));
  });
}

/**
 * Лучший кандидат, а не первый попавшийся: поиск Википедии ставит первой
 * страницу-разрешение неоднозначностей, и «найти первое совпадение» означало
 * взять её. Совпадений считаем по числу совпавших частей имени.
 */
export function pickWikipediaCandidate<T extends { title: string }>(
  candidates: readonly T[],
  targets: string[]
): T | null {
  let best: { c: T; score: number } | null = null;
  for (const c of candidates) {
    if (!isMatch(c.title, targets)) continue;
    const titleTokens = new Set(nameTokens(c.title));
    const score = Math.max(
      ...targets.map((t) => nameTokens(t).filter((tok) => titleTokens.has(tok)).length),
      0
    );
    if (!best || score > best.score) best = { c, score };
  }
  return best?.c ?? null;
}

// --- rate-limit hook -------------------------------------------------------
let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const minInterval = providerConfig.wikipedia.minRequestIntervalMs;
  const wait = lastRequestAt + minInterval - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

/**
 * Пауза, которую просит сам сервис.
 *
 * Wikimedia отвечает на 429 заголовком `Retry-After` — в секундах либо датой.
 * Читаем его, а не выдумываем свою задержку; при отсутствии или бессмыслице
 * берём умеренное значение по умолчанию и ограничиваем сверху, чтобы шаг не
 * встал на минуты из-за одной цифры в ответе.
 */
export function retryAfterMs(res: Response, attempt: number): number {
  const raw = res.headers.get("retry-after");
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_RETRY_WAIT_MS);
  if (raw) {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) {
      const delta = at - Date.now();
      if (delta > 0) return Math.min(delta, MAX_RETRY_WAIT_MS);
    }
  }
  return Math.min(1000 * 2 ** attempt, MAX_RETRY_WAIT_MS);
}

const MAX_RETRY_WAIT_MS = 8_000;
const MAX_RETRIES = 2;

async function fetchJson(url: string): Promise<unknown> {
  /*
   * 429 — это «подожди», а не «не получилось».
   *
   * Раньше любой не-200 сразу превращался в ошибку, и один ответ 429 ронял весь
   * агент проверки Википедии: `PROVIDER_REQUEST_FAILED: HTTP 429`. Сервис при
   * этом прямо говорит, сколько ждать. Правило проекта здесь то же, что и для
   * Arsenkin: ожидание — не попытка, и отказ одного источника не должен
   * обнулять оплаченный сбор.
   *
   * Повторяем только то, что имеет смысл повторять: 429 и временные 5xx.
   * Ошибки запроса (4xx, кроме 429) повторять бессмысленно — ответ не изменится.
   */
  for (let attempt = 0; ; attempt += 1) {
    await throttle();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": providerConfig.wikipedia.userAgent,
          "Api-User-Agent": providerConfig.wikipedia.userAgent,
        },
      });
      if (res.ok) return await res.json();
      const worthRetry = res.status === 429 || res.status === 503 || res.status === 502;
      if (!worthRetry || attempt >= MAX_RETRIES) {
        throw new Error(`HTTP ${res.status}`);
      }
      const waitMs = retryAfterMs(res, attempt);
      clearTimeout(timer);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface SearchApiResponse {
  query?: { search?: Array<{ title?: string; pageid?: number; snippet?: string }> };
}

interface SummaryApiResponse {
  extract?: string;
  content_urls?: { desktop?: { page?: string } };
}

function notabilityScore(extract: string | null, candidateCount: number): number {
  if (!extract) return candidateCount > 0 ? 20 : 0;
  const lengthScore = Math.min(80, Math.round(extract.length / 20));
  return Math.min(100, lengthScore + candidateCount * 4);
}

export class WikipediaProvider {
  readonly name = "WIKIPEDIA" as const;

  availability(): { status: AvailabilityStatus; message?: string } {
    const a = getProviderAvailability("WIKIPEDIA");
    return { status: a.status, message: a.message };
  }

  enabled(): boolean {
    return this.availability().status === "ENABLED";
  }

  private async lookupLanguage(
    language: string,
    terms: string[]
  ): Promise<WikipediaLanguageResult> {
    const query = terms[0] ?? "";
    const searchUrl =
      `https://${language}.wikipedia.org/w/api.php?action=query&list=search` +
      `&srsearch=${encodeURIComponent(query)}&srlimit=5&format=json`;

    const searchRaw = (await fetchJson(searchUrl)) as SearchApiResponse;
    const candidates: WikipediaCandidate[] = (searchRaw.query?.search ?? []).map((s) => ({
      title: s.title ?? "",
      pageId: s.pageid ?? null,
      snippet: (s.snippet ?? "").replace(/<[^>]*>/g, ""),
    }));

    const matched = pickWikipediaCandidate(candidates, terms);

    let extract: string | null = null;
    let url: string | null = null;
    let summaryRaw: unknown = null;
    if (matched) {
      try {
        const summaryUrl =
          `https://${language}.wikipedia.org/api/rest_v1/page/summary/` +
          encodeURIComponent(matched.title.replace(/ /g, "_"));
        summaryRaw = (await fetchJson(summaryUrl)) as SummaryApiResponse;
        const summary = summaryRaw as SummaryApiResponse;
        extract = summary.extract ?? null;
        url =
          summary.content_urls?.desktop?.page ??
          `https://${language}.wikipedia.org/wiki/${encodeURIComponent(matched.title.replace(/ /g, "_"))}`;
      } catch {
        url = `https://${language}.wikipedia.org/wiki/${encodeURIComponent(matched.title.replace(/ /g, "_"))}`;
      }
    }

    return {
      language,
      exists: Boolean(matched),
      matchedTitle: matched?.title ?? null,
      url,
      extract,
      notabilityScore: matched ? notabilityScore(extract, candidates.length) : 0,
      candidates,
      rawSnapshot: {
        demo: false,
        provider: "WIKIPEDIA",
        language,
        query,
        terms,
        search: candidates,
        summary: summaryRaw,
        capturedAt: new Date().toISOString(),
      },
    };
  }

  async lookup(params: {
    subjectFullName: string;
    aliases: string[];
  }): Promise<WikipediaLookupResult> {
    const availability = this.availability();
    if (availability.status !== "ENABLED") {
      return {
        status: "DISABLED",
        languages: [],
        error: {
          code: "PROVIDER_DISABLED",
          message: availability.message ?? "Wikipedia connector is disabled.",
          retryable: false,
          provider: "WIKIPEDIA",
        },
      };
    }

    const terms = [params.subjectFullName, ...params.aliases]
      .map((t) => t.trim())
      .filter(Boolean);

    const languages: WikipediaLanguageResult[] = [];
    let failures = 0;
    let lastError: unknown = null;

    for (const language of providerConfig.wikipedia.languages) {
      try {
        languages.push(await this.lookupLanguage(language, terms));
      } catch (err) {
        failures++;
        lastError = err;
      }
    }

    if (languages.length === 0) {
      return {
        status: "FAILED",
        languages: [],
        error: {
          code: "PROVIDER_REQUEST_FAILED",
          message:
            lastError instanceof Error
              ? `Wikipedia request failed: ${lastError.message}`
              : "Wikipedia request failed.",
          retryable: true,
          provider: "WIKIPEDIA",
        },
      };
    }

    return {
      status: "SUCCESS",
      languages,
      error:
        failures > 0
          ? {
              code: "PROVIDER_REQUEST_FAILED",
              message: `${failures} language lookup(s) failed.`,
              retryable: true,
              provider: "WIKIPEDIA",
            }
          : undefined,
    };
  }
}

export const wikipediaProvider = new WikipediaProvider();
