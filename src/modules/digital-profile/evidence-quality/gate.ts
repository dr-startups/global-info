/**
 * Stage O5 — Evidence Quality Gate.
 *
 * Evaluates each evidence item for identity, risk, content class, and report eligibility.
 * PURE + deterministic. Builds on N1.3 classifier; no LLM.
 */

import {
  classifySearchResultRecord,
  isRiskyResultClass,
  isStrongAutoSnapshotRisk,
  readRiskClassification,
  type AutoResultClassification,
} from "../risk-classifier/result-classifier";
import type { IdentityConfidence } from "../risk-classifier/entity-disambiguation";
import {
  isAdverseContentClass,
  isExcludedContentClass,
  isUsefulProfileContentClass,
  mapResultClassToContentClass,
} from "./content-class";
import { classifyAutocompleteQuery } from "./autocomplete-class";
import {
  buildSubjectFingerprint,
  evaluateIdentityDecision,
  identityDecisionToConfidence,
  type IdentityDecision,
} from "./subject-fingerprint";
import { readThumbnailStatus } from "./image-thumbnail-service";
import type {
  EvidenceItemInput,
  EvidenceQualityAssessment,
  EvidenceSurfaceType,
  ReportEligibility,
  RiskConfidence,
  SelectionReason,
} from "./types";

const AUTOCOMPLETE_SURFACES: EvidenceSurfaceType[] = ["SEARCH_SUGGESTION", "RELATED_QUERY"];
const STRICT_EXCLUDE: IdentityDecision[] = ["NAMESAKE", "ENTITY_MISMATCH", "INSUFFICIENT_MATCH"];

/** O5.3 — identity from result content; search query must not anchor unrelated hits. */
function identityEvidenceText(input: EvidenceItemInput): string {
  if (isAutocompleteSurface(input.surfaceType)) {
    return [input.title, input.snippet, input.query, input.url].filter(Boolean).join(" ");
  }
  return [input.title, input.snippet, input.url, input.domain].filter(Boolean).join(" ");
}

function isAutocompleteSurface(surfaceType: EvidenceSurfaceType): boolean {
  return AUTOCOMPLETE_SURFACES.includes(surfaceType);
}

/** O5.3 — suggestions/related: exposure only, never subject evidence or risk. */
function deriveAutocompleteExposureEligibility(params: {
  reportEligibilityOverride?: ReportEligibility | null;
  isDuplicate: boolean;
  isFalsePositive: boolean;
  autocompleteClass: ReturnType<typeof classifyAutocompleteQuery>;
}): ReportEligibility {
  if (params.reportEligibilityOverride) return params.reportEligibilityOverride;
  if (params.isDuplicate) return "EXCLUDE";
  if (params.isFalsePositive) return "EXCLUDE";
  if (params.autocompleteClass === "IRRELEVANT_QUERY") return "REVIEW_REQUIRED";
  return "INTERNAL_ONLY";
}

/** O5.3 — strict identity gate for organic/images/videos/knowledge. */
function deriveStrictIdentityEligibility(params: {
  surfaceType: EvidenceSurfaceType;
  contentClass: ReturnType<typeof mapResultClassToContentClass>;
  identityDecision: IdentityDecision;
  identityConfidence: IdentityConfidence;
  riskConfidence: RiskConfidence;
  manualClassification: string | null;
  isFalsePositive: boolean;
  auto: AutoResultClassification | null;
  reviewStatus: string | null;
  isDuplicate: boolean;
  reportEligibilityOverride?: ReportEligibility | null;
}): ReportEligibility {
  if (params.reportEligibilityOverride) return params.reportEligibilityOverride;
  if (params.isDuplicate) return "EXCLUDE";
  if (params.isFalsePositive) return "EXCLUDE";
  if (STRICT_EXCLUDE.includes(params.identityDecision)) return "EXCLUDE";
  if (isExcludedContentClass(params.contentClass)) return "EXCLUDE";

  if (params.manualClassification && isRiskyResultClass(params.manualClassification)) {
    if (params.identityDecision === "POSSIBLE_SUBJECT") return "REVIEW_REQUIRED";
    return "CLIENT_INCLUDE";
  }

  if (isAdverseContentClass(params.contentClass)) {
    if (params.identityDecision === "POSSIBLE_SUBJECT") return "REVIEW_REQUIRED";
    if (params.identityDecision === "LIKELY_SUBJECT" || params.identityDecision === "EXACT_SUBJECT") {
      if (
        params.auto &&
        isStrongAutoSnapshotRisk(params.auto) &&
        params.riskConfidence === "HIGH"
      ) {
        return "CLIENT_INCLUDE";
      }
      return "REVIEW_REQUIRED";
    }
    return "EXCLUDE";
  }

  if (
    isUsefulProfileContentClass(params.contentClass) &&
    (params.identityDecision === "EXACT_SUBJECT" || params.identityDecision === "LIKELY_SUBJECT")
  ) {
    return "CLIENT_INCLUDE";
  }

  if (params.identityDecision === "EXACT_SUBJECT" || params.identityDecision === "LIKELY_SUBJECT") {
    if (params.surfaceType === "IMAGE_RESULT" || params.surfaceType === "VIDEO_RESULT") {
      return "CLIENT_INCLUDE";
    }
    return params.reviewStatus === "REVIEWED" ? "CLIENT_INCLUDE" : "INTERNAL_ONLY";
  }

  if (params.identityDecision === "POSSIBLE_SUBJECT") {
    if (params.surfaceType === "IMAGE_RESULT" || params.surfaceType === "VIDEO_RESULT") {
      return "EXCLUDE";
    }
    return "REVIEW_REQUIRED";
  }

  if (params.auto?.potentialRiskForReview) return "REVIEW_REQUIRED";
  return "EXCLUDE";
}

function readManualClassification(rawMetadata: unknown): {
  classification: string | null;
  isFalsePositive: boolean;
} {
  const rc = readRiskClassification(rawMetadata);
  const manual = rc?.manual;
  if (!manual?.classification) return { classification: null, isFalsePositive: false };
  const isFalsePositive = !isRiskyResultClass(manual.classification);
  return { classification: manual.classification, isFalsePositive };
}

function effectiveAuto(rawMetadata: unknown): AutoResultClassification | null {
  return readRiskClassification(rawMetadata)?.auto ?? null;
}

function riskConfidenceFrom(
  auto: AutoResultClassification | null,
  contentClass: ReturnType<typeof mapResultClassToContentClass>,
  manualClassification: string | null
): RiskConfidence {
  if (manualClassification) {
    return isRiskyResultClass(manualClassification) ? "HIGH" : "NONE";
  }
  if (isExcludedContentClass(contentClass) || contentClass === "CORPORATE_REGISTRY") {
    return "NONE";
  }
  if (auto?.riskConfidence) return auto.riskConfidence;
  if (auto?.confidence) return auto.confidence;
  return "LOW";
}

function deriveSelectionReason(params: {
  identityConfidence: IdentityConfidence;
  contentClass: ReturnType<typeof mapResultClassToContentClass>;
  manualClassification: string | null;
  isFalsePositive: boolean;
  auto: AutoResultClassification | null;
  isDuplicate: boolean;
  reportEligibilityOverride?: ReportEligibility | null;
  surfaceType?: EvidenceSurfaceType;
  identityDecision?: IdentityDecision;
}): SelectionReason {
  if (params.reportEligibilityOverride === "EXCLUDE") return "manual_false_positive";
  if (params.isDuplicate) return "duplicate_url";
  if (params.isFalsePositive) return "manual_false_positive";
  if (params.manualClassification && isRiskyResultClass(params.manualClassification)) {
    return "manual_confirmed";
  }
  if (params.contentClass === "NAMESAKE") return "namesake_detected";
  if (params.contentClass === "ENTITY_MISMATCH") return "entity_mismatch";
  if (params.contentClass === "CORPORATE_REGISTRY") return "weak_registry_only";
  if (params.surfaceType && isAutocompleteSurface(params.surfaceType)) {
    return "autocomplete_exposure";
  }
  if (params.identityDecision === "INSUFFICIENT_MATCH") return "insufficient_match";
  if (params.auto?.potentialRiskForReview) return "weak_adverse_terms";
  if (isUsefulProfileContentClass(params.contentClass)) return "useful_profile_material";
  if (params.identityConfidence === "HIGH") return "exact_subject_match";
  if (params.identityConfidence === "MEDIUM") return "partial_subject_match";
  if (isAdverseContentClass(params.contentClass) && params.auto && isStrongAutoSnapshotRisk(params.auto)) {
    return "strong_legal_terms";
  }
  if (params.contentClass === "LOW_VALUE" || params.contentClass === "UNKNOWN") {
    return "low_value_surface";
  }
  return "partial_subject_match";
}

function deriveReportEligibility(params: {
  surfaceType: EvidenceSurfaceType;
  contentClass: ReturnType<typeof mapResultClassToContentClass>;
  identityConfidence: IdentityConfidence;
  identityDecision: IdentityDecision;
  riskConfidence: RiskConfidence;
  manualClassification: string | null;
  isFalsePositive: boolean;
  auto: AutoResultClassification | null;
  reviewStatus: string | null;
  isDuplicate: boolean;
  reportEligibilityOverride?: ReportEligibility | null;
  title?: string | null;
  subjectFullName?: string | null;
  autocompleteClass?: ReturnType<typeof classifyAutocompleteQuery>;
}): ReportEligibility {
  if (isAutocompleteSurface(params.surfaceType)) {
    return deriveAutocompleteExposureEligibility({
      reportEligibilityOverride: params.reportEligibilityOverride,
      isDuplicate: params.isDuplicate,
      isFalsePositive: params.isFalsePositive,
      autocompleteClass: params.autocompleteClass ?? "GENERIC_QUERY",
    });
  }
  return deriveStrictIdentityEligibility(params);
}

/** Evaluates one evidence item through the quality gate. */
export function evaluateEvidenceItem(
  input: EvidenceItemInput,
  options: { isDuplicate?: boolean } = {}
): EvidenceQualityAssessment {
  const manual = readManualClassification(input.rawMetadata);
  const auto = effectiveAuto(input.rawMetadata);
  const override = input.reportEligibilityOverride ?? readEligibilityOverride(input.rawMetadata);

  let classification = manual.classification ?? auto?.classification ?? input.classification ?? null;
  let identityConfidence = auto?.identityConfidence ?? "MEDIUM";
  let autoBlock = auto;

  if (!classification && !manual.classification) {
    const classified = classifySearchResultRecord({
      title: input.title,
      url: input.url,
      domain: input.domain,
      snippet: input.snippet,
      subjectFullName: input.subjectFullName,
      query: input.query,
      region: input.region,
      source: input.source,
    });
    classification = classified.classification;
    identityConfidence = classified.identityConfidence;
    autoBlock = { ...classified, classifiedAt: new Date().toISOString() };
  }

  const textForIdentity = identityEvidenceText(input);
  const fingerprint = input.subjectFullName?.trim()
    ? buildSubjectFingerprint({ fullName: input.subjectFullName.trim() })
    : null;

  let identityDecision: IdentityDecision = "POSSIBLE_SUBJECT";
  let identityReason = "default";
  let autocompleteClass: ReturnType<typeof classifyAutocompleteQuery> | undefined;

  if (isAutocompleteSurface(input.surfaceType)) {
    autocompleteClass = classifyAutocompleteQuery(textForIdentity, input.subjectFullName);
    const id = evaluateIdentityDecision(textForIdentity, fingerprint);
    identityDecision = id.decision;
    identityReason = id.reason;
    identityConfidence = identityDecisionToConfidence(id.decision);
  } else {
    const id = evaluateIdentityDecision(textForIdentity, fingerprint);
    identityDecision = id.decision;
    identityReason = id.reason;
    identityConfidence = identityDecisionToConfidence(id.decision);
  }

  const resolvedClass = mapResultClassToContentClass(classification, input.surfaceType);
  if (!isAutocompleteSurface(input.surfaceType)) {
    if (resolvedClass === "NAMESAKE" || identityDecision === "NAMESAKE") {
      identityDecision = "NAMESAKE";
      identityConfidence = "NONE";
    }
    if (resolvedClass === "ENTITY_MISMATCH" || identityDecision === "ENTITY_MISMATCH") {
      identityDecision = "ENTITY_MISMATCH";
      identityConfidence = "NONE";
    }
  }
  const riskConfidence = riskConfidenceFrom(autoBlock, resolvedClass, manual.classification);
  const selectionReason = deriveSelectionReason({
    identityConfidence,
    contentClass: resolvedClass,
    manualClassification: manual.classification,
    isFalsePositive: manual.isFalsePositive,
    auto: autoBlock,
    isDuplicate: options.isDuplicate ?? false,
    reportEligibilityOverride: override,
    surfaceType: input.surfaceType,
    identityDecision,
  });
  const reportEligibility = deriveReportEligibility({
    surfaceType: input.surfaceType,
    contentClass: resolvedClass,
    identityConfidence,
    identityDecision,
    riskConfidence,
    manualClassification: manual.classification,
    isFalsePositive: manual.isFalsePositive,
    auto: autoBlock,
    reviewStatus: input.reviewStatus ?? null,
    isDuplicate: options.isDuplicate ?? false,
    reportEligibilityOverride: override,
    title: input.title ?? input.query,
    subjectFullName: input.subjectFullName,
    autocompleteClass,
  });

  const isSubjectEvidence =
    !isAutocompleteSurface(input.surfaceType) &&
    !STRICT_EXCLUDE.includes(identityDecision) &&
    reportEligibility !== "EXCLUDE";

  const isAdverseForReport =
    isSubjectEvidence &&
    reportEligibility === "CLIENT_INCLUDE" &&
    (manual.classification
      ? isRiskyResultClass(manual.classification)
      : autoBlock
        ? isStrongAutoSnapshotRisk(autoBlock)
        : isAdverseContentClass(resolvedClass) && riskConfidence === "HIGH");

  const isUsefulProfileMaterial =
    isSubjectEvidence &&
    (reportEligibility === "CLIENT_INCLUDE" || reportEligibility === "INTERNAL_ONLY") &&
    isUsefulProfileContentClass(resolvedClass);

  return {
    identityConfidence,
    riskConfidence,
    contentClass: resolvedClass,
    reportEligibility,
    selectionReason,
    isAdverseForReport,
    isUsefulProfileMaterial,
    duplicateOf: options.isDuplicate ? "dedupe" : null,
    identityDecision,
    identityReason,
    autocompleteClass,
    isSubjectEvidence,
    thumbnailStatus: readThumbnailStatus(input.rawMetadata),
  };
}

function readEligibilityOverride(rawMetadata: unknown): ReportEligibility | null {
  if (!rawMetadata || typeof rawMetadata !== "object") return null;
  const eq = (rawMetadata as Record<string, unknown>).evidenceQuality;
  if (!eq || typeof eq !== "object") return null;
  const el = (eq as Record<string, unknown>).reportEligibilityOverride;
  if (
    el === "CLIENT_INCLUDE" ||
    el === "INTERNAL_ONLY" ||
    el === "REVIEW_REQUIRED" ||
    el === "EXCLUDE"
  ) {
    return el;
  }
  return null;
}

export function mergeEvidenceQualityMetadata(
  rawMetadata: unknown,
  quality: EvidenceQualityAssessment
): Record<string, unknown> {
  const base =
    rawMetadata && typeof rawMetadata === "object"
      ? { ...(rawMetadata as Record<string, unknown>) }
      : {};
  base.evidenceQuality = {
    identityConfidence: quality.identityConfidence,
    riskConfidence: quality.riskConfidence,
    contentClass: quality.contentClass,
    reportEligibility: quality.reportEligibility,
    selectionReason: quality.selectionReason,
    identityDecision: quality.identityDecision,
    identityReason: quality.identityReason,
    autocompleteClass: quality.autocompleteClass,
    isSubjectEvidence: quality.isSubjectEvidence,
    thumbnailStatus: quality.thumbnailStatus,
    assessedAt: new Date().toISOString(),
  };
  return base;
}
