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

function isMatch(title: string, targets: string[]): boolean {
  const t = baseTitle(title);
  return targets.some((target) => {
    const n = normalizeName(target);
    if (!n) return false;
    return t === n || t.startsWith(n) || n.startsWith(t);
  });
}

// --- rate-limit hook -------------------------------------------------------
let lastRequestAt = 0;
async function throttle(): Promise<void> {
  const minInterval = providerConfig.wikipedia.minRequestIntervalMs;
  const wait = lastRequestAt + minInterval - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function fetchJson(url: string): Promise<unknown> {
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
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
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

    const matched = candidates.find((c) => isMatch(c.title, terms)) ?? null;

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
