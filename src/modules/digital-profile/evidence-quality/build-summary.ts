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
      });
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
  };
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
