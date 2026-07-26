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

/** Сколько символов причины от провайдера показываем. */
const MAX_PROVIDER_REASON_CHARS = 160;

/**
 * Достаёт человекочитаемую причину из тела ошибки провайдера.
 *
 * Провайдеры её сообщают: Serper на исчерпанном ключе отвечает
 * `{"message":"Not enough credits"}` со статусом 400. Мы это тело выбрасывали и
 * писали оператору «Provider returned HTTP 400» — код, по которому нельзя
 * понять, что нужно пополнить счёт (шаг 13, B2).
 *
 * Возвращает `null`, когда причины нет или тело не текстовое: показывать
 * оператору кусок HTML-страницы ошибки бессмысленно.
 */
export function extractProviderReason(body: string | null | undefined): string | null {
  const raw = String(body ?? "").trim();
  if (!raw) return null;
  // HTML-страница ошибки — не сообщение, а вёрстка.
  if (/^\s*</.test(raw)) return null;

  const clean = (value: unknown): string | null => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    return text.length > MAX_PROVIDER_REASON_CHARS
      ? `${text.slice(0, MAX_PROVIDER_REASON_CHARS - 1)}…`
      : text;
  };

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === "string") return clean(parsed);
    if (parsed && typeof parsed === "object") {
      const o = parsed as Record<string, unknown>;
      const nested = o.error && typeof o.error === "object"
        ? (o.error as Record<string, unknown>).message
        : undefined;
      for (const candidate of [o.message, o.error, o.detail, o.description, nested]) {
        if (typeof candidate === "string") {
          const text = clean(candidate);
          if (text) return text;
        }
      }
    }
    return null;
  } catch {
    // Не JSON — но короткий текст провайдера тоже пригодится.
    return clean(raw);
  }
}

/** Сообщение об ошибке, называющее причину, когда провайдер её сообщил. */
export function providerHttpMessage(status: number, body?: string | null): string {
  const reason = extractProviderReason(body);
  return reason
    ? `Provider returned HTTP ${status}: ${reason}`
    : `Provider returned HTTP ${status}.`;
}

/**
 * Maps an HTTP status to a typed provider error. Pure + exported so the smoke
 * test can assert 401/403/429/5xx handling without making a network call.
 */
export function mapStatusToProviderError(
  status: number,
  /** Тело ответа, если оно прочитано: провайдер часто называет в нём причину. */
  body?: string | null
): ProviderHttpError | null {
  const reason = extractProviderReason(body);
  if (status === 429) {
    return new ProviderHttpError(
      "PROVIDER_RATE_LIMITED",
      reason ? `Provider rate limited (HTTP 429): ${reason}` : "Provider rate limited (HTTP 429).",
      true
    );
  }
  if (status === 401 || status === 403) {
    return new ProviderHttpError(
      "PROVIDER_BAD_RESPONSE",
      reason
        ? `Provider rejected the request (HTTP ${status}): ${reason}`
        : `Provider rejected the request (HTTP ${status}). Check API key / folder id.`,
      false
    );
  }
  if (status >= 500) {
    return new ProviderHttpError("PROVIDER_BAD_RESPONSE", providerHttpMessage(status, body), true);
  }
  if (status >= 400) {
    return new ProviderHttpError("PROVIDER_BAD_RESPONSE", providerHttpMessage(status, body), false);
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
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw (
      mapStatusToProviderError(res.status, body) ??
      new ProviderHttpError("PROVIDER_BAD_RESPONSE", providerHttpMessage(res.status, body), false)
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
  const text = await res.text();
  // Тело читается до разбора статуса: причина отказа приходит именно в нём.
  const mapped = mapStatusToProviderError(res.status, text);
  if (mapped) throw mapped;
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
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw (
      mapStatusToProviderError(res.status, body) ??
      new ProviderHttpError("PROVIDER_BAD_RESPONSE", providerHttpMessage(res.status, body), false)
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
