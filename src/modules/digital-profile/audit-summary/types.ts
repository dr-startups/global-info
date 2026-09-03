/**
 * Audit Summary types (Stage J).
 *
 * The audit summary turns stored evidence + risk findings into structured,
 * cautious summary blocks for the report. It is fully deterministic — no LLM,
 * no network, no scraping. Wording is non-conclusive ("mentions found",
 * "sources contain information", "requires manual review").
 */

import type { RiskLevel, RiskTheme } from "../risk-classifier/types";
import type { RegionCollectionStatus } from "../search-surfaces/region-profiles";

export type OverallRiskLevel = RiskLevel | "UNKNOWN";

export type AuditTone = "neutral" | "caution" | "elevated" | "insufficient_data";

export type RegionCode = "RU" | "UAE" | "INTERNATIONAL";

export interface SearchSummary {
  totalResults: number;
  uniqueUrls: number;
  negativeResults: number;
  /** 0..1 share of negative results among total. */
  negativeShare: number;
  negativeDomains: string[];
  topNegativeThemes: { theme: RiskTheme; count: number }[];
  topNegativeUrls: { url: string; title: string | null }[];
}

export interface SurfacesSummary {
  suggestions: { total: number; negative: number; negativeShare: number };
  relatedQueries: { total: number; negative: number; negativeShare: number };
  images: { total: number; negative: number; negativeShare: number };
  videos: { total: number; negative: number; negativeShare: number };
  knowledgeBlocks: { total: number; mismatches: number };
  screenshots: number;
  syntheticSnapshots: number;
}

export interface WikipediaSummary {
  exists: boolean;
  pageUrl: string | null;
  language: string | null;
  /** 0..100 heuristic notability proxy (not an authoritative metric). */
  notabilityScore: number;
  conclusion: string;
}

export interface ComplianceDatabaseSummary {
  providersChecked: string[];
  activeMatches: number;
  pepMatches: number;
  rcaMatches: number;
  sanctionsMatches: number;
  adverseMediaMatches: number;
  conclusion: string;
}

export interface RiskSummaryBlock {
  highestRiskLevel: OverallRiskLevel;
  totalFindings: number;
  findingsByLevel: Record<string, number>;
  findingsByTheme: Record<string, number>;
  topFindings: {
    severity: string;
    theme: string;
    title: string;
    reviewStatus: string;
    evidenceCount: number;
  }[];
}

export interface DataQualitySummary {
  evidenceCount: number;
  reviewedFindings: number;
  pendingFindings: number;
  dismissedFindings: number;
  missingSections: string[];
  warnings: string[];
}

export interface RegionAuditSummary {
  region: RegionCode;
  language: string;
  organicTotal: number;
  organicNegative: number;
  organicNeutral: number;
  organicPositive: number;
  organicNegativeShare: number;
  uniqueNegativeUrls: number;
  totalUniqueUrls: number;
  suggestionsTotal: number;
  suggestionsNegative: number;
  relatedQueriesTotal: number;
  relatedQueriesNegative: number;
  imagesTotal: number;
  imagesNegative: number;
  videosTotal: number;
  videosNegative: number;
  knowledgeBlockStatus: "PRESENT" | "MISMATCH" | "ABSENT" | "NOT_COLLECTED";
  /** Stage O4.1 — whether this region was actually queried. */
  collectionStatus?: RegionCollectionStatus;
  statusMessage?: string;
  regionRiskLevel: OverallRiskLevel;
  regionConclusion: string;
  /** Compact rows for the report tables (bounded). */
  topResults: {
    provider: string;
    rank: number | null;
    domain: string;
    title: string;
    classification: string;
  }[];
  topSuggestions: string[];
  topImages: { title: string; url: string | null }[];
  topVideos: { title: string; url: string | null }[];
  /** Stage K2 — additional bounded region detail for full audit pages. */
  topThemes: { theme: string; count: number }[];
  topNegativeDomains: string[];
  topNegativeUrls: { title: string; domain: string; classification: string }[];
  topRelatedQueries: string[];
  knowledgeBlock: { title: string; snippet: string; source: string } | null;
  evidenceAppendix: {
    title: string;
    domain: string;
    provider: string;
    classification: string;
  }[];
}

export interface KeyFindingGroup {
  /** search_profile | wikipedia | compliance_databases | search_surfaces | data_quality */
  group: string;
  title: string;
  points: string[];
}

export interface AuditSummary {
  caseId: string;
  subjectFullName: string;
  generatedAt: string;
  overallRiskLevel: OverallRiskLevel;
  overallTone: AuditTone;
  executiveSummary: string[];
  keyFindings: KeyFindingGroup[];
  recommendedActions: string[];
  regions: RegionAuditSummary[];
  searchSummary: SearchSummary;
  surfacesSummary: SurfacesSummary;
  wikipediaSummary: WikipediaSummary;
  complianceDatabaseSummary: ComplianceDatabaseSummary;
  riskSummary: RiskSummaryBlock;
  dataQualitySummary: DataQualitySummary;
}
