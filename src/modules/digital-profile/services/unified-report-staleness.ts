/**
 * Mark an existing canonical (unified job) report as stale / REBUILD_REQUIRED.
 *
 * Diagnostic collectors (standalone Arsenkin CaseAgent runs, ad-hoc enrichment)
 * append new evidence but MUST NOT regenerate the client report. When they run
 * against a case whose unified job already produced an accepted report, they
 * flag that report stale so the operator re-runs the unified CTA. This never
 * generates a report, never sets REPORT_READY and never touches the legacy
 * composer.
 */

import {
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
} from "./unified-collection-job-store";

export const CANONICAL_ARTIFACTS_STALE_WARNING = "CANONICAL_ARTIFACTS_STALE";

export function markUnifiedReportArtifactsStale(
  caseId: string,
  reason: string
): { marked: boolean; reason: string } {
  const job = loadUnifiedCollectionJob(caseId);
  if (!job) return { marked: false, reason: "no-unified-job" };
  // Only a completed, accepted (or partial) report can go stale.
  if (job.stage !== "REPORT_READY" && job.stage !== "COMPLETED_PARTIAL") {
    return { marked: false, reason: `job-not-accepted:${job.stage}` };
  }
  const tag = `${CANONICAL_ARTIFACTS_STALE_WARNING}:${reason}`;
  if (job.warnings.includes(tag)) return { marked: true, reason: "already-stale" };
  patchUnifiedCollectionJob(caseId, { warnings: [...job.warnings, tag] });
  return { marked: true, reason: tag };
}

export function isUnifiedReportStale(warnings: string[] | undefined): boolean {
  return (warnings ?? []).some((w) => w.startsWith(CANONICAL_ARTIFACTS_STALE_WARNING));
}
