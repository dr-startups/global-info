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
import type {
  ProviderRunResult,
  SearchProviderRequest,
  SearchProviderResult,
  SerpDepthAudit,
} from "./types";
import { domainOf } from "./types";

/** Hardcoded endpoint — never read from env (SSRF guard). */
export const SERPER_SEARCH_ENDPOINT = "https://google.serper.dev/search";

/**
 * Потолок глубины на один запрос — предел самого API.
 *
 * Глубже сотни Serper не отдаёт, то есть это ещё и потолок числа платных
 * страниц на один запрос: десять. Саму глубину заказывает вызывающий по
 * назначению запроса, а не настройка, — каждая страница стоит денег.
 */
const SERPER_MAX_RESULTS_PER_QUERY = 100;

/**
 * Размер страницы органической выдачи Google.
 *
 * Глубина — это страницы, а не размер одного запроса. Отчёт обещает клиенту
 * ТОП-20, и позиции 11–20 обязаны прийти из того же снимка выдачи, что и 1–10:
 * второй снимок, снятый другим инструментом или в другое время, даёт точные на
 * вид номера, которые точными не являются.
 */
export const SERPER_PAGE_SIZE = 10;

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

/** Builds the Serper request body for one page (pure, testable). */
export function buildSerperSearchBody(
  request: SearchProviderRequest,
  page: number
): Record<string, string | number> {
  const cfg = providerConfig.google;
  return {
    q: request.query,
    gl: (request.region ?? cfg.gl).toLowerCase(),
    hl: request.language ?? cfg.hl,
    num: SERPER_PAGE_SIZE,
    page,
  };
}

/** Органические строки страницы ответа — единственное место, где их достают. */
function serperOrganicItems(raw: unknown): SerperOrganicItem[] {
  const organic = (raw as SerperSearchResponse)?.organic;
  return Array.isArray(organic) ? organic : [];
}

/**
 * Normalizes one Serper page into evidence-first search results.
 *
 * Номер страницы обязателен: умолчание молча дало бы второй десятке позиции
 * первой — ровно тот дефект, ради которого позицию и начали считать сами.
 */
export function normalizeSerperResponse(
  raw: unknown,
  request: SearchProviderRequest,
  page: number
): SearchProviderResult[] {
  const items = serperOrganicItems(raw);
  const capturedAt = new Date().toISOString();
  const results: SearchProviderResult[] = [];
  const pageOffset = (page - 1) * SERPER_PAGE_SIZE;
  items.forEach((item, i) => {
    const url = String(item.link ?? "").trim();
    if (!url) return;
    // Позицию считаем мы. `position` из ответа нумерует строки своей страницы
    // с единицы, то есть на второй странице он снова 1..10; принять его за
    // позицию — значит напечатать вторую десятку под номерами первой.
    const rank = pageOffset + i + 1;
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
        // Позиция строки; её и читает аналитика (`rankOf`).
        rank,
        // Число провайдера остаётся фактом о его ответе — рядом и под своим
        // именем, чтобы его нельзя было спутать с позицией.
        ...(typeof item.position === "number" ? { providerPosition: item.position } : {}),
        ...(item.date ? { date: String(item.date) } : {}),
      },
      capturedAt,
    });
  });
  return results;
}

/**
 * Отказ провайдера в терминах ProviderRunResult.
 *
 * Учёт отдаётся и здесь: по нему видно, что не куплено ничего, — статус этого
 * не говорит, он говорит только про исход.
 */
function serperFailure(err: unknown, audit: SerpDepthAudit): ProviderRunResult {
  const failed = {
    status: "FAILED" as const,
    provider: "GOOGLE" as const,
    results: [],
    depthAudit: audit,
  };
  if (err instanceof ProviderHttpError && err.code === "PROVIDER_UNAUTHORIZED") {
    // Отвергнутый ключ у Serper — это 401/403, и переменную называем мы: в
    // сообщении провайдера её имени нет.
    return {
      ...failed,
      error: {
        code: err.code,
        message: "Serper rejected the request — check GOOGLE_EXTERNAL_SERP_API_KEY.",
        retryable: false,
        provider: "GOOGLE",
      },
    };
  }
  return { ...failed, error: toProviderError(err, "GOOGLE") };
}

export async function serperSearch(request: SearchProviderRequest): Promise<ProviderRunResult> {
  const ext = providerConfig.google.external;
  // Настройка провайдера — глубина по умолчанию, а не потолок: аудит просит
  // ТОП-20, и просьба вызывающего сильнее умолчания. Потолок задаёт API
  // (Serper принимает не больше 100 результатов на запрос). Пока здесь стоял
  // `Math.min(запрошено, настройка)`, в сеть уходило `num: 10` при просьбе о
  // двадцати, и отчёт называл первую страницу выдачи аудитом ТОП-20.
  const limit = resolveSearchDepth({
    requested: request.limit,
    fallback: providerConfig.google.resultsPerQuery,
    max: SERPER_MAX_RESULTS_PER_QUERY,
  });
  const pages = Math.ceil(limit / SERPER_PAGE_SIZE);

  const results: SearchProviderResult[] = [];
  const audit: SerpDepthAudit = { requested: limit, perPage: [], repeatedFromEarlierPages: 0 };
  const seenUrls = new Set<string>();

  // Форма цикла та же, что у постраничного сбора Яндекса: страница за
  // страницей, пока страница полная и глубина не выбрана.
  for (let page = 1; page <= pages; page += 1) {
    let raw: unknown;
    try {
      raw = await postJson(SERPER_SEARCH_ENDPOINT, buildSerperSearchBody(request, page), {
        timeoutMs: ext.timeoutMs,
        headers: { "X-API-KEY": ext.apiKey ?? "" },
      });
    } catch (err) {
      // Причина остановки — часть учёта: без неё «вторая страница отказала» и
      // «глубже ничего нет» неразличимы, а прогон в обоих случаях зелёный.
      audit.stoppedByError = toProviderError(err, "GOOGLE").code;
      // Отказ второй страницы не отменяет первую: собранное дороже полноты.
      if (page === 1) return serperFailure(err, audit);
      break;
    }

    // Полнота страницы считается по строкам ответа провайдера, а не по тем,
    // что мы оставили: строка без адреса — не конец выдачи.
    const returned = serperOrganicItems(raw).length;
    audit.perPage.push(returned);

    const rows = normalizeSerperResponse(raw, request, page);
    audit.repeatedFromEarlierPages += rows.filter((r) => seenUrls.has(r.url)).length;
    rows.forEach((r) => seenUrls.add(r.url));
    results.push(...rows);

    if (returned < SERPER_PAGE_SIZE) break;
  }

  return {
    status: "SUCCESS",
    provider: "GOOGLE",
    results: results.slice(0, limit),
    depthAudit: audit,
  };
}
