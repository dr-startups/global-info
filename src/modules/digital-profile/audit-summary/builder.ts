/**
 * Audit Summary builder (Stage J).
 *
 * Loads stored evidence + risk findings for a case and assembles a deterministic,
 * cautious AuditSummary. No LLM, no network, no scraping. Pure aggregation +
 * templated prose.
 */

import { prisma } from "@/server/prisma/client";
import { NotFoundError } from "../http/errors";
import {
  calculateOverallRiskLevel,
  computeComplianceSummary,
  computeDataQuality,
  computeRegions,
  computeRiskSummary,
  computeSearchSummary,
  computeSurfacesSummary,
  computeWikipediaSummary,
  type LoadedDb,
  type LoadedFinding,
  type LoadedOrganic,
  type LoadedSurface,
  type LoadedWiki,
} from "./calculations";
import {
  buildExecutiveSummary,
  buildKeyFindings,
  buildRecommendedActions,
  deriveTone,
} from "./text-builder";
import type { AuditSummary } from "./types";
import {
  normalizeReportLanguage,
  type ReportLanguage,
} from "../report/i18n/report-dictionary";

export interface BuildAuditSummaryOptions {
  locale?: ReportLanguage;
}

export async function buildAuditSummary(
  caseId: string,
  options: BuildAuditSummaryOptions = {}
): Promise<AuditSummary> {
  const locale = normalizeReportLanguage(options.locale);
  const caseRow = await prisma.case.findFirst({
    where: { id: caseId, deletedAt: null },
    select: {
      id: true,
      subjects: {
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { fullName: true },
      },
    },
  });
  if (!caseRow) throw new NotFoundError("Case not found");

  const [organicRows, surfaceRows, wikiRows, dbRows, findingRows, screenshots] =
    await Promise.all([
      prisma.searchResult.findMany({
        where: { caseId },
        select: {
          id: true,
          engine: true,
          url: true,
          title: true,
          snippet: true,
          classification: true,
          source: true,
          rank: true,
        },
      }),
      prisma.searchSurfaceItem.findMany({
        where: { caseId, deletedAt: null },
        select: {
          id: true,
          type: true,
          source: true,
          query: true,
          region: true,
          language: true,
          title: true,
          snippet: true,
          url: true,
          imageUrl: true,
          videoUrl: true,
          classification: true,
          riskTheme: true,
          rawMetadata: true,
        },
      }),
      prisma.wikipediaCheck.findMany({
        where: { caseId },
        orderBy: { lastChecked: "desc" },
        select: { exists: true, url: true, language: true, pageTitle: true, snapshot: true },
      }),
      prisma.databaseProfile.findMany({
        where: { caseId },
        select: {
          provider: true,
          matchType: true,
          matchScore: true,
          reviewStatus: true,
          riskTypes: true,
          hitSource: true,
        },
      }),
      prisma.riskFinding.findMany({
        where: { caseId },
        select: {
          severity: true,
          riskTheme: true,
          category: true,
          title: true,
          reviewStatus: true,
          evidenceRefs: true,
        },
      }),
      prisma.screenshot.count({ where: { caseId, deletedAt: null } }),
    ]);

  const organic: LoadedOrganic[] = organicRows.map((r) => ({
    id: r.id,
    engine: r.engine,
    url: r.url,
    title: r.title,
    snippet: r.snippet,
    classification: r.classification,
    source: r.source,
    rank: r.rank,
  }));
  const surfaces: LoadedSurface[] = surfaceRows.map((s) => ({
    id: s.id,
    type: s.type,
    source: s.source,
    query: s.query,
    region: s.region,
    language: s.language,
    title: s.title,
    snippet: s.snippet,
    url: s.url,
    imageUrl: s.imageUrl,
    videoUrl: s.videoUrl,
    classification: s.classification,
    riskTheme: s.riskTheme,
    rawMetadata: s.rawMetadata,
  }));
  const wikis: LoadedWiki[] = wikiRows;
  const dbs: LoadedDb[] = dbRows.map((d) => ({
    ...d,
    riskTypes: Array.isArray(d.riskTypes) ? (d.riskTypes as string[]) : [],
  }));
  const findings: LoadedFinding[] = findingRows.map((f) => ({
    severity: f.severity,
    riskTheme: f.riskTheme,
    category: f.category,
    title: f.title,
    reviewStatus: f.reviewStatus,
    evidenceCount: Array.isArray(f.evidenceRefs) ? (f.evidenceRefs as unknown[]).length : 0,
  }));

  const searchSummary = computeSearchSummary(organic, findings);
  const surfacesSummary = computeSurfacesSummary(surfaces, screenshots);
  const wikipediaSummary = computeWikipediaSummary(wikis, locale);
  const complianceDatabaseSummary = computeComplianceSummary(dbs, locale);
  const riskSummary = computeRiskSummary(findings);
  const regions = computeRegions(organic, surfaces, locale);

  const evidenceCount =
    organic.length + surfaces.length + wikis.length + dbs.length + screenshots;

  const dataQualitySummary = computeDataQuality({
    evidenceCount,
    findings,
    organicCount: organic.length,
    surfacesCount: surfaces.length,
    wikiCount: wikis.length,
    dbCount: dbs.length,
    locale,
  });

  const overallRiskLevel = calculateOverallRiskLevel({
    findings,
    compliance: complianceDatabaseSummary,
    searchNegativeShare: searchSummary.negativeShare,
    negativeSuggestions: surfacesSummary.suggestions.negative,
    negativeImages: surfacesSummary.images.negative,
    negativeVideos: surfacesSummary.videos.negative,
    wikipediaAbsent: !wikipediaSummary.exists,
    evidenceCount,
  });

  const overallTone = deriveTone(overallRiskLevel, evidenceCount);
  const subjectFullName = caseRow.subjects[0]?.fullName ?? "Unknown subject";

  const executiveSummary = buildExecutiveSummary({
    subjectFullName,
    overallRiskLevel,
    search: searchSummary,
    surfaces: surfacesSummary,
    wikipedia: wikipediaSummary,
    compliance: complianceDatabaseSummary,
    dataQuality: dataQualitySummary,
    locale,
  });
  const keyFindings = buildKeyFindings({
    search: searchSummary,
    surfaces: surfacesSummary,
    wikipedia: wikipediaSummary,
    compliance: complianceDatabaseSummary,
    dataQuality: dataQualitySummary,
    locale,
  });
  const recommendedActions = buildRecommendedActions({
    overallRiskLevel,
    wikipedia: wikipediaSummary,
    compliance: complianceDatabaseSummary,
    dataQuality: dataQualitySummary,
    locale,
  });

  return {
    caseId,
    subjectFullName,
    generatedAt: new Date().toISOString(),
    overallRiskLevel,
    overallTone,
    executiveSummary,
    keyFindings,
    recommendedActions,
    regions,
    searchSummary,
    surfacesSummary,
    wikipediaSummary,
    complianceDatabaseSummary,
    riskSummary,
    dataQualitySummary,
  };
}
