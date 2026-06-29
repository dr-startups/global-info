/**
 * Deterministic audit-summary calculations (Stage J).
 *
 * Pure functions over already-loaded evidence rows. No LLM, no network. All
 * "negativity" detection reuses the Risk Classifier dictionaries.
 */

import {
  allNegativeKeywords,
  matchesAny,
  reputationDomains,
} from "../risk-classifier/dictionaries";
import { RISK_LEVEL_RANK } from "../risk-classifier/types";
import type { RiskTheme } from "../risk-classifier/types";
import { auditPhrases, type ReportLanguage } from "../report/i18n/report-dictionary";
import type {
  ComplianceDatabaseSummary,
  DataQualitySummary,
  OverallRiskLevel,
  RegionAuditSummary,
  RegionCode,
  RiskSummaryBlock,
  SearchSummary,
  SurfacesSummary,
  WikipediaSummary,
} from "./types";

// ---------------------------------------------------------------------------
// Loaded row shapes (filled by builder from prisma rows)
// ---------------------------------------------------------------------------

export interface LoadedOrganic {
  id: string;
  engine: string;
  url: string;
  title: string | null;
  snippet: string | null;
  classification: string;
  source: string | null;
  rank: number | null;
  rawMetadata?: unknown;
}

export interface LoadedSurface {
  id: string;
  type: string;
  source: string;
  query: string | null;
  region: string | null;
  language: string | null;
  title: string | null;
  snippet: string | null;
  url: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  classification: string | null;
  riskTheme: string | null;
  rawMetadata: unknown;
}

export interface LoadedWiki {
  exists: boolean;
  url: string | null;
  language: string | null;
  pageTitle: string | null;
  snapshot: unknown;
}

export interface LoadedDb {
  provider: string;
  matchType: string | null;
  matchScore: number | null;
  reviewStatus?: string;
  riskTypes?: string[];
  hitSource?: string;
}

function isActiveComplianceHit(d: LoadedDb): boolean {
  const rs = d.reviewStatus ?? "PENDING";
  return rs !== "FALSE_POSITIVE" && rs !== "DISMISSED";
}

function riskTypesOf(d: LoadedDb): string[] {
  if (d.riskTypes && d.riskTypes.length > 0) return d.riskTypes;
  const mt = (d.matchType ?? "").toUpperCase();
  if (/SANCTION/.test(mt)) return ["SANCTIONS"];
  if (/PEP/.test(mt)) return ["PEP"];
  if (/ADVERSE/.test(mt)) return ["ADVERSE_MEDIA"];
  return [];
}

/** Providers actually queried (manual import or official API) — not mock/stub rows. */
export function providersQueriedFromCompliance(dbs: LoadedDb[]): string[] {
  return Array.from(
    new Set(
      dbs
        .filter((d) => d.hitSource === "MANUAL" || d.hitSource === "OFFICIAL_API")
        .map((d) => d.provider)
    )
  );
}

export interface LoadedFinding {
  severity: string;
  riskTheme: string | null;
  category: string;
  title: string;
  reviewStatus: string;
  evidenceCount: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function hasCyrillic(text: string): boolean {
  return /[\u0400-\u04FF]/.test(text);
}

export function domainOf(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function isReputationDomain(url: string | null): boolean {
  const d = domainOf(url);
  return !!d && reputationDomains.some((r) => d.includes(r));
}

export function isNegativeOrganic(r: LoadedOrganic): boolean {
  if (r.classification === "ADVERSE_MEDIA") return true;
  if (isReputationDomain(r.url)) return true;
  const text = `${r.title ?? ""} ${r.snippet ?? ""} ${r.url}`;
  return matchesAny(text, allNegativeKeywords).length > 0;
}

function isPositiveOrganic(r: LoadedOrganic): boolean {
  return ["SOCIAL_PROFILE", "CORPORATE"].includes(r.classification);
}

export function isNegativeSurface(s: LoadedSurface): boolean {
  const cls = (s.classification ?? "").toUpperCase();
  if (["NEGATIVE", "ADVERSE_MEDIA"].includes(cls)) return true;
  const text = `${s.query ?? ""} ${s.title ?? ""} ${s.snippet ?? ""}`;
  return matchesAny(text, allNegativeKeywords).length > 0;
}

export function regionOfOrganic(r: LoadedOrganic): RegionCode {
  if (r.engine === "YANDEX") return "RU";
  const text = `${r.title ?? ""} ${r.snippet ?? ""}`;
  return hasCyrillic(text) ? "RU" : "UAE";
}

export function regionOfSurface(s: LoadedSurface): RegionCode {
  const reg = (s.region ?? "").toUpperCase();
  if (reg.includes("RU")) return "RU";
  if (reg.includes("AE") || reg.includes("UAE")) return "UAE";
  if ((s.language ?? "").toLowerCase().startsWith("ru")) return "RU";
  const text = `${s.query ?? ""} ${s.title ?? ""}`;
  return hasCyrillic(text) ? "RU" : "UAE";
}

function share(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 1000) / 1000 : 0;
}

// ---------------------------------------------------------------------------
// Search summary
// ---------------------------------------------------------------------------

export function computeSearchSummary(
  organic: LoadedOrganic[],
  findings: LoadedFinding[]
): SearchSummary {
  const uniqueUrls = new Set(organic.map((r) => r.url));
  const negatives = organic.filter(isNegativeOrganic);
  const negativeDomains = Array.from(
    new Set(negatives.map((r) => domainOf(r.url)).filter(Boolean))
  );

  const themeCount = new Map<RiskTheme, number>();
  for (const f of findings) {
    if (f.reviewStatus === "DISMISSED") continue;
    const t = (f.riskTheme ?? f.category) as RiskTheme;
    themeCount.set(t, (themeCount.get(t) ?? 0) + 1);
  }
  const topNegativeThemes = Array.from(themeCount.entries())
    .filter(([t]) => t !== "wikipedia" && t !== "search_profile")
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([theme, count]) => ({ theme, count }));

  return {
    totalResults: organic.length,
    uniqueUrls: uniqueUrls.size,
    negativeResults: negatives.length,
    negativeShare: share(negatives.length, organic.length),
    negativeDomains: negativeDomains.slice(0, 10),
    topNegativeThemes,
    topNegativeUrls: negatives.slice(0, 5).map((r) => ({ url: r.url, title: r.title })),
  };
}

// ---------------------------------------------------------------------------
// Surfaces summary
// ---------------------------------------------------------------------------

function countSurface(items: LoadedSurface[], type: string) {
  const subset = items.filter((s) => s.type === type);
  const negative = subset.filter(isNegativeSurface).length;
  return { total: subset.length, negative, negativeShare: share(negative, subset.length) };
}

export function computeSurfacesSummary(
  surfaces: LoadedSurface[],
  screenshots: number
): SurfacesSummary {
  const knowledge = surfaces.filter((s) => s.type === "KNOWLEDGE_BLOCK");
  const mismatches = knowledge.filter((s) => {
    const meta = (s.rawMetadata ?? {}) as Record<string, unknown>;
    return (
      meta.mismatch === true ||
      meta.manualFlag === true ||
      (s.classification ?? "").toUpperCase() === "MISMATCH"
    );
  }).length;

  return {
    suggestions: countSurface(surfaces, "SUGGESTION"),
    relatedQueries: countSurface(surfaces, "RELATED_QUERY"),
    images: countSurface(surfaces, "IMAGE_RESULT"),
    videos: countSurface(surfaces, "VIDEO_RESULT"),
    knowledgeBlocks: { total: knowledge.length, mismatches },
    screenshots,
    syntheticSnapshots: surfaces.filter(
      (s) => s.type === "SERP_SCREENSHOT" || s.source === "SYNTHETIC_SNAPSHOT"
    ).length,
  };
}

// ---------------------------------------------------------------------------
// Wikipedia summary
// ---------------------------------------------------------------------------

export function computeWikipediaSummary(
  wikis: LoadedWiki[],
  locale: ReportLanguage = "ru"
): WikipediaSummary {
  const p = auditPhrases(locale);
  // Prefer an existing page if any check found one.
  const present = wikis.find((w) => w.exists) ?? null;
  const any = wikis[0] ?? null;
  const exists = !!present;
  const w = present ?? any;
  let notabilityScore = 0;
  if (exists && w) {
    notabilityScore = 70 + (w.url ? 20 : 0) + (w.pageTitle ? 10 : 0);
    if (notabilityScore > 100) notabilityScore = 100;
  }
  const conclusion = exists
    ? p.wikiExists()
    : wikis.length === 0
      ? p.wikiNotChecked()
      : p.wikiAbsent();

  return {
    exists,
    pageUrl: w?.url ?? null,
    language: w?.language ?? null,
    notabilityScore,
    conclusion,
  };
}

// ---------------------------------------------------------------------------
// Compliance database summary
// ---------------------------------------------------------------------------

export function computeComplianceSummary(
  dbs: LoadedDb[],
  locale: ReportLanguage = "ru"
): ComplianceDatabaseSummary {
  const p = auditPhrases(locale);
  const active = dbs.filter(isActiveComplianceHit);
  const providersChecked = providersQueriedFromCompliance(dbs);
  const pepMatches = active.filter((d) => riskTypesOf(d).includes("PEP")).length;
  const rcaMatches = active.filter((d) => /RCA/.test((d.matchType ?? "").toUpperCase())).length;
  const sanctionsMatches = active.filter((d) => riskTypesOf(d).includes("SANCTIONS")).length;
  const adverseMediaMatches = active.filter((d) => riskTypesOf(d).includes("ADVERSE_MEDIA")).length;
  const activeMatches = active.filter(
    (d) =>
      (d.matchScore ?? 0) >= 45 ||
      riskTypesOf(d).some((rt) => ["SANCTIONS", "PEP", "WATCHLIST", "ADVERSE_MEDIA"].includes(rt))
  ).length;

  let conclusion: string;
  if (dbs.length === 0) {
    conclusion = p.compNone();
  } else if (sanctionsMatches > 0) {
    conclusion = p.compSanctions();
  } else if (pepMatches + rcaMatches > 0) {
    conclusion = p.compPepRca();
  } else if (activeMatches > 0) {
    conclusion = p.compActive();
  } else if (dbs.some((d) => d.reviewStatus === "PENDING" || d.reviewStatus === "NEEDS_REVIEW")) {
    conclusion =
      locale === "ru"
        ? "Есть потенциальные совпадения, ожидающие проверки аналитиком."
        : "Potential matches pending analyst review.";
  } else {
    conclusion = p.compNoMaterial();
  }

  return {
    providersChecked,
    activeMatches,
    pepMatches,
    rcaMatches,
    sanctionsMatches,
    adverseMediaMatches,
    conclusion,
  };
}

// ---------------------------------------------------------------------------
// Risk summary (excludes dismissed from top findings)
// ---------------------------------------------------------------------------

export function computeRiskSummary(findings: LoadedFinding[]): RiskSummaryBlock {
  const active = findings.filter((f) => f.reviewStatus !== "DISMISSED");
  const findingsByLevel: Record<string, number> = {};
  const findingsByTheme: Record<string, number> = {};
  for (const f of active) {
    findingsByLevel[f.severity] = (findingsByLevel[f.severity] ?? 0) + 1;
    const theme = f.riskTheme ?? f.category;
    findingsByTheme[theme] = (findingsByTheme[theme] ?? 0) + 1;
  }
  const highest = active.reduce<OverallRiskLevel>((acc, f) => {
    const lvl = f.severity as keyof typeof RISK_LEVEL_RANK;
    if (!(lvl in RISK_LEVEL_RANK)) return acc;
    if (acc === "UNKNOWN") return f.severity as OverallRiskLevel;
    const accRank = RISK_LEVEL_RANK[acc as keyof typeof RISK_LEVEL_RANK] ?? 0;
    return RISK_LEVEL_RANK[lvl] > accRank ? (f.severity as OverallRiskLevel) : acc;
  }, "UNKNOWN");

  const topFindings = active
    .slice()
    .sort(
      (a, b) =>
        (RISK_LEVEL_RANK[b.severity as keyof typeof RISK_LEVEL_RANK] ?? 0) -
        (RISK_LEVEL_RANK[a.severity as keyof typeof RISK_LEVEL_RANK] ?? 0)
    )
    .slice(0, 5)
    .map((f) => ({
      severity: f.severity,
      theme: f.riskTheme ?? f.category,
      title: f.title,
      reviewStatus: f.reviewStatus,
      evidenceCount: f.evidenceCount,
    }));

  return {
    highestRiskLevel: active.length === 0 ? "UNKNOWN" : highest,
    totalFindings: active.length,
    findingsByLevel,
    findingsByTheme,
    topFindings,
  };
}

// ---------------------------------------------------------------------------
// Overall risk level (deterministic)
// ---------------------------------------------------------------------------

export interface OverallRiskInput {
  findings: LoadedFinding[];
  compliance: ComplianceDatabaseSummary;
  searchNegativeShare: number;
  negativeSuggestions: number;
  negativeImages: number;
  negativeVideos: number;
  wikipediaAbsent: boolean;
  evidenceCount: number;
}

export function calculateOverallRiskLevel(input: OverallRiskInput): OverallRiskLevel {
  if (input.evidenceCount === 0) return "UNKNOWN";

  const active = input.findings.filter((f) => f.reviewStatus !== "DISMISSED");
  const has = (lvl: string) => active.some((f) => f.severity === lvl);

  if (has("CRITICAL") || input.compliance.sanctionsMatches > 0) return "CRITICAL";

  if (
    has("HIGH") ||
    input.compliance.pepMatches + input.compliance.rcaMatches > 0 ||
    input.searchNegativeShare >= 0.25
  ) {
    return "HIGH";
  }

  const hasNegativeSurfaces =
    input.negativeSuggestions > 0 || input.negativeImages > 0 || input.negativeVideos > 0;
  const otherRisks = active.length > 0 || hasNegativeSurfaces || input.searchNegativeShare > 0;
  if (
    input.searchNegativeShare >= 0.1 ||
    hasNegativeSurfaces ||
    (input.wikipediaAbsent && otherRisks)
  ) {
    return "MEDIUM";
  }

  return "LOW";
}

// ---------------------------------------------------------------------------
// Regions (RU / UAE)
// ---------------------------------------------------------------------------

const REGIONS: RegionCode[] = ["RU", "UAE"];
const REGION_LANG: Record<RegionCode, string> = { RU: "ru", UAE: "en" };

export function computeRegions(
  organic: LoadedOrganic[],
  surfaces: LoadedSurface[],
  locale: ReportLanguage = "ru"
): RegionAuditSummary[] {
  const p = auditPhrases(locale);
  return REGIONS.map((region) => {
    const ro = organic.filter((r) => regionOfOrganic(r) === region);
    const rs = surfaces.filter((s) => regionOfSurface(s) === region);
    const negatives = ro.filter(isNegativeOrganic);
    const positives = ro.filter(isPositiveOrganic);
    const negUrls = new Set(negatives.map((r) => r.url));
    const allUrls = new Set(ro.map((r) => r.url));

    const sug = rs.filter((s) => s.type === "SUGGESTION");
    const rel = rs.filter((s) => s.type === "RELATED_QUERY");
    const img = rs.filter((s) => s.type === "IMAGE_RESULT");
    const vid = rs.filter((s) => s.type === "VIDEO_RESULT");
    const kb = rs.filter((s) => s.type === "KNOWLEDGE_BLOCK");
    const kbMismatch = kb.some((s) => {
      const meta = (s.rawMetadata ?? {}) as Record<string, unknown>;
      return meta.mismatch === true || (s.classification ?? "").toUpperCase() === "MISMATCH";
    });

    const negShare = share(negatives.length, ro.length);
    const sugNeg = sug.filter(isNegativeSurface).length;
    const imgNeg = img.filter(isNegativeSurface).length;
    const vidNeg = vid.filter(isNegativeSurface).length;

    let regionRiskLevel: OverallRiskLevel = "LOW";
    if (ro.length + rs.length === 0) regionRiskLevel = "UNKNOWN";
    else if (negShare >= 0.25) regionRiskLevel = "HIGH";
    else if (negShare >= 0.1 || sugNeg + imgNeg + vidNeg > 0) regionRiskLevel = "MEDIUM";

    const regionConclusion =
      ro.length + rs.length === 0
        ? p.regionNoData(region)
        : negatives.length > 0
          ? p.regionNegative(region, negatives.length, ro.length)
          : p.regionNoAdverse(region);

    return {
      region,
      language: REGION_LANG[region],
      organicTotal: ro.length,
      organicNegative: negatives.length,
      organicNeutral: ro.length - negatives.length - positives.length,
      organicPositive: positives.length,
      organicNegativeShare: negShare,
      uniqueNegativeUrls: negUrls.size,
      totalUniqueUrls: allUrls.size,
      suggestionsTotal: sug.length,
      suggestionsNegative: sugNeg,
      relatedQueriesTotal: rel.length,
      relatedQueriesNegative: rel.filter(isNegativeSurface).length,
      imagesTotal: img.length,
      imagesNegative: imgNeg,
      videosTotal: vid.length,
      videosNegative: vidNeg,
      knowledgeBlockStatus: kb.length === 0 ? "ABSENT" : kbMismatch ? "MISMATCH" : "PRESENT",
      regionRiskLevel,
      regionConclusion,
      topResults: ro
        .slice()
        .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999))
        .slice(0, 20)
        .map((r) => ({
          provider: r.engine,
          rank: r.rank,
          domain: domainOf(r.url),
          title: r.title ?? r.url,
          classification: r.classification,
        })),
      topSuggestions: sug
        .map((s) => s.query ?? s.title ?? "")
        .filter(Boolean)
        .slice(0, 15),
      topImages: img
        .slice(0, 10)
        .map((s) => ({ title: s.title ?? s.query ?? "image", url: s.imageUrl ?? s.url })),
      topVideos: vid
        .slice(0, 10)
        .map((s) => ({ title: s.title ?? s.query ?? "video", url: s.videoUrl ?? s.url })),
      topThemes: computeRegionThemes(negatives, rs),
      topNegativeDomains: Array.from(
        new Set(negatives.map((r) => domainOf(r.url)).filter(Boolean))
      ).slice(0, 10),
      topNegativeUrls: negatives.slice(0, 10).map((r) => ({
        title: r.title ?? r.url,
        domain: domainOf(r.url),
        classification: r.classification,
      })),
      topRelatedQueries: rel
        .map((s) => s.query ?? s.title ?? "")
        .filter(Boolean)
        .slice(0, 15),
      knowledgeBlock:
        kb.length === 0
          ? null
          : {
              title: kb[0].title ?? kb[0].query ?? "Knowledge block",
              snippet: kb[0].snippet ?? "",
              source: kb[0].source ?? "",
            },
      evidenceAppendix: ro.slice(0, 15).map((r) => ({
        title: r.title ?? r.url,
        domain: domainOf(r.url),
        provider: r.engine,
        classification: r.classification,
      })),
    };
  });
}

/** Region-scoped negative theme counts (deterministic, bounded). */
function computeRegionThemes(
  negatives: LoadedOrganic[],
  surfaces: LoadedSurface[]
): { theme: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of surfaces) {
    if (!isNegativeSurface(s)) continue;
    const t = s.riskTheme ?? "search_profile";
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  for (const r of negatives) {
    const t = r.classification === "ADVERSE_MEDIA" ? "adverse_media" : "search_profile";
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([theme, count]) => ({ theme, count }));
}

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

export function computeDataQuality(params: {
  evidenceCount: number;
  findings: LoadedFinding[];
  organicCount: number;
  surfacesCount: number;
  wikiCount: number;
  dbCount: number;
  locale?: ReportLanguage;
}): DataQualitySummary {
  const p = auditPhrases(params.locale ?? "ru");
  const reviewedFindings = params.findings.filter((f) => f.reviewStatus === "REVIEWED").length;
  const pendingFindings = params.findings.filter((f) => f.reviewStatus === "PENDING").length;
  const dismissedFindings = params.findings.filter((f) => f.reviewStatus === "DISMISSED").length;

  const missingSections: string[] = [];
  if (params.organicCount === 0) missingSections.push("organic_search");
  if (params.surfacesCount === 0) missingSections.push("search_surfaces");
  if (params.wikiCount === 0) missingSections.push("wikipedia");
  if (params.dbCount === 0) missingSections.push("compliance_databases");

  const warnings: string[] = [];
  if (params.evidenceCount === 0) {
    warnings.push(p.dqNoEvidence());
  } else if (params.evidenceCount < 5) {
    warnings.push(p.dqLittleEvidence());
  }
  if (params.organicCount > 0 && params.organicCount < 5) {
    warnings.push(p.dqFewOrganic());
  }
  if (pendingFindings > 0) {
    warnings.push(p.dqPending(pendingFindings));
  }
  if (missingSections.length > 0) {
    warnings.push(p.dqMissing(missingSections.join(", ")));
  }

  return {
    evidenceCount: params.evidenceCount,
    reviewedFindings,
    pendingFindings,
    dismissedFindings,
    missingSections,
    warnings,
  };
}
