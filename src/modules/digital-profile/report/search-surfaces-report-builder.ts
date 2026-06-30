/**
 * Stage O4 — builds report_json.searchSurfaces from stored evidence.
 *
 * Distinguishes "0 negative" (data collected) from "not collected" (provider not run).
 * Pure aggregation — no network, no LLM.
 */

import { prisma } from "@/server/prisma/client";
import {
  buildSearchMatrix,
  filterMatrixInputsByRegion,
  type SearchMatrix,
} from "../search-surfaces/search-matrix";
import type { OrionRegionCode } from "../search-surfaces/orion-query-plan";
import { regionProfile, type RegionCollectionStatus } from "../search-surfaces/region-profiles";
import { isAdverseSurface } from "../services/orion-search-profile-service";
import {
  isRiskyResultClass,
  readRiskClassification,
} from "../risk-classifier/result-classifier";
import type { SearchSurfaceType } from "../search-surfaces/types";
import { evaluateEvidenceItem } from "../evidence-quality/gate";
import { dedupeEvidenceItems, pickBestRepresentatives } from "../evidence-quality/dedupe";
import { selectEvidenceForReport } from "../evidence-quality/selection-policy";
import type { EvidenceSurfaceType, SurfaceQualityStats } from "../evidence-quality/types";
import type { GatedEvidenceItem } from "../evidence-quality/types";

export interface SurfaceBucketSummary {
  total: number;
  adverse: number;
  collectionStatus: RegionCollectionStatus;
  statusMessage: string;
  items: SurfaceReportItem[];
  /** Stage O5 — quality-gated selection stats. */
  qualityStats?: SurfaceQualityStats;
}

export interface SurfaceReportItem {
  title: string;
  snippet: string | null;
  url: string | null;
  domain: string | null;
  thumbnailUrl: string | null;
  classification: string | null;
  riskTheme: string | null;
  query: string | null;
  rank: number | null;
  /** O5 — report eligibility for client/internal filtering at render. */
  reportEligibility?: string;
  contentClass?: string;
}

export interface RegionSearchSurfacesBlock {
  region: OrionRegionCode;
  label: string;
  language: string;
  collectionStatus: RegionCollectionStatus;
  statusMessage: string;
  organic: SurfaceBucketSummary;
  suggestions: SurfaceBucketSummary;
  relatedQueries: SurfaceBucketSummary;
  images: SurfaceBucketSummary;
  videos: SurfaceBucketSummary;
  knowledgePanel: SurfaceBucketSummary;
  wikipedia: SurfaceBucketSummary;
  matrix: SearchMatrix | null;
  summary: {
    queryVariants: string[];
    totalCheckedResults: number;
    uniqueUrls: number;
    uniqueAdverseUrls: number;
    adversePercentage: number;
    topAdverseThemes: { theme: string; count: number }[];
    topAdverseDomains: { domain: string; count: number }[];
  };
}

export interface SearchSurfacesReportBlock {
  regions: {
    ru: RegionSearchSurfacesBlock;
    uae: RegionSearchSurfacesBlock;
    international: RegionSearchSurfacesBlock;
  };
  globalSummary: {
    regionsCollected: number;
    regionsNotQueried: number;
    totalUniqueUrls: number;
    totalUniqueAdverseUrls: number;
    relatedQueriesTotal: number;
    relatedQueriesNegative: number;
    suggestionsTotal: number;
    imagesTotal: number;
    videosTotal: number;
    knowledgePanelTotal: number;
    /** ABSENT when queried but Serper returned no KG; NOT_COLLECTED when region not run. */
    knowledgePanelStatus: "PRESENT" | "ABSENT" | "NOT_COLLECTED" | "MISMATCH";
  };
  dataQualityWarnings: string[];
}

function isNegativeOrganic(classification: string | null, rawMetadata: unknown): boolean {
  const rc = readRiskClassification(rawMetadata);
  const cls = rc?.manual?.classification ?? rc?.auto?.classification ?? classification;
  if (!cls) return false;
  const q = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    classification: cls,
    rawMetadata,
  });
  return q.isAdverseForReport;
}

const SURFACE_EVIDENCE_TYPE: Partial<Record<SearchSurfaceType, EvidenceSurfaceType>> = {
  SUGGESTION: "SEARCH_SUGGESTION",
  RELATED_QUERY: "RELATED_QUERY",
  IMAGE_RESULT: "IMAGE_RESULT",
  VIDEO_RESULT: "VIDEO_RESULT",
  KNOWLEDGE_BLOCK: "KNOWLEDGE_BLOCK",
};

function bucketFromGatedRows(
  rows: Array<{
    id?: string;
    title: string | null;
    snippet: string | null;
    url: string | null;
    domain: string | null;
    thumbnailUrl: string | null;
    imageUrl: string | null;
    classification: string | null;
    riskTheme: string | null;
    query: string | null;
    rank: number | null;
    rawMetadata?: unknown;
    reviewStatus?: string | null;
    region?: string | null;
  }>,
  surfaceType: EvidenceSurfaceType,
  regionStatus: RegionCollectionStatus,
  regionMessage: string,
  subjectFullName: string | null,
  limit = 20
): SurfaceBucketSummary {
  const gated: GatedEvidenceItem[] = dedupeEvidenceItems(
    rows.map((r) => ({
      id: r.id,
      surfaceType,
      title: r.title,
      url: r.url,
      domain: r.domain,
      snippet: r.snippet,
      classification: r.classification,
      riskTheme: r.riskTheme,
      query: r.query,
      region: r.region,
      rawMetadata: r.rawMetadata,
      reviewStatus: r.reviewStatus,
      subjectFullName,
    })),
    subjectFullName
  ).items;

  const selected = selectEvidenceForReport(gated, "INTERNAL").selected;
  const picked = pickBestRepresentatives(selected, limit);
  const adverse = picked.filter((r) => r.quality.isAdverseForReport).length;
  const excluded = gated.length - picked.length;
  const reviewRequired = gated.filter((r) => r.quality.reportEligibility === "REVIEW_REQUIRED").length;
  const duplicates = gated.filter((r) => r.quality.selectionReason === "duplicate_url").length;

  const qualityStats: SurfaceQualityStats = {
    totalCollected: rows.length,
    selectedForReport: picked.length,
    excludedAsNoise: excluded,
    reviewRequired,
    duplicatesCollapsed: duplicates,
    clientIncluded: picked.filter((r) => r.quality.reportEligibility === "CLIENT_INCLUDE").length,
    dataQualityStatus: rows.length > 0 ? "COLLECTED" : regionStatus === "COLLECTED" ? "EMPTY" : regionStatus,
  };

  if (rows.length > 0) {
    return {
      total: rows.length,
      adverse,
      collectionStatus: "COLLECTED",
      statusMessage: "Data collected.",
      items: picked.map((r, idx) => ({
        title: r.title ?? r.query ?? "",
        snippet: r.snippet ?? null,
        url: r.url ?? null,
        domain: r.domain ?? null,
        thumbnailUrl: (r as { thumbnailUrl?: string | null }).thumbnailUrl ?? null,
        classification: r.classification ?? null,
        riskTheme: r.riskTheme ?? null,
        query: r.query ?? null,
        rank: idx + 1,
        reportEligibility: r.quality.reportEligibility,
        contentClass: r.quality.contentClass,
      })),
      qualityStats,
    };
  }
  if (regionStatus === "COLLECTED") {
    return {
      total: 0,
      adverse: 0,
      collectionStatus: "COLLECTED",
      statusMessage: "Queried — none found for this surface.",
      items: [],
      qualityStats: {
        totalCollected: 0,
        selectedForReport: 0,
        excludedAsNoise: 0,
        reviewRequired: 0,
        duplicatesCollapsed: 0,
        clientIncluded: 0,
        dataQualityStatus: "EMPTY",
      },
    };
  }
  return {
    total: 0,
    adverse: 0,
    collectionStatus: regionStatus,
    statusMessage: regionMessage,
    items: [],
    qualityStats: {
      totalCollected: 0,
      selectedForReport: 0,
      excludedAsNoise: 0,
      reviewRequired: 0,
      duplicatesCollapsed: 0,
      clientIncluded: 0,
      dataQualityStatus: regionStatus,
    },
  };
}

function emptyBucket(status: RegionCollectionStatus, message: string): SurfaceBucketSummary {
  return {
    total: 0,
    adverse: 0,
    collectionStatus: status,
    statusMessage: message,
    items: [],
  };
}

function toSurfaceItem(row: {
  title: string | null;
  snippet: string | null;
  url: string | null;
  domain: string | null;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  classification: string | null;
  riskTheme: string | null;
  query: string | null;
  rank: number | null;
}): SurfaceReportItem {
  return {
    title: row.title ?? row.query ?? "",
    snippet: row.snippet,
    url: row.url,
    domain: row.domain,
    thumbnailUrl: row.thumbnailUrl ?? row.imageUrl,
    classification: row.classification,
    riskTheme: row.riskTheme,
    query: row.query,
    rank: row.rank,
  };
}

function normalizeSurfaceRegion(region: string | null | undefined): OrionRegionCode | null {
  const reg = (region ?? "").trim().toUpperCase();
  if (reg === "RU") return "RU";
  if (reg === "UAE" || reg === "AE") return "UAE";
  if (reg === "INTERNATIONAL" || reg === "INTL" || reg === "GLOBAL") return "INTERNATIONAL";
  return null;
}

function filterSurfacesByRegion(
  rows: Awaited<ReturnType<typeof loadSurfaces>>,
  region: OrionRegionCode
): Awaited<ReturnType<typeof loadSurfaces>> {
  return rows.filter((s) => {
    const tagged = normalizeSurfaceRegion(s.region);
    if (tagged) return tagged === region;
    return region === "RU";
  });
}

function bucketFromRows(
  rows: Array<{
    title: string | null;
    snippet: string | null;
    url: string | null;
    domain: string | null;
    thumbnailUrl: string | null;
    imageUrl: string | null;
    classification: string | null;
    riskTheme: string | null;
    query: string | null;
    rank: number | null;
  }>,
  regionStatus: RegionCollectionStatus,
  regionMessage: string,
  limit = 20
): SurfaceBucketSummary {
  const adverse = rows.filter((r) => isAdverseSurface(r.classification)).length;
  if (rows.length > 0) {
    return {
      total: rows.length,
      adverse,
      collectionStatus: "COLLECTED",
      statusMessage: "Data collected.",
      items: rows.slice(0, limit).map(toSurfaceItem),
    };
  }
  if (regionStatus === "COLLECTED") {
    return {
      total: 0,
      adverse: 0,
      collectionStatus: "COLLECTED",
      statusMessage: "Queried — none found for this surface.",
      items: [],
    };
  }
  return {
    total: 0,
    adverse: 0,
    collectionStatus: regionStatus,
    statusMessage: regionMessage,
    items: [],
  };
}

function deriveRegionCollectionStatus(
  organicCount: number,
  surfaceCount: number,
  region: OrionRegionCode
): { status: RegionCollectionStatus; message: string } {
  if (organicCount + surfaceCount > 0) {
    return { status: "COLLECTED", message: "Search profile data collected." };
  }
  const profile = regionProfile(region);
  if (region !== "RU") {
    return {
      status: "NOT_QUERIED",
      message: `${profile.label} search was not run — provider not queried.`,
    };
  }
  return {
    status: "NOT_QUERIED",
    message: "No search evidence stored for this region.",
  };
}

function buildRegionBlock(
  region: OrionRegionCode,
  organicRows: Awaited<ReturnType<typeof loadOrganic>>,
  surfaceRows: Awaited<ReturnType<typeof loadSurfaces>>,
  wikiRows: Awaited<ReturnType<typeof loadWiki>>,
  subjectFullName: string | null
): RegionSearchSurfacesBlock {
  const profile = regionProfile(region);
  const regionOrganic = filterMatrixInputsByRegion(
    organicRows.map((r) => ({
      id: r.id,
      engine: r.engine,
      url: r.url,
      title: r.title,
      snippet: r.snippet,
      rank: r.rank,
      classification: r.classification,
      rawMetadata: r.rawMetadata,
    })),
    region
  );

  const regionSurfaces = filterSurfacesByRegion(surfaceRows, region);

  const derived = deriveRegionCollectionStatus(regionOrganic.length, regionSurfaces.length, region);
  const matrix = regionOrganic.length > 0 ? buildSearchMatrix(regionOrganic) : null;

  const byType = (type: SearchSurfaceType) =>
    regionSurfaces.filter((s) => s.type === type);

  const organicAdverse = regionOrganic.filter((r) =>
    isNegativeOrganic(r.classification, r.rawMetadata)
  );

  const surfaceInput = (type: SearchSurfaceType) =>
    byType(type).map((s) => ({
      id: (s as { id?: string }).id,
      title: s.title,
      snippet: s.snippet,
      url: s.url,
      domain: s.domain,
      thumbnailUrl: s.thumbnailUrl,
      imageUrl: s.imageUrl,
      classification: s.classification,
      riskTheme: s.riskTheme,
      query: s.query,
      rank: s.rank,
      rawMetadata: s.rawMetadata,
      reviewStatus: s.reviewStatus,
      region,
    }));

  const gatedBucket = (type: SearchSurfaceType) =>
    bucketFromGatedRows(
      surfaceInput(type),
      SURFACE_EVIDENCE_TYPE[type] ?? "SEARCH_SUGGESTION",
      derived.status,
      derived.message,
      subjectFullName,
      type === "RELATED_QUERY" ? 15 : 20
    );

  const wikiLang = region === "RU" ? "ru" : "en";
  const wiki = wikiRows.filter((w) => (w.language ?? "").toLowerCase().startsWith(wikiLang));

  return {
    region,
    label: profile.label,
    language: profile.language,
    collectionStatus: derived.status,
    statusMessage: derived.message,
    organic: bucketFromGatedRows(
      regionOrganic.map((r) => ({
        id: r.id,
        title: r.title,
        snippet: r.snippet,
        url: r.url,
        domain: null,
        thumbnailUrl: null,
        imageUrl: null,
        classification: r.classification,
        riskTheme: null,
        query: ((r.rawMetadata ?? {}) as Record<string, unknown>).orionQuery as string | null ?? null,
        rank: r.rank,
        rawMetadata: r.rawMetadata,
        reviewStatus: null,
        region,
      })),
      "SEARCH_RESULT",
      derived.status,
      derived.message,
      subjectFullName,
      20
    ),
    suggestions: gatedBucket("SUGGESTION"),
    relatedQueries: gatedBucket("RELATED_QUERY"),
    images: gatedBucket("IMAGE_RESULT"),
    videos: gatedBucket("VIDEO_RESULT"),
    knowledgePanel: gatedBucket("KNOWLEDGE_BLOCK"),
    wikipedia: {
      total: wiki.length,
      adverse: 0,
      collectionStatus: wiki.length > 0 ? "COLLECTED" : derived.status,
      statusMessage: wiki.length > 0 ? "Wikipedia check present." : derived.message,
      items: wiki.map((w) => ({
        title: w.pageTitle ?? "Wikipedia",
        snippet: w.exists ? "Page exists" : "No page",
        url: w.url,
        domain: w.url ? "wikipedia.org" : null,
        thumbnailUrl: null,
        classification: null,
        riskTheme: null,
        query: null,
        rank: null,
      })),
    },
    matrix,
    summary: {
      queryVariants: matrix?.summary.queryVariants ?? [],
      totalCheckedResults: matrix?.summary.totalResultRows ?? regionOrganic.length,
      uniqueUrls: matrix?.summary.uniqueUrls ?? new Set(regionOrganic.map((r) => r.url)).size,
      uniqueAdverseUrls:
        matrix?.summary.uniqueAdverseUrls ??
        new Set(organicAdverse.map((r) => r.url)).size,
      adversePercentage: matrix?.summary.adversePercentage ?? 0,
      topAdverseThemes: matrix?.summary.topAdverseThemes ?? [],
      topAdverseDomains: matrix?.summary.topAdverseDomains ?? [],
    },
  };
}

async function loadOrganic(caseId: string) {
  return prisma.searchResult.findMany({
    where: { caseId },
    select: {
      id: true,
      engine: true,
      url: true,
      title: true,
      snippet: true,
      rank: true,
      classification: true,
      rawMetadata: true,
      source: true,
    },
  });
}

async function loadSurfaces(caseId: string) {
  return prisma.searchSurfaceItem.findMany({
    where: { caseId, deletedAt: null, demo: false, type: { not: "MANUAL_NOTE" } },
    select: {
      id: true,
      type: true,
      region: true,
      title: true,
      snippet: true,
      url: true,
      domain: true,
      thumbnailUrl: true,
      imageUrl: true,
      classification: true,
      riskTheme: true,
      query: true,
      rank: true,
      reviewStatus: true,
      rawMetadata: true,
    },
  });
}

async function loadWiki(caseId: string) {
  return prisma.wikipediaCheck.findMany({
    where: { caseId },
    select: { exists: true, url: true, language: true, pageTitle: true },
  });
}

export async function buildSearchSurfacesReportBlock(
  caseId: string,
  options: { includeDemo?: boolean } = {}
): Promise<SearchSurfacesReportBlock> {
  const subjectRow = await prisma.case.findFirst({
    where: { id: caseId },
    select: { subjects: { orderBy: { createdAt: "asc" }, take: 1, select: { fullName: true } } },
  });
  const subjectFullName = subjectRow?.subjects[0]?.fullName ?? null;

  const [organicRows, surfaceRows, wikiRows] = await Promise.all([
    loadOrganic(caseId),
    loadSurfaces(caseId),
    loadWiki(caseId),
  ]);

  const organic = options.includeDemo
    ? organicRows
    : organicRows.filter((r) => !String(r.source ?? "").includes("mock"));

  const ru = buildRegionBlock("RU", organic, surfaceRows, wikiRows, subjectFullName);
  const uae = buildRegionBlock("UAE", organic, surfaceRows, wikiRows, subjectFullName);
  const international = buildRegionBlock("INTERNATIONAL", organic, surfaceRows, wikiRows, subjectFullName);

  const blocks = [ru, uae, international];
  const warnings: string[] = [];
  for (const b of blocks) {
    if (b.collectionStatus === "NOT_QUERIED" || b.collectionStatus === "NOT_CONFIGURED") {
      warnings.push(b.statusMessage);
    }
  }

  const collected = blocks.filter((b) => b.collectionStatus === "COLLECTED");
  const notQueried = blocks.filter(
    (b) => b.collectionStatus === "NOT_QUERIED" || b.collectionStatus === "NOT_CONFIGURED"
  );

  const sumBucket = (pick: (b: RegionSearchSurfacesBlock) => SurfaceBucketSummary) =>
    blocks.reduce((n, b) => n + pick(b).total, 0);
  const sumAdverse = (pick: (b: RegionSearchSurfacesBlock) => SurfaceBucketSummary) =>
    blocks.reduce((n, b) => n + pick(b).adverse, 0);

  const knowledgeTotal = sumBucket((b) => b.knowledgePanel);
  const knowledgeStatus: SearchSurfacesReportBlock["globalSummary"]["knowledgePanelStatus"] =
    knowledgeTotal > 0
      ? blocks.some((b) =>
          b.knowledgePanel.items.some((i) => i.classification === "ENTITY_CONFUSION")
        )
        ? "MISMATCH"
        : "PRESENT"
      : collected.length > 0
        ? "ABSENT"
        : "NOT_COLLECTED";

  return {
    regions: { ru, uae, international },
    globalSummary: {
      regionsCollected: collected.length,
      regionsNotQueried: notQueried.length,
      totalUniqueUrls:
        ru.summary.uniqueUrls + uae.summary.uniqueUrls + international.summary.uniqueUrls,
      totalUniqueAdverseUrls:
        ru.summary.uniqueAdverseUrls +
        uae.summary.uniqueAdverseUrls +
        international.summary.uniqueAdverseUrls,
      relatedQueriesTotal: sumBucket((b) => b.relatedQueries),
      relatedQueriesNegative: sumAdverse((b) => b.relatedQueries),
      suggestionsTotal: sumBucket((b) => b.suggestions),
      imagesTotal: sumBucket((b) => b.images),
      videosTotal: sumBucket((b) => b.videos),
      knowledgePanelTotal: knowledgeTotal,
      knowledgePanelStatus: knowledgeStatus,
    },
    dataQualityWarnings: warnings,
  };
}

function regionHasEvidence(block: RegionSearchSurfacesBlock): boolean {
  return (
    block.organic.total +
      block.suggestions.total +
      block.relatedQueries.total +
      block.images.total +
      block.videos.total +
      block.knowledgePanel.total >
    0
  );
}

/** Maps searchSurfaces region block onto auditSummary-compatible region dict. */
export function regionBlockToAuditRegion(
  block: RegionSearchSurfacesBlock
): Record<string, unknown> | null {
  if (block.collectionStatus !== "COLLECTED" && !regionHasEvidence(block)) {
    return null;
  }
  return {
    region: block.region,
    language: block.language,
    organicTotal: block.organic.total,
    organicNegative: block.organic.adverse,
    organicNegativeShare:
      block.organic.total > 0 ? block.organic.adverse / block.organic.total : 0,
    uniqueNegativeUrls: block.summary.uniqueAdverseUrls,
    totalUniqueUrls: block.summary.uniqueUrls,
    suggestionsTotal: block.suggestions.total,
    suggestionsNegative: block.suggestions.adverse,
    relatedQueriesTotal: block.relatedQueries.total,
    relatedQueriesNegative: block.relatedQueries.adverse,
    imagesTotal: block.images.total,
    imagesNegative: block.images.adverse,
    videosTotal: block.videos.total,
    videosNegative: block.videos.adverse,
    knowledgeBlockStatus:
      block.knowledgePanel.total > 0
        ? block.knowledgePanel.items.some((i) => i.classification === "ENTITY_CONFUSION")
          ? "MISMATCH"
          : "PRESENT"
        : block.collectionStatus === "COLLECTED"
          ? "ABSENT"
          : "NOT_COLLECTED",
    collectionStatus: block.collectionStatus,
    statusMessage: block.statusMessage,
    topResults: block.organic.items.slice(0, 20).map((i, idx) => ({
      provider: "GOOGLE",
      rank: i.rank ?? idx + 1,
      domain: i.domain ?? "",
      title: i.title,
      classification: i.classification,
    })),
    topSuggestions: block.suggestions.items.map((i) => i.title),
    topRelatedQueries: block.relatedQueries.items.map((i) => i.title),
    topImages: block.images.items.map((i) => ({
      title: i.title,
      url: i.thumbnailUrl ?? i.url,
    })),
    topVideos: block.videos.items.map((i) => ({
      title: i.title,
      url: i.thumbnailUrl ?? i.url,
    })),
    topThemes: block.summary.topAdverseThemes.map((t) => ({ theme: t.theme, count: t.count })),
    topNegativeDomains: block.summary.topAdverseDomains.map((d) => d.domain),
    topNegativeUrls: block.organic.items
      .filter((i) => {
        const q = evaluateEvidenceItem({
          surfaceType: "SEARCH_RESULT",
          title: i.title,
          classification: i.classification,
          subjectFullName: null,
        });
        return q.isAdverseForReport;
      })
      .slice(0, 10)
      .map((i) => ({
        title: i.title,
        domain: i.domain ?? "",
        classification: i.classification,
      })),
    regionConclusion:
      block.collectionStatus === "NOT_QUERIED" || block.collectionStatus === "NOT_CONFIGURED"
        ? block.statusMessage
        : block.organic.adverse > 0
          ? `Adverse organic content detected (${block.organic.adverse}/${block.organic.total}).`
          : "No adverse organic content in collected results.",
    regionRiskLevel:
      block.collectionStatus !== "COLLECTED" && block.organic.total === 0
        ? "UNKNOWN"
        : block.summary.adversePercentage >= 25
          ? "HIGH"
          : block.summary.adversePercentage >= 10
            ? "MEDIUM"
            : "LOW",
  };
}
