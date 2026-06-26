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

/** Hard cap on a provider response body we are willing to read (anti-DoS). */
export const MAX_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MB

/**
 * Maps an HTTP status to a typed provider error. Pure + exported so the smoke
 * test can assert 401/403/429/5xx handling without making a network call.
 */
export function mapStatusToProviderError(status: number): ProviderHttpError | null {
  if (status === 429) {
    return new ProviderHttpError("PROVIDER_RATE_LIMITED", "Provider rate limited (HTTP 429).", true);
  }
  if (status === 401 || status === 403) {
    return new ProviderHttpError(
      "PROVIDER_BAD_RESPONSE",
      `Provider rejected the request (HTTP ${status}). Check API key / folder id.`,
      false
    );
  }
  if (status >= 500) {
    return new ProviderHttpError("PROVIDER_BAD_RESPONSE", `Provider returned HTTP ${status}.`, true);
  }
  if (status >= 400) {
    return new ProviderHttpError("PROVIDER_BAD_RESPONSE", `Provider returned HTTP ${status}.`, false);
  }
  return null;
}

interface TimedFetchInit extends TimedFetchOptions {
  method?: string;
  body?: string;
}

async function timedFetch(url: string, options: TimedFetchInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await fetch(url, {
      method: options.method ?? "GET",
      body: options.body,
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

/**
 * POST JSON with timeout + status mapping + a hard response-size cap. Secrets are
 * passed via headers and never logged. Throws ProviderHttpError on failure.
 */
export async function postJson(
  url: string,
  body: unknown,
  options: TimedFetchOptions
): Promise<unknown> {
  const res = await timedFetch(url, {
    ...options,
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...options.headers },
  });
  const mapped = mapStatusToProviderError(res.status);
  if (mapped) throw mapped;
  const text = await res.text();
  if (text.length > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new ProviderHttpError("PROVIDER_BAD_RESPONSE", "Provider response too large.", false);
  }
  try {
    return JSON.parse(text);
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
