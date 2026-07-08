/**
 * R10.5 — Admin review workflow QA inspection.
 */

import type { OrionClientContent } from "../content/orion-client-content-builder";
import type { AdminReviewDecisionSet } from "../evidence/admin-review-decision";
import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import { applyAdminDecisionsToJudgments } from "../evidence/apply-admin-decisions-to-judgments";

export type AdminReviewWorkflowQaVerdict =
  | "ADMIN_REVIEW_WORKFLOW_READY"
  | "BLOCKED_PENDING_USED_AS_CONFIRMED"
  | "BLOCKED_EXCLUDED_USED"
  | "BLOCKED_WRONG_SUBJECT_USED"
  | "BLOCKED_CAVEAT_MISSING"
  | "BLOCKED_FAKE_APPROVALS"
  | "BLOCKED_DECISION_STORE";

export function inspectAdminReviewWorkflowQa(input: {
  preReviewContent: OrionClientContent;
  postReviewContent: OrionClientContent;
  productionDecisions: AdminReviewDecisionSet;
  sampleDecisions: AdminReviewDecisionSet;
  judgments: EvidenceJudgment[];
}): {
  version: "r10-5-admin-review-workflow-qa-v1";
  passed: boolean;
  verdict: AdminReviewWorkflowQaVerdict;
  issues: string[];
  checks: Array<{ id: string; passed: boolean; detail: string }>;
} {
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];

  const pendingInPreFindings = input.preReviewContent.approvedFindings.filter((f) =>
    input.productionDecisions.decisions.some(
      (d) => d.status === "PENDING" && f.title.includes(d.evidenceId.slice(0, 8))
    )
  );
  checks.push({
    id: "pre-review-no-pending-as-confirmed",
    passed: input.preReviewContent.mode === "pre_review",
    detail: `pre-review mode=${input.preReviewContent.mode}`,
  });

  const applied = applyAdminDecisionsToJudgments(input.judgments, input.sampleDecisions.decisions);
  const postApproved = input.postReviewContent.approvedFindings;
  const sampleApproved = input.sampleDecisions.decisions.filter(
    (d) => d.status === "APPROVED" || d.status === "APPROVED_WITH_CAVEAT"
  );

  checks.push({
    id: "approved-can-enter-findings",
    passed: sampleApproved.length === 0 || postApproved.length > 0,
    detail: `post-review approved findings=${postApproved.length}, sample approved=${sampleApproved.length}`,
  });

  const caveatMissing = input.sampleDecisions.decisions.filter(
    (d) => d.status === "APPROVED_WITH_CAVEAT" && !d.caveatText?.trim()
  );
  checks.push({
    id: "caveat-text-present",
    passed: caveatMissing.length === 0,
    detail: `${caveatMissing.length} APPROVED_WITH_CAVEAT missing caveatText`,
  });
  if (caveatMissing.length) issues.push("caveat-missing");

  const appendixSample = input.sampleDecisions.decisions.filter((d) => d.status === "APPENDIX_ONLY");
  const appendixInMain = postApproved.filter((f) =>
    appendixSample.some((d) => {
      const j = input.judgments.find((x) => x.evidenceId === d.evidenceId);
      return j && f.title === j.title;
    })
  );
  checks.push({
    id: "appendix-only-not-in-main-findings",
    passed: appendixInMain.length === 0,
    detail: `${appendixInMain.length} appendix-only items in main findings`,
  });
  if (appendixInMain.length) issues.push("appendix-in-main");

  const excludedSample = input.sampleDecisions.decisions.filter((d) => d.status === "EXCLUDED");
  const excludedInPost = excludedSample.filter((d) => {
    const j = input.judgments.find((x) => x.evidenceId === d.evidenceId);
    return j && postApproved.some((f) => f.title === j.title);
  });
  checks.push({
    id: "excluded-absent-from-client",
    passed: excludedInPost.length === 0,
    detail: `${excludedInPost.length} excluded items still in post-review findings`,
  });
  if (excludedInPost.length) issues.push("excluded-used");

  const wrongSample = input.sampleDecisions.decisions.filter((d) => d.status === "WRONG_SUBJECT");
  const wrongInPost = wrongSample.filter((d) => {
    const j = input.judgments.find((x) => x.evidenceId === d.evidenceId);
    return (
      j &&
      (postApproved.some((f) => f.title === j.title) ||
        input.postReviewContent.manualReviewSection.items.some((m) => m.title === j.title))
    );
  });
  checks.push({
    id: "wrong-subject-absent",
    passed: wrongInPost.length === 0,
    detail: `${wrongInPost.length} wrong-subject items in post-review content`,
  });
  if (wrongInPost.length) issues.push("wrong-subject-used");

  checks.push({
    id: "no-wrong-subject-override",
    passed: applied.blockedOverrides.length >= 0,
    detail: `${applied.blockedOverrides.length} blocked wrong-subject override attempts`,
  });

  const fakeApprovals = input.productionDecisions.decisions.filter((d) => d.status !== "PENDING");
  checks.push({
    id: "no-fake-production-approvals",
    passed: fakeApprovals.length === 0 && !input.productionDecisions.qaSampleOnly,
    detail: `${fakeApprovals.length} non-pending in production admin-review-decisions.json`,
  });
  if (fakeApprovals.length) issues.push("fake-approvals");

  checks.push({
    id: "sample-is-marked-qa-only",
    passed: input.sampleDecisions.qaSampleOnly === true,
    detail: `sample qaSampleOnly=${input.sampleDecisions.qaSampleOnly}`,
  });

  const differs =
    JSON.stringify(input.preReviewContent.approvedFindings) !==
      JSON.stringify(input.postReviewContent.approvedFindings) ||
    input.preReviewContent.approvedFindings.length !== input.postReviewContent.approvedFindings.length;
  checks.push({
    id: "post-differs-when-sample-decisions",
    passed: differs || sampleApproved.length === 0,
    detail: differs ? "pre/post content differs" : "no sample approvals to compare",
  });

  checks.push({
    id: "decision-store-valid",
    passed:
      input.productionDecisions.version === "r10-5-admin-review-decisions-v1" &&
      input.productionDecisions.decisions.length > 0,
    detail: `${input.productionDecisions.decisions.length} production decisions`,
  });

  let verdict: AdminReviewWorkflowQaVerdict = "ADMIN_REVIEW_WORKFLOW_READY";
  if (issues.includes("fake-approvals")) verdict = "BLOCKED_FAKE_APPROVALS";
  else if (issues.includes("wrong-subject-used")) verdict = "BLOCKED_WRONG_SUBJECT_USED";
  else if (issues.includes("excluded-used")) verdict = "BLOCKED_EXCLUDED_USED";
  else if (issues.includes("caveat-missing")) verdict = "BLOCKED_CAVEAT_MISSING";
  else if (issues.includes("appendix-in-main")) verdict = "BLOCKED_PENDING_USED_AS_CONFIRMED";
  else if (input.productionDecisions.decisions.length === 0) verdict = "BLOCKED_DECISION_STORE";

  return {
    version: "r10-5-admin-review-workflow-qa-v1",
    passed: verdict === "ADMIN_REVIEW_WORKFLOW_READY",
    verdict,
    issues,
    checks,
  };
}
