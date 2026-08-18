/**
 * Serper.dev Google SERP adapter (Stage N2 external_serp).
 *
 * Official paid API: POST https://google.serper.dev/search
 * Auth: X-API-KEY header only — never in URLs, logs, DB, or rawMetadata.
 *
 * No scraping, no browser automation. When misconfigured it resolves to a
 * structured ProviderRunResult instead of throwing.
 */

import { parseSerperDate } from "./published-date";
import { providerConfig } from "./config";
import { postJson, ProviderHttpError, toProviderError } from "./http";
import { resolveSearchDepth } from "./search-depth";
import type { ProviderRunResult, SearchProviderRequest, SearchProviderResult } from "./types";
import { domainOf } from "./types";

/** Hardcoded endpoint — never read from env (SSRF guard). */
export const SERPER_SEARCH_ENDPOINT = "https://google.serper.dev/search";

/**
 * Потолок глубины на один запрос — предел самого API.
 *
 * Просить глубже 10 у Serper стоит два кредита за запрос вместо одного,
 * поэтому глубину заказывает вызывающий по назначению запроса, а не настройка.
 */
const SERPER_MAX_RESULTS_PER_QUERY = 100;

export interface SerperOrganicItem {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
  date?: string;
}

export interface SerperSearchResponse {
  organic?: SerperOrganicItem[];
  [k: string]: unknown;
}

/** Builds the Serper request body (pure, testable). */
export function buildSerperSearchBody(
  request: SearchProviderRequest,
  num: number
): Record<string, string | number> {
  const cfg = providerConfig.google;
  return {
    q: request.query,
    gl: (request.region ?? cfg.gl).toLowerCase(),
    hl: request.language ?? cfg.hl,
    num: Math.min(Math.max(1, num), SERPER_MAX_RESULTS_PER_QUERY),
  };
}

/** Normalizes a Serper JSON response into evidence-first search results. */
export function normalizeSerperResponse(
  raw: unknown,
  request: SearchProviderRequest
): SearchProviderResult[] {
  const organic = (raw as SerperSearchResponse)?.organic;
  const items: SerperOrganicItem[] = Array.isArray(organic) ? organic : [];
  const capturedAt = new Date().toISOString();
  const results: SearchProviderResult[] = [];
  items.forEach((item, i) => {
    const url = String(item.link ?? "").trim();
    if (!url) return;
    const rank = typeof item.position === "number" && item.position > 0 ? item.position : i + 1;
    results.push({
      provider: "GOOGLE",
      query: request.query,
      region: request.region ?? providerConfig.google.gl,
      language: request.language ?? providerConfig.google.hl,
      rank,
      title: String(item.title ?? ""),
      snippet: String(item.snippet ?? ""),
      url,
      domain: domainOf(url),
      ...(parseSerperDate(item.date) ? { publishedAt: parseSerperDate(item.date)! } : {}),
      rawMetadata: {
        source: "serper",
        position: rank,
        ...(item.date ? { date: String(item.date) } : {}),
      },
      capturedAt,
    });
  });
  return results;
}

export async function serperSearch(request: SearchProviderRequest): Promise<ProviderRunResult> {
  const ext = providerConfig.google.external;
  // Настройка провайдера — глубина по умолчанию, а не потолок: аудит просит
  // ТОП-20, и просьба вызывающего сильнее умолчания. Потолок задаёт API
  // (Serper принимает `num` до 100). Пока здесь стоял `Math.min(запрошено,
  // настройка)`, в сеть уходило `num: 10` при просьбе о двадцати, и отчёт
  // называл первую страницу выдачи аудитом ТОП-20.
  const limit = resolveSearchDepth({
    requested: request.limit,
    fallback: providerConfig.google.resultsPerQuery,
    max: SERPER_MAX_RESULTS_PER_QUERY,
  });

  try {
    const raw = await postJson(SERPER_SEARCH_ENDPOINT, buildSerperSearchBody(request, limit), {
      timeoutMs: ext.timeoutMs,
      headers: { "X-API-KEY": ext.apiKey ?? "" },
    });
    const results = normalizeSerperResponse(raw, request).slice(0, limit);
    return {
      status: "SUCCESS",
      provider: "GOOGLE",
      results,
    };
  } catch (err) {
    if (err instanceof ProviderHttpError && err.code === "PROVIDER_BAD_RESPONSE") {
      // Serper uses 401/403 for bad keys — surface a clearer message.
      const msg = err.message;
      if (/401|403/.test(msg)) {
        return {
          status: "FAILED",
          provider: "GOOGLE",
          results: [],
          error: {
            code: err.code,
            message: "Serper rejected the request — check GOOGLE_EXTERNAL_SERP_API_KEY.",
            retryable: false,
            provider: "GOOGLE",
          },
        };
      }
    }
    return {
      status: "FAILED",
      provider: "GOOGLE",
      results: [],
      error: toProviderError(err, "GOOGLE"),
    };
  }
}
