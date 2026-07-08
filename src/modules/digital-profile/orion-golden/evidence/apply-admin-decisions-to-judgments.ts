/**
 * R10.5 — Apply human admin decisions to evidence judgments.
 */

import type { EvidenceJudgment, ReviewDecision } from "./evidence-judgment";
import type { AdminReviewDecision, AdminReviewStatus } from "./admin-review-decision";

export type AdminJudgmentApplication = {
  judgments: EvidenceJudgment[];
  blockedOverrides: string[];
};

function mapStatusToReviewDecision(
  status: AdminReviewStatus,
  prior: ReviewDecision
): ReviewDecision {
  switch (status) {
    case "APPROVED":
    case "APPROVED_WITH_CAVEAT":
      return "AUTO_INCLUDE_CLIENT_REPORT";
    case "APPENDIX_ONLY":
      return "APPENDIX_ONLY";
    case "EXCLUDED":
      return "EXCLUDE_NOISE";
    case "WRONG_SUBJECT":
      return "EXCLUDE_WRONG_SUBJECT";
    case "NEEDS_MORE_SOURCES":
    case "PENDING":
      return prior === "MANUAL_REVIEW_REQUIRED" ? "MANUAL_REVIEW_REQUIRED" : prior;
    default:
      return prior;
  }
}

export function applyAdminDecisionsToJudgments(
  judgments: EvidenceJudgment[],
  decisions: AdminReviewDecision[]
): AdminJudgmentApplication {
  const byId = new Map(decisions.map((d) => [d.evidenceId, d]));
  const blockedOverrides: string[] = [];

  const updated = judgments.map((j) => {
    const admin = byId.get(j.evidenceId);
    if (!admin) return j;

    if (
      j.reviewDecision === "EXCLUDE_WRONG_SUBJECT" &&
      admin.status !== "WRONG_SUBJECT" &&
      admin.status !== "EXCLUDED"
    ) {
      blockedOverrides.push(j.evidenceId);
      return {
        ...j,
        adminReviewStatus: "WRONG_SUBJECT" as const,
        reviewDecision: "EXCLUDE_WRONG_SUBJECT" as const,
        adminReviewerNote: admin.reviewerNote,
        adminReviewedAt: admin.reviewedAt,
        adminReviewedBy: admin.reviewedBy,
      };
    }

    if (j.subjectBinding === "WRONG_SUBJECT" && admin.status === "APPROVED") {
      blockedOverrides.push(j.evidenceId);
      return {
        ...j,
        adminReviewStatus: "WRONG_SUBJECT" as const,
        reviewDecision: "EXCLUDE_WRONG_SUBJECT" as const,
      };
    }

    const reviewDecision = mapStatusToReviewDecision(admin.status, j.reviewDecision);
    let clientSafeSummary = admin.approvedClientSummary ?? j.clientSafeSummary;

    if (admin.status === "APPROVED_WITH_CAVEAT") {
      const caveat = admin.caveatText?.trim();
      if (caveat) {
        clientSafeSummary = `${clientSafeSummary} [Оговорка: ${caveat}]`;
      }
    }

    if (admin.status === "NEEDS_MORE_SOURCES") {
      clientSafeSummary = `${clientSafeSummary} Требуются дополнительные источники для подтверждения.`;
    }

    return {
      ...j,
      reviewDecision,
      clientSafeSummary,
      adminReviewStatus: admin.status,
      adminReviewerNote: admin.reviewerNote,
      adminReviewedAt: admin.reviewedAt,
      adminReviewedBy: admin.reviewedBy,
      manualReviewReason:
        admin.status === "PENDING"
          ? j.manualReviewReason ?? "Ожидает решения аналитика."
          : admin.status === "NEEDS_MORE_SOURCES"
            ? "Требуются дополнительные источники."
            : j.manualReviewReason,
      flags:
        admin.status === "APPROVED_WITH_CAVEAT" && admin.caveatText
          ? [...j.flags.filter((f) => f !== "admin_caveated"), "admin_caveated"]
          : j.flags,
    };
  });

  return { judgments: updated, blockedOverrides };
}
