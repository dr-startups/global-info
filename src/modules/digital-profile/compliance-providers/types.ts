/**
 * Stage C1 — unified compliance screening types.
 * All hits are potential matches until analyst review.
 */

import type { AvailabilityStatus } from "../providers/types";

export type ComplianceProviderName =
  | "OPEN_SANCTIONS"
  | "DOW_JONES"
  | "LEXISNEXIS"
  | "WORLD_CHECK"
  | "MANUAL_IMPORT";

export type ComplianceProviderKind = "REAL" | "MANUAL" | "MOCK";

export type ComplianceRiskType =
  | "SANCTIONS"
  /**
   * The provider's `sanction.linked`: the person is connected to a sanctioned
   * entity but is not listed anywhere. A type of its own rather than
   * `SANCTIONS` or `WATCHLIST` — the report goes to a bank, where an
   * approximate label about a person is a false statement, not a rounding.
   */
  | "SANCTION_LINKED"
  | "PEP"
  | "ADVERSE_MEDIA"
  | "WATCHLIST"
  | "LAW_ENFORCEMENT"
  | "LEGAL"
  | "INSOLVENCY"
  | "POLITICAL_EXPOSURE"
  | "OTHER";

export type ComplianceHitReviewStatus =
  | "PENDING"
  | "MATCH_CONFIRMED"
  | "FALSE_POSITIVE"
  | "NEEDS_REVIEW"
  | "DISMISSED";

export type ComplianceHitSource = "MANUAL" | "OFFICIAL_API" | "MOCK";

export type ComplianceConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

export interface ComplianceScreeningRequest {
  caseId: string;
  subjectFullName: string;
  aliases?: string[];
  dateOfBirth?: string | null;
  nationality?: string | null;
  country?: string | null;
}

export interface ComplianceScreeningHit {
  provider: ComplianceProviderName;
  source: ComplianceHitSource;
  screeningRunId?: string;
  subjectName: string;
  matchedName: string;
  aliases: string[];
  categories: string[];
  riskTypes: ComplianceRiskType[];
  countries: string[];
  datesOfBirth: string[];
  matchScore: number;
  confidence: ComplianceConfidenceLevel;
  profileId?: string;
  profileUrl?: string;
  summary: string;
  rawMetadataSafe: Record<string, unknown>;
  reviewStatus: ComplianceHitReviewStatus;
  reviewedBy?: string;
  reviewedAt?: string;
}

export type ComplianceScreeningStatus =
  | "SUCCESS"
  | "FAILED"
  | "NOT_CONFIGURED"
  | "DISABLED"
  | "PROVIDER_ERROR";

export interface ComplianceProviderError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface ComplianceScreeningResult {
  status: ComplianceScreeningStatus;
  provider: ComplianceProviderName;
  hits: ComplianceScreeningHit[];
  error?: ComplianceProviderError;
}

export interface ComplianceProviderStatus {
  name: ComplianceProviderName;
  kind: ComplianceProviderKind;
  label: string;
  enabled: boolean;
  configured: boolean;
  status: AvailabilityStatus | "PROVIDER_ERROR";
  missingConfigKeys: string[];
  supportsRealCalls: boolean;
  notes: string;
}

export interface ManualComplianceImportInput {
  provider: "DOW_JONES" | "LEXISNEXIS" | "WORLD_CHECK" | "OTHER";
  matchedName: string;
  profileUrl?: string;
  profileId?: string;
  categories?: string[];
  riskTypes: ComplianceRiskType[];
  countries?: string[];
  datesOfBirth?: string[];
  summary?: string;
  evidenceUrl?: string;
  matchScore?: number;
  confidence?: ComplianceConfidenceLevel;
  reviewStatus?: ComplianceHitReviewStatus;
}

export interface MatchScoringInput {
  subjectFullName: string;
  subjectAliases?: string[];
  subjectDob?: string | null;
  subjectCountry?: string | null;
  matchedName: string;
  matchedAliases?: string[];
  matchedDob?: string | null;
  matchedCountry?: string | null;
  riskTypes: ComplianceRiskType[];
}

export interface MatchScoringResult {
  matchScore: number;
  confidence: ComplianceConfidenceLevel;
  signals: string[];
}

export interface ComplianceSummaryBlock {
  providerStatuses: ComplianceProviderStatus[];
  totalHits: number;
  pendingHits: number;
  confirmedHits: number;
  falsePositives: number;
  byRiskType: Record<string, number>;
  topHits: Array<{
    id: string;
    provider: string;
    matchedName: string;
    riskTypes: string[];
    matchScore: number | null;
    confidence: string | null;
    reviewStatus: string;
    source: string;
  }>;
  dataQualityWarnings: string[];
  reviewRequiredWarning: string;
}
