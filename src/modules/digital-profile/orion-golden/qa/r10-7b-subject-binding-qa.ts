/**
 * R10.7b — Subject binding QA inspection.
 */

import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import type { OrionClientContent } from "../content/orion-client-content-builder";
import type { SubjectIdentityProfile } from "../identity/subject-identity-profile";
import type { SectionGptOrchestrationMeta } from "../sections/orion-section-analysis";
import type { OrionSectionBundle } from "../sections/orion-section-bundle";

export type SubjectBindingQaVerdict =
  | "SUBJECT_BINDING_READY"
  | "SUBJECT_BINDING_IMPROVED_STILL_LIMITED"
  | "BLOCKED_UNKNOWN_TOO_HIGH"
  | "BLOCKED_WRONG_SUBJECT_USED"
  | "BLOCKED_PATRONYMIC_MISMATCH_CONFIRMED"
  | "BLOCKED_RISKY_UNKNOWN_AUTO_INCLUDED"
  | "BLOCKED_IDENTITY_SAFETY_REGRESSION";

export type SubjectBindingBaseline = {
  CONFIRMED?: number;
  LIKELY?: number;
  WEAK?: number;
  WRONG_SUBJECT?: number;
  UNKNOWN?: number;
};

const HIGH_IMPACT = new Set([
  "CONTROVERSIAL_DUAL_USE",
  "POSSIBLE_ADVERSE",
  "COMPLIANCE_RELEVANT",
  "ADVERSE_CONFIRMED",
]);

function countBindings(judgments: EvidenceJudgment[]): Record<string, number> {
  return judgments.reduce<Record<string, number>>((acc, j) => {
    acc[j.subjectBinding] = (acc[j.subjectBinding] ?? 0) + 1;
    return acc;
  }, {});
}

export function inspectSubjectBindingQa(input: {
  judgments: EvidenceJudgment[];
  clientContent: OrionClientContent;
  identityProfile?: SubjectIdentityProfile;
  sectionBundles?: OrionSectionBundle[];
  orchestrationMeta?: SectionGptOrchestrationMeta;
  /** R10.7a baseline binding counts */
  baseline?: SubjectBindingBaseline;
}): {
  version: "r10-7b-subject-binding-qa-v1";
  passed: boolean;
  verdict: SubjectBindingQaVerdict;
  issues: string[];
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  subjectBindingCounts: Record<string, number>;
  baseline?: SubjectBindingBaseline;
  deltas?: Record<string, number>;
} {
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const counts = countBindings(input.judgments);
  const baseline = input.baseline ?? {
    CONFIRMED: 81,
    LIKELY: 86,
    WEAK: 0,
    WRONG_SUBJECT: 0,
    UNKNOWN: 561,
  };

  const deltas: Record<string, number> = {};
  for (const key of ["CONFIRMED", "LIKELY", "WEAK", "WRONG_SUBJECT", "UNKNOWN"] as const) {
    deltas[key] = (counts[key] ?? 0) - (baseline[key] ?? 0);
  }

  const unknown = counts.UNKNOWN ?? 0;
  const confirmed = counts.CONFIRMED ?? 0;
  const likely = counts.LIKELY ?? 0;
  const wrong = counts.WRONG_SUBJECT ?? 0;
  const total = input.judgments.length || 1;
  const unknownShare = unknown / total;

  checks.push({
    id: "unknown-decreased",
    passed: unknown < (baseline.UNKNOWN ?? Number.MAX_SAFE_INTEGER),
    detail: `UNKNOWN ${baseline.UNKNOWN ?? "?"} → ${unknown} (Δ ${deltas.UNKNOWN})`,
  });
  if (!(unknown < (baseline.UNKNOWN ?? Number.MAX_SAFE_INTEGER))) issues.push("unknown-not-decreased");

  checks.push({
    id: "confirmed-or-likely-increased",
    passed:
      confirmed + likely > (baseline.CONFIRMED ?? 0) + (baseline.LIKELY ?? 0) ||
      unknown < (baseline.UNKNOWN ?? 0) * 0.85,
    detail: `CONFIRMED+LIKELY ${(baseline.CONFIRMED ?? 0) + (baseline.LIKELY ?? 0)} → ${confirmed + likely}`,
  });

  const wrongInClient = input.clientContent.approvedFindings.filter((f) => {
    const id = f.evidenceId ?? f.evidenceRefs?.[0];
    if (!id) return false;
    const j = input.judgments.find((x) => x.evidenceId === id);
    return j?.subjectBinding === "WRONG_SUBJECT";
  });
  checks.push({
    id: "no-wrong-subject-in-findings",
    passed: wrongInClient.length === 0,
    detail: `${wrongInClient.length} wrong-subject in approved findings`,
  });
  if (wrongInClient.length) issues.push("wrong-subject-used");

  const wrongInGpt = (input.sectionBundles ?? []).flatMap((b) =>
    b.allowedEvidence.filter((e) => e.subjectBinding === "WRONG_SUBJECT" || e.reviewDecision === "EXCLUDE_WRONG_SUBJECT")
  );
  checks.push({
    id: "no-wrong-subject-in-gpt-input",
    passed: wrongInGpt.length === 0,
    detail: `${wrongInGpt.length} wrong-subject in section allowedEvidence`,
  });
  if (wrongInGpt.length) issues.push("wrong-subject-in-gpt");

  const patronymicConfirmed = input.judgments.filter(
    (j) =>
      j.subjectBinding === "CONFIRMED" &&
      (j.flags.includes("patronymic_mismatch") ||
        j.subjectBindingNegativeSignals?.some((s) => s.startsWith("patronymic_mismatch")))
  );
  checks.push({
    id: "no-patronymic-mismatch-confirmed",
    passed: patronymicConfirmed.length === 0,
    detail: `${patronymicConfirmed.length} patronymic-mismatch marked CONFIRMED`,
  });
  if (patronymicConfirmed.length) issues.push("patronymic-confirmed");

  const innConfirmed = input.judgments.filter(
    (j) => j.flags.includes("exact_inn_match") && j.subjectBinding !== "CONFIRMED" && j.subjectBinding !== "LIKELY"
  );
  checks.push({
    id: "exact-inn-strong-binding",
    passed: innConfirmed.length === 0,
    detail: `${innConfirmed.length} exact INN without CONFIRMED/LIKELY`,
  });

  const riskyUnknownAuto = input.judgments.filter(
    (j) =>
      j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT" &&
      (j.subjectBinding === "UNKNOWN" || j.subjectBinding === "WEAK" || HIGH_IMPACT.has(j.riskSignal))
  );
  checks.push({
    id: "no-risky-unknown-auto-include",
    passed: riskyUnknownAuto.length === 0,
    detail: `${riskyUnknownAuto.length} unsafe auto-includes`,
  });
  if (riskyUnknownAuto.length) issues.push("risky-unknown-auto");

  const confirmedAdverseManual = input.judgments.filter(
    (j) =>
      j.subjectBinding === "CONFIRMED" &&
      HIGH_IMPACT.has(j.riskSignal) &&
      j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT"
  );
  checks.push({
    id: "confirmed-adverse-not-auto",
    passed: confirmedAdverseManual.length === 0,
    detail: `${confirmedAdverseManual.length} CONFIRMED high-impact auto-included`,
  });
  if (confirmedAdverseManual.length) issues.push("identity-safety-regression");

  if (input.orchestrationMeta) {
    checks.push({
      id: "no-mega-prompt",
      passed: input.orchestrationMeta.megaPromptUsed === false,
      detail: `megaPromptUsed=${input.orchestrationMeta.megaPromptUsed}`,
    });
  }

  checks.push({
    id: "unknown-share-not-extreme",
    passed: unknownShare < 0.85,
    detail: `UNKNOWN share=${(unknownShare * 100).toFixed(1)}%`,
  });
  if (unknownShare >= 0.85) issues.push("unknown-too-high");

  let verdict: SubjectBindingQaVerdict = "SUBJECT_BINDING_READY";
  if (issues.includes("wrong-subject-used") || issues.includes("wrong-subject-in-gpt")) {
    verdict = "BLOCKED_WRONG_SUBJECT_USED";
  } else if (issues.includes("patronymic-confirmed")) {
    verdict = "BLOCKED_PATRONYMIC_MISMATCH_CONFIRMED";
  } else if (issues.includes("risky-unknown-auto") || issues.includes("identity-safety-regression")) {
    verdict = "BLOCKED_IDENTITY_SAFETY_REGRESSION";
  } else if (issues.includes("unknown-too-high")) {
    verdict = "BLOCKED_UNKNOWN_TOO_HIGH";
  } else if (issues.includes("unknown-not-decreased") || unknownShare > 0.55) {
    verdict = "SUBJECT_BINDING_IMPROVED_STILL_LIMITED";
  } else if ((deltas.UNKNOWN ?? 0) < 0 && confirmed + likely > (baseline.CONFIRMED ?? 0) + (baseline.LIKELY ?? 0) - 5) {
    verdict = "SUBJECT_BINDING_READY";
  } else if ((deltas.UNKNOWN ?? 0) < 0) {
    verdict = "SUBJECT_BINDING_IMPROVED_STILL_LIMITED";
  }

  const passed =
    verdict === "SUBJECT_BINDING_READY" || verdict === "SUBJECT_BINDING_IMPROVED_STILL_LIMITED";

  return {
    version: "r10-7b-subject-binding-qa-v1",
    passed,
    verdict,
    issues,
    checks,
    subjectBindingCounts: counts,
    baseline,
    deltas,
  };
}
