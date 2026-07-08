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

const AUTHORITATIVE_SOURCES: SourceReliability[] = ["AUTHORITATIVE", "PUBLIC_REGISTRY", "REPUTABLE_MEDIA"];

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

  // Rule 4 — controversial dual-use
  if (j.riskSignal === "CONTROVERSIAL_DUAL_USE") {
    return "MANUAL_REVIEW_REQUIRED";
  }

  // Rule 6 — allegations / opinions / rumors (unless authoritative fact)
  if (
    (j.contentNature === "ALLEGATION" || j.contentNature === "OPINION" || j.contentNature === "RUMOR") &&
    !AUTHORITATIVE_SOURCES.includes(j.sourceReliability)
  ) {
    return "MANUAL_REVIEW_REQUIRED";
  }

  // Rule 5 — high-impact weak certainty
  if (
    isHighImpactRisk(j.riskSignal) &&
    (!isStrongBinding(j.subjectBinding) || !AUTHORITATIVE_SOURCES.includes(j.sourceReliability))
  ) {
    return "MANUAL_REVIEW_REQUIRED";
  }

  // Rule 9 — low confidence on risk/compliance
  if (j.confidence < 0.72) {
    if (isHighImpactRisk(j.riskSignal)) return "MANUAL_REVIEW_REQUIRED";
    if (j.riskSignal === "NEUTRAL_CONTEXT" || j.riskSignal === "NO_RISK_SIGNAL" || j.riskSignal === "POSITIVE_SIGNAL") {
      return "APPENDIX_ONLY";
    }
  }

  // Rule 7 — weak / unknown binding
  if (j.subjectBinding === "WEAK" || j.subjectBinding === "UNKNOWN") {
    if (isHighImpactRisk(j.riskSignal)) return "MANUAL_REVIEW_REQUIRED";
    return "APPENDIX_ONLY";
  }

  // Rule 3 — confirmed strong evidence
  if (
    isStrongBinding(j.subjectBinding) &&
    isStrongRelevance(j.relevance) &&
    AUTHORITATIVE_SOURCES.includes(j.sourceReliability) &&
    j.contentNature === "FACT" &&
    j.riskSignal !== "INSUFFICIENT_CONTEXT" &&
    j.confidence >= 0.72
  ) {
    return "AUTO_INCLUDE_CLIENT_REPORT";
  }

  // Rule 8 — positive / neutral
  if (j.riskSignal === "POSITIVE_SIGNAL" || j.riskSignal === "NEUTRAL_CONTEXT" || j.riskSignal === "NO_RISK_SIGNAL") {
    if (isStrongBinding(j.subjectBinding) && isStrongRelevance(j.relevance) && j.confidence >= 0.72) {
      return "AUTO_INCLUDE_CLIENT_REPORT";
    }
    return "APPENDIX_ONLY";
  }

  // Adverse confirmed only with strong binding + authoritative — else manual
  if (j.riskSignal === "ADVERSE_CONFIRMED") {
    if (isStrongBinding(j.subjectBinding) && AUTHORITATIVE_SOURCES.includes(j.sourceReliability) && j.confidence >= 0.72) {
      return "AUTO_INCLUDE_CLIENT_REPORT";
    }
    return "MANUAL_REVIEW_REQUIRED";
  }

  if (j.riskSignal === "INSUFFICIENT_CONTEXT") {
    return "MANUAL_REVIEW_REQUIRED";
  }

  if (isStrongRelevance(j.relevance) && isStrongBinding(j.subjectBinding)) {
    return "AUTO_INCLUDE_CLIENT_REPORT";
  }

  if (j.relevance === "POTENTIALLY_RELEVANT") {
    return "MANUAL_REVIEW_REQUIRED";
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
