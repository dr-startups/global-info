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
import {
  AUTOCOMPLETE_EXPOSURE_GROUPS,
  autocompleteGroupLabel,
} from "../evidence-quality/autocomplete-class";
import {
  ensureImageThumbnail,
} from "../evidence-quality/image-thumbnail-service";
import type { AutocompleteClass, EvidenceSurfaceType, SurfaceQualityStats } from "../evidence-quality/types";
import type { GatedEvidenceItem } from "../evidence-quality/types";
import { annotateSourceQuality, type SourceQualitySummary } from "../evidence-quality/source-quality";
import { Prisma } from "@prisma/client";

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
  /** O5.3 — identity / autocomplete exposure metadata. */
  identityDecision?: string;
  autocompleteClass?: string;
  autocompleteGroup?: string;
  thumbnailStorageKey?: string | null;
  thumbnailStatus?: string;
  sourcePageUrl?: string | null;
  /** Stage R4.2 — normalized source-quality and dedup metadata. */
  sourceFingerprint?: string;
  canonicalUrlKey?: string | null;
  canonicalDomain?: string | null;
  canonicalTitleKey?: string | null;
  providerKey?: string;
  sourceSurfaceType?: string;
  language?: string | null;
  sourceRegion?: string | null;
  duplicateGroupId?: string | null;
  duplicateRank?: number | null;
  duplicateReason?: string | null;
  sourceQualityDecision?: string;
  sourceQualityReason?: string;
  confidenceLabel?: string;
  sourceRank?: number;
  sourceScoreBucket?: string;
  clientSafeReason?: string;
  internalReason?: string;
  rankingFactors?: Record<string, number>;
  limitingFactors?: string[];
  /** Stage R4.3 — query/screenshot provenance linkage. */
  queryId?: string;
  queryPurpose?: string;
  providerLabel?: string;
  screenshotId?: string | null;
  surfaceId?: string;
}

export interface AutocompleteSuggestionGroup {
  key: "exact" | "adjacent" | "typo" | "other";
  label: string;
  items: string[];
}

export interface SurfaceBucketSummary {
  total: number;
  adverse: number;
  collectionStatus: RegionCollectionStatus;
  statusMessage: string;
  items: SurfaceReportItem[];
  /** Stage O5 — quality-gated selection stats. */
  qualityStats?: SurfaceQualityStats;
  /** O5.3 — grouped autocomplete exposure (suggestions / related). */
  suggestionGroups?: AutocompleteSuggestionGroup[];
  exposureDisclaimer?: string;
  /** O5.3 — internal image selection stats. */
  imageSelectionNote?: string;
  /** O5.4 — excluded namesakes/noise (internal appendix only). */
  excludedItems?: SurfaceReportItem[];
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
  /** Stage R4.2 — report-level source quality summary. */
  sourceQualitySummary?: SourceQualitySummary;
}

function normalizeDomainCandidate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const withoutScheme = raw.replace(/^https?:\/\//i, "");
  const host = withoutScheme.split("/")[0]?.trim().replace(/^www\./i, "") ?? "";
  if (!host) return null;
  const normalized = host.toLowerCase();
  if (!/[a-z0-9-]+\.[a-z]{2,}/i.test(normalized)) return null;
  return normalized;
}

function extractDomainFromMetadata(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const rec = meta as Record<string, unknown>;
  const candidates = [
    rec.canonicalDomain,
    rec.hostname,
    rec.normalizedDomain,
    rec.displayDomain,
    rec.sourceDomain,
    rec.sourceHost,
    rec.canonicalUrl,
    rec.sourcePageUrl,
    rec.url,
  ];
  for (const candidate of candidates) {
    const parsed = normalizeDomainCandidate(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function resolveSurfaceDomain(input: {
  domain?: string | null;
  canonicalDomain?: string | null;
  canonicalUrl?: string | null;
  sourcePageUrl?: string | null;
  url?: string | null;
  hostname?: string | null;
  normalizedDomain?: string | null;
  rawMetadata?: unknown;
}): string | null {
  const candidates: unknown[] = [
    input.canonicalDomain,
    input.domain,
    input.canonicalUrl,
    input.sourcePageUrl,
    input.url,
    input.hostname,
    input.normalizedDomain,
  ];
  for (const candidate of candidates) {
    const parsed = normalizeDomainCandidate(candidate);
    if (parsed) return parsed;
  }
  return extractDomainFromMetadata(input.rawMetadata);
}

function hasCyrillic(value: string): boolean {
  return /[\u0400-\u04FF]/.test(value);
}

function topicLabel(theme: string | null | undefined, ru: boolean): string {
  const key = String(theme ?? "").trim().toLowerCase();
  if (!key) return "";
  const ruMap: Record<string, string> = {
    political_exposure: "Политическая экспозиция",
    criminal: "Уголовно-правовые упоминания",
    legal_dispute: "Судебные / правовые споры",
    sanctions: "Санкционные / watchlist-сигналы",
    sanctions_watchlist: "Санкционные / watchlist-сигналы",
    adverse_media: "Негативные публикации",
    regulatory: "Регуляторные упоминания",
    corporate_ownership: "Корпоративные и имущественные связи",
    unknown: "Тема требует классификации",
  };
  const enMap: Record<string, string> = {
    political_exposure: "Political exposure",
    criminal: "Criminal-law mentions",
    legal_dispute: "Legal disputes",
    sanctions: "Sanctions / watchlist signals",
    sanctions_watchlist: "Sanctions / watchlist signals",
    adverse_media: "Adverse media coverage",
    regulatory: "Regulatory mentions",
    corporate_ownership: "Corporate and ownership links",
    unknown: "Theme requires classification",
  };
  const mapped = (ru ? ruMap : enMap)[key];
  return mapped ?? (ru ? "Тема требует классификации" : "Theme requires classification");
}

function buildRegionConclusion(
  block: RegionSearchSurfacesBlock,
  organicSelected: SurfaceReportItem[],
  imageItems: SurfaceReportItem[],
  videoItems: SurfaceReportItem[],
  reportLanguage: "ru" | "en"
): string {
  const ruReport = reportLanguage === "ru";
  const noIntlSubjectResults =
    block.region !== "RU" &&
    organicSelected.length === 0 &&
    imageItems.length === 0 &&
    videoItems.length === 0 &&
    block.collectionStatus === "COLLECTED";
  if (block.collectionStatus === "NOT_QUERIED" || block.collectionStatus === "NOT_CONFIGURED") {
    return block.statusMessage;
  }
  if (noIntlSubjectResults) {
    return ruReport
      ? "Подтверждённых международных материалов по субъекту не выявлено."
      : "No international subject-matched results in collected data.";
  }
  const adverseCount = block.organic.adverse;
  const hasRiskSignals =
    (block.summary.topAdverseThemes?.length ?? 0) > 0 ||
    (block.summary.topAdverseDomains?.length ?? 0) > 0;
  if (adverseCount > 0) {
    return ruReport
      ? `В открытых источниках обнаружены материалы, требующие аналитической проверки (${adverseCount}/${Math.max(1, block.organic.total)}). Часть сигналов может относиться к совпадениям по имени или контексту, поэтому итоговая оценка должна подтверждаться вручную.`
      : `Detected ${adverseCount} potentially adverse material(s) (${adverseCount}/${Math.max(1, block.organic.total)}); analyst review is recommended.`;
  }
  if (hasRiskSignals) {
    return ruReport
      ? "Подтверждённых негативных URL в основном списке не выявлено, однако обнаружены тематические риск-сигналы и домены, требующие аналитической проверки."
      : "No confirmed adverse URLs were detected in the primary list, but thematic risk signals and domains require analyst review.";
  }
  return ruReport
    ? "Подтверждённых негативных материалов по выбранным релевантным результатам не выявлено. Отдельные сигналы сохранены для аналитической проверки."
    : "No adverse organic content in selected subject-matched results.";
}

function isNegativeOrganic(
  classification: string | null,
  rawMetadata: unknown,
  subjectFullName: string | null,
  title?: string | null,
  snippet?: string | null
): boolean {
  const rc = readRiskClassification(rawMetadata);
  const cls = rc?.manual?.classification ?? rc?.auto?.classification ?? classification;
  if (!cls) return false;
  const q = evaluateEvidenceItem({
    surfaceType: "SEARCH_RESULT",
    title,
    snippet,
    classification: cls,
    rawMetadata,
    subjectFullName,
  });
  return q.isAdverseForReport;
}

type SurfaceRowInput = {
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
  subjectAliases?: string[];
  subjectCountry?: string | null;
  subjectNationality?: string | null;
  subjectRegionHints?: string[];
};

type SubjectIdentityContext = {
  fullName: string | null;
  aliases: string[];
  country: string | null;
  nationality: string | null;
  regionHints: string[];
};

function mapGatedToReportItem(
  r: GatedEvidenceItem & { thumbnailUrl?: string | null; imageUrl?: string | null },
  idx: number
): SurfaceReportItem {
  const rawUrl = (r.url ?? "").trim();
  const sourceUrl =
    rawUrl.startsWith("http://") || rawUrl.startsWith("https://")
      ? rawUrl
      : rawUrl.startsWith("/goto?url=")
        ? `https://www.google.com/search?q=${encodeURIComponent(r.title ?? r.query ?? "source")}`
        : rawUrl || null;
  const ac = r.quality.autocompleteClass;
  const group = ac ? AUTOCOMPLETE_EXPOSURE_GROUPS[ac as AutocompleteClass] : undefined;
  const eq =
    r.rawMetadata && typeof r.rawMetadata === "object"
      ? ((r.rawMetadata as Record<string, unknown>).evidenceQuality as Record<string, unknown> | undefined)
      : undefined;
  const sq = ((r.quality as { sourceQuality?: Record<string, unknown> }).sourceQuality ??
    (eq?.sourceQuality as Record<string, unknown> | undefined)) as
    | Record<string, unknown>
    | undefined;
  const providerKey = (typeof sq?.providerKey === "string" ? sq.providerKey : "unknown").toLowerCase();
  const providerLabel =
    providerKey === "google"
      ? "Google"
      : providerKey === "yandex"
        ? "Yandex"
        : providerKey === "serper"
          ? "Serper"
          : providerKey === "wikipedia"
            ? "Wikipedia"
            : providerKey;
  const qText = String(r.query ?? "").trim();
  const qNorm = qText.toLowerCase().replace(/\s+/g, " ");
  const queryId = qNorm
    ? `q-${providerKey}-${String(r.region ?? "UNKNOWN").toUpperCase()}-${qNorm
        .slice(0, 32)
        .replace(/[^a-z0-9]+/g, "-")}`
    : undefined;
  const queryPurposeFromMeta =
    r.rawMetadata && typeof r.rawMetadata === "object"
      ? (r.rawMetadata as Record<string, unknown>).queryPurpose
      : undefined;
  const queryPurpose =
    typeof queryPurposeFromMeta === "string" && queryPurposeFromMeta.trim()
      ? queryPurposeFromMeta
      : r.surfaceType === "IMAGE_RESULT"
        ? "media_lookup"
        : r.surfaceType === "VIDEO_RESULT"
          ? "media_lookup"
          : r.surfaceType === "SEARCH_SUGGESTION"
            ? "suggestion_lookup"
            : r.surfaceType === "RELATED_QUERY"
              ? "related_lookup"
              : "subject_lookup";
  const surfaceId =
    typeof r.id === "string" && r.id
      ? r.id
      : `surface-${String(r.surfaceType ?? "unknown").toLowerCase()}-${idx + 1}`;
  const canonicalUrl =
    typeof sq?.canonicalUrl === "string"
      ? sq.canonicalUrl
      : typeof sq?.canonicalUrlKey === "string"
        ? sq.canonicalUrlKey
        : null;
  const domain = resolveSurfaceDomain({
    domain: r.domain ?? null,
    canonicalDomain: typeof sq?.canonicalDomain === "string" ? sq.canonicalDomain : null,
    canonicalUrl,
    sourcePageUrl: sourceUrl,
    url: r.url ?? null,
    rawMetadata: r.rawMetadata,
  });
  return {
    title: r.title ?? r.query ?? "",
    snippet: r.snippet ?? null,
    url: r.url ?? null,
    domain,
    thumbnailUrl: r.thumbnailUrl ?? r.imageUrl ?? null,
    classification: r.classification ?? null,
    riskTheme: r.riskTheme ?? null,
    query: r.query ?? null,
    rank: idx + 1,
    reportEligibility: r.quality.reportEligibility,
    contentClass: r.quality.contentClass,
    identityDecision: r.quality.identityDecision,
    autocompleteClass: ac,
    autocompleteGroup: group,
    thumbnailStorageKey: typeof eq?.thumbnailStorageKey === "string" ? eq.thumbnailStorageKey : null,
    thumbnailStatus: (eq?.thumbnailStatus as string) ?? r.quality.thumbnailStatus,
    sourcePageUrl: sourceUrl,
    sourceFingerprint: typeof sq?.sourceFingerprint === "string" ? sq.sourceFingerprint : undefined,
    canonicalUrlKey: typeof sq?.canonicalUrlKey === "string" ? sq.canonicalUrlKey : null,
    canonicalDomain: typeof sq?.canonicalDomain === "string" ? sq.canonicalDomain : null,
    canonicalTitleKey: typeof sq?.canonicalTitleKey === "string" ? sq.canonicalTitleKey : null,
    providerKey: typeof sq?.providerKey === "string" ? sq.providerKey : undefined,
    sourceSurfaceType: typeof sq?.surfaceType === "string" ? sq.surfaceType : undefined,
    language: typeof sq?.language === "string" ? sq.language : null,
    sourceRegion: typeof sq?.region === "string" ? sq.region : null,
    duplicateGroupId: typeof sq?.duplicateGroupId === "string" ? sq.duplicateGroupId : null,
    duplicateRank: typeof sq?.duplicateRank === "number" ? sq.duplicateRank : null,
    duplicateReason: typeof sq?.duplicateReason === "string" ? sq.duplicateReason : null,
    sourceQualityDecision: typeof sq?.sourceQualityDecision === "string" ? sq.sourceQualityDecision : undefined,
    sourceQualityReason: typeof sq?.sourceQualityReason === "string" ? sq.sourceQualityReason : undefined,
    confidenceLabel: typeof sq?.confidenceLabel === "string" ? sq.confidenceLabel : undefined,
    sourceRank: typeof sq?.sourceRank === "number" ? sq.sourceRank : undefined,
    sourceScoreBucket:
      typeof sq?.sourceScoreBucket === "string" ? sq.sourceScoreBucket : undefined,
    clientSafeReason: typeof sq?.clientSafeReason === "string" ? sq.clientSafeReason : undefined,
    internalReason: typeof sq?.internalReason === "string" ? sq.internalReason : undefined,
    rankingFactors:
      sq?.rankingFactors && typeof sq.rankingFactors === "object"
        ? (sq.rankingFactors as Record<string, number>)
        : undefined,
    limitingFactors:
      Array.isArray(sq?.limitingFactors) && sq?.limitingFactors.every((v) => typeof v === "string")
        ? (sq.limitingFactors as string[])
        : undefined,
    queryId,
    queryPurpose,
    providerLabel,
    screenshotId: null,
    surfaceId,
  };
}

const SURFACE_EVIDENCE_TYPE: Partial<Record<SearchSurfaceType, EvidenceSurfaceType>> = {
  SUGGESTION: "SEARCH_SUGGESTION",
  RELATED_QUERY: "RELATED_QUERY",
  IMAGE_RESULT: "IMAGE_RESULT",
  VIDEO_RESULT: "VIDEO_RESULT",
  KNOWLEDGE_BLOCK: "KNOWLEDGE_BLOCK",
  AI_ANSWER: "AI_ANSWER",
};

const EXPOSURE_DISCLAIMER =
  "Подсказки отражают ассоциации поисковика при вводе похожих запросов и не являются подтверждёнными материалами о субъекте.";

function bucketFromAutocompleteRows(
  rows: SurfaceRowInput[],
  surfaceType: EvidenceSurfaceType,
  regionStatus: RegionCollectionStatus,
  regionMessage: string,
  subject: SubjectIdentityContext,
  reportLanguage: "ru" | "en",
  limit = 20
): SurfaceBucketSummary {
  const gatedRaw: GatedEvidenceItem[] = dedupeEvidenceItems(
    rows.map((r) => ({
      id: r.id,
      surfaceType,
      title: r.title,
      url: r.url,
      domain: r.domain,
      snippet: r.snippet,
      thumbnailUrl: r.thumbnailUrl,
      classification: r.classification,
      riskTheme: r.riskTheme,
      query: r.query,
      region: r.region,
      rawMetadata: r.rawMetadata,
      reviewStatus: r.reviewStatus,
      subjectFullName: subject.fullName,
      subjectAliases: r.subjectAliases ?? subject.aliases,
      subjectCountry: r.subjectCountry ?? subject.country,
      subjectNationality: r.subjectNationality ?? subject.nationality,
      subjectRegionHints: r.subjectRegionHints ?? subject.regionHints,
    })),
    subject.fullName
  ).items;
  const gated = annotateSourceQuality(gatedRaw, reportLanguage);

  const exposure = gated.filter((r) => r.quality.reportEligibility !== "EXCLUDE");
  const picked = pickBestRepresentatives(exposure, limit);
  const excluded = gated.length - picked.length;
  const duplicates = gated.filter((r) => r.quality.selectionReason === "duplicate_url").length;

  const groupBuckets: Record<"exact" | "adjacent" | "typo" | "other", string[]> = {
    exact: [],
    adjacent: [],
    typo: [],
    other: [],
  };
  for (const r of picked) {
    const ac = (r.quality.autocompleteClass ?? "GENERIC_QUERY") as AutocompleteClass;
    const grp = AUTOCOMPLETE_EXPOSURE_GROUPS[ac];
    groupBuckets[grp].push(r.title ?? r.query ?? "");
  }

  const suggestionGroups: AutocompleteSuggestionGroup[] = (
    ["exact", "adjacent", "typo", "other"] as const
  )
    .filter((key) => groupBuckets[key].length > 0)
    .map((key) => ({
      key,
      label: autocompleteGroupLabel(key, reportLanguage),
      items: groupBuckets[key],
    }));

  const qualityStats: SurfaceQualityStats = {
    totalCollected: rows.length,
    selectedForReport: picked.length,
    excludedAsNoise: excluded,
    reviewRequired: gated.filter((r) => r.quality.reportEligibility === "REVIEW_REQUIRED").length,
    duplicatesCollapsed: duplicates,
    clientIncluded: 0,
    dataQualityStatus: rows.length > 0 ? "COLLECTED" : regionStatus === "COLLECTED" ? "EMPTY" : regionStatus,
  };

  if (rows.length > 0) {
    return {
      total: rows.length,
      adverse: 0,
      collectionStatus: "COLLECTED",
      statusMessage: "Data collected.",
      items: picked.map(mapGatedToReportItem),
      qualityStats,
      suggestionGroups,
      exposureDisclaimer: EXPOSURE_DISCLAIMER,
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

async function bucketFromGatedRows(
  rows: SurfaceRowInput[],
  surfaceType: EvidenceSurfaceType,
  regionStatus: RegionCollectionStatus,
  regionMessage: string,
  subject: SubjectIdentityContext,
  reportLanguage: "ru" | "en",
  limit = 20,
  options: { caseId?: string; fetchThumbnails?: boolean } = {}
): Promise<SurfaceBucketSummary> {
  const gatedRaw: GatedEvidenceItem[] = dedupeEvidenceItems(
    rows.map((r) => ({
      id: r.id,
      surfaceType,
      title: r.title,
      url: r.url,
      domain: r.domain,
      snippet: r.snippet,
      thumbnailUrl: r.thumbnailUrl,
      classification: r.classification,
      riskTheme: r.riskTheme,
      query: r.query,
      region: r.region,
      rawMetadata: r.rawMetadata,
      reviewStatus: r.reviewStatus,
      subjectFullName: subject.fullName,
      subjectAliases: r.subjectAliases ?? subject.aliases,
      subjectCountry: r.subjectCountry ?? subject.country,
      subjectNationality: r.subjectNationality ?? subject.nationality,
      subjectRegionHints: r.subjectRegionHints ?? subject.regionHints,
    })),
    subject.fullName
  ).items;
  const gated = annotateSourceQuality(gatedRaw, reportLanguage);

  const selection = selectEvidenceForReport(gated, "INTERNAL");
  const picked = pickBestRepresentatives(selection.selected, limit);

  const excludedItems = selection.excluded
    .filter((r) =>
      ["NAMESAKE", "ENTITY_MISMATCH", "INSUFFICIENT_MATCH"].includes(
        r.quality.identityDecision ?? ""
      )
    )
    .slice(0, 25)
    .map((r, idx) => mapGatedToReportItem(r, idx));

  if (options.fetchThumbnails && options.caseId && surfaceType === "IMAGE_RESULT") {
    for (const r of picked) {
      if (!r.id) continue;
      const thumb = await ensureImageThumbnail({
        caseId: options.caseId,
        surfaceId: r.id,
        imageUrl: (r as { imageUrl?: string | null }).imageUrl,
        thumbnailUrl: (r as { thumbnailUrl?: string | null }).thumbnailUrl,
        rawMetadata: r.rawMetadata,
      });
      r.rawMetadata = thumb.rawMetadata;
      r.quality = {
        ...r.quality,
        thumbnailStatus: thumb.status,
      };
      if (thumb.storageKey && r.id) {
        await prisma.searchSurfaceItem.update({
          where: { id: r.id },
          data: { rawMetadata: thumb.rawMetadata as Prisma.InputJsonValue },
        });
      }
    }
  }

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
      items: picked.map(mapGatedToReportItem),
      qualityStats,
      excludedItems,
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
  subject: SubjectIdentityContext,
  caseId: string,
  reportLanguage: "ru" | "en" = "ru"
): Promise<RegionSearchSurfacesBlock> {
  return buildRegionBlockAsync(
    region,
    organicRows,
    surfaceRows,
    wikiRows,
    subject,
    caseId,
    reportLanguage
  );
}

async function buildRegionBlockAsync(
  region: OrionRegionCode,
  organicRows: Awaited<ReturnType<typeof loadOrganic>>,
  surfaceRows: Awaited<ReturnType<typeof loadSurfaces>>,
  wikiRows: Awaited<ReturnType<typeof loadWiki>>,
  subject: SubjectIdentityContext,
  caseId: string,
  reportLanguage: "ru" | "en" = "ru"
): Promise<RegionSearchSurfacesBlock> {
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
    isNegativeOrganic(r.classification, r.rawMetadata, subject.fullName, r.title, r.snippet)
  );

  const surfaceInput = (type: SearchSurfaceType) =>
    byType(type).map((s) => ({
      id: s.id,
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
      subjectAliases: subject.aliases,
      subjectCountry: subject.country,
      subjectNationality: subject.nationality,
      subjectRegionHints: subject.regionHints,
    }));

  const autocompleteBucket = (type: SearchSurfaceType, limit = 20) =>
    bucketFromAutocompleteRows(
      surfaceInput(type),
      SURFACE_EVIDENCE_TYPE[type] ?? "SEARCH_SUGGESTION",
      derived.status,
      derived.message,
      subject,
      reportLanguage,
      limit
    );

  const gatedBucket = (type: SearchSurfaceType, limit = 20, fetchThumbnails = false) =>
    bucketFromGatedRows(
      surfaceInput(type),
      SURFACE_EVIDENCE_TYPE[type] ?? "SEARCH_SUGGESTION",
      derived.status,
      derived.message,
      subject,
      reportLanguage,
      limit,
      { caseId, fetchThumbnails }
    );

  const wikiLang = region === "RU" ? "ru" : "en";
  const wiki = wikiRows.filter((w) => (w.language ?? "").toLowerCase().startsWith(wikiLang));

  const organicBucket = await bucketFromGatedRows(
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
      subjectAliases: subject.aliases,
      subjectCountry: subject.country,
      subjectNationality: subject.nationality,
      subjectRegionHints: subject.regionHints,
    })),
    "SEARCH_RESULT",
    derived.status,
    derived.message,
    subject,
    reportLanguage,
    20
  );
  const images = await gatedBucket("IMAGE_RESULT", 9, true);
  const imageNote =
    images.qualityStats && images.qualityStats.totalCollected > 0
      ? `${images.qualityStats.totalCollected} collected, ${images.qualityStats.selectedForReport} selected, ${images.qualityStats.excludedAsNoise} excluded as namesakes/noise.`
      : undefined;

  return {
    region,
    label: profile.label,
    language: profile.language,
    collectionStatus: derived.status,
    statusMessage: derived.message,
    organic: organicBucket,
    suggestions: autocompleteBucket("SUGGESTION"),
    relatedQueries: autocompleteBucket("RELATED_QUERY", 15),
    images: { ...images, imageSelectionNote: imageNote },
    videos: await gatedBucket("VIDEO_RESULT"),
    knowledgePanel: await gatedBucket("KNOWLEDGE_BLOCK"),
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
    select: {
      targetRegions: true,
      subjects: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { fullName: true, aliases: true, country: true, nationality: true },
      },
    },
  });
  const subject = subjectRow?.subjects[0];
  const subjectContext: SubjectIdentityContext = {
    fullName: subject?.fullName ?? null,
    aliases: subject?.aliases ?? [],
    country: subject?.country ?? null,
    nationality: subject?.nationality ?? null,
    regionHints: subjectRow?.targetRegions ?? [],
  };

  const [organicRows, surfaceRows, wikiRows] = await Promise.all([
    loadOrganic(caseId),
    loadSurfaces(caseId),
    loadWiki(caseId),
  ]);

  const organic = options.includeDemo
    ? organicRows
    : organicRows.filter((r) => !String(r.source ?? "").includes("mock"));

  const ru = await buildRegionBlock("RU", organic, surfaceRows, wikiRows, subjectContext, caseId);
  const uae = await buildRegionBlock("UAE", organic, surfaceRows, wikiRows, subjectContext, caseId);
  const international = await buildRegionBlock(
    "INTERNATIONAL",
    organic,
    surfaceRows,
    wikiRows,
    subjectContext,
    caseId
  );

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
export interface RegionAuditMapOptions {
  audience?: "CLIENT" | "INTERNAL";
  reportLanguage?: "ru" | "en";
  confirmedAppendix?: Array<{
    title: string;
    domain: string;
    type?: string;
    identity?: string;
    class?: string;
    review?: string;
    link?: string;
    provider?: string;
    classification?: string;
  }>;
  excludedAppendix?: Array<{
    title: string;
    domain: string;
    reason: string;
    identityDecision: string;
  }>;
  organicSelected?: SurfaceReportItem[];
  imagesSelected?: SurfaceReportItem[];
  videosSelected?: SurfaceReportItem[];
}

export function regionBlockToAuditRegion(
  block: RegionSearchSurfacesBlock,
  options: RegionAuditMapOptions = {}
): Record<string, unknown> | null {
  if (block.collectionStatus !== "COLLECTED" && !regionHasEvidence(block)) {
    return null;
  }

  const organicItems = options.organicSelected ?? block.organic.items;
  const imageItems = options.imagesSelected ?? block.images.items;
  const videoItems = options.videosSelected ?? block.videos.items;

  const imagesCollected = block.images.qualityStats?.totalCollected ?? block.images.total;
  const imagesSelectedCount = imageItems.length;
  const videosCollected = block.videos.qualityStats?.totalCollected ?? block.videos.total;
  const videosSelectedCount = videoItems.length;

  const imageSelectionNote =
    block.images.imageSelectionNote ??
    (imagesCollected > 0
      ? `Collected images: ${imagesCollected}; subject-matched: ${imagesSelectedCount}; excluded: ${Math.max(0, imagesCollected - imagesSelectedCount)}.`
      : null);

  const videoSelectionNote =
    videosCollected > 0
      ? `Collected videos: ${videosCollected}; subject-matched: ${videosSelectedCount}; excluded: ${Math.max(0, videosCollected - videosSelectedCount)}.`
      : null;

  const confirmedAppendix =
    options.confirmedAppendix ??
    organicItems.slice(0, 15).map((i) => ({
      title: i.title,
      domain: i.domain ?? "",
      provider: "GOOGLE",
      classification: i.classification ?? "",
      type: "ORGANIC",
      identity: i.identityDecision ?? "",
      class: i.classification ?? "",
      review: i.reportEligibility ?? "",
      link: i.sourcePageUrl ?? i.url ?? "",
    }));

  const languageHint = options.reportLanguage ?? (hasCyrillic(String(block.label ?? "")) ? "ru" : "en");
  const regionConclusion = buildRegionConclusion(block, organicItems, imageItems, videoItems, languageHint);
  const ruReport = languageHint === "ru";
  return {
    region: block.region,
    language: block.language,
    organicTotal: block.organic.qualityStats?.totalCollected ?? block.organic.total,
    organicNegative: organicItems.filter((i) =>
      isNegativeOrganic(i.classification, null, null, i.title, i.snippet)
    ).length,
    organicNegativeShare:
      organicItems.length > 0
        ? organicItems.filter((i) =>
            isNegativeOrganic(i.classification, null, null, i.title, i.snippet)
          ).length / organicItems.length
        : 0,
    uniqueNegativeUrls: block.summary.uniqueAdverseUrls,
    totalUniqueUrls: block.summary.uniqueUrls,
    suggestionsTotal: block.suggestions.total,
    suggestionsNegative: block.suggestions.adverse,
    relatedQueriesTotal: block.relatedQueries.total,
    relatedQueriesNegative: block.relatedQueries.adverse,
    imagesTotal: imagesCollected,
    imagesSelected: imagesSelectedCount,
    imagesNegative: imageItems.filter((i) => isAdverseSurface(i.classification)).length,
    videosTotal: videosCollected,
    videosSelected: videosSelectedCount,
    videosNegative: videoItems.filter((i) => isAdverseSurface(i.classification)).length,
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
    topResults: organicItems.slice(0, 20).map((i, idx) => ({
      provider: "GOOGLE",
      rank: i.rank ?? idx + 1,
      domain:
        resolveSurfaceDomain({
          domain: i.domain,
          canonicalDomain: i.canonicalDomain ?? null,
          sourcePageUrl: i.sourcePageUrl ?? null,
          url: i.url ?? null,
        }) ?? (ruReport ? "домен не указан" : "domain unavailable"),
      title: i.title,
      classification: i.classification,
      identityDecision: i.identityDecision ?? null,
    })),
    topSuggestions: block.suggestions.items.map((i) => i.title),
    suggestionGroups: block.suggestions.suggestionGroups ?? [],
    exposureDisclaimer: block.suggestions.exposureDisclaimer ?? null,
    topRelatedQueries: block.relatedQueries.items.map((i) => i.title),
    relatedSuggestionGroups: block.relatedQueries.suggestionGroups ?? [],
    topImages: imageItems.map((i) => ({
      title: i.title,
      url: i.thumbnailUrl ?? i.url,
      source: i.domain ?? "",
      thumbnailStorageKey: i.thumbnailStorageKey ?? null,
      identityDecision: i.identityDecision ?? null,
      thumbnailStatus: i.thumbnailStatus ?? null,
      sourcePageUrl: i.sourcePageUrl ?? i.url,
    })),
    imageSelectionNote,
    videoSelectionNote,
    topVideos: videoItems.map((i) => ({
      title: i.title,
      url: i.sourcePageUrl ?? i.url ?? "",
      source: i.domain ?? "",
      thumbnailUrl: i.thumbnailUrl,
      identityDecision: i.identityDecision ?? null,
      reportEligibility: i.reportEligibility ?? null,
    })),
    topThemes: block.summary.topAdverseThemes.map((t) => ({
      theme: topicLabel(t.theme, ruReport),
      count: t.count,
    })),
    topNegativeDomains: block.summary.topAdverseDomains.map((d) => d.domain),
    topNegativeUrls: organicItems
      .filter((i) =>
        isNegativeOrganic(i.classification, null, null, i.title, i.snippet)
      )
      .slice(0, 10)
      .map((i) => ({
        title: i.title,
        domain: i.domain ?? "",
        classification: i.classification,
      })),
    regionConclusion,
    regionRiskLevel:
      block.collectionStatus !== "COLLECTED" && block.organic.total === 0
        ? "UNKNOWN"
        : block.summary.adversePercentage >= 25
          ? "HIGH"
          : block.summary.adversePercentage >= 10
            ? "MEDIUM"
            : "LOW",
    evidenceAppendix: confirmedAppendix,
    excludedAppendix: options.excludedAppendix ?? [],
  };
}
