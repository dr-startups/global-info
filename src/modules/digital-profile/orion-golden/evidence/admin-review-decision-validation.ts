/**
 * R10.8 — Shared validation for admin review decisions (server + UI).
 */

import type { AdminReviewStatus } from "./admin-review-decision";

export type AdminDecisionValidationInput = {
  status: AdminReviewStatus;
  reviewerNote?: string;
  caveatText?: string;
  requestedSources?: string[];
  /** When true, APPROVED on high-impact items is allowed after UI confirmation */
  highImpactAcknowledged?: boolean;
  isHighImpact?: boolean;
  /** Existing non-pending status — overwrite requires confirmation */
  existingStatus?: AdminReviewStatus;
  overwriteConfirmed?: boolean;
};

export type AdminDecisionValidationResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

export function validateAdminReviewDecisionInput(
  input: AdminDecisionValidationInput
): AdminDecisionValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (input.status === "APPROVED_WITH_CAVEAT" && !input.caveatText?.trim()) {
    errors.push("APPROVED_WITH_CAVEAT requires caveatText");
  }
  if (input.status === "NEEDS_MORE_SOURCES") {
    const hasSources = (input.requestedSources?.filter((s) => s.trim()).length ?? 0) > 0;
    if (!hasSources && !input.reviewerNote?.trim()) {
      errors.push("NEEDS_MORE_SOURCES requires requestedSources or reviewerNote");
    }
  }
  if (input.status === "WRONG_SUBJECT" && !input.reviewerNote?.trim()) {
    errors.push("WRONG_SUBJECT requires reviewerNote");
  }
  if (
    input.status === "APPROVED" &&
    input.isHighImpact &&
    !input.highImpactAcknowledged
  ) {
    errors.push("APPROVED on high-impact item requires explicit highImpactAcknowledged confirmation");
  }
  if (
    input.existingStatus &&
    input.existingStatus !== "PENDING" &&
    input.status !== input.existingStatus &&
    !input.overwriteConfirmed
  ) {
    errors.push("Overwriting an existing decision requires overwriteConfirmed");
  }

  if (input.status === "APPROVED") {
    warnings.push("APPROVED includes the item in client analysis as an approved finding.");
  }
  if (input.status === "APPROVED_WITH_CAVEAT") {
    warnings.push("APPROVED_WITH_CAVEAT будет включено в клиентский анализ только с оговоркой.");
  }
  if (input.status === "WRONG_SUBJECT") {
    warnings.push("WRONG_SUBJECT будет полностью исключён из клиентского анализа.");
  }
  if (input.status === "EXCLUDED") {
    warnings.push("EXCLUDED не попадёт в клиентский отчёт.");
  }
  if (input.status === "PENDING") {
    warnings.push("PENDING не используется как подтверждённый риск.");
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function isHighImpactManualReviewItem(input: {
  riskSignal?: string;
  flags?: string[];
  title?: string;
  sourceDomain?: string;
  groupReason?: string;
}): boolean {
  const flags = input.flags ?? [];
  const hay = `${input.title ?? ""} ${input.sourceDomain ?? ""}`.toLowerCase();
  if (flags.includes("compliance_db_potential_match") || flags.includes("high_impact_manual")) return true;
  if (flags.some((f) => f.startsWith("controversial:"))) return true;
  if (
    input.riskSignal === "COMPLIANCE_RELEVANT" ||
    input.riskSignal === "POSSIBLE_ADVERSE" ||
    input.riskSignal === "ADVERSE_CONFIRMED" ||
    input.riskSignal === "CONTROVERSIAL_DUAL_USE"
  ) {
    return true;
  }
  if (
    input.groupReason === "compliance_potential_match" ||
    input.groupReason === "court_legal_ambiguity" ||
    input.groupReason === "controversial_dual_use"
  ) {
    return true;
  }
  return /lexis|world[- ]?check|dow jones|watchlist|санкц|pep|rca|offshore|офшор|adverse/i.test(hay);
}
