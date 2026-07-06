/** ORION Client Storyboard — contract between GPT analysis and visual composer (R9.9). */

export type ClientStoryboardSectionKey =
  | "cover"
  | "executive_summary"
  | "risk_overview"
  | "ru_audit"
  | "ru_search"
  | "compliance"
  | "lexisnexis"
  | "appendix"
  | "commercial";

export type ClientSlideType =
  | "cover"
  | "global_toc"
  | "executive_summary"
  | "scope_overview"
  | "risk_conclusion"
  | "risk_matrix"
  | "region_summary"
  | "search_overview"
  | "relevant_sources"
  | "excluded_matches"
  | "serp_screenshot"
  | "search_results_table"
  | "adverse_media_summary"
  | "image_grid"
  | "video_cards"
  | "knowledge_panel"
  | "wikipedia_summary"
  | "compliance_summary"
  | "lexisnexis_summary"
  | "lexisnexis_signals"
  | "lexisnexis_visual_page"
  | "evidence_appendix"
  | "recommended_actions"
  | "commercial_offer"
  | "about"
  | "no_data_compact";

export type ClientRiskLevel = "low" | "medium" | "high" | "unknown";

export type ClientVisualDensity = "compact" | "standard" | "rich";

export interface ClientEvidenceRef {
  evidenceRef: string;
  label: string;
  summary: string;
  statusLabel: string;
}

export interface ClientAssetRef {
  assetRef: string;
  kind: "serp_snapshot" | "image_grid" | "video_cards" | "knowledge_panel" | "lexis_page" | "other";
  title: string;
  status: "ready" | "unavailable" | "omitted";
}

export interface ClientMetricCard {
  label: string;
  value: string | number;
  tone?: "neutral" | "low" | "medium" | "high" | "warning";
}

export interface ClientFindingCard {
  headline: string;
  summary: string;
  evidenceRefs: string[];
  severity?: ClientRiskLevel;
}

export interface ClientActionItem {
  label: string;
  rationale: string;
  priority?: "high" | "medium" | "low";
}

export interface ClientSlideBlock {
  blockType: "takeaway" | "bullets" | "metrics" | "findings" | "evidence" | "actions" | "asset";
  content: string | string[] | ClientMetricCard[] | ClientFindingCard[] | ClientActionItem[];
}

export interface ClientStoryboardSlide {
  slideId: string;
  sectionKey: ClientStoryboardSectionKey;
  slideType: ClientSlideType;
  title: string;
  subtitle?: string;
  clientTakeaway: string;
  metrics: ClientMetricCard[];
  findings: ClientFindingCard[];
  evidenceRefs: ClientEvidenceRef[];
  assetRefs: ClientAssetRef[];
  recommendedActions: ClientActionItem[];
  riskLevel: ClientRiskLevel;
  layoutIntent: string;
  omitIfNoData: boolean;
  visualDensityTarget: ClientVisualDensity;
  blocks?: ClientSlideBlock[];
  /** Max bullets for composer enforcement */
  maxBullets?: number;
}

export interface ClientStoryboardSection {
  sectionKey: ClientStoryboardSectionKey;
  title: string;
  subtitle?: string;
  slides: ClientStoryboardSlide[];
}

export interface ClientStoryboardQa {
  generatedBy: "gpt-5.5" | "deterministic" | "mixed";
  requireAi: boolean;
  realCaseQualityEligible: boolean;
  caseId: string;
  caseSource: "env" | "db" | "fixture";
  warnings: string[];
}

export interface ClientStoryboard {
  version: "orion-client-storyboard-v1";
  subject: { displayName: string; locale: "ru" | "en" };
  generatedAt: string;
  sections: ClientStoryboardSection[];
  slides: ClientStoryboardSlide[];
  qa: ClientStoryboardQa;
}

/** GPT storyboard-ready section output (R9.9). */
export interface GptStoryboardSectionPlan {
  slideKey: string;
  slideType: ClientSlideType;
  title: string;
  subtitle?: string;
  clientTakeaway: string;
  bullets?: string[];
  evidenceRefs?: string[];
  assetRefs?: string[];
}

export type GptStoryboardSectionKey =
  | "executive_summary"
  | "ru_audit_summary"
  | "ru_search_results"
  | "lexis_summary"
  | "recommended_actions";

export interface GptEvidenceExample {
  humanTitle: string;
  source: string;
  domain: string;
  whyIncluded: string;
  clientSafeStatus: "relevant" | "requires_review" | "excluded_from_risk";
}

export interface GptRiskInterpretation {
  level: "low" | "medium" | "high" | "review_required";
  plainLanguageReason: string;
  notConfirmedDisclaimer: string;
}

export interface GptStoryboardSectionAnalysis {
  sectionKey: GptStoryboardSectionKey;
  generatedBy: "gpt-5.5" | "deterministic";
  clientTitle?: string;
  executiveTakeaway: string;
  clientExplanation: string;
  riskInterpretation: string;
  whatWasChecked?: string[];
  whatWasFound?: string[];
  whatItMeans?: string[];
  whatRequiresManualReview?: string[];
  excludedNoiseSummary?: string[];
  confidence?: "high" | "medium" | "low";
  structuredRisk?: GptRiskInterpretation;
  evidenceExamples?: GptEvidenceExample[];
  clientWarnings?: string[];
  confirmedFacts: string[];
  unconfirmedSignals: string[];
  manualReviewQueue: string[];
  recommendedActions: string[];
  slidePlans: GptStoryboardSectionPlan[];
  warnings: string[];
}
