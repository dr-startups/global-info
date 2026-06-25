/**
 * Report download authorization policy (Stage M2).
 *
 * PURE decision logic (role + draft state) extracted so it can be unit-tested by
 * smoke:storage and reused by the download route. Case-level access is enforced
 * separately (DB-backed) by the caller — this only covers the role/draft rule:
 *
 *   - CLIENT_VIEWER may download client-safe (non-draft, no-watermark) reports
 *     only, and only when they hold the report.downloadClient capability.
 *   - Staff need at least report.downloadInternal.
 *
 * A valid signed token never overrides this — it is checked in addition.
 */

import { can, type DpRole } from "./roles";

export interface ReportDownloadDecision {
  allowed: boolean;
  reason?: string;
}

/** True when a report is internal/draft (not safe for client viewers). */
export function isReportDraft(
  status: string | null | undefined,
  watermark: string | null | undefined
): boolean {
  const finalized = (status ?? "").toUpperCase() === "FINAL";
  const watermarked = !!(watermark && watermark.trim());
  return !finalized || watermarked;
}

export function authorizeReportDownload(input: {
  role: DpRole;
  isDraft: boolean;
}): ReportDownloadDecision {
  const { role, isDraft } = input;

  if (role === "CLIENT_VIEWER") {
    if (isDraft) {
      return { allowed: false, reason: "client_viewer_draft_blocked" };
    }
    if (!can(role, "report.downloadClient")) {
      return { allowed: false, reason: "missing_download_client" };
    }
    return { allowed: true };
  }

  if (!can(role, "report.downloadInternal")) {
    return { allowed: false, reason: "missing_download_internal" };
  }
  return { allowed: true };
}
