/**
 * Pure validation of client content / binding / admin decision artifacts for live canary.
 */

export type ClientContentArtifact = {
  caseId?: string;
  reportRunId?: string;
};

export type ClientContentBindingArtifact = {
  sourceReportRunId?: string;
  effectiveReportRunId?: string;
  overridden?: boolean;
};

export type AdminReviewDecisionsArtifact = {
  caseId?: string;
  qaSampleOnly?: boolean;
  decisions?: unknown[];
};

export type ClientBindingValidationInput = {
  caseId: string;
  reportRunId: string;
  content: ClientContentArtifact | null;
  binding: ClientContentBindingArtifact | null;
  adminDecisions: AdminReviewDecisionsArtifact | null;
  /** When true, missing production decisions is a blocker (default for live). */
  requireAdminDecisions?: boolean;
};

export type ClientBindingValidationResult = {
  ok: boolean;
  blockers: string[];
};

export function validateClientBindingArtifacts(
  input: ClientBindingValidationInput
): ClientBindingValidationResult {
  const blockers: string[] = [];
  const requireAdmin = input.requireAdminDecisions !== false;

  if (!input.content) {
    blockers.push("client-content-missing");
  } else {
    if (input.content.caseId !== input.caseId) {
      blockers.push("client-content-caseId-mismatch");
    }
    if (input.content.reportRunId !== input.reportRunId) {
      blockers.push("client-content-reportRunId-mismatch");
    }
  }

  if (!input.binding) {
    blockers.push("client-content-binding-missing");
  } else {
    if (input.binding.sourceReportRunId !== input.reportRunId) {
      blockers.push("binding-sourceReportRunId-mismatch");
    }
    if (input.binding.effectiveReportRunId !== input.reportRunId) {
      blockers.push("binding-effectiveReportRunId-mismatch");
    }
    if (input.binding.overridden === true) {
      blockers.push("binding-overridden");
    }
  }

  if (!input.adminDecisions) {
    if (requireAdmin) {
      blockers.push("admin-review-decisions-missing");
    }
  } else {
    if (input.adminDecisions.caseId != null && input.adminDecisions.caseId !== input.caseId) {
      blockers.push("admin-decisions-caseId-mismatch");
    }
    if (input.adminDecisions.qaSampleOnly === true) {
      blockers.push("qa-sample-decisions-forbidden");
    }
  }

  return { ok: blockers.length === 0, blockers };
}
