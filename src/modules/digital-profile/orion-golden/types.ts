/** R10 — ORION Golden Report shared types (3-layer agent architecture). */

export type OrionGoldenLayer = "collection" | "filtering" | "report_assembly";

export type OrionGoldenRunStatus =
  | "planned"
  | "collecting"
  | "filtering"
  | "analyzing"
  | "composing"
  | "rendering"
  | "completed"
  | "failed"
  | "blocked_gpt";

export type OrionGoldenSectionKey =
  | "cover"
  | "global_toc"
  | "global_summary_inputs"
  | "offer_context"
  | "executive_summary"
  | "compliance_risk_matrix"
  | "ru_digital_profile"
  | "ru_audit_summary"
  | "ru_search_results"
  | "ru_serp_screenshots"
  | "ru_suggestions"
  | "ru_images"
  | "ru_videos"
  | "ru_knowledge"
  | "ru_wikipedia"
  | "uae_digital_profile"
  | "uae_audit_summary"
  | "uae_search_results"
  | "uae_serp_screenshots"
  | "uae_suggestions"
  | "uae_images"
  | "uae_videos"
  | "uae_knowledge"
  | "uae_wikipedia"
  | "compliance_databases"
  | "lexisnexis"
  | "dow_jones"
  | "world_check"
  | "offer"
  | "product_overview"
  | "solution_digital_profile"
  | "solution_compliance_databases"
  | "solution_wikipedia"
  | "about"
  | "appendix";

export type RelevanceClass =
  | "strong_relevant"
  | "relevant"
  | "potentially_relevant"
  | "weak_match"
  | "excluded_noise";

export type EvidenceDecisionRecord = {
  inventoryId: string;
  normalizedTitle: string;
  normalizedSnippet: string;
  domain?: string;
  canonicalUrl?: string;
  language?: string;
  region?: string;
  evidenceType: string;
  entityMatchScore?: number;
  relevanceClass: RelevanceClass;
  riskTheme?: string;
  riskLevel?: string;
  confidence?: number;
  includeInClientReport: boolean;
  includeInAppendix: boolean;
  exclusionReason?: string;
  humanReason: string;
};

export type SectionEvidencePack = {
  sectionKey: OrionGoldenSectionKey;
  totalInSection: number;
  selectedCount: number;
  excludedCount: number;
  displayBudget: number;
  selectedForDisplay: EvidenceDecisionRecord[];
  selectedForAnalysis: EvidenceDecisionRecord[];
  excluded: EvidenceDecisionRecord[];
  metrics: Record<string, number | string>;
  warnings: string[];
};

export type OrionGoldenSectionAnalysis = {
  sectionKey: string;
  clientTitle: string;
  mainConclusion: string;
  riskLevel: "low" | "medium" | "high" | "critical" | "review_required" | "no_data";
  whatWasChecked: string[];
  whatWasFound: string[];
  whyItMatters: string[];
  riskInterpretation: string[];
  manualReviewNeeded: string[];
  recommendedActions: string[];
  keyEvidence: Array<{
    title: string;
    domain?: string;
    sourceType: string;
    whyRelevant: string;
    verificationStatus: "confirmed" | "likely" | "requires_review" | "excluded_from_risk";
  }>;
  excludedNoiseSummary: string[];
  clientNarrative: string;
  slidePlan: Array<{ slideKey: string; template: string; title: string }>;
  generatedBy: "gpt-5.5" | "blocked";
};

export type OrionGoldenExecutiveSynthesis = {
  executiveSummary: string;
  globalRiskLevel: "low" | "medium" | "high" | "critical" | "review_required";
  riskMatrix: Array<{ theme: string; level: string; summary: string }>;
  mainRisks: string[];
  possibleConsequences: string[];
  finalRecommendations: string[];
  nextSteps: string[];
  generatedBy: "gpt-5.5" | "blocked";
};

export type OrionGoldenQaVerdict =
  | "PASS"
  | "BLOCKED_GPT"
  | "BLOCKED_DATA_ROUTING"
  | "BLOCKED_RELEVANCE_FILTER"
  | "BLOCKED_VISUAL"
  | "BLOCKED_CLIENT_TEXT"
  | "BLOCKED_STRUCTURE"
  | "BLOCKED";

export type RawInventoryItem = {
  inventoryId: string;
  caseId: string;
  reportRunId: string;
  source: string;
  provider: string;
  region: string;
  query?: string;
  collectedAt: string;
  evidenceType: string;
  title: string;
  snippet?: string;
  sourceUrl?: string;
  screenshotRef?: string;
  storageRef?: string;
  imageUrl?: string;
  videoUrl?: string;
  classification?: string;
  rawMetadata?: Record<string, unknown>;
};
