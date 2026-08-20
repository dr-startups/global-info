/**
 * Real Wikipedia connector using the official, public MediaWiki/REST APIs.
 *
 * This is a read-only, evidence-first connector: it returns normalized data plus
 * a raw snapshot, and the AGENT (not the provider) persists evidence. It never
 * auto-publishes anything and performs no scraping — only documented public API
 * endpoints with a descriptive User-Agent, as Wikimedia requires.
 */

import { getProviderAvailability, providerConfig } from "./config";
import { hasCyrillic, transliterateRuToEn } from "../search-surfaces/orion-query-plan";
import type { AvailabilityStatus, ProviderError } from "./types";

export interface WikipediaCandidate {
  title: string;
  pageId: number | null;
  snippet: string;
}

/** Как статья нашлась: поиском по имени или по межъязыковой ссылке соседа. */
export type WikipediaFoundVia = "search" | "langlink";

export interface WikipediaLanguageResult {
  language: string;
  exists: boolean;
  matchedTitle: string | null;
  url: string | null;
  extract: string | null;
  /**
   * Полный плейнтекст статьи (`prop=extracts&explaintext`) с заголовками
   * `== … ==`. Один вызов даёт и лид, и структуру разделов, и тело для разбора;
   * REST-сводка рядом остаётся, но лидом служить не может — она срезает скобки
   * первого предложения (наблюдение: у статьи Мордашова так исчезла дата
   * рождения, и «основное описание» вышло в 76 знаков).
   */
  articleText: string | null;
  foundVia: WikipediaFoundVia | null;
  /** Раздел-источник межъязыковой ссылки, по которой найдена эта статья. */
  langlinkOf: { language: string; title: string } | null;
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

/**
 * Термы субъекта: как его пишут, и как его пишут латиницей.
 *
 * Латинские варианты строит планировщик запросов (`transliterateRuToEn`) — той
 * же функцией собраны запросы контура ОАЭ, и шестой транслитерации в проекте не
 * заводится. Повторы схлопываются: в живой проверке один и тот же терм пришёл
 * дважды (имя субъекта заодно числилось псевдонимом).
 */
function subjectTerms(subjectFullName: string, aliases: string[]): string[] {
  const given = [subjectFullName, ...aliases].map((t) => String(t ?? "").trim()).filter(Boolean);
  const latin = given.filter(hasCyrillic).map((t) => transliterateRuToEn(t).trim());
  return [...new Set([...given, ...latin])].filter(Boolean);
}

/**
 * Языковой раздел спрашивают на его языке.
 *
 * en-проверка кириллическим запросом вернула «статьи нет» при существующей
 * статье `en.wikipedia.org/wiki/Viktor_Rashnikov`, и отчёт напечатал «не
 * найдена» рядом с той же статьёй в таблице выдачи. Русский раздел спрашивается
 * как прежде — первым термом, остальные — первым латинским; латиницы нет вовсе
 * (у субъекта нерусское имя без транслитерации) — остаётся первый терм.
 */
function queryForLanguage(language: string, terms: string[]): string {
  if (String(language ?? "").toLowerCase().startsWith("ru")) return terms[0] ?? "";
  return terms.find((t) => !hasCyrillic(t)) ?? terms[0] ?? "";
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

/** `formatversion=2`: страницы приходят массивом, а не словарём по pageid. */
interface ExtractsApiResponse {
  query?: { pages?: Array<{ title?: string; extract?: string }> };
}

interface LanglinksApiResponse {
  query?: { pages?: Array<{ langlinks?: Array<{ lang?: string; title?: string }> }> };
}

/** Адрес статьи в её языковом разделе — в одной форме на весь модуль. */
function articleUrl(language: string, title: string): string {
  return `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

function apiUrl(language: string, params: Record<string, string>): string {
  const query = new URLSearchParams({ format: "json", formatversion: "2", ...params });
  return `https://${language}.wikipedia.org/w/api.php?${query.toString()}`;
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

  /**
   * Полный текст статьи одним вызовом.
   *
   * Отказ здесь проверку не роняет: статья без текста — валидное состояние, и
   * «нашли статью, но не смогли прочитать» честнее, чем «статьи нет».
   */
  private async articleText(language: string, title: string): Promise<string | null> {
    try {
      const raw = (await fetchJson(
        apiUrl(language, {
          action: "query",
          prop: "extracts",
          explaintext: "1",
          redirects: "1",
          titles: title,
        })
      )) as ExtractsApiResponse;
      const text = raw.query?.pages?.[0]?.extract;
      return typeof text === "string" && text.trim() ? text : null;
    } catch {
      return null;
    }
  }

  /** Заголовок той же сущности в другом языковом разделе, если он объявлен. */
  private async langlinkTitle(
    source: { language: string; title: string },
    target: string
  ): Promise<string | null> {
    try {
      const raw = (await fetchJson(
        apiUrl(source.language, {
          action: "query",
          prop: "langlinks",
          lllimit: "50",
          redirects: "1",
          titles: source.title,
        })
      )) as LanglinksApiResponse;
      const code = target.toLowerCase().split(/[-_]/u)[0] ?? "";
      const link = (raw.query?.pages?.[0]?.langlinks ?? []).find(
        (l) => String(l.lang ?? "").toLowerCase() === code
      );
      const title = String(link?.title ?? "").trim();
      return title || null;
    } catch {
      return null;
    }
  }

  private async lookupLanguage(
    language: string,
    terms: string[]
  ): Promise<WikipediaLanguageResult> {
    const query = queryForLanguage(language, terms);
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
        url = summary.content_urls?.desktop?.page ?? articleUrl(language, matched.title);
      } catch {
        url = articleUrl(language, matched.title);
      }
    }
    const articleText = matched ? await this.articleText(language, matched.title) : null;

    return {
      language,
      exists: Boolean(matched),
      matchedTitle: matched?.title ?? null,
      url,
      extract,
      articleText,
      foundVia: matched ? "search" : null,
      langlinkOf: null,
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
        articleText,
        foundVia: matched ? "search" : null,
        langlinkOf: null,
        capturedAt: new Date().toISOString(),
      },
    };
  }

  /**
   * Статья раздела, где поиск ничего не дал, но сосед статью нашёл.
   *
   * Межъязыковая ссылка — утверждение самой Википедии о том, что это одна и та
   * же сущность Викиданных, а не наша догадка по транслитерации. На живом
   * прогоне Мордашова en-поиск вернул страницу-дизамбигуацию «Alexey», отчёт
   * написал «статьи нет» — и напечатал это над собственными буллетами со
   * ссылкой на `en.wikipedia.org/wiki/Alexei_Mordashov`. Заголовок этой статьи
   * стоит в langlinks ru-статьи прямым текстом.
   *
   * Поисковый запрос раздела в снимке остаётся дословным: «по этому запросу не
   * нашла» и «статья есть» — два разных наблюдения, и страница печатает оба.
   */
  private async resolveByLanglink(
    missing: WikipediaLanguageResult,
    source: WikipediaLanguageResult
  ): Promise<WikipediaLanguageResult> {
    const sourceTitle = String(source.matchedTitle ?? "").trim();
    if (!sourceTitle) return missing;
    const title = await this.langlinkTitle(
      { language: source.language, title: sourceTitle },
      missing.language
    );
    if (!title) return missing;
    const langlinkOf = { language: source.language, title: sourceTitle };
    const articleText = await this.articleText(missing.language, title);
    const raw = (missing.rawSnapshot ?? {}) as Record<string, unknown>;
    return {
      ...missing,
      exists: true,
      matchedTitle: title,
      url: articleUrl(missing.language, title),
      articleText,
      foundVia: "langlink",
      langlinkOf,
      notabilityScore: notabilityScore(missing.extract, missing.candidates.length),
      rawSnapshot: { ...raw, articleText, foundVia: "langlink", langlinkOf },
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

    const terms = subjectTerms(params.subjectFullName, params.aliases);

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

    // Разделы, где поиск промахнулся, добираются межъязыковой ссылкой уже
    // найденной статьи. Источник берётся первый найденный по порядку языков
    // конфигурации — он же первый по приоритету.
    const source = languages.find((l) => l.exists && l.matchedTitle);
    if (source) {
      for (const [i, lang] of languages.entries()) {
        if (lang.exists) continue;
        languages[i] = await this.resolveByLanglink(lang, source);
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
