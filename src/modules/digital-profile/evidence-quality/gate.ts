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
  isLikelyNamesake,
  parseSubjectName,
} from "../risk-classifier/entity-disambiguation";
import {
  isAdverseContentClass,
  isExcludedContentClass,
  isUsefulProfileContentClass,
  mapResultClassToContentClass,
} from "./content-class";
import type {
  EvidenceItemInput,
  EvidenceQualityAssessment,
  EvidenceSurfaceType,
  ReportEligibility,
  RiskConfidence,
  SelectionReason,
} from "./types";

const USEFUL_PROFILE_MIN_IDENTITY: IdentityConfidence[] = ["HIGH", "MEDIUM"];

function isMeaningfulRelatedQuery(title: string | null | undefined): boolean {
  const t = (title ?? "").trim();
  return t.length >= 3 && !/^[\d\s\-_.]+$/i.test(t);
}

function queryHasSubjectAssociation(
  text: string,
  subjectFullName: string | null | undefined
): boolean {
  if (!subjectFullName?.trim()) return false;
  const subject = parseSubjectName(subjectFullName.trim());
  const hay = text.toLowerCase().replace(/ё/g, "е");
  const has = (token: string | null) =>
    !!token && hay.includes(token.toLowerCase().replace(/ё/g, "е"));
  return has(subject.surname) || has(subject.givenName) || has(subject.patronymic);
}

/** O5.1 — associative surfaces: related queries are not exact-FIO evidence. */
function deriveRelatedQueryEligibility(params: {
  contentClass: ReturnType<typeof mapResultClassToContentClass>;
  identityConfidence: IdentityConfidence;
  riskConfidence: RiskConfidence;
  manualClassification: string | null;
  isFalsePositive: boolean;
  auto: AutoResultClassification | null;
  isDuplicate: boolean;
  reportEligibilityOverride?: ReportEligibility | null;
  title?: string | null;
  subjectFullName?: string | null;
}): ReportEligibility {
  if (params.reportEligibilityOverride) return params.reportEligibilityOverride;
  if (params.isDuplicate) return "EXCLUDE";
  if (params.isFalsePositive) return "EXCLUDE";
  if (params.contentClass === "NAMESAKE" || params.contentClass === "ENTITY_MISMATCH") {
    return "EXCLUDE";
  }

  if (params.manualClassification && isRiskyResultClass(params.manualClassification)) {
    return "CLIENT_INCLUDE";
  }

  if (isAdverseContentClass(params.contentClass)) {
    if (params.identityConfidence === "LOW") return "EXCLUDE";
    if (
      params.auto &&
      isStrongAutoSnapshotRisk(params.auto) &&
      params.riskConfidence === "HIGH"
    ) {
      return "CLIENT_INCLUDE";
    }
    return "REVIEW_REQUIRED";
  }

  const meaningful = isMeaningfulRelatedQuery(params.title);
  const associated = queryHasSubjectAssociation(params.title ?? "", params.subjectFullName);

  if (!meaningful) return "REVIEW_REQUIRED";
  if (params.identityConfidence === "HIGH") return "CLIENT_INCLUDE";
  if (params.identityConfidence === "MEDIUM") return "CLIENT_INCLUDE";
  if (associated) return "INTERNAL_ONLY";
  return "REVIEW_REQUIRED";
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
  if (params.surfaceType === "RELATED_QUERY" && !isAdverseContentClass(params.contentClass)) {
    return "useful_profile_material";
  }
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
  riskConfidence: RiskConfidence;
  manualClassification: string | null;
  isFalsePositive: boolean;
  auto: AutoResultClassification | null;
  reviewStatus: string | null;
  isDuplicate: boolean;
  reportEligibilityOverride?: ReportEligibility | null;
  title?: string | null;
  subjectFullName?: string | null;
}): ReportEligibility {
  if (params.surfaceType === "RELATED_QUERY") {
    return deriveRelatedQueryEligibility(params);
  }
  if (params.reportEligibilityOverride) return params.reportEligibilityOverride;
  if (params.isDuplicate) return "EXCLUDE";
  if (params.isFalsePositive) return "EXCLUDE";
  if (isExcludedContentClass(params.contentClass)) return "EXCLUDE";

  if (params.manualClassification && isRiskyResultClass(params.manualClassification)) {
    return "CLIENT_INCLUDE";
  }

  if (isAdverseContentClass(params.contentClass)) {
    if (params.identityConfidence === "LOW") return "EXCLUDE";
    if (
      params.auto &&
      isStrongAutoSnapshotRisk(params.auto) &&
      params.riskConfidence === "HIGH"
    ) {
      return "CLIENT_INCLUDE";
    }
    if (params.auto?.potentialRiskForReview || params.riskConfidence !== "HIGH") {
      return "REVIEW_REQUIRED";
    }
    return "REVIEW_REQUIRED";
  }

  if (
    isUsefulProfileContentClass(params.contentClass) &&
    USEFUL_PROFILE_MIN_IDENTITY.includes(params.identityConfidence)
  ) {
    return "CLIENT_INCLUDE";
  }

  if (params.auto?.potentialRiskForReview) return "REVIEW_REQUIRED";

  if (
    params.contentClass === "UNKNOWN" ||
    params.contentClass === "LOW_VALUE" ||
    params.identityConfidence === "LOW"
  ) {
    return params.reviewStatus === "REVIEWED" ? "INTERNAL_ONLY" : "EXCLUDE";
  }

  if (params.reviewStatus === "REVIEWED") return "INTERNAL_ONLY";
  return "INTERNAL_ONLY";
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

  const contentClass = mapResultClassToContentClass(classification, input.surfaceType);
  const queryText = (input.title ?? input.query ?? "").trim();
  const subjectParsed = input.subjectFullName?.trim()
    ? parseSubjectName(input.subjectFullName.trim())
    : null;

  if (input.surfaceType === "RELATED_QUERY" && subjectParsed) {
    if (isLikelyNamesake(queryText, subjectParsed)) {
      identityConfidence = "LOW";
    } else if (contentClass === "NAMESAKE") {
      classification = "NEUTRAL";
    }
  }

  const resolvedClass = mapResultClassToContentClass(classification, input.surfaceType);
  if (resolvedClass === "NAMESAKE" || resolvedClass === "ENTITY_MISMATCH") {
    identityConfidence = "LOW";
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
  });
  const reportEligibility = deriveReportEligibility({
    surfaceType: input.surfaceType,
    contentClass: resolvedClass,
    identityConfidence,
    riskConfidence,
    manualClassification: manual.classification,
    isFalsePositive: manual.isFalsePositive,
    auto: autoBlock,
    reviewStatus: input.reviewStatus ?? null,
    isDuplicate: options.isDuplicate ?? false,
    reportEligibilityOverride: override,
    title: input.title ?? input.query,
    subjectFullName: input.subjectFullName,
  });

  const isAdverseForReport =
    reportEligibility === "CLIENT_INCLUDE" &&
    (manual.classification
      ? isRiskyResultClass(manual.classification)
      : autoBlock
        ? isStrongAutoSnapshotRisk(autoBlock)
        : isAdverseContentClass(resolvedClass) && riskConfidence === "HIGH");

  const isUsefulProfileMaterial =
    (reportEligibility === "CLIENT_INCLUDE" || reportEligibility === "INTERNAL_ONLY") &&
    (isUsefulProfileContentClass(resolvedClass) ||
      (input.surfaceType === "RELATED_QUERY" && !isAdverseContentClass(resolvedClass)));

  return {
    identityConfidence,
    riskConfidence,
    contentClass: resolvedClass,
    reportEligibility,
    selectionReason,
    isAdverseForReport,
    isUsefulProfileMaterial,
    duplicateOf: options.isDuplicate ? "dedupe" : null,
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
    assessedAt: new Date().toISOString(),
  };
  return base;
}
