/**
 * R10.7a — Threshold & evidence classification tuning QA.
 */

import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import { isSafeNeutralAutoIncludeCandidate } from "../evidence/evidence-judgment";
import type { OrionClientContent } from "../content/orion-client-content-builder";
import type { SectionGptOrchestrationMeta } from "../sections/orion-section-analysis";

export type ThresholdTuningQaVerdict =
  | "THRESHOLD_TUNING_READY"
  | "BLOCKED_TOO_STRICT"
  | "BLOCKED_TOO_PERMISSIVE"
  | "BLOCKED_ADVERSE_AUTO_INCLUDED"
  | "BLOCKED_WEAK_BINDING_AUTO_INCLUDED"
  | "BLOCKED_SECTION_ASSEMBLY"
  | "BLOCKED_EXEC_RISK_INJECTION";

const HIGH_IMPACT: Array<EvidenceJudgment["riskSignal"]> = [
  "CONTROVERSIAL_DUAL_USE",
  "POSSIBLE_ADVERSE",
  "COMPLIANCE_RELEVANT",
  "ADVERSE_CONFIRMED",
];

export function inspectThresholdTuningQa(input: {
  judgments: EvidenceJudgment[];
  clientContent: OrionClientContent;
  orchestrationMeta?: SectionGptOrchestrationMeta;
  beforeAutoIncludeCount?: number;
}): {
  version: "r10-7a-threshold-tuning-qa-v1";
  passed: boolean;
  verdict: ThresholdTuningQaVerdict;
  issues: string[];
  checks: Array<{ id: string; passed: boolean; detail: string }>;
} {
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const auto = input.judgments.filter((j) => j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT");

  const adverseAuto = auto.filter((j) => HIGH_IMPACT.includes(j.riskSignal));
  checks.push({
    id: "no-adverse-auto-include",
    passed: adverseAuto.length === 0,
    detail: `${adverseAuto.length} high-impact auto-included`,
  });
  if (adverseAuto.length) issues.push("adverse-auto-included");

  const weakAuto = auto.filter((j) => j.subjectBinding === "WEAK" || j.subjectBinding === "UNKNOWN");
  checks.push({
    id: "no-weak-binding-auto-include",
    passed: weakAuto.length === 0,
    detail: `${weakAuto.length} weak/unknown binding auto-included`,
  });
  if (weakAuto.length) issues.push("weak-binding-auto-included");

  const allegationAuto = auto.filter(
    (j) => j.contentNature === "ALLEGATION" || j.contentNature === "OPINION" || j.contentNature === "RUMOR"
  );
  checks.push({
    id: "no-allegation-opinion-rumor-auto",
    passed: allegationAuto.length === 0,
    detail: `${allegationAuto.length} allegation/opinion/rumor auto-included`,
  });
  if (allegationAuto.length) issues.push("allegation-auto-included");

  const complianceDbAuto = auto.filter((j) => j.flags.includes("compliance_db_potential_match"));
  checks.push({
    id: "no-compliance-db-auto-include",
    passed: complianceDbAuto.length === 0,
    detail: `${complianceDbAuto.length} Lexis/DJ/WC potential matches auto-included`,
  });
  if (complianceDbAuto.length) issues.push("compliance-db-auto-included");

  const unsafeAuto = auto.filter((j) => !isSafeNeutralAutoIncludeCandidate(j));
  checks.push({
    id: "auto-include-matches-safe-rule",
    passed: unsafeAuto.length === 0,
    detail: `${unsafeAuto.length} auto-includes fail safe-neutral rule`,
  });
  if (unsafeAuto.length) issues.push("unsafe-auto-include");

  checks.push({
    id: "auto-include-gt-zero",
    passed: auto.length > 0,
    detail: `AUTO_INCLUDE_CLIENT_REPORT=${auto.length}`,
  });
  if (auto.length === 0) issues.push("still-too-strict");

  const findingsWithoutRefs = input.clientContent.approvedFindings.filter(
    (f) => !f.evidenceRefs?.length && !f.caveat
  );
  checks.push({
    id: "findings-have-evidence-refs",
    passed: findingsWithoutRefs.length === 0 || input.clientContent.approvedFindings.length === 0,
    detail: `${findingsWithoutRefs.length} findings without refs`,
  });

  const execSection = input.clientContent.sections?.find((s) => s.sectionId === "01_executive_summary");
  const riskSection = input.clientContent.sections?.find((s) => s.sectionId === "02_compliance_risk_matrix");
  checks.push({
    id: "exec-section-populated",
    passed: Boolean(execSection && execSection.status !== "DATA_POOR" && execSection.narrative.length > 80),
    detail: execSection ? `status=${execSection.status} len=${execSection.narrative.length}` : "missing",
  });
  if (!execSection || execSection.status === "DATA_POOR") issues.push("exec-injection-failed");

  checks.push({
    id: "risk-section-populated",
    passed: Boolean(riskSection && riskSection.status !== "DATA_POOR" && riskSection.narrative.length > 40),
    detail: riskSection ? `status=${riskSection.status} findings=${riskSection.keyFindings.length}` : "missing",
  });
  if (!riskSection || riskSection.status === "DATA_POOR") issues.push("risk-injection-failed");

  checks.push({
    id: "section-assembly",
    passed: input.clientContent.assemblySource === "section_analyses",
    detail: input.clientContent.assemblySource,
  });
  if (input.clientContent.assemblySource !== "section_analyses") issues.push("section-assembly");

  if (input.orchestrationMeta) {
    checks.push({
      id: "no-mega-prompt",
      passed: input.orchestrationMeta.megaPromptUsed === false,
      detail: `megaPromptUsed=${input.orchestrationMeta.megaPromptUsed}`,
    });
    if (input.orchestrationMeta.megaPromptUsed) issues.push("mega-prompt");
  }

  let verdict: ThresholdTuningQaVerdict = "THRESHOLD_TUNING_READY";
  if (issues.includes("adverse-auto-included") || issues.includes("allegation-auto-included") || issues.includes("compliance-db-auto-included")) {
    verdict = "BLOCKED_ADVERSE_AUTO_INCLUDED";
  } else if (issues.includes("weak-binding-auto-included") || issues.includes("unsafe-auto-include")) {
    verdict = "BLOCKED_WEAK_BINDING_AUTO_INCLUDED";
  } else if (issues.includes("exec-injection-failed") || issues.includes("risk-injection-failed")) {
    verdict = "BLOCKED_EXEC_RISK_INJECTION";
  } else if (issues.includes("section-assembly")) {
    verdict = "BLOCKED_SECTION_ASSEMBLY";
  } else if (issues.includes("still-too-strict")) {
    verdict = "BLOCKED_TOO_STRICT";
  } else if (auto.length > 200) {
    verdict = "BLOCKED_TOO_PERMISSIVE";
    issues.push("too-permissive");
  }

  return {
    version: "r10-7a-threshold-tuning-qa-v1",
    passed: verdict === "THRESHOLD_TUNING_READY",
    verdict,
    issues,
    checks,
  };
}
