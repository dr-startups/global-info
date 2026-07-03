import type { SearchSurfacesReportBlock, SurfaceReportItem } from "./search-surfaces-report-builder";

export interface ReportSourceQualitySummary {
  totalCollected: number;
  uniqueSources: number;
  duplicateCount: number;
  includedCount: number;
  reviewCount: number;
  excludedCount: number;
  unavailableCount: number;
  bySurfaceType: Record<string, number>;
  byProvider: Record<string, number>;
  topDuplicateDomains: Array<{ domain: string; count: number }>;
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  lowConfidenceCount: number;
  unknownConfidenceCount: number;
  namesakeSuppressionCount?: number;
  fallbackSourceCount?: number;
  explanation: { ru: string; en: string };
}

function collectItems(block: SearchSurfacesReportBlock): SurfaceReportItem[] {
  const out: SurfaceReportItem[] = [];
  for (const region of Object.values(block.regions)) {
    for (const bucket of [
      region.organic,
      region.suggestions,
      region.relatedQueries,
      region.images,
      region.videos,
      region.knowledgePanel,
      region.wikipedia,
    ]) {
      for (const row of bucket.items) out.push(row);
    }
  }
  return out;
}

export function buildReportSourceQualitySummary(
  block: SearchSurfacesReportBlock
): ReportSourceQualitySummary {
  const rows = collectItems(block);
  const totalCollected = Object.values(block.regions).reduce((sum, region) => {
    return (
      sum +
      (region.organic.qualityStats?.totalCollected ?? region.organic.total) +
      (region.suggestions.qualityStats?.totalCollected ?? region.suggestions.total) +
      (region.relatedQueries.qualityStats?.totalCollected ?? region.relatedQueries.total) +
      (region.images.qualityStats?.totalCollected ?? region.images.total) +
      (region.videos.qualityStats?.totalCollected ?? region.videos.total) +
      (region.knowledgePanel.qualityStats?.totalCollected ?? region.knowledgePanel.total)
    );
  }, 0);
  const uniq = new Set<string>();
  const bySurfaceType: Record<string, number> = {};
  const byProvider: Record<string, number> = {};
  const dupDomain = new Map<string, number>();
  let duplicateCount = 0;
  let includedCount = 0;
  let reviewCount = 0;
  let excludedCount = 0;
  let unavailableCount = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  let unknown = 0;
  let namesakeSuppression = 0;
  let fallback = 0;

  for (const r of rows) {
    const fp = r.sourceFingerprint ?? r.canonicalUrlKey ?? `${r.domain ?? ""}|${r.title ?? ""}`;
    if (fp) uniq.add(fp);
    const surf = String(r.sourceSurfaceType ?? "unknown");
    bySurfaceType[surf] = (bySurfaceType[surf] ?? 0) + 1;
    const provider = String(r.providerKey ?? "unknown");
    byProvider[provider] = (byProvider[provider] ?? 0) + 1;
    const decision = String(r.sourceQualityDecision ?? "");
    if (decision === "duplicate") {
      duplicateCount += 1;
      const d = String(r.canonicalDomain ?? r.domain ?? "");
      if (d) dupDomain.set(d, (dupDomain.get(d) ?? 0) + 1);
    } else if (decision === "include") includedCount += 1;
    else if (decision === "review") reviewCount += 1;
    else if (decision === "exclude") excludedCount += 1;
    else if (decision === "unavailable") unavailableCount += 1;
    else if (decision === "fallback") fallback += 1;

    if (String(r.sourceQualityReason ?? "") === "namesake_risk") namesakeSuppression += 1;
    const c = String(r.confidenceLabel ?? "unknown");
    if (c === "high") high += 1;
    else if (c === "medium") medium += 1;
    else if (c === "low") low += 1;
    else unknown += 1;
  }

  const topDuplicateDomains = [...dupDomain.entries()]
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalCollected,
    uniqueSources: uniq.size,
    duplicateCount,
    includedCount,
    reviewCount,
    excludedCount,
    unavailableCount,
    bySurfaceType,
    byProvider,
    topDuplicateDomains,
    highConfidenceCount: high,
    mediumConfidenceCount: medium,
    lowConfidenceCount: low,
    unknownConfidenceCount: unknown,
    namesakeSuppressionCount: namesakeSuppression || undefined,
    fallbackSourceCount: fallback || undefined,
    explanation: {
      ru: "Повторы и нерелевантные совпадения отфильтрованы; включены только приоритетные материалы.",
      en: "Duplicate and low-relevance matches are filtered; priority evidence is retained.",
    },
  };
}
