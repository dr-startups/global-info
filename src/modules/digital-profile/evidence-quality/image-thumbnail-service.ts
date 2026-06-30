/**
 * O5.3 — fetch and cache small image thumbnails for report evidence.
 * Provider thumbnailUrl only — no browser scraping.
 */

import { createHash } from "node:crypto";
import { buildStorageKey } from "../storage/keys";
import { fileExists, saveFile } from "../storage/private-store";
import type { ThumbnailStatus } from "./types";

const MAX_BYTES = 512_000;
const TIMEOUT_MS = 12_000;
const ALLOWED_TYPES = /^image\/(jpeg|jpg|png|webp|gif)/i;

export function hashImageSource(url: string): string {
  return createHash("sha256").update(url.trim()).digest("hex").slice(0, 32);
}

function readStoredThumbnailKey(rawMetadata: unknown): string | null {
  if (!rawMetadata || typeof rawMetadata !== "object") return null;
  const eq = (rawMetadata as Record<string, unknown>).evidenceQuality;
  if (!eq || typeof eq !== "object") return null;
  const key = (eq as Record<string, unknown>).thumbnailStorageKey;
  return typeof key === "string" && key.trim() ? key.trim() : null;
}

export function readThumbnailStatus(rawMetadata: unknown): ThumbnailStatus {
  if (!rawMetadata || typeof rawMetadata !== "object") return "NOT_FETCHED";
  const eq = (rawMetadata as Record<string, unknown>).evidenceQuality;
  if (!eq || typeof eq !== "object") return "NOT_FETCHED";
  const st = (eq as Record<string, unknown>).thumbnailStatus;
  if (
    st === "AVAILABLE" ||
    st === "FAILED" ||
    st === "NOT_FETCHED" ||
    st === "BLOCKED" ||
    st === "UNSAFE"
  ) {
    return st;
  }
  return readStoredThumbnailKey(rawMetadata) ? "AVAILABLE" : "NOT_FETCHED";
}

/** Downloads a small thumbnail and stores it in private case storage. */
export async function fetchImageThumbnail(params: {
  caseId: string;
  imageUrl: string;
}): Promise<{ storageKey: string | null; status: ThumbnailStatus }> {
  const url = params.imageUrl?.trim();
  if (!url || !/^https?:\/\//i.test(url)) {
    return { storageKey: null, status: "NOT_FETCHED" };
  }

  const hash = hashImageSource(url);
  const storageKey = buildStorageKey.imageThumbnail(params.caseId, hash, "jpg");

  if (await fileExists(storageKey)) {
    return { storageKey, status: "AVAILABLE" };
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": "GlobalInfo-DigitalProfile/1.0 (thumbnail)" },
      redirect: "follow",
    });
    if (!res.ok) return { storageKey: null, status: "FAILED" };
    const ct = res.headers.get("content-type") ?? "";
    if (!ALLOWED_TYPES.test(ct)) return { storageKey: null, status: "UNSAFE" };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return { storageKey: null, status: "BLOCKED" };
    if (buf.length < 64) return { storageKey: null, status: "FAILED" };
    await saveFile(storageKey, buf);
    return { storageKey, status: "AVAILABLE" };
  } catch {
    return { storageKey: null, status: "FAILED" };
  }
}

export async function ensureImageThumbnail(params: {
  caseId: string;
  surfaceId?: string;
  imageUrl: string | null | undefined;
  thumbnailUrl: string | null | undefined;
  rawMetadata?: unknown;
}): Promise<{ storageKey: string | null; status: ThumbnailStatus; rawMetadata: Record<string, unknown> }> {
  const existingKey = readStoredThumbnailKey(params.rawMetadata);
  if (existingKey && (await fileExists(existingKey))) {
    return {
      storageKey: existingKey,
      status: "AVAILABLE",
      rawMetadata: mergeThumbnailMetadata(params.rawMetadata, existingKey, "AVAILABLE"),
    };
  }

  const fetchUrl = (params.thumbnailUrl ?? params.imageUrl ?? "").trim();
  if (!fetchUrl) {
    return {
      storageKey: null,
      status: "NOT_FETCHED",
      rawMetadata: mergeThumbnailMetadata(params.rawMetadata, null, "NOT_FETCHED"),
    };
  }

  const result = await fetchImageThumbnail({ caseId: params.caseId, imageUrl: fetchUrl });
  return {
    storageKey: result.storageKey,
    status: result.status,
    rawMetadata: mergeThumbnailMetadata(params.rawMetadata, result.storageKey, result.status),
  };
}

export function mergeThumbnailMetadata(
  rawMetadata: unknown,
  storageKey: string | null,
  status: ThumbnailStatus
): Record<string, unknown> {
  const base =
    rawMetadata && typeof rawMetadata === "object"
      ? { ...(rawMetadata as Record<string, unknown>) }
      : {};
  const eq = (base.evidenceQuality as Record<string, unknown>) ?? {};
  base.evidenceQuality = {
    ...eq,
    thumbnailStorageKey: storageKey,
    thumbnailStatus: status,
    thumbnailDownloadedAt: storageKey ? new Date().toISOString() : eq.thumbnailDownloadedAt,
  };
  return base;
}
