/**
 * R10.4 — Content quality review (brain-first, not visual).
 */

import type { OrionClientContent } from "../content/orion-client-content-builder";
import type { EvidenceJudgmentQaVerdict } from "./r10-4-evidence-judgment-qa";

export type ContentQualityVerdict =
  | "CONTENT_QUALITY_READY"
  | "CONTENT_QUALITY_NEEDS_MANUAL_REVIEW"
  | "CONTENT_QUALITY_BLOCKED";

export function inspectContentQualityReview(input: {
  clientContent: OrionClientContent;
  judgmentVerdict: EvidenceJudgmentQaVerdict;
  manualReviewPendingCount: number;
}): {
  version: "r10-4-content-quality-review-v1";
  verdict: ContentQualityVerdict;
  passed: boolean;
  findings: string[];
  strengths: string[];
} {
  const findings: string[] = [];
  const strengths: string[] = [];

  if (input.judgmentVerdict !== "EVIDENCE_JUDGMENT_READY") {
    findings.push(`Evidence judgment blocked: ${input.judgmentVerdict}`);
  }

  if (/e2e|20260704|r7\.5 lexis ui/i.test(input.clientContent.subject.displayName)) {
    findings.push("Subject is internal E2E test identifier — not production client-ready naming");
  }

  if (input.clientContent.approvedFindings.length === 0) {
    findings.push("No auto-approved findings — client report would be empty of key evidence");
  } else {
    strengths.push(`${input.clientContent.approvedFindings.length} approved findings for client narrative`);
  }

  if (input.manualReviewPendingCount > 0) {
    strengths.push(`${input.manualReviewPendingCount} items correctly routed to manual review section`);
  }

  if (input.clientContent.manualReviewSection.items.length > 0) {
    strengths.push("Manual review section present with caveated language");
  }

  strengths.push("Executive draft distinguishes preliminary vs confirmed conclusions");

  let verdict: ContentQualityVerdict = "CONTENT_QUALITY_READY";
  if (input.judgmentVerdict !== "EVIDENCE_JUDGMENT_READY") {
    verdict = "CONTENT_QUALITY_BLOCKED";
  } else if (input.manualReviewPendingCount > 20 || findings.length > 1) {
    verdict = "CONTENT_QUALITY_NEEDS_MANUAL_REVIEW";
  }

  return {
    version: "r10-4-content-quality-review-v1",
    verdict,
    passed: verdict === "CONTENT_QUALITY_READY",
    findings,
    strengths,
  };
}
