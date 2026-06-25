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

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

export function buildExecutiveSummary(params: {
  subjectFullName: string;
  overallRiskLevel: OverallRiskLevel;
  search: SearchSummary;
  surfaces: SurfacesSummary;
  wikipedia: WikipediaSummary;
  compliance: ComplianceDatabaseSummary;
  dataQuality: DataQualitySummary;
}): string[] {
  const { search, surfaces, wikipedia, compliance, dataQuality } = params;
  const bullets: string[] = [];

  bullets.push(
    `Briefly: open-source review of ${params.subjectFullName} produced an overall risk level of ${params.overallRiskLevel} (preliminary, requires manual review).`
  );

  if (search.totalResults > 0) {
    bullets.push(
      `Analysed ${search.totalResults} organic result(s) across ${search.uniqueUrls} unique URL(s); ${search.negativeResults} (${pct(search.negativeShare)}) contain potentially adverse mentions.`
    );
  } else {
    bullets.push("No organic search results have been collected yet.");
  }

  const negSurfaces =
    surfaces.suggestions.negative + surfaces.images.negative + surfaces.videos.negative;
  if (surfaces.suggestions.total + surfaces.images.total + surfaces.videos.total > 0) {
    bullets.push(
      `Search surfaces: ${surfaces.suggestions.negative}/${surfaces.suggestions.total} negative suggestion(s), ${surfaces.images.negative}/${surfaces.images.total} image(s), ${surfaces.videos.negative}/${surfaces.videos.total} video(s) flagged for review.`
    );
  }
  if (negSurfaces === 0 && surfaces.suggestions.total > 0) {
    // keep concise
  }

  bullets.push(
    wikipedia.exists
      ? "An authoritative Wikipedia profile exists and should be reviewed for accuracy."
      : "No authoritative Wikipedia profile was found (absence of a controlled profile, not an adverse signal)."
  );

  if (compliance.providersChecked.length > 0) {
    bullets.push(
      compliance.activeMatches > 0
        ? `Compliance screening (${compliance.providersChecked.join(", ")}) returned ${compliance.activeMatches} potential match(es); mandatory manual verification.`
        : `Compliance screening (${compliance.providersChecked.join(", ")}) returned no material matches; confirm manually.`
    );
  }

  if (dataQuality.warnings.length > 0) {
    bullets.push(`Data quality: ${dataQuality.warnings[0]}`);
  }

  return bullets.slice(0, 6);
}

export function buildKeyFindings(params: {
  search: SearchSummary;
  surfaces: SurfacesSummary;
  wikipedia: WikipediaSummary;
  compliance: ComplianceDatabaseSummary;
  dataQuality: DataQualitySummary;
}): KeyFindingGroup[] {
  const groups: KeyFindingGroup[] = [];
  const { search, surfaces, wikipedia, compliance, dataQuality } = params;

  // Search profile
  const searchPoints: string[] = [];
  if (search.totalResults > 0) {
    searchPoints.push(
      `${search.negativeResults} of ${search.totalResults} organic result(s) (${pct(search.negativeShare)}) contain potentially adverse mentions.`
    );
    if (search.negativeDomains.length > 0) {
      searchPoints.push(`Adverse mentions originate from: ${search.negativeDomains.slice(0, 5).join(", ")}.`);
    }
    if (search.topNegativeThemes.length > 0) {
      searchPoints.push(
        `Recurring themes: ${search.topNegativeThemes.map((t) => `${t.theme} (${t.count})`).join(", ")}.`
      );
    }
  } else {
    searchPoints.push("No organic search results collected yet.");
  }
  groups.push({ group: "search_profile", title: "Search profile", points: searchPoints });

  // Search surfaces
  const surfacePoints: string[] = [];
  surfacePoints.push(
    `Suggestions: ${surfaces.suggestions.negative}/${surfaces.suggestions.total} flagged; related: ${surfaces.relatedQueries.negative}/${surfaces.relatedQueries.total}.`
  );
  surfacePoints.push(
    `Images: ${surfaces.images.negative}/${surfaces.images.total} flagged; videos: ${surfaces.videos.negative}/${surfaces.videos.total}.`
  );
  if (surfaces.knowledgeBlocks.total > 0) {
    surfacePoints.push(
      `Knowledge block(s): ${surfaces.knowledgeBlocks.total}, mismatches flagged: ${surfaces.knowledgeBlocks.mismatches}.`
    );
  }
  groups.push({ group: "search_surfaces", title: "Search surfaces", points: surfacePoints });

  // Wikipedia
  groups.push({
    group: "wikipedia",
    title: "Wikipedia",
    points: [wikipedia.conclusion],
  });

  // Compliance
  const compPoints: string[] = [compliance.conclusion];
  if (compliance.providersChecked.length > 0) {
    compPoints.push(
      `PEP: ${compliance.pepMatches}, RCA: ${compliance.rcaMatches}, sanctions: ${compliance.sanctionsMatches}, adverse media: ${compliance.adverseMediaMatches}.`
    );
  }
  groups.push({ group: "compliance_databases", title: "Compliance databases", points: compPoints });

  // Data quality
  groups.push({
    group: "data_quality",
    title: "Data quality",
    points:
      dataQuality.warnings.length > 0
        ? dataQuality.warnings
        : ["Evidence coverage is adequate for a preliminary assessment."],
  });

  return groups;
}

export function buildRecommendedActions(params: {
  overallRiskLevel: OverallRiskLevel;
  wikipedia: WikipediaSummary;
  compliance: ComplianceDatabaseSummary;
  dataQuality: DataQualitySummary;
}): string[] {
  const actions: string[] = [];
  const { overallRiskLevel, wikipedia, compliance, dataQuality } = params;
  const elevated = RISK_RANK[overallRiskLevel] >= RISK_RANK.HIGH;
  const lowData = dataQuality.evidenceCount < 5;

  if (elevated) {
    actions.push("Conduct a thorough manual review of all flagged sources before drawing conclusions.");
    actions.push("Clarify and corroborate sources containing adverse mentions.");
    actions.push("Prepare a digital-profile management strategy for the subject.");
    if (compliance.activeMatches > 0) {
      actions.push("Verify compliance-database matches via official channels.");
    }
    actions.push("Set up ongoing monitoring for changes in the subject's digital footprint.");
  }

  if (!wikipedia.exists) {
    actions.push("Consider establishing or improving an authoritative Wikipedia profile, where appropriate and policy-compliant.");
  }

  if (lowData) {
    actions.push("Expand data collection across regions and search surfaces.");
    actions.push("Upload available manual evidence to strengthen the assessment.");
    actions.push("Enable official search/compliance APIs to gather verified data.");
  }

  if (!elevated && !lowData) {
    actions.push("Maintain periodic monitoring; no elevated risk indicators at this time.");
  }

  return Array.from(new Set(actions));
}
