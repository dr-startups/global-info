/**
 * Cautious text builders for the audit summary (Stage J).
 *
 * Deterministic templated prose — no LLM. Wording is intentionally
 * non-conclusive ("mentions found", "sources contain information",
 * "requires manual review") and never makes legal/criminal assertions.
 */

import type {
  AuditTone,
  ComplianceDatabaseSummary,
  DataQualitySummary,
  KeyFindingGroup,
  OverallRiskLevel,
  SearchSummary,
  SurfacesSummary,
  WikipediaSummary,
} from "./types";
import {
  auditPhrases,
  type ReportLanguage,
} from "../report/i18n/report-dictionary";

const RISK_RANK: Record<OverallRiskLevel, number> = {
  UNKNOWN: -1,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

export function deriveTone(level: OverallRiskLevel, evidenceCount: number): AuditTone {
  if (evidenceCount === 0 || level === "UNKNOWN") return "insufficient_data";
  if (level === "CRITICAL" || level === "HIGH") return "elevated";
  if (level === "MEDIUM") return "caution";
  return "neutral";
}

export function buildExecutiveSummary(params: {
  subjectFullName: string;
  overallRiskLevel: OverallRiskLevel;
  search: SearchSummary;
  surfaces: SurfacesSummary;
  wikipedia: WikipediaSummary;
  compliance: ComplianceDatabaseSummary;
  dataQuality: DataQualitySummary;
  locale?: ReportLanguage;
}): string[] {
  const { search, surfaces, wikipedia, compliance, dataQuality } = params;
  const p = auditPhrases(params.locale ?? "ru");
  const bullets: string[] = [];

  bullets.push(p.execIntro(params.subjectFullName, params.overallRiskLevel));

  if (search.totalResults > 0) {
    bullets.push(
      p.execAnalysed(search.totalResults, search.uniqueUrls, search.negativeResults, search.negativeShare)
    );
  } else {
    bullets.push(p.execNoOrganic());
  }

  if (surfaces.suggestions.total + surfaces.images.total + surfaces.videos.total > 0) {
    bullets.push(
      p.execSurfaces(
        surfaces.suggestions.negative, surfaces.suggestions.total,
        surfaces.images.negative, surfaces.images.total,
        surfaces.videos.negative, surfaces.videos.total
      )
    );
  }

  bullets.push(wikipedia.exists ? p.execWikiExists() : p.execWikiAbsent());

  if (compliance.providersChecked.length > 0) {
    const providers = compliance.providersChecked.join(", ");
    bullets.push(
      compliance.activeMatches > 0
        ? p.execComplianceActive(providers, compliance.activeMatches)
        : p.execComplianceNone(providers)
    );
  }

  if (dataQuality.warnings.length > 0) {
    bullets.push(p.execDataQuality(dataQuality.warnings[0]));
  }

  return bullets.slice(0, 6);
}

export function buildKeyFindings(params: {
  search: SearchSummary;
  surfaces: SurfacesSummary;
  wikipedia: WikipediaSummary;
  compliance: ComplianceDatabaseSummary;
  dataQuality: DataQualitySummary;
  locale?: ReportLanguage;
}): KeyFindingGroup[] {
  const groups: KeyFindingGroup[] = [];
  const { search, surfaces, wikipedia, compliance, dataQuality } = params;
  const p = auditPhrases(params.locale ?? "ru");

  // Search profile
  const searchPoints: string[] = [];
  if (search.totalResults > 0) {
    searchPoints.push(
      p.kfNegOfTotal(search.negativeResults, search.totalResults, search.negativeShare)
    );
    if (search.negativeDomains.length > 0) {
      searchPoints.push(p.kfAdverseFrom(search.negativeDomains.slice(0, 5).join(", ")));
    }
    if (search.topNegativeThemes.length > 0) {
      searchPoints.push(
        p.kfRecurringThemes(search.topNegativeThemes.map((t) => `${t.theme} (${t.count})`).join(", "))
      );
    }
  } else {
    searchPoints.push(p.kfNoOrganic());
  }
  groups.push({ group: "search_profile", title: p.kfSearchProfile, points: searchPoints });

  // Search surfaces
  const surfacePoints: string[] = [];
  surfacePoints.push(
    p.kfSuggestions(
      surfaces.suggestions.negative, surfaces.suggestions.total,
      surfaces.relatedQueries.negative, surfaces.relatedQueries.total
    )
  );
  surfacePoints.push(
    p.kfImagesVideos(
      surfaces.images.negative, surfaces.images.total,
      surfaces.videos.negative, surfaces.videos.total
    )
  );
  if (surfaces.knowledgeBlocks.total > 0) {
    surfacePoints.push(
      p.kfKnowledge(surfaces.knowledgeBlocks.total, surfaces.knowledgeBlocks.mismatches)
    );
  }
  groups.push({ group: "search_surfaces", title: p.kfSearchSurfaces, points: surfacePoints });

  // Wikipedia
  groups.push({
    group: "wikipedia",
    title: p.kfWikipedia,
    points: [wikipedia.conclusion],
  });

  // Compliance
  const compPoints: string[] = [compliance.conclusion];
  if (compliance.providersChecked.length > 0) {
    compPoints.push(
      p.kfPepRca(
        compliance.pepMatches, compliance.rcaMatches,
        compliance.sanctionsMatches, compliance.adverseMediaMatches
      )
    );
  }
  groups.push({ group: "compliance_databases", title: p.kfCompliance, points: compPoints });

  // Data quality
  groups.push({
    group: "data_quality",
    title: p.kfDataQuality,
    points:
      dataQuality.warnings.length > 0
        ? dataQuality.warnings
        : [p.kfCoverageAdequate()],
  });

  return groups;
}

export function buildRecommendedActions(params: {
  overallRiskLevel: OverallRiskLevel;
  wikipedia: WikipediaSummary;
  compliance: ComplianceDatabaseSummary;
  dataQuality: DataQualitySummary;
  locale?: ReportLanguage;
}): string[] {
  const actions: string[] = [];
  const { overallRiskLevel, wikipedia, compliance, dataQuality } = params;
  const p = auditPhrases(params.locale ?? "ru");
  const elevated = RISK_RANK[overallRiskLevel] >= RISK_RANK.HIGH;
  const lowData = dataQuality.evidenceCount < 5;

  if (elevated) {
    actions.push(p.raThoroughReview());
    actions.push(p.raCorroborate());
    actions.push(p.raStrategy());
    if (compliance.activeMatches > 0) {
      actions.push(p.raVerifyCompliance());
    }
    actions.push(p.raMonitoring());
  }

  if (!wikipedia.exists) {
    actions.push(p.raWikipedia());
  }

  if (lowData) {
    actions.push(p.raExpandCollection());
    actions.push(p.raUploadEvidence());
    actions.push(p.raEnableApis());
  }

  if (!elevated && !lowData) {
    actions.push(p.raMaintainMonitoring());
  }

  return Array.from(new Set(actions));
}
