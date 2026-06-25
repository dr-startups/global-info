/**
 * Risk Classifier v1 types (Stage I).
 *
 * Deterministic, rule-based classification over already-stored evidence. No LLM,
 * no network. Every classification result references concrete evidence and uses
 * cautious wording ("mentions found", "requires manual review") — never a
 * categorical legal/factual assertion about the subject.
 */

export type RiskSignalType =
  | "ADVERSE_MEDIA"
  | "SANCTIONS_MENTION"
  | "PEP_RCA_MENTION"
  | "POLITICAL_EXPOSURE"
  | "OFFSHORE_MENTION"
  | "LEGAL_DISPUTE"
  | "BANKRUPTCY_MENTION"
  | "CRIMINAL_ALLEGATION"
  | "REPUTATION_SITE"
  | "WIKIPEDIA_ABSENT"
  | "KNOWLEDGE_BLOCK_MISMATCH"
  | "NEGATIVE_SUGGESTION"
  | "NEGATIVE_IMAGE"
  | "NEGATIVE_VIDEO"
  | "COMPLIANCE_DATABASE_MATCH"
  | "MANUAL_FLAG";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type RiskTheme =
  | "sanctions"
  | "pep_rca"
  | "adverse_media"
  | "politics"
  | "offshore"
  | "legal"
  | "criminal_allegation"
  | "reputation"
  | "wikipedia"
  | "search_profile"
  | "compliance_database"
  | "other";

export type RiskEvidenceType =
  | "SEARCH_RESULT"
  | "SEARCH_SURFACE_ITEM"
  | "WIKIPEDIA_CHECK"
  | "DATABASE_PROFILE"
  | "SCREENSHOT"
  | "MANUAL";

export interface RiskEvidenceRef {
  type: RiskEvidenceType;
  id: string;
  title?: string;
  url?: string;
  provider?: string;
  source?: string;
}

export interface RiskClassificationResult {
  signalType: RiskSignalType;
  theme: RiskTheme;
  riskLevel: RiskLevel;
  title: string;
  description: string;
  evidenceRefs: RiskEvidenceRef[];
  /** 0..1 heuristic confidence (deterministic, not probabilistic truth). */
  confidence: number;
  rationale: string;
  demo: boolean;
}

export const RISK_LEVEL_RANK: Record<RiskLevel, number> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export function maxRiskLevel(levels: RiskLevel[]): RiskLevel | null {
  if (levels.length === 0) return null;
  return levels.reduce((a, b) => (RISK_LEVEL_RANK[b] > RISK_LEVEL_RANK[a] ? b : a));
}

export interface ClassifyRunSummary {
  totalEvidenceScanned: number;
  findingsCreated: number;
  findingsUpdated: number;
  findingsSkippedReviewed: number;
  findingsDismissedIgnored: number;
  highestRiskLevel: RiskLevel | "NONE";
}
