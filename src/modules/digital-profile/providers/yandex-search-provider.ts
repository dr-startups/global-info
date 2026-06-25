/**
 * Yandex Search API provider (XML) — real connector.
 *
 * Official API only: https://yandex.com/search/xml (Yandex Cloud Search API).
 * No scraping, no browser automation, no SERP screenshots. Secrets are never
 * logged or returned. When disabled/unconfigured it resolves to a structured
 * ProviderRunResult instead of throwing.
 */

import { providerConfig, getProviderAvailability } from "./config";
import { getText, toProviderError } from "./http";
import type { SearchProvider } from "./search-provider";
import type {
  AvailabilityStatus,
  ProviderRunResult,
  SearchProviderRequest,
  SearchProviderResult,
} from "./types";
import { domainOf } from "./types";

const ENDPOINT = "https://yandex.com/search/xml";
const MAX_PER_PAGE = 10;

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function firstTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1] : null;
}

export class YandexSearchProvider implements SearchProvider {
  readonly name = "YANDEX" as const;

  availability(): { status: AvailabilityStatus; message?: string } {
    const a = getProviderAvailability("YANDEX");
    return { status: a.status, message: a.message };
  }

  enabled(): boolean {
    return this.availability().status === "ENABLED";
  }

  validateConfig(): { ok: boolean; message?: string } {
    const a = this.availability();
    return { ok: a.status === "ENABLED", message: a.message };
  }

  private buildUrl(request: SearchProviderRequest, page: number): string {
    const params = new URLSearchParams({
      folderid: providerConfig.yandex.folderId ?? "",
      apikey: providerConfig.yandex.apiKey ?? "",
      query: request.query,
      page: String(page),
    });
    const l10n = request.language === "ru" ? "ru" : "en";
    params.set("l10n", l10n);
    const lr = providerConfig.yandex.region;
    if (lr) params.set("lr", lr);
    return `${ENDPOINT}?${params.toString()}`;
  }

  async search(request: SearchProviderRequest): Promise<ProviderRunResult> {
    const a = this.availability();
    if (a.status !== "ENABLED") {
      return {
        status: a.status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : "DISABLED",
        provider: this.name,
        results: [],
        error: {
          code: a.status === "NOT_CONFIGURED" ? "PROVIDER_NOT_CONFIGURED" : "PROVIDER_DISABLED",
          message: a.message ?? "Yandex connector unavailable.",
          retryable: false,
          provider: this.name,
        },
      };
    }

    const limit = Math.min(request.limit ?? providerConfig.maxResults, providerConfig.maxResults);
    const snapshots: unknown[] = [];
    const results: SearchProviderResult[] = [];

    try {
      let page = request.page && request.page > 1 ? request.page - 1 : 0; // Yandex page is 0-based
      while (results.length < limit) {
        const xml = await getText(this.buildUrl(request, page), {
          timeoutMs: providerConfig.timeoutMs,
        });
        snapshots.push(xml);
        const error = firstTag(xml, "error");
        if (error) {
          // Yandex signals quota/auth issues via <error code="...">.
          const isRate = /limit|quota|too many/i.test(error);
          throw Object.assign(new Error(stripTags(error)), {
            __yandex: true,
            isRate,
          });
        }
        const mapped = this.normalize(xml, request).map((r) => ({
          ...r,
          rank: results.length + r.rank,
        }));
        results.push(...mapped);
        if (mapped.length < MAX_PER_PAGE) break;
        page += 1;
      }
    } catch (err) {
      if (err && typeof err === "object" && "__yandex" in err) {
        const e = err as unknown as { message: string; isRate: boolean };
        return {
          status: "FAILED",
          provider: this.name,
          results,
          rawSnapshot: snapshots,
          error: {
            code: e.isRate ? "PROVIDER_RATE_LIMITED" : "PROVIDER_BAD_RESPONSE",
            message: e.message,
            retryable: e.isRate,
            provider: this.name,
          },
        };
      }
      return {
        status: "FAILED",
        provider: this.name,
        results,
        rawSnapshot: snapshots,
        error: toProviderError(err, this.name),
      };
    }

    return {
      status: "SUCCESS",
      provider: this.name,
      results: results.slice(0, limit),
      rawSnapshot: snapshots,
    };
  }

  /** Parses the Yandex XML response into normalized results. */
  normalize(raw: unknown, request: SearchProviderRequest): SearchProviderResult[] {
    const xml = typeof raw === "string" ? raw : "";
    const capturedAt = new Date().toISOString();
    const docs = xml.match(/<doc[^>]*>[\s\S]*?<\/doc>/gi) ?? [];
    const results: SearchProviderResult[] = [];
    docs.forEach((block, i) => {
      const url = stripTags(firstTag(block, "url") ?? "");
      if (!url) return;
      const title = stripTags(firstTag(block, "title") ?? "");
      const headline =
        firstTag(block, "headline") ??
        firstTag(block, "passage") ??
        firstTag(block, "extended-text") ??
        "";
      results.push({
        provider: this.name,
        query: request.query,
        region: request.region,
        language: request.language,
        rank: i + 1,
        title,
        snippet: stripTags(headline),
        url,
        domain: stripTags(firstTag(block, "domain") ?? "") || domainOf(url),
        rawMetadata: { raw: block },
        capturedAt,
      });
    });
    return results;
  }
}

export const yandexSearchProvider = new YandexSearchProvider();
