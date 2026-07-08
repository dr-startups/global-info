/**
 * R10.6 — Section GPT orchestration QA.
 */

import { getClientAuditSections, getGptSectionAnalysisEntries, ORION_COMMERCIAL_SECTION_IDS } from "../sections/orion-section-registry";
import type { OrionSectionBundle } from "../sections/orion-section-bundle";
import type { OrionSectionAnalysis, SectionGptOrchestrationMeta } from "../sections/orion-section-analysis";
import type { ExecutiveSynthesisInput } from "../gpt/orion-executive-synthesis-from-sections";
import type { SectionDerivedRiskMatrix } from "../sections/orion-risk-matrix-from-sections";
import type { OrionClientContent } from "../content/orion-client-content-builder";

export type SectionGptOrchestrationQaVerdict =
  | "SECTION_GPT_ORCHESTRATION_READY"
  | "BLOCKED_GPT_SECTION_RUNTIME"
  | "SECTION_STRUCTURE_READY_GPT_RUNTIME_BLOCKED"
  | "BLOCKED_MEGA_PROMPT"
  | "BLOCKED_RAW_INVENTORY_TO_GPT"
  | "BLOCKED_WRONG_SUBJECT_IN_GPT_INPUT"
  | "BLOCKED_NOISE_IN_GPT_INPUT"
  | "BLOCKED_PENDING_MANUAL_REVIEW_CONFIRMED"
  | "BLOCKED_EXEC_SYNTHESIS_RAW_EVIDENCE"
  | "BLOCKED_RISK_MATRIX_RAW_EVIDENCE"
  | "BLOCKED_SECTION_EVIDENCE_MISMATCH"
  | "BLOCKED_CLIENT_CONTENT_NOT_SECTION_BASED"
  | "BLOCKED_COMMERCIAL_SECTIONS_IN_AUDIT_MODE";

export function inspectSectionGptOrchestrationQa(input: {
  sectionBundles: OrionSectionBundle[];
  sectionAnalyses: OrionSectionAnalysis[];
  orchestrationMeta: SectionGptOrchestrationMeta;
  executiveInput: ExecutiveSynthesisInput;
  riskMatrix: SectionDerivedRiskMatrix;
  clientContent: OrionClientContent;
}): {
  version: "r10-6-section-gpt-orchestration-qa-v1";
  passed: boolean;
  verdict: SectionGptOrchestrationQaVerdict;
  issues: string[];
  checks: Array<{ id: string; passed: boolean; detail: string }>;
} {
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];

  const registry = getClientAuditSections();
  checks.push({
    id: "registry-exists",
    passed: registry.length >= 40,
    detail: `${registry.length} canonical sections`,
  });

  const gptSections = getGptSectionAnalysisEntries().filter((s) =>
    input.sectionBundles.some((b) => b.sectionId === s.sectionId && b.applicable && b.dataSufficiency !== "NOT_APPLICABLE")
  );

  checks.push({
    id: "no-mega-prompt",
    passed: input.orchestrationMeta.megaPromptUsed === false,
    detail: `megaPromptUsed=${input.orchestrationMeta.megaPromptUsed}`,
  });
  if (input.orchestrationMeta.megaPromptUsed) issues.push("mega-prompt");

  checks.push({
    id: "gpt-call-count-matches",
    passed: input.orchestrationMeta.gptSectionCallCount === input.orchestrationMeta.gptSectionCallIds.length,
    detail: `${input.orchestrationMeta.gptSectionCallCount} GPT section calls`,
  });

  const applicableGptBundles = input.sectionBundles.filter(
    (b) =>
      b.analysisMode === "GPT_SECTION_ANALYSIS" &&
      b.applicable &&
      !(b.dataSufficiency === "INSUFFICIENT" && b.allowedEvidence.length === 0)
  );
  const sectionsRequiringGpt = applicableGptBundles.filter(
    (b) =>
      (b.dataSufficiency === "SUFFICIENT" || b.dataSufficiency === "LIMITED") && b.allowedEvidence.length > 0
  );
  const gptFailedFallback = input.orchestrationMeta.skippedSections.filter((s) => s.reason === "gpt_failed_fallback");

  checks.push({
    id: "gpt-calls-match-applicable-sections",
    passed: input.orchestrationMeta.gptSectionCallCount <= applicableGptBundles.length,
    detail: `calls=${input.orchestrationMeta.gptSectionCallCount} applicable=${applicableGptBundles.length}`,
  });

  checks.push({
    id: "gpt-runtime-success-required",
    passed: sectionsRequiringGpt.length === 0 || input.orchestrationMeta.gptSectionCallCount > 0,
    detail: `requiringGpt=${sectionsRequiringGpt.length} successful=${input.orchestrationMeta.gptSectionCallCount}`,
  });
  if (sectionsRequiringGpt.length > 0 && input.orchestrationMeta.gptSectionCallCount === 0) {
    issues.push("gpt-runtime-zero-success");
  }

  checks.push({
    id: "no-gpt-fallback-failures",
    passed: gptFailedFallback.length === 0,
    detail: `${gptFailedFallback.length} gpt_failed_fallback sections`,
  });
  if (gptFailedFallback.length > 0) issues.push("gpt-failed-fallback");

  let wrongSubjectInInput = 0;
  let noiseInAllowed = 0;
  for (const bundle of input.sectionBundles) {
    for (const e of bundle.allowedEvidence) {
      if (e.reviewDecision === "EXCLUDE_WRONG_SUBJECT" || e.subjectBinding === "WRONG_SUBJECT") wrongSubjectInInput += 1;
      if (e.reviewDecision === "EXCLUDE_NOISE") noiseInAllowed += 1;
    }
  }
  checks.push({
    id: "no-wrong-subject-in-gpt-input",
    passed: wrongSubjectInInput === 0,
    detail: `${wrongSubjectInInput} wrong-subject in allowedEvidence`,
  });
  if (wrongSubjectInInput) issues.push("wrong-subject-in-input");

  checks.push({
    id: "no-noise-in-gpt-input",
    passed: noiseInAllowed === 0,
    detail: `${noiseInAllowed} noise in allowedEvidence`,
  });
  if (noiseInAllowed) issues.push("noise-in-input");

  const pendingAsConfirmed = input.sectionAnalyses.flatMap((a) =>
    a.keyFindings.filter(
      (f) => !f.caveat && a.status === "MANUAL_REVIEW_PENDING" && f.summary && !f.summary.includes("Требует")
    )
  );
  checks.push({
    id: "no-pending-as-confirmed",
    passed: pendingAsConfirmed.length === 0,
    detail: `${pendingAsConfirmed.length} pending promoted as confirmed`,
  });
  if (pendingAsConfirmed.length) issues.push("pending-confirmed");

  const execRaw = JSON.stringify(input.executiveInput);
  checks.push({
    id: "exec-no-raw-inventory",
    passed: !execRaw.includes("full-evidence-inventory") && !execRaw.includes('"items":'),
    detail: "executive input is section summaries only",
  });
  if (execRaw.includes('"items":')) issues.push("exec-raw-inventory");

  checks.push({
    id: "risk-matrix-section-derived",
    passed: input.riskMatrix.inputSource === "section_analyses_only",
    detail: input.riskMatrix.inputSource,
  });

  checks.push({
    id: "client-content-section-based",
    passed: input.clientContent.assemblySource === "section_analyses" && (input.clientContent.sections?.length ?? 0) > 0,
    detail: `assemblySource=${input.clientContent.assemblySource} sections=${input.clientContent.sections?.length ?? 0}`,
  });
  if (input.clientContent.assemblySource !== "section_analyses") issues.push("not-section-based");

  const commercialInContent = (input.clientContent.sections ?? []).some((s) =>
    ORION_COMMERCIAL_SECTION_IDS.some((c) => s.sectionId.includes(c))
  );
  checks.push({
    id: "no-commercial-sections",
    passed: !commercialInContent,
    detail: commercialInContent ? "commercial sections found" : "ok",
  });
  if (commercialInContent) issues.push("commercial-in-audit");

  const findingsWithoutRefs = input.clientContent.approvedFindings.filter(
    (f) => !f.evidenceRefs?.length && !f.caveat
  );
  checks.push({
    id: "findings-have-evidence-or-caveat",
    passed: findingsWithoutRefs.length === 0 || input.clientContent.approvedFindings.length === 0,
    detail: `${findingsWithoutRefs.length} findings without refs`,
  });

  let verdict: SectionGptOrchestrationQaVerdict = "SECTION_GPT_ORCHESTRATION_READY";
  if (issues.includes("mega-prompt")) verdict = "BLOCKED_MEGA_PROMPT";
  else if (issues.includes("wrong-subject-in-input")) verdict = "BLOCKED_WRONG_SUBJECT_IN_GPT_INPUT";
  else if (issues.includes("noise-in-input")) verdict = "BLOCKED_NOISE_IN_GPT_INPUT";
  else if (issues.includes("pending-confirmed")) verdict = "BLOCKED_PENDING_MANUAL_REVIEW_CONFIRMED";
  else if (issues.includes("exec-raw-inventory")) verdict = "BLOCKED_EXEC_SYNTHESIS_RAW_EVIDENCE";
  else if (input.riskMatrix.inputSource !== "section_analyses_only") verdict = "BLOCKED_RISK_MATRIX_RAW_EVIDENCE";
  else if (issues.includes("not-section-based")) verdict = "BLOCKED_CLIENT_CONTENT_NOT_SECTION_BASED";
  else if (issues.includes("commercial-in-audit")) verdict = "BLOCKED_COMMERCIAL_SECTIONS_IN_AUDIT_MODE";
  else if (issues.includes("gpt-runtime-zero-success") || issues.includes("gpt-failed-fallback")) {
    const structuralOk =
      !issues.includes("wrong-subject-in-input") &&
      !issues.includes("noise-in-input") &&
      !issues.includes("pending-confirmed") &&
      !issues.includes("exec-raw-inventory") &&
      input.riskMatrix.inputSource === "section_analyses_only" &&
      !issues.includes("not-section-based") &&
      !issues.includes("commercial-in-audit");
    verdict = structuralOk ? "SECTION_STRUCTURE_READY_GPT_RUNTIME_BLOCKED" : "BLOCKED_GPT_SECTION_RUNTIME";
  }

  return {
    version: "r10-6-section-gpt-orchestration-qa-v1",
    passed: verdict === "SECTION_GPT_ORCHESTRATION_READY",
    verdict,
    issues,
    checks,
  };
}
