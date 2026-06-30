/**
 * Stage O5 — builds evidenceQuality summary for report_json.
 */

import type {
  EvidenceItemInput,
  EvidenceQualitySummary,
  EvidenceSurfaceType,
  GatedEvidenceItem,
  SelectionReason,
  SurfaceQualityStats,
} from "./types";
import { dedupeEvidenceItems } from "./dedupe";
import { evaluateEvidenceItem } from "./gate";

function surfaceKey(type: EvidenceSurfaceType): EvidenceSurfaceType {
  return type;
}

export function buildEvidenceQualitySummary(
  items: EvidenceItemInput[],
  subjectFullName?: string | null
): EvidenceQualitySummary {
  const { items: gated, duplicatesCollapsed } = dedupeEvidenceItems(items, subjectFullName);

  const totals = {
    collected: gated.length,
    clientIncluded: 0,
    internalOnly: 0,
    reviewRequired: 0,
    excluded: 0,
    duplicates: duplicatesCollapsed,
  };

  const bySurface: EvidenceQualitySummary["bySurface"] = {};
  const byRegion: EvidenceQualitySummary["byRegion"] = {};
  const exclusionCounts = new Map<SelectionReason, number>();

  const usefulProfileMaterials: EvidenceQualitySummary["usefulProfileMaterials"] = [];
  const highConfidenceRisks: EvidenceQualitySummary["highConfidenceRisks"] = [];
  const reviewQueue: EvidenceQualitySummary["reviewQueue"] = [];

  const identityMetrics = {
    collectedTotal: 0,
    subjectMatchedTotal: 0,
    exactSubject: 0,
    likelySubject: 0,
    possibleSubject: 0,
    namesakesExcluded: 0,
    entityMismatchesExcluded: 0,
    insufficientMatchesExcluded: 0,
    lowValueExcluded: 0,
    selectedForClient: 0,
    selectedForInternalReview: 0,
  };

  const autocompleteMetrics = {
    total: 0,
    exactSubjectQueries: 0,
    adjacentPersonQueries: 0,
    typoOrSimilarQueries: 0,
    riskQueries: 0,
    clientShown: 0,
    excludedFromEvidence: 0,
  };

  const imageMetrics = {
    collected: 0,
    thumbnailsFetched: 0,
    thumbnailsAvailable: 0,
    subjectMatched: 0,
    selectedForReport: 0,
    excludedNamesakeOrNoise: 0,
    fetchFailed: 0,
  };

  const AUTOCOMPLETE_SURFACES: EvidenceSurfaceType[] = ["SEARCH_SUGGESTION", "RELATED_QUERY"];

  for (const item of gated) {
    const q = item.quality;
    switch (q.reportEligibility) {
      case "CLIENT_INCLUDE":
        totals.clientIncluded += 1;
        break;
      case "INTERNAL_ONLY":
        totals.internalOnly += 1;
        break;
      case "REVIEW_REQUIRED":
        totals.reviewRequired += 1;
        break;
      case "EXCLUDE":
        totals.excluded += 1;
        break;
    }

    if (q.reportEligibility === "EXCLUDE" || q.selectionReason === "duplicate_url") {
      exclusionCounts.set(q.selectionReason, (exclusionCounts.get(q.selectionReason) ?? 0) + 1);
    }

    const st = surfaceKey(item.surfaceType);
    const surf: SurfaceQualityStats = bySurface[st] ?? {
      totalCollected: 0,
      selectedForReport: 0,
      excludedAsNoise: 0,
      reviewRequired: 0,
      duplicatesCollapsed: 0,
      clientIncluded: 0,
      dataQualityStatus: "COLLECTED",
    };
    surf.totalCollected += 1;
    if (q.reportEligibility === "CLIENT_INCLUDE") {
      surf.selectedForReport += 1;
      surf.clientIncluded += 1;
    } else if (q.reportEligibility === "REVIEW_REQUIRED") {
      surf.reviewRequired += 1;
      surf.selectedForReport += 1;
    } else if (q.reportEligibility === "INTERNAL_ONLY") {
      surf.selectedForReport += 1;
    } else {
      surf.excludedAsNoise += 1;
    }
    if (q.selectionReason === "duplicate_url") surf.duplicatesCollapsed += 1;
    bySurface[st] = surf;

    const reg = (item.region ?? "UNKNOWN").toUpperCase();
    const rr = byRegion[reg] ?? { collected: 0, selected: 0, excluded: 0, reviewRequired: 0 };
    rr.collected += 1;
    if (q.reportEligibility === "CLIENT_INCLUDE" || q.reportEligibility === "INTERNAL_ONLY") {
      rr.selected += 1;
    } else if (q.reportEligibility === "REVIEW_REQUIRED") {
      rr.reviewRequired += 1;
      rr.selected += 1;
    } else {
      rr.excluded += 1;
    }
    byRegion[reg] = rr;

    if (q.isUsefulProfileMaterial) {
      usefulProfileMaterials.push({
        title: item.title ?? item.query ?? "",
        contentClass: q.contentClass,
        region: item.region,
      });
    }
    if (q.isAdverseForReport && q.riskConfidence === "HIGH") {
      highConfidenceRisks.push({
        title: item.title ?? item.query ?? "",
        contentClass: q.contentClass,
        region: item.region,
      });
    }
    if (q.reportEligibility === "REVIEW_REQUIRED") {
      reviewQueue.push({
        id: item.id,
        title: item.title ?? item.query ?? "",
        surfaceType: item.surfaceType,
        contentClass: q.contentClass,
        selectionReason: q.selectionReason,
        region: item.region,
        identityDecision: q.identityDecision,
        autocompleteClass: q.autocompleteClass,
      });
    }

    if (AUTOCOMPLETE_SURFACES.includes(item.surfaceType)) {
      autocompleteMetrics.total += 1;
      const ac = q.autocompleteClass;
      if (ac === "EXACT_SUBJECT_QUERY" || ac === "SUBJECT_BROAD_QUERY") {
        autocompleteMetrics.exactSubjectQueries += 1;
      } else if (ac === "ADJACENT_PERSON_QUERY" || ac === "NAMESAKE_QUERY") {
        autocompleteMetrics.adjacentPersonQueries += 1;
      } else if (ac === "TYPO_OR_SIMILAR_QUERY") {
        autocompleteMetrics.typoOrSimilarQueries += 1;
      } else if (ac === "RISK_QUERY") {
        autocompleteMetrics.riskQueries += 1;
      }
      if (q.reportEligibility !== "EXCLUDE") autocompleteMetrics.clientShown += 1;
      autocompleteMetrics.excludedFromEvidence += 1;
    } else {
      identityMetrics.collectedTotal += 1;
      const id = q.identityDecision;
      if (id === "EXACT_SUBJECT") identityMetrics.exactSubject += 1;
      else if (id === "LIKELY_SUBJECT") identityMetrics.likelySubject += 1;
      else if (id === "POSSIBLE_SUBJECT") identityMetrics.possibleSubject += 1;
      else if (id === "NAMESAKE") identityMetrics.namesakesExcluded += 1;
      else if (id === "ENTITY_MISMATCH") identityMetrics.entityMismatchesExcluded += 1;
      else if (id === "INSUFFICIENT_MATCH") identityMetrics.insufficientMatchesExcluded += 1;
      if (q.contentClass === "LOW_VALUE" && q.reportEligibility === "EXCLUDE") {
        identityMetrics.lowValueExcluded += 1;
      }
      if (q.isSubjectEvidence) identityMetrics.subjectMatchedTotal += 1;
      if (q.reportEligibility === "CLIENT_INCLUDE") identityMetrics.selectedForClient += 1;
      if (q.reportEligibility === "REVIEW_REQUIRED" || q.reportEligibility === "INTERNAL_ONLY") {
        identityMetrics.selectedForInternalReview += 1;
      }
    }

    if (item.surfaceType === "IMAGE_RESULT") {
      imageMetrics.collected += 1;
      const thumbStatus = q.thumbnailStatus ?? readThumbFromMeta(item.rawMetadata);
      if (thumbStatus === "AVAILABLE") {
        imageMetrics.thumbnailsAvailable += 1;
        imageMetrics.thumbnailsFetched += 1;
      } else if (thumbStatus === "FAILED" || thumbStatus === "BLOCKED" || thumbStatus === "UNSAFE") {
        imageMetrics.fetchFailed += 1;
      }
      if (q.isSubjectEvidence) imageMetrics.subjectMatched += 1;
      if (q.reportEligibility === "CLIENT_INCLUDE" || q.reportEligibility === "INTERNAL_ONLY") {
        imageMetrics.selectedForReport += 1;
      }
      if (q.reportEligibility === "EXCLUDE") imageMetrics.excludedNamesakeOrNoise += 1;
    }
  }

  const topExclusionReasons = [...exclusionCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    totals,
    bySurface,
    byRegion,
    topExclusionReasons,
    usefulProfileMaterials: usefulProfileMaterials.slice(0, 20),
    highConfidenceRisks: highConfidenceRisks.slice(0, 15),
    reviewQueue: reviewQueue.slice(0, 50),
    identity: identityMetrics,
    autocompleteExposure: autocompleteMetrics,
    imageEvidence: imageMetrics,
  };
}

function readThumbFromMeta(rawMetadata: unknown): string | undefined {
  if (!rawMetadata || typeof rawMetadata !== "object") return undefined;
  const eq = (rawMetadata as Record<string, unknown>).evidenceQuality;
  if (!eq || typeof eq !== "object") return undefined;
  const st = (eq as Record<string, unknown>).thumbnailStatus;
  return typeof st === "string" ? st : undefined;
}

export function gateItemsForReport(
  items: EvidenceItemInput[],
  subjectFullName?: string | null
): GatedEvidenceItem[] {
  const { items: gated } = dedupeEvidenceItems(items, subjectFullName);
  return gated.map((item) => ({
    ...item,
    quality: item.quality ?? evaluateEvidenceItem(item),
  }));
}

/** Caps overall risk when only weak/pending signals exist. */
export function capOverallRiskFromQuality(
  level: string,
  summary: EvidenceQualitySummary,
  reviewedHighFindings: number
): string {
  if (level === "CRITICAL" && summary.highConfidenceRisks.length === 0 && reviewedHighFindings === 0) {
    return summary.totals.reviewRequired > 0 ? "MEDIUM" : "LOW";
  }
  if (level === "HIGH" && summary.highConfidenceRisks.length === 0 && reviewedHighFindings === 0) {
    return summary.totals.reviewRequired > 0 ? "MEDIUM" : "LOW";
  }
  return level;
}
