/**
 * R10.4 — Evidence judgment model and deterministic review routing.
 * Independent from rendering; GPT proposes, policy decides.
 */

import type { AdminReviewStatus } from "./admin-review-decision";

export type { AdminReviewStatus };

export type SubjectBinding = "CONFIRMED" | "LIKELY" | "WEAK" | "WRONG_SUBJECT" | "UNKNOWN";

export type JudgmentRelevanceClass =
  | "STRONG_RELEVANT"
  | "RELEVANT"
  | "POTENTIALLY_RELEVANT"
  | "LOW_RELEVANCE"
  | "NOISE";

export type SourceReliability =
  | "AUTHORITATIVE"
  | "PUBLIC_REGISTRY"
  | "BUSINESS_REGISTRY_AGGREGATOR"
  | "REPUTABLE_MEDIA"
  | "SOCIAL_MEDIA"
  | "BLOG_FORUM"
  | "MARKETPLACE"
  | "UNKNOWN";

export type ContentNature =
  | "FACT"
  | "ALLEGATION"
  | "OPINION"
  | "RUMOR"
  | "ADVERTISEMENT"
  | "PROFILE_PAGE"
  | "DUPLICATE"
  | "TECHNICAL_PAGE";

export type RiskSignal =
  | "NO_RISK_SIGNAL"
  | "POSITIVE_SIGNAL"
  | "NEUTRAL_CONTEXT"
  | "POSSIBLE_ADVERSE"
  | "ADVERSE_CONFIRMED"
  | "COMPLIANCE_RELEVANT"
  | "CONTROVERSIAL_DUAL_USE"
  | "INSUFFICIENT_CONTEXT";

export type ReviewDecision =
  | "AUTO_INCLUDE_CLIENT_REPORT"
  | "APPENDIX_ONLY"
  | "EXCLUDE_NOISE"
  | "EXCLUDE_WRONG_SUBJECT"
  | "MANUAL_REVIEW_REQUIRED";

export type RecommendedAdminAction =
  | "APPROVE_FOR_REPORT"
  | "APPROVE_AS_CAVEATED"
  | "KEEP_APPENDIX_ONLY"
  | "EXCLUDE"
  | "REQUEST_MORE_SOURCES"
  | "MARK_WRONG_SUBJECT";

export type EvidenceJudgment = {
  evidenceId: string;
  title: string;
  url?: string;
  sourceDomain?: string;

  subjectBinding: SubjectBinding;
  relevance: JudgmentRelevanceClass;
  sourceReliability: SourceReliability;
  contentNature: ContentNature;
  riskSignal: RiskSignal;
  reviewDecision: ReviewDecision;

  confidence: number;

  clientSafeSummary: string;
  whyRelevant: string;
  whyRiskyOrNot: string;

  alternativeInterpretations: string[];
  evidenceForRisk: string[];
  evidenceAgainstRisk: string[];

  manualReviewReason?: string;
  recommendedAdminAction: RecommendedAdminAction;

  flags: string[];

  adminReviewStatus: AdminReviewStatus;
  adminReviewerNote?: string;
  adminReviewedAt?: string;
  adminReviewedBy?: string;
};

/** Trusted sources eligible for safe neutral auto-include (not adverse authority). */
const SAFE_AUTO_INCLUDE_SOURCES: SourceReliability[] = [
  "AUTHORITATIVE",
  "PUBLIC_REGISTRY",
  "BUSINESS_REGISTRY_AGGREGATOR",
  "REPUTABLE_MEDIA",
];

const AUTHORITATIVE_SOURCES: SourceReliability[] = SAFE_AUTO_INCLUDE_SOURCES;

const SAFE_NEUTRAL_RISKS: RiskSignal[] = ["NO_RISK_SIGNAL", "NEUTRAL_CONTEXT", "POSITIVE_SIGNAL"];

const SAFE_CONTENT_NATURES: ContentNature[] = ["FACT", "PROFILE_PAGE"];

function isHighImpactRisk(signal: RiskSignal): boolean {
  return (
    signal === "POSSIBLE_ADVERSE" ||
    signal === "ADVERSE_CONFIRMED" ||
    signal === "COMPLIANCE_RELEVANT" ||
    signal === "CONTROVERSIAL_DUAL_USE"
  );
}

function isStrongBinding(binding: SubjectBinding): boolean {
  return binding === "CONFIRMED" || binding === "LIKELY";
}

function isStrongRelevance(relevance: JudgmentRelevanceClass): boolean {
  return relevance === "STRONG_RELEVANT" || relevance === "RELEVANT";
}

function hasUnsafeAutoIncludeFlags(j: EvidenceJudgment): boolean {
  return j.flags.some(
    (f) =>
      f.startsWith("controversial:") ||
      f === "wrong_subject" ||
      f === "demo_content" ||
      f === "mock_domain" ||
      f === "high_impact_manual" ||
      f === "compliance_db_potential_match"
  );
}

/**
 * R10.7a — Safe neutral auto-include.
 * Only confirmed/likely neutral registry/profile facts; never adverse/compliance/controversial.
 */
export function isSafeNeutralAutoIncludeCandidate(j: EvidenceJudgment): boolean {
  if (!isStrongBinding(j.subjectBinding)) return false;
  if (!isStrongRelevance(j.relevance)) return false;
  if (!SAFE_AUTO_INCLUDE_SOURCES.includes(j.sourceReliability)) return false;
  if (!SAFE_CONTENT_NATURES.includes(j.contentNature)) return false;
  if (!SAFE_NEUTRAL_RISKS.includes(j.riskSignal)) return false;
  if (j.confidence < 0.55) return false;
  if (isHighImpactRisk(j.riskSignal)) return false;
  if (j.contentNature === "ALLEGATION" || j.contentNature === "OPINION" || j.contentNature === "RUMOR") return false;
  if (hasUnsafeAutoIncludeFlags(j)) return false;
  return true;
}

/** Deterministic routing — final authority for client inclusion. */
export function decideEvidenceReview(j: EvidenceJudgment): ReviewDecision {
  // Rule 1 — wrong subject
  if (j.subjectBinding === "WRONG_SUBJECT") {
    return "EXCLUDE_WRONG_SUBJECT";
  }

  // Rule 2 — noise
  if (
    j.relevance === "NOISE" ||
    j.contentNature === "ADVERTISEMENT" ||
    j.contentNature === "TECHNICAL_PAGE" ||
    j.contentNature === "DUPLICATE"
  ) {
    return "EXCLUDE_NOISE";
  }

  // Hard protect — never auto-include high-impact / allegation / rumor / opinion
  if (isHighImpactRisk(j.riskSignal)) {
    return "MANUAL_REVIEW_REQUIRED";
  }
  if (j.contentNature === "ALLEGATION" || j.contentNature === "OPINION" || j.contentNature === "RUMOR") {
    return "MANUAL_REVIEW_REQUIRED";
  }

  // Weak / unknown binding:
  // - high-impact → manual
  // - insufficient context / neutral → appendix (not worth analyst queue)
  if (j.subjectBinding === "WEAK" || j.subjectBinding === "UNKNOWN") {
    if (isHighImpactRisk(j.riskSignal)) return "MANUAL_REVIEW_REQUIRED";
    return "APPENDIX_ONLY";
  }

  // R10.7a — safe confirmed neutral registry/profile facts (confidence >= 0.55)
  if (isSafeNeutralAutoIncludeCandidate(j)) {
    return "AUTO_INCLUDE_CLIENT_REPORT";
  }

  // Insufficient context for risk/relevance on strong binding — appendix unless high-impact (already gated)
  if (j.riskSignal === "INSUFFICIENT_CONTEXT") {
    return "APPENDIX_ONLY";
  }

  // Low confidence on remaining safe signals → appendix, not main report
  if (j.confidence < 0.55) {
    if (SAFE_NEUTRAL_RISKS.includes(j.riskSignal)) return "APPENDIX_ONLY";
    return "MANUAL_REVIEW_REQUIRED";
  }

  if (j.relevance === "POTENTIALLY_RELEVANT") {
    if (isHighImpactRisk(j.riskSignal)) return "MANUAL_REVIEW_REQUIRED";
    // Ambiguous relevance but safe risk → appendix, not analyst queue
    return "APPENDIX_ONLY";
  }

  if (SAFE_NEUTRAL_RISKS.includes(j.riskSignal) && isStrongBinding(j.subjectBinding)) {
    return "APPENDIX_ONLY";
  }

  return "APPENDIX_ONLY";
}

export function finalizeEvidenceJudgment(partial: Omit<EvidenceJudgment, "reviewDecision">): EvidenceJudgment {
  const reviewDecision = decideEvidenceReview({ ...partial, reviewDecision: "APPENDIX_ONLY" });
  let recommendedAdminAction: RecommendedAdminAction = "APPROVE_FOR_REPORT";
  let adminReviewStatus: AdminReviewStatus = "APPROVED";

  switch (reviewDecision) {
    case "EXCLUDE_WRONG_SUBJECT":
      recommendedAdminAction = "MARK_WRONG_SUBJECT";
      adminReviewStatus = "WRONG_SUBJECT";
      break;
    case "EXCLUDE_NOISE":
      recommendedAdminAction = "EXCLUDE";
      adminReviewStatus = "EXCLUDED";
      break;
    case "MANUAL_REVIEW_REQUIRED":
      recommendedAdminAction = "APPROVE_AS_CAVEATED";
      adminReviewStatus = "PENDING";
      break;
    case "APPENDIX_ONLY":
      recommendedAdminAction = "KEEP_APPENDIX_ONLY";
      adminReviewStatus = "APPENDIX_ONLY";
      break;
    default:
      recommendedAdminAction = "APPROVE_FOR_REPORT";
      adminReviewStatus = "APPROVED";
  }

  return {
    ...partial,
    reviewDecision,
    recommendedAdminAction,
    adminReviewStatus,
  };
}

export function countByReviewDecision(judgments: EvidenceJudgment[]): Record<ReviewDecision, number> {
  const out: Record<string, number> = {};
  for (const j of judgments) {
    out[j.reviewDecision] = (out[j.reviewDecision] ?? 0) + 1;
  }
  return out as Record<ReviewDecision, number>;
}

export function countByRiskSignal(judgments: EvidenceJudgment[]): Record<RiskSignal, number> {
  const out: Record<string, number> = {};
  for (const j of judgments) {
    out[j.riskSignal] = (out[j.riskSignal] ?? 0) + 1;
  }
  return out as Record<RiskSignal, number>;
}
