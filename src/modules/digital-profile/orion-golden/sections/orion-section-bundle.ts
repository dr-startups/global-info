/**
 * R10.6 — ORION section bundle model.
 */

import type { OrionAnalysisMode } from "./orion-section-registry";

export type OrionSectionClientUse =
  | "MAIN_ANALYSIS"
  | "CAVEATED_ANALYSIS"
  | "APPENDIX_ONLY"
  | "MANUAL_REVIEW_ONLY";

export type OrionSectionBundleEvidence = {
  evidenceId: string;
  title: string;
  sourceType: string;
  sourceDomain?: string;
  url?: string;
  snippet?: string;
  subjectBinding: string;
  relevance: string;
  sourceReliability?: string;
  contentNature?: string;
  riskSignal: string;
  reviewDecision: string;
  adminReviewStatus?: string;
  clientUse: OrionSectionClientUse;
  caveat?: string;
  whyIncluded?: string;
};

export type OrionSectionDataSufficiency = "SUFFICIENT" | "LIMITED" | "INSUFFICIENT" | "NOT_APPLICABLE";

export type OrionSectionBundle = {
  version: "r10-6-orion-section-bundle-v1";
  sectionId: string;
  order: number;
  title: string;
  sectionPurpose: string;
  analysisMode: OrionAnalysisMode;
  applicable: boolean;
  applicabilityReason: string;
  allowedEvidence: OrionSectionBundleEvidence[];
  excludedEvidenceSummary: Array<{ evidenceId: string; reason: string }>;
  manualReviewSummary: {
    pendingCount: number;
    approvedCount: number;
    approvedWithCaveatCount: number;
    appendixOnlyCount: number;
    excludedCount: number;
    wrongSubjectCount: number;
  };
  evidenceCounts: {
    totalCandidate: number;
    allowed: number;
    excluded: number;
    appendixOnly: number;
    manualReviewOnly: number;
  };
  dataSufficiency: OrionSectionDataSufficiency;
  sectionWarnings: string[];
};

export type OrionSectionBundleIndex = {
  version: "r10-6-section-bundles-index-v1";
  caseId: string;
  reportRunId: string;
  generatedAt: string;
  sectionCount: number;
  sections: Array<{
    sectionId: string;
    order: number;
    title: string;
    analysisMode: OrionAnalysisMode;
    applicable: boolean;
    allowedCount: number;
    dataSufficiency: OrionSectionDataSufficiency;
  }>;
};
