/**
 * Categorize Arsenkin /check and /get failures separately from parse outcomes.
 */

import { createHash } from "node:crypto";
import { ArsenkinRequestError } from "./client";
import { redactDeep, redactSecrets } from "./redact";

export type ArsenkinResultFetchCategory =
  | "HTTP_ERROR"
  | "NETWORK_ERROR"
  | "INVALID_JSON"
  | "TASK_NOT_READY"
  | "TASK_NOT_FOUND"
  | "PROVIDER_ERROR"
  | "PARSE_ERROR"
  | "EMPTY_RESULT"
  | "OK";

export type ArsenkinTransportMeta = {
  httpStatus: number | null;
  providerCode: string | null;
  contentType: string | null;
  byteLength: number;
  bodyHash: string;
  safePreview: string;
  category: ArsenkinResultFetchCategory;
  elapsedMs: number;
};

export function buildTransportMeta(input: {
  httpStatus?: number | null;
  providerCode?: string | null;
  contentType?: string | null;
  bodyText: string;
  category: ArsenkinResultFetchCategory;
  elapsedMs: number;
}): ArsenkinTransportMeta {
  const safe = redactSecrets(input.bodyText ?? "");
  return {
    httpStatus: input.httpStatus ?? null,
    providerCode: input.providerCode ?? null,
    contentType: input.contentType ?? null,
    byteLength: Buffer.byteLength(input.bodyText ?? "", "utf-8"),
    bodyHash: createHash("sha256").update(input.bodyText ?? "").digest("hex").slice(0, 16),
    safePreview: safe.slice(0, 240),
    category: input.category,
    elapsedMs: input.elapsedMs,
  };
}

export function categorizeCheckOrGetFailure(error: unknown): {
  category: ArsenkinResultFetchCategory;
  message: string;
  meta: Record<string, unknown>;
} {
  if (error instanceof ArsenkinRequestError) {
    const status = error.options.status;
    const code = String(error.options.code ?? "").toUpperCase();
    const raw = error.options.raw;
    if (status === 404 || /NOT_FOUND|UNKNOWN_TASK/i.test(code)) {
      return {
        category: "TASK_NOT_FOUND",
        message: error.message,
        meta: { status, code, raw: redactDeep(raw) },
      };
    }
    if (/NOT_READY|PROGRESS|RUNNING|QUEUED/i.test(code) || status === 202) {
      return {
        category: "TASK_NOT_READY",
        message: error.message,
        meta: { status, code, raw: redactDeep(raw) },
      };
    }
    if (status != null && status >= 400) {
      return {
        category: status >= 500 ? "HTTP_ERROR" : "PROVIDER_ERROR",
        message: error.message,
        meta: { status, code, raw: redactDeep(raw) },
      };
    }
    if (error.options.uncertain || /timeout|network|fetch/i.test(error.message)) {
      return {
        category: "NETWORK_ERROR",
        message: error.message,
        meta: { status, code, raw: redactDeep(raw) },
      };
    }
    return {
      category: "PROVIDER_ERROR",
      message: error.message,
      meta: { status, code, raw: redactDeep(raw) },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/json|parse/i.test(message)) {
    return { category: "INVALID_JSON", message, meta: {} };
  }
  if (/timeout|network|fetch|ECONN|ENOTFOUND/i.test(message)) {
    return { category: "NETWORK_ERROR", message, meta: {} };
  }
  return { category: "HTTP_ERROR", message, meta: {} };
}

export function categorizeProviderGetPayload(raw: Record<string, unknown>): ArsenkinResultFetchCategory {
  const code = String(raw.code ?? "").toUpperCase();
  if (code === "TASK_RESULT" || raw.result != null) return "OK";
  if (/NOT_READY|PROGRESS|RUNNING|QUEUED/i.test(code)) return "TASK_NOT_READY";
  if (/NOT_FOUND|UNKNOWN/i.test(code)) return "TASK_NOT_FOUND";
  if (/ERROR|FAIL/i.test(code)) return "PROVIDER_ERROR";
  if (raw.result == null && Object.keys(raw).length === 0) return "EMPTY_RESULT";
  return "OK";
}
