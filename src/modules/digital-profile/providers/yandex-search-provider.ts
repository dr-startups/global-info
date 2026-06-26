/**
 * Yandex Search API provider — real connector (Stage N1).
 *
 * Official Yandex Cloud Search API v2 only:
 *   POST https://searchapi.api.cloud.yandex.net/v2/web/search
 *   Authorization: Api-Key <key>   (header — never logged, never in the URL)
 * The sync endpoint returns `{ rawData: <base64 XML> }`; we decode + parse it.
 *
 * No scraping, no browser automation, no SERP screenshots. Secrets are never
 * logged or returned. When disabled/unconfigured it resolves to a structured
 * ProviderRunResult instead of throwing.
 */

import { providerConfig, getProviderAvailability } from "./config";
import { getProviderCapabilities } from "./capabilities";
import { postJson, toProviderError, ProviderHttpError } from "./http";
import {
  YANDEX_V2_ENDPOINT,
  buildYandexV2Body,
  decodeYandexV2RawData,
  toLocalization,
  toSearchType,
  YandexV2ParseError,
} from "./yandex-v2";
import type { SearchProvider, SurfaceMethodResult } from "./search-provider";
import type {
  AvailabilityStatus,
  ProviderRunResult,
  SearchProviderRequest,
  SearchProviderResult,
} from "./types";
import { domainOf } from "./types";
import type { ProviderCapabilities } from "../search-surfaces/types";

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

  /** Calls the v2 endpoint for one page and returns the decoded XML string. */
  private async fetchPageXml(request: SearchProviderRequest, page: number): Promise<string> {
    const cfg = providerConfig.yandex;
    const body = buildYandexV2Body({
      queryText: request.query,
      folderId: cfg.folderId ?? "",
      page,
      searchType: toSearchType(request.region ?? cfg.region),
      localization: toLocalization(request.language ?? cfg.localization),
    });
    const json = await postJson(YANDEX_V2_ENDPOINT, body, {
      timeoutMs: cfg.timeoutMs,
      // Secret travels in the header only; never logged, never in the URL.
      headers: { Authorization: `Api-Key ${cfg.apiKey ?? ""}` },
    });
    return decodeYandexV2RawData(json);
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

    const limit = Math.min(
      request.limit ?? providerConfig.yandex.resultsPerQuery,
      providerConfig.yandex.resultsPerQuery
    );
    const results: SearchProviderResult[] = [];

    try {
      let page = request.page && request.page > 1 ? request.page - 1 : 0; // 0-based
      while (results.length < limit) {
        const xml = await this.fetchPageXml(request, page);
        const error = firstTag(xml, "error");
        if (error) {
          // Yandex signals quota/auth issues via <error code="...">.
          const isRate = /limit|quota|too many/i.test(error);
          throw Object.assign(new Error(stripTags(error)), { __yandex: true, isRate });
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
          // rawSnapshot intentionally omitted: never persist raw XML/secrets.
          error: {
            code: e.isRate ? "PROVIDER_RATE_LIMITED" : "PROVIDER_BAD_RESPONSE",
            message: e.message,
            retryable: e.isRate,
            provider: this.name,
          },
        };
      }
      if (err instanceof YandexV2ParseError) {
        return {
          status: "FAILED",
          provider: this.name,
          results,
          error: {
            code: "PROVIDER_INVALID_RESPONSE",
            message: err.message,
            retryable: false,
            provider: this.name,
          },
        };
      }
      if (err instanceof ProviderHttpError) {
        return {
          status: "FAILED",
          provider: this.name,
          results,
          error: { code: err.code, message: err.message, retryable: err.retryable, provider: this.name },
        };
      }
      return {
        status: "FAILED",
        provider: this.name,
        results,
        error: toProviderError(err, this.name),
      };
    }

    return {
      status: "SUCCESS",
      provider: this.name,
      results: results.slice(0, limit),
    };
  }

  capabilities(): ProviderCapabilities {
    return getProviderCapabilities("YANDEX");
  }

  async searchImages(): Promise<SurfaceMethodResult> {
    return this.notSupported();
  }
  async searchVideos(): Promise<SurfaceMethodResult> {
    return this.notSupported();
  }
  async getSuggestions(): Promise<SurfaceMethodResult> {
    return this.notSupported();
  }
  async getRelatedQueries(): Promise<SurfaceMethodResult> {
    return this.notSupported();
  }

  private notSupported(): SurfaceMethodResult {
    return { status: "NOT_SUPPORTED", provider: this.name, method: "NOT_SUPPORTED", results: [] };
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
