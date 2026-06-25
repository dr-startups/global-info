/**
 * Storage key conventions + validation (Stage M2).
 *
 * Keys are POSIX-style, relative, and namespaced per case so a single storage
 * root (local dir today; S3/R2 later) stays organized and access-checkable:
 *
 *   cases/{caseId}/reports/{reportVersionId}/report.pptx
 *   cases/{caseId}/reports/{reportVersionId}/report.pdf
 *   cases/{caseId}/screenshots/{screenshotId}.{ext}
 *   cases/{caseId}/evidence/{evidenceId}/{filename}
 *   cases/{caseId}/exports/{exportId}/{filename}
 *
 * This module is PURE (no Node fs / no provider import) so it can be reused by
 * the local provider, future remote providers, and the smoke tests.
 */

/** A single path segment may contain id-safe chars only (no separators/dots-only). */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

export class StorageKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageKeyError";
  }
}

/**
 * Rejects path traversal and absolute paths. Returns a normalized key with
 * forward slashes and no leading slash. Throws `StorageKeyError` on anything
 * suspicious. Use this on every externally-influenced key before touching disk.
 */
export function preventPathTraversal(key: string): string {
  if (typeof key !== "string" || key.length === 0) {
    throw new StorageKeyError("Empty storage key");
  }
  if (key.length > 1024) {
    throw new StorageKeyError("Storage key too long");
  }
  // Normalize separators; reject NUL and backslashes-as-traversal.
  const k = key.replace(/\\/g, "/");
  if (k.includes("\0")) throw new StorageKeyError("Invalid storage key");
  // No absolute paths (POSIX "/..." or Windows "C:...").
  if (k.startsWith("/") || /^[A-Za-z]:/.test(k)) {
    throw new StorageKeyError("Absolute storage keys are not allowed");
  }
  const parts = k.split("/");
  for (const part of parts) {
    if (part === "" || part === "." || part === "..") {
      throw new StorageKeyError("Path traversal in storage key");
    }
    if (!SEGMENT_RE.test(part)) {
      throw new StorageKeyError(`Illegal characters in storage key segment: ${part}`);
    }
  }
  return parts.join("/");
}

/** Returns true if the key is a safe, normalized, relative storage key. */
export function validateStorageKey(key: string): boolean {
  try {
    preventPathTraversal(key);
    return true;
  } catch {
    return false;
  }
}

function seg(value: string, label: string): string {
  const v = String(value ?? "").trim();
  if (!v || !SEGMENT_RE.test(v)) {
    throw new StorageKeyError(`Invalid ${label} for storage key`);
  }
  return v;
}

export type ReportArtifact = "pptx" | "pdf";

/** Builders for the canonical storage keys. All inputs are validated. */
export const buildStorageKey = {
  reportArtifact(caseId: string, reportVersionId: string, type: ReportArtifact): string {
    const t = type === "pptx" || type === "pdf" ? type : null;
    if (!t) throw new StorageKeyError("Report artifact must be pptx or pdf");
    return `cases/${seg(caseId, "caseId")}/reports/${seg(reportVersionId, "reportVersionId")}/report.${t}`;
  },
  screenshot(caseId: string, screenshotId: string, ext: string): string {
    return `cases/${seg(caseId, "caseId")}/screenshots/${seg(screenshotId, "screenshotId")}.${seg(ext, "ext")}`;
  },
  evidence(caseId: string, evidenceId: string, filename: string): string {
    return `cases/${seg(caseId, "caseId")}/evidence/${seg(evidenceId, "evidenceId")}/${seg(filename, "filename")}`;
  },
  export(caseId: string, exportId: string, filename: string): string {
    return `cases/${seg(caseId, "caseId")}/exports/${seg(exportId, "exportId")}/${seg(filename, "filename")}`;
  },
  /** Reserved prefix for ephemeral health-check probes. */
  healthProbe(token: string): string {
    return `_health/${seg(token, "token")}`;
  },
};
