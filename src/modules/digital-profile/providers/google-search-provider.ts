/**
 * Google Programmable Search provider (Custom Search JSON API) — real connector.
 *
 * Official API only: https://www.googleapis.com/customsearch/v1
 * No scraping, no browser automation, no SERP screenshots. Secrets are never
 * logged or returned. When disabled/unconfigured it resolves to a structured
 * ProviderRunResult instead of throwing.
 */

import { providerConfig, getProviderAvailability } from "./config";
import { getProviderCapabilities } from "./capabilities";
import { getJson, toProviderError } from "./http";
import type { SearchProvider, SurfaceMethodResult } from "./search-provider";
import type {
  AvailabilityStatus,
  ProviderRunResult,
  SearchProviderRequest,
  SearchProviderResult,
} from "./types";
import { domainOf } from "./types";
import type { ProviderCapabilities } from "../search-surfaces/types";

const ENDPOINT = "https://www.googleapis.com/customsearch/v1";
const MAX_PER_PAGE = 10; // Custom Search API hard limit per request.

interface GoogleItem {
  title?: string;
  snippet?: string;
  link?: string;
  displayLink?: string;
  [k: string]: unknown;
}

interface GoogleResponse {
  items?: GoogleItem[];
}

export class GoogleSearchProvider implements SearchProvider {
  readonly name = "GOOGLE" as const;

  availability(): { status: AvailabilityStatus; message?: string } {
    const a = getProviderAvailability("GOOGLE");
    return { status: a.status, message: a.message };
  }

  enabled(): boolean {
    return this.availability().status === "ENABLED";
  }

  validateConfig(): { ok: boolean; message?: string } {
    const a = this.availability();
    return { ok: a.status === "ENABLED", message: a.message };
  }

  private buildUrl(request: SearchProviderRequest, start: number, num: number): string {
    const params = new URLSearchParams({
      key: providerConfig.google.apiKey ?? "",
      cx: providerConfig.google.engineId ?? "",
      q: request.query,
      num: String(num),
      start: String(start),
    });
    if (request.language) params.set("hl", request.language);
    if (request.region) params.set("gl", request.region.toLowerCase());
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
          message: a.message ?? "Google connector unavailable.",
          retryable: false,
          provider: this.name,
        },
      };
    }

    const limit = Math.min(request.limit ?? providerConfig.maxResults, providerConfig.maxResults);
    const snapshots: unknown[] = [];
    const results: SearchProviderResult[] = [];

    try {
      let start = request.page && request.page > 1 ? (request.page - 1) * MAX_PER_PAGE + 1 : 1;
      while (results.length < limit) {
        const num = Math.min(MAX_PER_PAGE, limit - results.length);
        const raw = (await getJson(this.buildUrl(request, start, num), {
          timeoutMs: providerConfig.timeoutMs,
        })) as GoogleResponse;
        snapshots.push(raw);
        const mapped = this.normalize(raw, request).map((r) => ({
          ...r,
          rank: results.length + r.rank,
        }));
        results.push(...mapped);
        if (!raw.items || raw.items.length < num) break; // no more pages
        start += num;
      }
    } catch (err) {
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

  capabilities(): ProviderCapabilities {
    return getProviderCapabilities("GOOGLE");
  }

  // Surface-specific methods. The current official adapter only does organic
  // search; everything else is NOT_SUPPORTED here (no scraping fallback).
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

  normalize(raw: unknown, request: SearchProviderRequest): SearchProviderResult[] {
    const items = (raw as GoogleResponse)?.items ?? [];
    const capturedAt = new Date().toISOString();
    return items.map((item, i) => {
      const url = String(item.link ?? "");
      return {
        provider: this.name,
        query: request.query,
        region: request.region,
        language: request.language,
        rank: i + 1,
        title: String(item.title ?? ""),
        snippet: String(item.snippet ?? ""),
        url,
        domain: item.displayLink ? String(item.displayLink).replace(/^www\./, "") : domainOf(url),
        rawMetadata: item,
        capturedAt,
      };
    });
  }
}

export const googleSearchProvider = new GoogleSearchProvider();
