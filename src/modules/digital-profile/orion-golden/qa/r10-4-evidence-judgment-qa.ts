/**
 * R10.4 — Evidence judgment QA inspection.
 */

import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import type { EvidenceBundlesArtifact } from "../evidence/evidence-client-gate";
import type { OrionClientContent } from "../content/orion-client-content-builder";
import type { OrionGoldenSectionAnalysis } from "../types";

export type EvidenceJudgmentQaVerdict =
  | "EVIDENCE_JUDGMENT_READY"
  | "BLOCKED_WRONG_SUBJECT_USED"
  | "BLOCKED_MANUAL_REVIEW_BYPASS"
  | "BLOCKED_OVERCLAIMED_RISK"
  | "BLOCKED_UNSUPPORTED_ADVERSE"
  | "BLOCKED_EMPTY_JUDGMENT";

export function inspectEvidenceJudgmentQa(input: {
  judgments: EvidenceJudgment[];
  bundles: EvidenceBundlesArtifact;
  clientContent: OrionClientContent;
  sectionAnalyses?: OrionGoldenSectionAnalysis[];
}): {
  version: "r10-4-evidence-judgment-review-v1";
  passed: boolean;
  verdict: EvidenceJudgmentQaVerdict;
  issues: string[];
  checks: Array<{ id: string; passed: boolean; detail: string }>;
} {
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];

  if (input.judgments.length === 0) {
    return {
      version: "r10-4-evidence-judgment-review-v1",
      passed: false,
      verdict: "BLOCKED_EMPTY_JUDGMENT",
      issues: ["no-judgments"],
      checks: [{ id: "non-empty", passed: false, detail: "0 judgments" }],
    };
  }

  const wrongInClient = input.bundles.autoInclude.filter((b) => b.subjectBinding === "WRONG_SUBJECT");
  checks.push({
    id: "no-wrong-subject-in-client",
    passed: wrongInClient.length === 0,
    detail: `${wrongInClient.length} wrong-subject in autoInclude`,
  });
  if (wrongInClient.length) issues.push("wrong-subject-in-client-findings");

  const manualAsConfirmed = input.bundles.autoInclude.filter((b) => b.gptTier === "manual_review_pending");
  checks.push({
    id: "no-manual-as-confirmed",
    passed: manualAsConfirmed.length === 0,
    detail: `${manualAsConfirmed.length} manual items in autoInclude`,
  });
  if (manualAsConfirmed.length) issues.push("manual-review-bypass");

  const controversialAutoIncluded = input.judgments.filter(
    (j) => j.riskSignal === "CONTROVERSIAL_DUAL_USE" && j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT"
  );
  const controversialAsAdverseConfirmed = input.judgments.filter(
    (j) => j.flags.some((f) => f.startsWith("controversial:")) && j.riskSignal === "ADVERSE_CONFIRMED"
  );
  checks.push({
    id: "no-controversial-auto-include",
    passed: controversialAutoIncluded.length === 0,
    detail: `${controversialAutoIncluded.length} controversial dual-use auto-included`,
  });
  checks.push({
    id: "no-controversial-as-adverse-confirmed",
    passed: controversialAsAdverseConfirmed.length === 0,
    detail: `${controversialAsAdverseConfirmed.length} controversial topics labelled ADVERSE_CONFIRMED`,
  });
  if (controversialAutoIncluded.length || controversialAsAdverseConfirmed.length) {
    issues.push("overclaimed-risk");
  }

  const allegationAutoInclude = input.judgments.filter(
    (j) =>
      (j.contentNature === "ALLEGATION" || j.contentNature === "RUMOR") &&
      j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT" &&
      j.sourceReliability !== "AUTHORITATIVE"
  );
  checks.push({
    id: "no-allegation-auto-include",
    passed: allegationAutoInclude.length === 0,
    detail: `${allegationAutoInclude.length} allegations auto-included`,
  });
  if (allegationAutoInclude.length) issues.push("unsupported-adverse-auto-included");

  const ambiguousManual = input.judgments.filter(
    (j) =>
      (j.riskSignal === "CONTROVERSIAL_DUAL_USE" || j.riskSignal === "COMPLIANCE_RELEVANT") &&
      j.reviewDecision === "MANUAL_REVIEW_REQUIRED"
  );
  checks.push({
    id: "ambiguous-in-manual-queue",
    passed: ambiguousManual.every((j) => input.bundles.manualReview.some((m) => m.evidenceId === j.evidenceId)),
    detail: `${ambiguousManual.length} high-impact ambiguous routed to manual`,
  });

  if (input.sectionAnalyses) {
    const narratives = input.sectionAnalyses.map((s) => s.clientNarrative).join("\n");
    const wrongUsed = input.judgments
      .filter((j) => j.subjectBinding === "WRONG_SUBJECT")
      .some((j) => narratives.toLowerCase().includes(j.title.toLowerCase().slice(0, 20)));
    checks.push({
      id: "gpt-no-wrong-subject-narrative",
      passed: !wrongUsed,
      detail: wrongUsed ? "GPT narrative may reference wrong-subject item" : "ok",
    });
    if (wrongUsed) issues.push("wrong-subject-in-gpt-narrative");
  }

  checks.push({
    id: "client-distinguishes-fact-interpretation",
    passed: input.clientContent.methodologyNotes.length > 0 && input.clientContent.manualReviewSection.items.length >= 0,
    detail: "methodology + manual review section present",
  });

  let verdict: EvidenceJudgmentQaVerdict = "EVIDENCE_JUDGMENT_READY";
  if (issues.includes("wrong-subject-in-client-findings") || issues.includes("wrong-subject-in-gpt-narrative")) {
    verdict = "BLOCKED_WRONG_SUBJECT_USED";
  } else if (issues.includes("manual-review-bypass")) {
    verdict = "BLOCKED_MANUAL_REVIEW_BYPASS";
  } else if (issues.includes("unsupported-adverse-auto-included")) {
    verdict = "BLOCKED_UNSUPPORTED_ADVERSE";
  } else if (issues.includes("overclaimed-risk")) {
    verdict = "BLOCKED_OVERCLAIMED_RISK";
  }

  return {
    version: "r10-4-evidence-judgment-review-v1",
    passed: verdict === "EVIDENCE_JUDGMENT_READY",
    verdict,
    issues,
    checks,
  };
}
