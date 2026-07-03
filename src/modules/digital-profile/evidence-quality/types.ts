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
  | "override_selected"
  | "manual_review_required"
  | "weak_identity_override"
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
  | "pending_review"
  | "insufficient_match"
  | "autocomplete_exposure";

export type IdentityDecision =
  | "EXACT_SUBJECT"
  | "LIKELY_SUBJECT"
  | "POSSIBLE_SUBJECT"
  | "NAMESAKE"
  | "ENTITY_MISMATCH"
  | "INSUFFICIENT_MATCH";

export type AutocompleteClass =
  | "EXACT_SUBJECT_QUERY"
  | "SUBJECT_BROAD_QUERY"
  | "ADJACENT_PERSON_QUERY"
  | "NAMESAKE_QUERY"
  | "TYPO_OR_SIMILAR_QUERY"
  | "GENERIC_QUERY"
  | "IRRELEVANT_QUERY"
  | "RISK_QUERY";

export type ThumbnailStatus =
  | "AVAILABLE"
  | "FAILED"
  | "NOT_FETCHED"
  | "BLOCKED"
  | "UNSAFE";

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
  subjectAliases?: string[];
  subjectCountry?: string | null;
  subjectNationality?: string | null;
  subjectRegionHints?: string[];
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
  /** O5.3 — strict identity decision for evidence surfaces. */
  identityDecision?: IdentityDecision;
  identityReason?: string;
  /** O5.3 — autocomplete exposure class (suggestions / related queries). */
  autocompleteClass?: AutocompleteClass;
  isSubjectEvidence?: boolean;
  thumbnailStatus?: ThumbnailStatus;
  entityMatch?: {
    decision:
      | "strict_subject"
      | "likely_subject"
      | "possible_subject"
      | "namesake"
      | "not_subject"
      | "insufficient_identity";
    confidence: number;
    reasons: string[];
    matchedTokens: string[];
    missingCriticalTokens: string[];
    conflictingTokens: string[];
    patronymicStatus: "match" | "missing" | "conflict" | "not_applicable";
    regionStatus: "match" | "weak" | "conflict" | "unknown";
  };
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
    identityDecision?: IdentityDecision;
    autocompleteClass?: AutocompleteClass;
  }>;
  /** O5.3 — identity precision metrics. */
  identity?: {
    collectedTotal: number;
    subjectMatchedTotal: number;
    exactSubject: number;
    likelySubject: number;
    possibleSubject: number;
    namesakesExcluded: number;
    entityMismatchesExcluded: number;
    insufficientMatchesExcluded: number;
    lowValueExcluded: number;
    selectedForClient: number;
    selectedForInternalReview: number;
  };
  autocompleteExposure?: {
    total: number;
    exactSubjectQueries: number;
    adjacentPersonQueries: number;
    typoOrSimilarQueries: number;
    riskQueries: number;
    clientShown: number;
    excludedFromEvidence: number;
  };
  imageEvidence?: {
    collected: number;
    thumbnailsFetched: number;
    thumbnailsAvailable: number;
    subjectMatched: number;
    selectedForReport: number;
    excludedNamesakeOrNoise: number;
    fetchFailed: number;
  };
}
