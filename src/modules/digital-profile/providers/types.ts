/**
 * Shared types for the real-connector provider layer (Stage H).
 */

export type SearchProviderName = "GOOGLE" | "YANDEX" | "WIKIPEDIA";

export type AvailabilityStatus = "ENABLED" | "DISABLED" | "NOT_CONFIGURED";

export type ProviderRunStatus = "SUCCESS" | "FAILED" | "DISABLED" | "NOT_CONFIGURED";

export interface SearchProviderRequest {
  caseId: string;
  subjectFullName: string;
  aliases: string[];
  query: string;
  region?: string;
  language?: string;
  limit?: number;
  page?: number;
}

export interface SearchProviderResult {
  provider: SearchProviderName;
  query: string;
  region?: string;
  language?: string;
  rank: number;
  title: string;
  snippet: string;
  url: string;
  domain: string;
  publishedAt?: string;
  /** Raw, source-attributed metadata (evidence-first). */
  rawMetadata: unknown;
  capturedAt: string;
}

export interface ProviderError {
  code:
    | "PROVIDER_DISABLED"
    | "PROVIDER_NOT_CONFIGURED"
    | "PROVIDER_REQUEST_FAILED"
    | "PROVIDER_RATE_LIMITED"
    | "PROVIDER_INVALID_RESPONSE";
  message: string;
  retryable: boolean;
  provider: SearchProviderName;
}

export interface ProviderRunResult {
  status: ProviderRunStatus;
  provider: SearchProviderName;
  results: SearchProviderResult[];
  /** Raw response snapshot for evidence/debugging (never rendered directly). */
  rawSnapshot?: unknown;
  error?: ProviderError;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
