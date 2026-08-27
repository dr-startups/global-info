/**
 * Unified HTTP error handling and response envelope for the Digital Profile API.
 *
 * Success: { "ok": true,  "data": ... }
 * Error:   { "ok": false, "error": { "code": "...", "message": "...", "details"? } }
 *
 * Stack traces are never exposed in responses.
 */

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { isDigitalProfileEnabled } from "../config";

export type ErrorCode =
  | "MODULE_DISABLED"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RENDERER_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    status: number,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class ModuleDisabledError extends AppError {
  constructor() {
    super("MODULE_DISABLED", 404, "Digital Profile module is disabled");
  }
}

export class ValidationError extends AppError {
  constructor(message = "Invalid request payload", details?: unknown) {
    super("VALIDATION_ERROR", 400, message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super("UNAUTHORIZED", 401, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super("FORBIDDEN", 403, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super("NOT_FOUND", 404, message);
  }
}

export class ConflictError extends AppError {
  /**
   * `details` — машинная причина отказа для клиента.
   *
   * Своего кода отказа в ответе быть не может: `ErrorCode` закрыт восемью
   * значениями, и расширять его ради одного случая значит менять контракт всех
   * маршрутов. Причина уезжает в `details.reason`, а человеческий текст живёт
   * в словарях i18n.
   */
  constructor(message = "Resource conflict", details?: unknown) {
    super("CONFLICT", 409, message, details);
  }
}

export class RendererUnavailableError extends AppError {
  constructor(message = "Report renderer is unavailable", details?: unknown) {
    super("RENDERER_UNAVAILABLE", 502, message, details);
  }
}

/** Throws if the module feature flag is disabled. */
export function assertModuleEnabled(): void {
  if (!isDigitalProfileEnabled()) {
    throw new ModuleDisabledError();
  }
}

export function jsonOk<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true as const, data }, { status });
}

function jsonError(error: AppError): NextResponse {
  return NextResponse.json(
    {
      ok: false as const,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    },
    { status: error.status }
  );
}

/** Maps any thrown value to a safe AppError (no stack traces leak out). */
export function normalizeError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  if (err instanceof ZodError) {
    return new ValidationError("Invalid request payload", err.flatten());
  }

  // Prisma known errors (unique constraint -> conflict, missing record -> 404).
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: string }).code;
    if (code === "P2002") return new ConflictError("Resource already exists");
    if (code === "P2025") return new NotFoundError();
  }

  // R10.10a — map known ORION admin workflow missing-resource errors to 404.
  if (err instanceof Error) {
    const msg = err.message;
    if (
      msg === "manual-review-queue-missing" ||
      msg === "manual-review-queue-case-mismatch" ||
      msg === "evidence-judgment-inspection-missing" ||
      msg === "evidence-bundles-missing" ||
      msg === "evidence-bundles-case-mismatch" ||
      msg === "invalid-case-id" ||
      msg.startsWith("manual-review-item-not-found:") ||
      msg.startsWith("admin-review-decision-case-mismatch:")
    ) {
      return new NotFoundError(
        msg.startsWith("manual-review-item-not-found:")
          ? "Evidence not found"
          : msg === "invalid-case-id"
            ? "Invalid case id"
            : "Case artifacts not found"
      );
    }
  }

  // Unexpected: log server-side, return generic message.
  console.error("[digital-profile] Unhandled error:", err);
  return new AppError("INTERNAL_ERROR", 500, "Internal server error");
}

/**
 * Wraps a route handler: enforces the feature flag, runs the handler, and
 * serializes the result/error into the unified envelope.
 */
export function withModule<A extends unknown[]>(
  handler: (...args: A) => Promise<NextResponse>
): (...args: A) => Promise<NextResponse> {
  return async (...args: A) => {
    try {
      assertModuleEnabled();
      return await handler(...args);
    } catch (err) {
      return jsonError(normalizeError(err));
    }
  };
}
