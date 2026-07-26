import { createHash } from "node:crypto";
import type { SerpCaptureEngine, SerpCaptureRegion } from "./types";

export class SerpUrlBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SerpUrlBuilderError";
  }
}

/** Normalize query for stable hashing / matching. */
export function normalizeSerpQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

export function hashSerpQuery(query: string): string {
  return createHash("sha256").update(normalizeSerpQuery(query).toLowerCase(), "utf8").digest("hex");
}

/**
 * Build allowlisted search URLs on the server only.
 * Client-supplied URLs are never accepted.
 */
export function buildAllowlistedSerpUrl(input: {
  query: string;
  engine: SerpCaptureEngine;
  region: SerpCaptureRegion;
  locale?: string;
}): { url: string; locale: string } {
  const q = normalizeSerpQuery(input.query);
  if (!q) throw new SerpUrlBuilderError("query-required");
  if (q.length > 200) throw new SerpUrlBuilderError("query-too-long");

  if (input.region === "UAE" && input.engine === "YANDEX") {
    throw new SerpUrlBuilderError("yandex-not-supported-for-uae");
  }

  const encoded = encodeURIComponent(q);

  if (input.engine === "YANDEX") {
    const locale = input.locale?.trim() || "ru-RU";
    return {
      url: `https://yandex.ru/search/?text=${encoded}&lr=213`,
      locale,
    };
  }

  if (input.region === "UAE") {
    const locale = input.locale?.trim() || "en-AE";
    return {
      url: `https://www.google.ae/search?q=${encoded}&hl=en&gl=ae`,
      locale,
    };
  }

  const locale = input.locale?.trim() || "ru-RU";
  return {
    url: `https://www.google.ru/search?q=${encoded}&hl=ru&gl=ru`,
    locale,
  };
}

/** Reject arbitrary client URLs — only allowlisted hosts. */
export function assertAllowlistedSerpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SerpUrlBuilderError("invalid-url");
  }
  const host = parsed.hostname.toLowerCase();
  const allowed =
    host === "yandex.ru" ||
    host === "www.yandex.ru" ||
    host === "google.ru" ||
    host === "www.google.ru" ||
    host === "google.ae" ||
    host === "www.google.ae";
  if (!allowed) throw new SerpUrlBuilderError("url-not-allowlisted");
}
