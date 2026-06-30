/**
 * Stage O5 — unified evidence quality model.
 * Pure types; no network, no LLM.
 */

import type { RegionCollectionStatus } from "../search-surfaces/region-profiles";
import type { IdentityConfidence } from "../risk-classifier/entity-disambiguation";
import type { ResultConfidence } from "../risk-classifier/result-classifier";

export type EvidenceSurfaceType =
  | "SEARCH_RESULT"
  | "SEARCH_SUGGESTION"
  | "RELATED_QUERY"
  | "IMAGE_RESULT"
  | "VIDEO_RESULT"
  | "KNOWLEDGE_BLOCK"
  | "WIKIPEDIA_RESULT"
  | "MANUAL_COMPLIANCE"
  | "MANUAL_IMPORT";

export type RiskConfidence = ResultConfidence | "NONE";

export type ContentClass =
  | "ADVERSE_LEGAL"
  | "ADVERSE_MEDIA"
  | "SANCTIONS"
  | "CRIMINAL"
  | "PEP_RCA"
  | "CORPORATE_REGISTRY"
  | "SOCIAL_PROFILE"
  | "BIOGRAPHY"
  | "NEWS_NEUTRAL"
  | "IMAGE_NEUTRAL"
  | "VIDEO_NEUTRAL"
  | "KNOWLEDGE_PANEL"
  | "WIKIPEDIA"
  | "NAMESAKE"
  | "ENTITY_MISMATCH"
  | "DUPLICATE"
  | "LOW_VALUE"
  | "UNKNOWN";

export type ReportEligibility =
  | "CLIENT_INCLUDE"
  | "INTERNAL_ONLY"
  | "REVIEW_REQUIRED"
  | "EXCLUDE";

export type SelectionReason =
  | "exact_subject_match"
  | "partial_subject_match"
  | "namesake_detected"
  | "weak_registry_only"
  | "strong_legal_terms"
  | "manual_confirmed"
  | "manual_false_positive"
  | "duplicate_url"
  | "low_value_surface"
  | "useful_profile_material"
  | "not_collected"
  | "provider_not_configured"
  | "weak_adverse_terms"
  | "entity_mismatch"
  | "pending_review";

export type ReportAudience = "INTERNAL" | "CLIENT";

export interface EvidenceItemInput {
  id?: string;
  surfaceType: EvidenceSurfaceType;
  title?: string | null;
  url?: string | null;
  domain?: string | null;
  snippet?: string | null;
  thumbnailUrl?: string | null;
  classification?: string | null;
  riskTheme?: string | null;
  reviewStatus?: string | null;
  region?: string | null;
  query?: string | null;
  source?: string | null;
  rawMetadata?: unknown;
  subjectFullName?: string | null;
  /** Manual report override stored on item (surfaces / results). */
  reportEligibilityOverride?: ReportEligibility | null;
}

export interface EvidenceQualityAssessment {
  identityConfidence: IdentityConfidence;
  riskConfidence: RiskConfidence;
  contentClass: ContentClass;
  reportEligibility: ReportEligibility;
  selectionReason: SelectionReason;
  isAdverseForReport: boolean;
  isUsefulProfileMaterial: boolean;
  duplicateOf?: string | null;
}

export interface GatedEvidenceItem extends EvidenceItemInput {
  quality: EvidenceQualityAssessment;
}

export interface SurfaceQualityStats {
  totalCollected: number;
  selectedForReport: number;
  excludedAsNoise: number;
  reviewRequired: number;
  duplicatesCollapsed: number;
  clientIncluded: number;
    dataQualityStatus: RegionCollectionStatus | "EMPTY";
}

export interface EvidenceQualitySummary {
  totals: {
    collected: number;
    clientIncluded: number;
    internalOnly: number;
    reviewRequired: number;
    excluded: number;
    duplicates: number;
  };
  bySurface: Partial<Record<EvidenceSurfaceType, SurfaceQualityStats>>;
  byRegion: Partial<
    Record<string, { collected: number; selected: number; excluded: number; reviewRequired: number }>
  >;
  topExclusionReasons: Array<{ reason: SelectionReason; count: number }>;
  usefulProfileMaterials: Array<{ title: string; contentClass: ContentClass; region?: string | null }>;
  highConfidenceRisks: Array<{ title: string; contentClass: ContentClass; region?: string | null }>;
  reviewQueue: Array<{
    id?: string;
    title: string;
    surfaceType: EvidenceSurfaceType;
    contentClass: ContentClass;
    selectionReason: SelectionReason;
    region?: string | null;
  }>;
}
