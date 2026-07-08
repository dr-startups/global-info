/**
 * R10.7c — Section content polish QA.
 */

import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import type { OrionClientContent } from "../content/orion-client-content-builder";
import type { SectionGptOrchestrationMeta } from "../sections/orion-section-analysis";
import type { OrionSectionBundle } from "../sections/orion-section-bundle";
import { isSafeNeutralAutoIncludeCandidate } from "../evidence/evidence-judgment";

export type SectionContentPolishVerdict =
  | "SECTION_CONTENT_POLISH_READY"
  | "STILL_TOO_GENERIC"
  | "BLOCKED_DUPLICATE_FINDINGS"
  | "BLOCKED_EMPTY_SECTION_SPAM"
  | "BLOCKED_RISK_MATRIX_TOO_NOISY"
  | "BLOCKED_SAFETY_REGRESSION";

const HIGH_IMPACT = new Set([
  "CONTROVERSIAL_DUAL_USE",
  "POSSIBLE_ADVERSE",
  "COMPLIANCE_RELEVANT",
  "ADVERSE_CONFIRMED",
]);

export function inspectSectionContentPolishQa(input: {
  judgments: EvidenceJudgment[];
  clientContent: OrionClientContent;
  sectionBundles?: OrionSectionBundle[];
  orchestrationMeta?: SectionGptOrchestrationMeta;
  /** R10.7b baseline client metrics (optional) */
  baseline?: {
    sectionsRendered?: number;
    riskMatrixRows?: number;
    approvedFindings?: number;
    clientContentChars?: number;
  };
}): {
  version: "r10-7c-section-content-polish-qa-v1";
  passed: boolean;
  verdict: SectionContentPolishVerdict;
  issues: string[];
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  metrics: {
    sectionsRendered: number;
    sectionsCollapsedDataPoor: number;
    registryClusters: number;
    duplicateFindingsRemoved: number;
    riskMatrixRowsBefore: number;
    riskMatrixRowsAfter: number;
    manualReviewGroups: number;
    recommendationsCount: number;
    approvedFindings: number;
    clientContentChars: number;
  };
} {
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const polish = input.clientContent.contentPolish;
  const sectionsRendered = polish?.sectionsRendered ?? input.clientContent.sections?.length ?? 0;
  const collapsed = polish?.sectionsCollapsedDataPoor ?? 0;
  const riskBefore = polish?.riskMatrixRowsBefore ?? input.clientContent.riskMatrixSummary?.rows.length ?? 0;
  const riskAfter = polish?.riskMatrixRowsAfter ?? input.clientContent.riskMatrixSummary?.rows.length ?? 0;
  const approved = input.clientContent.approvedFindings.length;
  const clientChars = JSON.stringify(input.clientContent).length;

  const metrics = {
    sectionsRendered,
    sectionsCollapsedDataPoor: collapsed,
    registryClusters: polish?.registryClusters ?? input.clientContent.evidenceClusters?.filter((c) => c.identityAnchor?.inn).length ?? 0,
    duplicateFindingsRemoved: polish?.duplicateFindingsRemoved ?? 0,
    riskMatrixRowsBefore: riskBefore,
    riskMatrixRowsAfter: riskAfter,
    manualReviewGroups: polish?.manualReviewGroups ?? input.clientContent.manualReviewGroups?.length ?? 0,
    recommendationsCount: polish?.recommendationsCount ?? input.clientContent.recommendations?.length ?? 0,
    approvedFindings: approved,
    clientContentChars: clientChars,
  };

  // Safety
  const highImpactAuto = input.judgments.filter(
    (j) => j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT" && HIGH_IMPACT.has(j.riskSignal)
  );
  checks.push({
    id: "no-high-impact-auto-include",
    passed: highImpactAuto.length === 0,
    detail: `${highImpactAuto.length} high-impact auto-included`,
  });
  if (highImpactAuto.length) issues.push("safety-regression");

  const unsafeAuto = input.judgments.filter(
    (j) => j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT" && !isSafeNeutralAutoIncludeCandidate(j)
  );
  checks.push({
    id: "auto-include-still-safe-neutral",
    passed: unsafeAuto.length === 0,
    detail: `${unsafeAuto.length} auto-includes fail safe-neutral rule`,
  });
  if (unsafeAuto.length) issues.push("safety-regression");

  const wrongInFindings = input.clientContent.approvedFindings.filter((f) => {
    const id = f.evidenceId ?? f.evidenceRefs?.[0];
    if (!id) return false;
    const j = input.judgments.find((x) => x.evidenceId === id);
    return j?.subjectBinding === "WRONG_SUBJECT";
  });
  checks.push({
    id: "no-wrong-subject-in-findings",
    passed: wrongInFindings.length === 0,
    detail: `${wrongInFindings.length} WRONG_SUBJECT in approved findings`,
  });
  if (wrongInFindings.length) issues.push("safety-regression");

  const wrongInGpt = (input.sectionBundles ?? []).flatMap((b) =>
    b.allowedEvidence.filter((e) => e.subjectBinding === "WRONG_SUBJECT")
  );
  checks.push({
    id: "no-wrong-subject-in-gpt",
    passed: wrongInGpt.length === 0,
    detail: `${wrongInGpt.length} WRONG_SUBJECT in GPT allowedEvidence`,
  });
  if (wrongInGpt.length) issues.push("safety-regression");

  const weakRiskyConfirmed = input.clientContent.approvedFindings.filter((f) => {
    const id = f.evidenceId ?? f.evidenceRefs?.[0];
    if (!id) return false;
    const j = input.judgments.find((x) => x.evidenceId === id);
    return (
      j &&
      (j.subjectBinding === "WEAK" || j.subjectBinding === "UNKNOWN") &&
      HIGH_IMPACT.has(j.riskSignal)
    );
  });
  checks.push({
    id: "no-weak-risky-as-confirmed-finding",
    passed: weakRiskyConfirmed.length === 0,
    detail: `${weakRiskyConfirmed.length} weak/unknown risky in approved findings`,
  });
  if (weakRiskyConfirmed.length) issues.push("safety-regression");

  if (input.orchestrationMeta) {
    checks.push({
      id: "no-mega-prompt",
      passed: input.orchestrationMeta.megaPromptUsed === false,
      detail: `megaPromptUsed=${input.orchestrationMeta.megaPromptUsed}`,
    });
  }

  checks.push({
    id: "orion-order-preserved",
    passed: (input.clientContent.sections ?? []).every(
      (s, i, arr) => i === 0 || s.order >= (arr[i - 1]?.order ?? 0)
    ),
    detail: `sections=${sectionsRendered}`,
  });
  if (
    !(input.clientContent.sections ?? []).every((s, i, arr) => i === 0 || s.order >= (arr[i - 1]?.order ?? 0))
  ) {
    issues.push("too-generic");
  }

  // Polish quality
  checks.push({
    id: "data-poor-collapsed",
    passed: collapsed >= 3 || sectionsRendered <= 28,
    detail: `collapsed=${collapsed} rendered=${sectionsRendered}`,
  });
  if (!(collapsed >= 3 || sectionsRendered <= 28)) issues.push("empty-section-spam");

  checks.push({
    id: "risk-matrix-compact",
    passed: riskAfter <= 18 && (riskBefore === 0 || riskAfter <= riskBefore),
    detail: `risk rows ${riskBefore} → ${riskAfter}`,
  });
  if (!(riskAfter <= 18)) issues.push("risk-matrix-noisy");

  const titles = input.clientContent.approvedFindings.map((f) => f.title.slice(0, 50).toLowerCase());
  const dupTitleCount = titles.length - new Set(titles).size;
  checks.push({
    id: "findings-deduped",
    passed: dupTitleCount <= 2,
    detail: `near-duplicate titles=${dupTitleCount}, duplicatesRemoved=${metrics.duplicateFindingsRemoved}`,
  });
  if (dupTitleCount > 2) issues.push("duplicate-findings");

  checks.push({
    id: "registry-clusters-present",
    passed: metrics.registryClusters >= 1 || metrics.duplicateFindingsRemoved >= 0,
    detail: `registryClusters=${metrics.registryClusters}`,
  });

  checks.push({
    id: "recommendations-specific",
    passed: metrics.recommendationsCount >= 2,
    detail: `recommendations=${metrics.recommendationsCount}`,
  });
  if (metrics.recommendationsCount < 2) issues.push("too-generic");

  checks.push({
    id: "manual-review-grouped",
    passed: metrics.manualReviewGroups >= 1 || input.judgments.filter((j) => j.reviewDecision === "MANUAL_REVIEW_REQUIRED").length === 0,
    detail: `manualReviewGroups=${metrics.manualReviewGroups}`,
  });

  let verdict: SectionContentPolishVerdict = "SECTION_CONTENT_POLISH_READY";
  if (issues.includes("safety-regression")) verdict = "BLOCKED_SAFETY_REGRESSION";
  else if (issues.includes("duplicate-findings")) verdict = "BLOCKED_DUPLICATE_FINDINGS";
  else if (issues.includes("empty-section-spam")) verdict = "BLOCKED_EMPTY_SECTION_SPAM";
  else if (issues.includes("risk-matrix-noisy")) verdict = "BLOCKED_RISK_MATRIX_TOO_NOISY";
  else if (issues.includes("too-generic")) verdict = "STILL_TOO_GENERIC";
  else if (collapsed < 1 && metrics.recommendationsCount < 3) verdict = "STILL_TOO_GENERIC";

  return {
    version: "r10-7c-section-content-polish-qa-v1",
    passed: verdict === "SECTION_CONTENT_POLISH_READY" || verdict === "STILL_TOO_GENERIC",
    verdict,
    issues,
    checks,
    metrics,
  };
}
