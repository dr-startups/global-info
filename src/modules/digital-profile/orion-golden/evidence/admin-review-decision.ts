/**
 * R10.5 — Admin review decision model (artifact-backed, no DB).
 */

export type AdminReviewStatus =
  | "PENDING"
  | "APPROVED"
  | "APPROVED_WITH_CAVEAT"
  | "APPENDIX_ONLY"
  | "EXCLUDED"
  | "NEEDS_MORE_SOURCES"
  | "WRONG_SUBJECT";

export type AdminReviewDecision = {
  evidenceId: string;
  status: AdminReviewStatus;
  reviewerNote?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  approvedClientSummary?: string;
  caveatText?: string;
  requestedSources?: string[];
};

export type AdminReviewDecisionSet = {
  version: "r10-5-admin-review-decisions-v1";
  caseId: string;
  generatedAt: string;
  updatedAt?: string;
  /** QA-only fixture marker — never treat as real admin approval in production. */
  qaSampleOnly?: boolean;
  decisions: AdminReviewDecision[];
};

export type AdminReviewDecisionInput = Omit<AdminReviewDecision, "evidenceId"> & {
  evidenceId?: string;
};

export function countAdminDecisionsByStatus(
  decisions: AdminReviewDecision[]
): Record<AdminReviewStatus, number> {
  const out: Record<string, number> = {
    PENDING: 0,
    APPROVED: 0,
    APPROVED_WITH_CAVEAT: 0,
    APPENDIX_ONLY: 0,
    EXCLUDED: 0,
    NEEDS_MORE_SOURCES: 0,
    WRONG_SUBJECT: 0,
  };
  for (const d of decisions) {
    out[d.status] = (out[d.status] ?? 0) + 1;
  }
  return out as Record<AdminReviewStatus, number>;
}

export function isNonPendingAdminDecision(decision: AdminReviewDecision): boolean {
  return decision.status !== "PENDING";
}

/** Client-final post-review must never use QA sample fixture decisions. */
export function selectPostReviewAdminDecisions(input: {
  useGptAutoAnalyst: boolean;
  productionDecisions: AdminReviewDecision[];
  resolvedAdminDecisions: AdminReviewDecision[];
}): AdminReviewDecision[] {
  return input.useGptAutoAnalyst ? input.resolvedAdminDecisions : input.productionDecisions;
}
