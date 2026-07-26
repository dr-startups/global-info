/**
 * Classify Arsenkin /set outcomes for durable enrichment.
 * Validation rejection without externalTaskId ≠ uncertain SUBMIT_UNKNOWN.
 */

import { ArsenkinRequestError } from "./client";
import type { ArsenkinTaskState } from "./types";

export type ArsenkinSubmitOutcomeKind =
  | "SUBMITTED"
  | "SUBMIT_REJECTED_RETRYABLE"
  | "SUBMIT_UNKNOWN_UNRECONCILED"
  | "RATE_LIMITED"
  | "FAILED";

const VALIDATION_CODES = new Set([
  "JSON_VALIDATION_ERROR",
  "VALIDATION_ERROR",
  "INVALID_PARAMS",
  "INVALID_REQUEST",
  "BAD_REQUEST",
]);

export function isArsenkinValidationRejectionCode(code: string | null | undefined): boolean {
  const c = String(code ?? "")
    .trim()
    .toUpperCase();
  if (!c) return false;
  if (VALIDATION_CODES.has(c)) return true;
  return /VALIDATION|INVALID_.*QUERY|BAD_REQUEST/i.test(c);
}

export function classifyArsenkinSubmitFailure(error: unknown): {
  kind: Exclude<ArsenkinSubmitOutcomeKind, "SUBMITTED">;
  state: ArsenkinTaskState;
  errorCode: string;
  terminal: boolean;
  softRetryAllowed: boolean;
} {
  const requestError = error instanceof ArsenkinRequestError ? error : null;
  const status = requestError?.options.status;
  const code = requestError?.options.code != null ? String(requestError.options.code) : null;
  const raw = requestError?.options.raw;
  const rawCode =
    raw && typeof raw === "object" && !Array.isArray(raw) && (raw as { code?: unknown }).code != null
      ? String((raw as { code: unknown }).code)
      : null;
  const effectiveCode = code ?? rawCode;
  const message = requestError?.message ?? (error instanceof Error ? error.message : String(error));

  // Deterministic schema/contract rejection — even when Arsenkin returns HTTP 500.
  if (
    isArsenkinValidationRejectionCode(effectiveCode) ||
    /JSON_VALIDATION_ERROR/i.test(message) ||
    /ошибк\w*\s+в\s+поле\s+queries/i.test(message)
  ) {
    return {
      kind: "SUBMIT_REJECTED_RETRYABLE",
      state: "SUBMIT_REJECTED_RETRYABLE",
      errorCode: "SUBMIT_REJECTED_RETRYABLE",
      terminal: true,
      softRetryAllowed: false,
    };
  }

  if (status === 429) {
    return {
      kind: "RATE_LIMITED",
      state: "RATE_LIMITED",
      errorCode: "http_429",
      terminal: false,
      softRetryAllowed: true,
    };
  }

  if (status != null && status >= 400 && status < 500) {
    return {
      kind: "FAILED",
      state: "FAILED",
      errorCode: `http_${status}`,
      terminal: true,
      softRetryAllowed: false,
    };
  }

  // Truly ambiguous: timeout / 5xx without validation code / unknown network.
  if (requestError?.options.uncertain || (status != null && status >= 500)) {
    return {
      kind: "SUBMIT_UNKNOWN_UNRECONCILED",
      state: "SUBMIT_UNKNOWN",
      errorCode: status ? `http_${status}` : "submit_unknown",
      terminal: true,
      softRetryAllowed: false,
    };
  }

  return {
    kind: "SUBMIT_UNKNOWN_UNRECONCILED",
    state: "SUBMIT_UNKNOWN",
    errorCode: "submit_unknown",
    terminal: true,
    softRetryAllowed: false,
  };
}

export function classifyProviderTaskSubmitOutcome(row: {
  state: string;
  externalTaskId?: string | null;
  errorCode?: string | null;
}): ArsenkinSubmitOutcomeKind {
  const ext = String(row.externalTaskId ?? "").trim();
  if (ext) return "SUBMITTED";
  const st = String(row.state ?? "").toUpperCase();
  const err = String(row.errorCode ?? "").toUpperCase();
  if (st === "SUBMIT_REJECTED_RETRYABLE" || err === "SUBMIT_REJECTED_RETRYABLE") {
    return "SUBMIT_REJECTED_RETRYABLE";
  }
  if (st === "SUBMIT_UNKNOWN" || err === "SUBMIT_UNKNOWN" || /SUBMIT_UNKNOWN/i.test(err)) {
    return "SUBMIT_UNKNOWN_UNRECONCILED";
  }
  if (st === "FAILED" && isArsenkinValidationRejectionCode(err)) {
    return "SUBMIT_REJECTED_RETRYABLE";
  }
  if (st === "RATE_LIMITED") return "RATE_LIMITED";
  if (st === "FAILED") return "FAILED";
  return "SUBMIT_UNKNOWN_UNRECONCILED";
}
