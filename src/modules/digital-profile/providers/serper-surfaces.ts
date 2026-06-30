/**
 * Stage O2 — Serper.dev multi-surface adapter.
 *
 * Official paid API endpoints (hardcoded — never from env):
 *  - POST https://google.serper.dev/search   (organic + related + knowledgeGraph)
 *  - POST https://google.serper.dev/images
 *  - POST https://google.serper.dev/videos
 *  - POST https://google.serper.dev/autocomplete
 *
 * No scraping, no browser automation. Returns structured surface payloads safe
 * for evidence storage (no API keys in rawMetadata).
 */

import { providerConfig } from "./config";
import { postJson, ProviderHttpError, toProviderError } from "./http";
import { domainOf } from "./types";
import type { SearchProviderRequest } from "./types";
import type { OrionRegionCode } from "../search-surfaces/orion-query-plan";
import { regionProfile } from "../search-surfaces/region-profiles";

export type SerperSurfaceKind =
  | "organic"
  | "images"
  | "videos"
  | "autocomplete"
  | "relatedQueries"
  | "knowledgePanel";

export type SurfaceFetchStatus = "SUCCESS" | "NOT_CONFIGURED" | "FAILED" | "NOT_SUPPORTED";

export interface SerperSurfaceItem {
  kind: SerperSurfaceKind;
  query: string;
  region: OrionRegionCode;
  language: string;
  rank: number | null;
  title: string;
  snippet: string;
  url: string | null;
  domain: string | null;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  sourcePageUrl: string | null;
  rawMetadataSafe: Record<string, unknown>;
}

export interface SerperSurfaceBatchResult {
  status: SurfaceFetchStatus;
  items: SerperSurfaceItem[];
  error?: string;
}

const ENDPOINTS = {
  search: "https://google.serper.dev/search",
  images: "https://google.serper.dev/images",
  videos: "https://google.serper.dev/videos",
  autocomplete: "https://google.serper.dev/autocomplete",
} as const;

function serperReady(): boolean {
  const ext = providerConfig.google.external;
  return ext.provider === "serper" && Boolean(ext.apiKey?.trim());
}

function serperHeaders(): Record<string, string> {
  return { "X-API-KEY": providerConfig.google.external.apiKey ?? "" };
}

function serperBody(
  request: SearchProviderRequest,
  region: OrionRegionCode,
  num?: number
): Record<string, string | number> {
  const profile = regionProfile(region);
  return {
    q: request.query,
    gl: profile.googleGl,
    hl: request.language ?? profile.googleHl,
    ...(profile.googleLocation ? { location: profile.googleLocation } : {}),
    ...(num != null ? { num: Math.min(Math.max(1, num), 100) } : {}),
  };
}

async function postSerper(
  endpoint: string,
  body: Record<string, string | number>
): Promise<unknown> {
  return postJson(endpoint, body, {
    timeoutMs: providerConfig.google.external.timeoutMs,
    headers: serperHeaders(),
  });
}

function failBatch(status: SurfaceFetchStatus, error?: string): SerperSurfaceBatchResult {
  return { status, items: [], error };
}

export async function serperOrganicWithExtras(
  request: SearchProviderRequest,
  region: OrionRegionCode,
  limit: number
): Promise<SerperSurfaceBatchResult> {
  if (!serperReady()) return failBatch("NOT_CONFIGURED", "Serper API key not configured");
  try {
    const raw = (await postSerper(
      ENDPOINTS.search,
      serperBody(request, region, limit)
    )) as Record<string, unknown>;
    const items: SerperSurfaceItem[] = [];
    const capturedAt = new Date().toISOString();
    const profile = regionProfile(region);

    const organic = Array.isArray(raw.organic) ? raw.organic : [];
    organic.forEach((item: Record<string, unknown>, i: number) => {
      const url = String(item.link ?? "").trim();
      if (!url) return;
      const rank = typeof item.position === "number" ? item.position : i + 1;
      items.push({
        kind: "organic",
        query: request.query,
        region,
        language: request.language ?? profile.language,
        rank,
        title: String(item.title ?? ""),
        snippet: String(item.snippet ?? ""),
        url,
        domain: domainOf(url),
        thumbnailUrl: null,
        imageUrl: null,
        videoUrl: null,
        sourcePageUrl: url,
        rawMetadataSafe: { source: "serper", surface: "organic", position: rank, capturedAt },
      });
    });

    const related = Array.isArray(raw.relatedSearches) ? raw.relatedSearches : [];
    related.forEach((item: Record<string, unknown>, i: number) => {
      const q = String(item.query ?? item.title ?? "").trim();
      if (!q) return;
      items.push({
        kind: "relatedQueries",
        query: request.query,
        region,
        language: request.language ?? profile.language,
        rank: i + 1,
        title: q,
        snippet: "",
        url: null,
        domain: null,
        thumbnailUrl: null,
        imageUrl: null,
        videoUrl: null,
        sourcePageUrl: null,
        rawMetadataSafe: { source: "serper", surface: "relatedSearches", capturedAt },
      });
    });

    const kg = raw.knowledgeGraph as Record<string, unknown> | undefined;
    if (kg && typeof kg === "object" && Object.keys(kg).length > 0) {
      const title = String(kg.title ?? kg.name ?? "").trim();
      const desc = String(kg.description ?? kg.type ?? "").trim();
      const kgUrl = String(kg.website ?? kg.link ?? "").trim() || null;
      items.push({
        kind: "knowledgePanel",
        query: request.query,
        region,
        language: request.language ?? profile.language,
        rank: 1,
        title: title || "Knowledge panel",
        snippet: desc,
        url: kgUrl,
        domain: kgUrl ? domainOf(kgUrl) : null,
        thumbnailUrl: typeof kg.imageUrl === "string" ? kg.imageUrl : null,
        imageUrl: typeof kg.imageUrl === "string" ? kg.imageUrl : null,
        videoUrl: null,
        sourcePageUrl: kgUrl,
        rawMetadataSafe: {
          source: "serper",
          surface: "knowledgeGraph",
          attributes: kg.attributes ?? null,
          capturedAt,
        },
      });
    }

    return { status: "SUCCESS", items };
  } catch (err) {
    if (err instanceof ProviderHttpError) {
      return failBatch("FAILED", err.message);
    }
    return failBatch("FAILED", toProviderError(err, "GOOGLE").message);
  }
}

export async function serperImageSearch(
  request: SearchProviderRequest,
  region: OrionRegionCode,
  limit: number
): Promise<SerperSurfaceBatchResult> {
  if (!serperReady()) return failBatch("NOT_CONFIGURED", "Serper API key not configured");
  try {
    const raw = (await postSerper(
      ENDPOINTS.images,
      serperBody(request, region, limit)
    )) as Record<string, unknown>;
    const items: SerperSurfaceItem[] = [];
    const profile = regionProfile(region);
    const capturedAt = new Date().toISOString();
    const images = Array.isArray(raw.images) ? raw.images : [];
    images.forEach((item: Record<string, unknown>, i: number) => {
      const imageUrl = String(item.imageUrl ?? item.thumbnailUrl ?? "").trim() || null;
      const sourceUrl = String(item.link ?? item.source ?? "").trim() || null;
      items.push({
        kind: "images",
        query: request.query,
        region,
        language: request.language ?? profile.language,
        rank: i + 1,
        title: String(item.title ?? item.source ?? "Image result"),
        snippet: String(item.source ?? ""),
        url: sourceUrl,
        domain: sourceUrl ? domainOf(sourceUrl) : null,
        thumbnailUrl: String(item.thumbnailUrl ?? item.imageUrl ?? "").trim() || null,
        imageUrl,
        videoUrl: null,
        sourcePageUrl: sourceUrl,
        rawMetadataSafe: { source: "serper", surface: "images", capturedAt },
      });
    });
    return { status: "SUCCESS", items };
  } catch (err) {
    return failBatch("FAILED", err instanceof Error ? err.message : "Image search failed");
  }
}

export async function serperVideoSearch(
  request: SearchProviderRequest,
  region: OrionRegionCode,
  limit: number
): Promise<SerperSurfaceBatchResult> {
  if (!serperReady()) return failBatch("NOT_CONFIGURED", "Serper API key not configured");
  try {
    const raw = (await postSerper(
      ENDPOINTS.videos,
      serperBody(request, region, limit)
    )) as Record<string, unknown>;
    const items: SerperSurfaceItem[] = [];
    const profile = regionProfile(region);
    const capturedAt = new Date().toISOString();
    const videos = Array.isArray(raw.videos) ? raw.videos : [];
    videos.forEach((item: Record<string, unknown>, i: number) => {
      const videoUrl = String(item.link ?? "").trim() || null;
      items.push({
        kind: "videos",
        query: request.query,
        region,
        language: request.language ?? profile.language,
        rank: i + 1,
        title: String(item.title ?? "Video result"),
        snippet: String(item.snippet ?? item.channel ?? ""),
        url: videoUrl,
        domain: videoUrl ? domainOf(videoUrl) : null,
        thumbnailUrl: String(item.imageUrl ?? item.thumbnailUrl ?? "").trim() || null,
        imageUrl: null,
        videoUrl,
        sourcePageUrl: videoUrl,
        rawMetadataSafe: { source: "serper", surface: "videos", channel: item.channel ?? null, capturedAt },
      });
    });
    return { status: "SUCCESS", items };
  } catch (err) {
    return failBatch("FAILED", err instanceof Error ? err.message : "Video search failed");
  }
}

export async function serperAutocomplete(
  request: SearchProviderRequest,
  region: OrionRegionCode
): Promise<SerperSurfaceBatchResult> {
  if (!serperReady()) return failBatch("NOT_CONFIGURED", "Serper API key not configured");
  try {
    const raw = (await postSerper(
      ENDPOINTS.autocomplete,
      serperBody(request, region)
    )) as Record<string, unknown>;
    const items: SerperSurfaceItem[] = [];
    const profile = regionProfile(region);
    const capturedAt = new Date().toISOString();
    const suggestions = Array.isArray(raw.suggestions) ? raw.suggestions : [];
    suggestions.forEach((item: unknown, i: number) => {
      const q = typeof item === "string" ? item : String((item as Record<string, unknown>).value ?? "");
      if (!q.trim()) return;
      items.push({
        kind: "autocomplete",
        query: request.query,
        region,
        language: request.language ?? profile.language,
        rank: i + 1,
        title: q.trim(),
        snippet: "",
        url: null,
        domain: null,
        thumbnailUrl: null,
        imageUrl: null,
        videoUrl: null,
        sourcePageUrl: null,
        rawMetadataSafe: { source: "serper", surface: "autocomplete", capturedAt },
      });
    });
    return { status: "SUCCESS", items };
  } catch (err) {
    return failBatch("FAILED", err instanceof Error ? err.message : "Autocomplete failed");
  }
}

/** Convenience: fetch all Serper surfaces for one primary query. */
export async function serperAllSurfacesForQuery(
  request: SearchProviderRequest,
  region: OrionRegionCode,
  limit: number
): Promise<{
  organic: SerperSurfaceBatchResult;
  images: SerperSurfaceBatchResult;
  videos: SerperSurfaceBatchResult;
  autocomplete: SerperSurfaceBatchResult;
}> {
  const [organic, images, videos, autocomplete] = await Promise.all([
    serperOrganicWithExtras(request, region, limit),
    serperImageSearch(request, region, limit),
    serperVideoSearch(request, region, limit),
    serperAutocomplete(request, region),
  ]);
  return { organic, images, videos, autocomplete };
}
