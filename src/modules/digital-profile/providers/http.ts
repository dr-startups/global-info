/**
 * Shared HTTP helper for keyed SERP providers. Adds a timeout and maps low-level
 * failures to typed provider error codes. Never logs secrets.
 */

import type { ProviderErrorCode, SearchProviderName } from "./types";

export class ProviderHttpError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  constructor(code: ProviderErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = "ProviderHttpError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Redacts query-string secrets (key/apikey/folderid) from a URL for safe logs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) {
      if (/key|apikey|folder|token|secret/i.test(k)) u.searchParams.set(k, "***");
    }
    return u.toString();
  } catch {
    return "<url>";
  }
}

export interface TimedFetchOptions {
  timeoutMs: number;
  headers?: Record<string, string>;
}

async function timedFetch(url: string, options: TimedFetchOptions): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", ...options.headers },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ProviderHttpError("PROVIDER_TIMEOUT", "Provider request timed out.", true);
    }
    throw new ProviderHttpError(
      "PROVIDER_NETWORK_ERROR",
      `Network error: ${redactUrl(url)}`,
      true
    );
  } finally {
    clearTimeout(timer);
  }
}

/** GET JSON with timeout + status mapping. Throws ProviderHttpError on failure. */
export async function getJson(url: string, options: TimedFetchOptions): Promise<unknown> {
  const res = await timedFetch(url, options);
  if (res.status === 429) {
    throw new ProviderHttpError("PROVIDER_RATE_LIMITED", "Provider rate limited.", true);
  }
  if (!res.ok) {
    throw new ProviderHttpError(
      "PROVIDER_BAD_RESPONSE",
      `Provider returned HTTP ${res.status}.`,
      res.status >= 500
    );
  }
  try {
    return await res.json();
  } catch {
    throw new ProviderHttpError("PROVIDER_INVALID_RESPONSE", "Invalid JSON from provider.", false);
  }
}

/** GET text with timeout + status mapping (for XML APIs). */
export async function getText(url: string, options: TimedFetchOptions): Promise<string> {
  const res = await timedFetch(url, options);
  if (res.status === 429) {
    throw new ProviderHttpError("PROVIDER_RATE_LIMITED", "Provider rate limited.", true);
  }
  if (!res.ok) {
    throw new ProviderHttpError(
      "PROVIDER_BAD_RESPONSE",
      `Provider returned HTTP ${res.status}.`,
      res.status >= 500
    );
  }
  return res.text();
}

export function toProviderError(err: unknown, provider: SearchProviderName) {
  if (err instanceof ProviderHttpError) {
    return { code: err.code, message: err.message, retryable: err.retryable, provider };
  }
  return {
    code: "PROVIDER_REQUEST_FAILED" as ProviderErrorCode,
    message: "Provider request failed.",
    retryable: true,
    provider,
  };
}
