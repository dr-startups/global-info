/**
 * Stage O5.4 — central report-facing selected evidence view model.
 *
 * Renderer pages must consume this VM (via auditSummary region patches or
 * report_json.selectedEvidence) — never raw collected SearchSurfaceItem rows.
 */

import type { AuditSummary } from "../audit-summary/types";
import type { ComplianceSummaryBlock } from "../compliance-providers/types";
import type { EvidenceQualitySummary } from "../evidence-quality/types";
import type { ReportAudience } from "../evidence-quality/types";
const AUTOCOMPLETE_DISCLAIMER =
  "Подсказки отражают ассоциации поисковика при вводе похожих запросов и не являются подтверждёнными материалами о субъекте.";
import type { ReportRiskSummary } from "../types";
import {
  regionBlockToAuditRegion,
  type RegionSearchSurfacesBlock,
  type SearchSurfacesReportBlock,
  type SurfaceReportItem,
} from "./search-surfaces-report-builder";

const COMPLIANCE_THEMES = new Set([
  "sanctions",
  "pep_rca",
  "compliance_database",
  "pep",
  "sanctions",
  "rca",
  "adverse_media",
]);

const SUBJECT_IDENTITY = new Set(["EXACT_SUBJECT", "LIKELY_SUBJECT"]);

export interface SelectedEvidenceAppendixRow {
  title: string;
  domain: string;
  type: string;
  identity: string;
  class: string;
  review: string;
  link: string;
}

export interface ExcludedEvidenceRow {
  title: string;
  domain: string;
  reason: string;
  identityDecision: string;
}

export interface SelectedVideoCard {
  title: string;
  sourceDomain: string;
  url: string;
  thumbnailUrl: string | null;
  identityDecision: string;
  selectionReason: string;
}

export interface SelectedImageCard {
  title: string;
  sourceDomain: string;
  sourceUrl: string;
  thumbnailStorageKey: string | null;
  thumbnailBase64?: string;
  identityDecision: string;
  subjectMatched: boolean;
}

export interface SelectedEvidenceMetrics {
  collectedTotal: number;
  subjectMatchedTotal: number;
  selectedForReport: number;
  namesakesExcluded: number;
  insufficientMatchesExcluded: number;
  imagesCollected: number;
  imagesSelected: number;
  videosCollected: number;
  videosSelected: number;
  autocompleteTotal: number;
  autocompleteEvidenceImpact: 0;
}

export interface SelectedEvidenceRegionVm {
  code: "RU" | "UAE" | "INTERNATIONAL";
  auditRegion: Record<string, unknown>;
  images: SelectedImageCard[];
  videos: SelectedVideoCard[];
  organicSelected: SurfaceReportItem[];
  organicNegativeSelected: SurfaceReportItem[];
  confirmedAppendix: SelectedEvidenceAppendixRow[];
  excludedAppendix: ExcludedEvidenceRow[];
  noIntlSubjectResults: boolean;
}

export interface SelectedEvidenceReportVm {
  organic: {
    selected: SurfaceReportItem[];
    negativeSelected: SurfaceReportItem[];
  };
  suggestions: {
    autocompleteExposure: SearchSurfacesReportBlock["regions"]["ru"]["suggestions"];
    disclaimer: string;
  };
  related: {
    autocompleteExposure: SearchSurfacesReportBlock["regions"]["ru"]["relatedQueries"];
  };
  images: {
    selectedSubjectMatched: SelectedImageCard[];
    metrics: Pick<
      SelectedEvidenceMetrics,
      "imagesCollected" | "imagesSelected"
    >;
  };
  videos: {
    selectedSubjectMatched: SelectedVideoCard[];
    metrics: Pick<SelectedEvidenceMetrics, "videosCollected" | "videosSelected">;
  };
  appendix: {
    confirmedSubjectEvidence: SelectedEvidenceAppendixRow[];
    excludedNamesakesInternalOnly: ExcludedEvidenceRow[];
  };
  riskFindings: {
    selectedSubjectMatchedOnly: Array<{
      severity: string;
      theme: string;
      title: string;
      evidenceCount: number;
      reviewStatus: string;
    }>;
  };
  compliance: {
    manualConfirmedOnly: boolean;
    providersRun: boolean;
  };
  metrics: SelectedEvidenceMetrics;
  regions: {
    ru: SelectedEvidenceRegionVm;
    uae: SelectedEvidenceRegionVm;
    international: SelectedEvidenceRegionVm;
  };
}

function domainOf(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function isSubjectMatchedItem(item: SurfaceReportItem): boolean {
  const id = item.identityDecision ?? "";
  return SUBJECT_IDENTITY.has(id) || item.reportEligibility === "CLIENT_INCLUDE";
}

/** O5.4 — images/videos need a visible subject anchor, not weak LIKELY on social noise. */
function isStrictMediaSubjectMatch(item: SurfaceReportItem, audience: ReportAudience): boolean {
  const text = `${item.title ?? ""} ${item.query ?? ""}`.toLowerCase();
  const hasSurname = text.includes("томилин") || text.includes("tomilin");
  const hasGiven = text.includes("константин") || text.includes("konstantin");
  if (item.identityDecision === "EXACT_SUBJECT") return true;
  if (item.reportEligibility === "CLIENT_INCLUDE" && item.identityDecision !== "LIKELY_SUBJECT") {
    return true;
  }
  if (!SUBJECT_IDENTITY.has(item.identityDecision ?? "")) {
    if (
      audience === "INTERNAL" &&
      item.identityDecision === "POSSIBLE_SUBJECT" &&
      item.reportEligibility === "REVIEW_REQUIRED"
    ) {
      return hasSurname && hasGiven && !WEAK_INTL_TITLE.test(text);
    }
    return false;
  }
  return hasSurname && hasGiven;
}

const WEAK_INTL_TITLE =
  /romanovich|lomonosov|rbml\s*collections|abramovich|tomlinson|anatoli\s+romanovich|prince\s+nicholas|nikita\s+romanovich|mikhail\s+romanovich/i;

/** O5.4.1 — international/UAE organic requires Tomilin+Konstantin anchor, not Romanovich-only noise. */
function isStrictIntlOrganicMatch(item: SurfaceReportItem): boolean {
  if (!isSubjectMatchedItem(item)) return false;
  const text = item.title ?? "";
  if (WEAK_INTL_TITLE.test(text)) return false;
  if (item.identityDecision === "EXACT_SUBJECT" || item.identityDecision === "LIKELY_SUBJECT") {
    const lower = text.toLowerCase();
    const hasSurname = lower.includes("томилин") || lower.includes("tomilin");
    const hasGiven = lower.includes("константин") || lower.includes("konstantin");
    return hasSurname && hasGiven;
  }
  return item.reportEligibility === "CLIENT_INCLUDE";
}

function isNegativeSelected(item: SurfaceReportItem): boolean {
  return Boolean(
    item.classification &&
      ["ADVERSE_MEDIA", "LEGAL", "REPUTATIONAL", "FRAUD", "SANCTIONS", "PEP"].some((t) =>
        String(item.classification).toUpperCase().includes(t)
      )
  );
}

function decisionPriority(decision: string | undefined): number {
  if (decision === "include") return 4;
  if (decision === "review") return 3;
  if (decision === "fallback") return 2;
  if (decision === "duplicate") return 1;
  return 0;
}

function identityPriority(identity: string | undefined): number {
  if (identity === "EXACT_SUBJECT") return 3;
  if (identity === "LIKELY_SUBJECT") return 2;
  if (identity === "POSSIBLE_SUBJECT") return 1;
  return 0;
}

function sortByEvidenceRank(items: SurfaceReportItem[]): SurfaceReportItem[] {
  return [...items].sort((a, b) => {
    const d = decisionPriority(b.sourceQualityDecision) - decisionPriority(a.sourceQualityDecision);
    if (d !== 0) return d;
    const i = identityPriority(b.identityDecision) - identityPriority(a.identityDecision);
    if (i !== 0) return i;
    const r = (b.sourceRank ?? 0) - (a.sourceRank ?? 0);
    if (r !== 0) return r;
    return (a.title ?? "").localeCompare(b.title ?? "");
  });
}

function surfaceTypeLabel(item: SurfaceReportItem, bucket: "organic" | "image" | "video"): string {
  if (bucket === "image") return "IMAGE";
  if (bucket === "video") return "VIDEO";
  return "ORGANIC";
}

function toAppendixRow(
  item: SurfaceReportItem,
  bucket: "organic" | "image" | "video"
): SelectedEvidenceAppendixRow {
  return {
    title: item.title,
    domain: item.domain ?? domainOf(item.url ?? item.sourcePageUrl),
    type: surfaceTypeLabel(item, bucket),
    identity: item.identityDecision ?? "—",
    class: item.classification ?? item.contentClass ?? "—",
    review: item.reportEligibility ?? "—",
    link: item.sourcePageUrl ?? item.url ?? "",
  };
}

function toExcludedRow(item: SurfaceReportItem): ExcludedEvidenceRow {
  const reason =
    item.clientSafeReason ??
    (item.identityDecision === "NAMESAKE"
      ? "namesake"
      : item.identityDecision === "ENTITY_MISMATCH"
        ? "entity mismatch"
        : item.identityDecision === "INSUFFICIENT_MATCH"
          ? "insufficient match / Romanovich-only"
          : item.reportEligibility === "EXCLUDE"
            ? "excluded"
            : "not subject");
  return {
    title: item.title,
    domain: item.domain ?? domainOf(item.url),
    reason,
    identityDecision: item.identityDecision ?? "—",
  };
}

function toVideoCard(item: SurfaceReportItem): SelectedVideoCard {
  const url = item.sourcePageUrl ?? item.url ?? "";
  return {
    title: item.title,
    sourceDomain: item.domain ?? domainOf(url),
    url,
    thumbnailUrl: item.thumbnailUrl,
    identityDecision: item.identityDecision ?? "",
    selectionReason:
      item.identityDecision === "EXACT_SUBJECT"
        ? "exact subject"
        : item.identityDecision === "LIKELY_SUBJECT"
          ? "likely subject"
          : item.reportEligibility === "CLIENT_INCLUDE"
            ? "manual include"
            : "selected",
  };
}

function toImageCard(item: SurfaceReportItem): SelectedImageCard {
  return {
    title: item.title,
    sourceDomain: item.domain ?? domainOf(item.sourcePageUrl ?? item.url),
    sourceUrl: item.sourcePageUrl ?? item.url ?? "",
    thumbnailStorageKey: item.thumbnailStorageKey ?? null,
    identityDecision: item.identityDecision ?? "",
    subjectMatched: isSubjectMatchedItem(item),
  };
}

function filterItemsForAudience(items: SurfaceReportItem[], audience: ReportAudience): SurfaceReportItem[] {
  if (audience === "INTERNAL") return items;
  return items.filter(
    (i) => i.reportEligibility === "CLIENT_INCLUDE" || SUBJECT_IDENTITY.has(i.identityDecision ?? "")
  );
}

function buildRegionVm(
  block: RegionSearchSurfacesBlock,
  code: "RU" | "UAE" | "INTERNATIONAL",
  audience: ReportAudience,
  reportLanguage: "ru" | "en"
): SelectedEvidenceRegionVm {
  const organicSelected = sortByEvidenceRank(filterItemsForAudience(
    block.organic.items.filter(
      code === "RU" ? isSubjectMatchedItem : isStrictIntlOrganicMatch
    ),
    audience
  ));
  const organicNegativeSelected = organicSelected.filter(isNegativeSelected);

  const imagesSelected = sortByEvidenceRank(filterItemsForAudience(
    block.images.items.filter((i) => isStrictMediaSubjectMatch(i, audience)),
    audience
  ));
  const videosSelected = sortByEvidenceRank(filterItemsForAudience(
    block.videos.items.filter((i) => isStrictMediaSubjectMatch(i, audience)),
    audience
  ));

  const confirmedAppendix: SelectedEvidenceAppendixRow[] = [];
  const seen = new Set<string>();
  const appendUnique = (item: SurfaceReportItem, bucket: "organic" | "image" | "video") => {
    const key =
      item.sourceFingerprint ??
      item.canonicalUrlKey ??
      `${item.domain ?? ""}|${item.title ?? ""}|${bucket}`;
    if (seen.has(key)) return;
    seen.add(key);
    confirmedAppendix.push(toAppendixRow(item, bucket));
  };
  for (const item of organicSelected) appendUnique(item, "organic");
  for (const item of imagesSelected) appendUnique(item, "image");
  for (const item of videosSelected) appendUnique(item, "video");

  const excludedAppendix: ExcludedEvidenceRow[] = [];
  if (audience === "INTERNAL") {
    for (const bucket of [block.organic, block.images, block.videos]) {
      for (const item of bucket.excludedItems ?? []) {
        excludedAppendix.push(toExcludedRow(item));
      }
    }
  }

  const noIntlSubjectResults =
    code !== "RU" &&
    organicSelected.length === 0 &&
    imagesSelected.length === 0 &&
    videosSelected.length === 0 &&
    block.collectionStatus === "COLLECTED";

  const auditRegion = regionBlockToAuditRegion(block, {
    audience,
    reportLanguage,
    confirmedAppendix,
    excludedAppendix,
    organicSelected,
    imagesSelected,
    videosSelected,
  });

  if (auditRegion) {
    auditRegion.noIntlSubjectResults = noIntlSubjectResults;
  }

  return {
    code,
    auditRegion: auditRegion ?? {},
    images: imagesSelected.map(toImageCard),
    videos: videosSelected.map(toVideoCard),
    organicSelected,
    organicNegativeSelected,
    confirmedAppendix,
    excludedAppendix,
    noIntlSubjectResults,
  };
}

export function hasManualComplianceEvidence(
  complianceSummary?: ComplianceSummaryBlock | null
): boolean {
  if (!complianceSummary) return false;
  if ((complianceSummary.confirmedHits ?? 0) > 0) return true;
  return (complianceSummary.topHits ?? []).some((h) => {
    const src = String(h.source ?? "").toUpperCase();
    return src.includes("MANUAL") && String(h.reviewStatus ?? "") !== "DISMISSED";
  });
}

export function complianceProvidersWereRun(
  complianceSummary?: ComplianceSummaryBlock | null
): boolean {
  if (!complianceSummary) return false;
  return (complianceSummary.totalHits ?? 0) > 0 || (complianceSummary.confirmedHits ?? 0) > 0;
}

export function filterReportRiskFindings(
  findings: Array<{
    severity: string;
    theme: string;
    title: string;
    evidenceCount: number;
    reviewStatus?: string;
  }>,
  complianceSummary?: ComplianceSummaryBlock | null,
  evidenceQuality?: EvidenceQualitySummary | null
): Array<{
  severity: string;
  theme: string;
  title: string;
  evidenceCount: number;
  reviewStatus: string;
}> {
  const manualOnly = hasManualComplianceEvidence(complianceSummary);
  const providersRun = complianceProvidersWereRun(complianceSummary);

  return findings.filter((f) => {
    const theme = String(f.theme ?? "").toLowerCase();
    const title = String(f.title ?? "").toUpperCase();

    if (!manualOnly && !providersRun) {
      if (COMPLIANCE_THEMES.has(theme)) return false;
      if (
        title.includes("WORLD_CHECK") ||
        title.includes("DOW_JONES") ||
        title.includes("LEXIS") ||
        title.includes("SANCTIONS") ||
        title.includes(" PEP ") ||
        title.startsWith("PEP ") ||
        title.includes("RCA")
      ) {
        return false;
      }
    }

    if (
      evidenceQuality &&
      evidenceQuality.highConfidenceRisks.length === 0 &&
      f.severity === "CRITICAL" &&
      String(f.reviewStatus ?? "PENDING") === "PENDING"
    ) {
      return false;
    }

    return true;
  }).map((f) => ({
    ...f,
    reviewStatus: String(f.reviewStatus ?? "PENDING"),
  }));
}

export function buildSelectedEvidenceReportVm(input: {
  searchSurfaces: SearchSurfacesReportBlock;
  reportAudience?: ReportAudience;
  reportLanguage?: "ru" | "en";
  riskSummary?: ReportRiskSummary | null;
  complianceSummary?: ComplianceSummaryBlock | null;
  evidenceQuality?: EvidenceQualitySummary | null;
}): SelectedEvidenceReportVm {
  const audience = input.reportAudience ?? "INTERNAL";
  const reportLanguage = input.reportLanguage ?? "ru";
  const ru = buildRegionVm(input.searchSurfaces.regions.ru, "RU", audience, reportLanguage);
  const uae = buildRegionVm(input.searchSurfaces.regions.uae, "UAE", audience, reportLanguage);
  const intl = buildRegionVm(
    input.searchSurfaces.regions.international,
    "INTERNATIONAL",
    audience,
    reportLanguage
  );

  const allOrganic = [...ru.organicSelected, ...uae.organicSelected, ...intl.organicSelected];
  const allImages = [...ru.images, ...uae.images, ...intl.images];
  const allVideos = [...ru.videos, ...uae.videos, ...intl.videos];

  const confirmedAppendix = [...ru.confirmedAppendix, ...uae.confirmedAppendix, ...intl.confirmedAppendix];
  const excludedAppendix = [...ru.excludedAppendix, ...uae.excludedAppendix, ...intl.excludedAppendix];

  const eq = input.evidenceQuality;
  const identity = eq?.identity;
  const img = eq?.imageEvidence;
  const ac = eq?.autocompleteExposure;

  const metrics: SelectedEvidenceMetrics = {
    collectedTotal: identity?.collectedTotal ?? eq?.totals.collected ?? 0,
    subjectMatchedTotal: identity?.subjectMatchedTotal ?? 0,
    selectedForReport: identity?.selectedForClient ?? eq?.totals.clientIncluded ?? confirmedAppendix.length,
    namesakesExcluded: identity?.namesakesExcluded ?? 0,
    insufficientMatchesExcluded: identity?.insufficientMatchesExcluded ?? 0,
    imagesCollected: img?.collected ?? input.searchSurfaces.globalSummary.imagesTotal,
    imagesSelected: allImages.length,
    videosCollected:
      img?.collected !== undefined
        ? input.searchSurfaces.globalSummary.videosTotal
        : input.searchSurfaces.globalSummary.videosTotal,
    videosSelected: allVideos.length,
    autocompleteTotal: ac?.total ?? 0,
    autocompleteEvidenceImpact: 0,
  };

  const filteredFindings = filterReportRiskFindings(
    input.riskSummary?.topFindings ?? [],
    input.complianceSummary,
    input.evidenceQuality
  );

  return {
    organic: {
      selected: allOrganic,
      negativeSelected: allOrganic.filter(isNegativeSelected),
    },
    suggestions: {
      autocompleteExposure: input.searchSurfaces.regions.ru.suggestions,
      disclaimer: AUTOCOMPLETE_DISCLAIMER,
    },
    related: {
      autocompleteExposure: input.searchSurfaces.regions.ru.relatedQueries,
    },
    images: {
      selectedSubjectMatched: allImages,
      metrics: { imagesCollected: metrics.imagesCollected, imagesSelected: metrics.imagesSelected },
    },
    videos: {
      selectedSubjectMatched: allVideos,
      metrics: { videosCollected: metrics.videosCollected, videosSelected: metrics.videosSelected },
    },
    appendix: {
      confirmedSubjectEvidence: confirmedAppendix,
      excludedNamesakesInternalOnly: excludedAppendix,
    },
    riskFindings: { selectedSubjectMatchedOnly: filteredFindings },
    compliance: {
      manualConfirmedOnly: hasManualComplianceEvidence(input.complianceSummary),
      providersRun: complianceProvidersWereRun(input.complianceSummary),
    },
    metrics,
    regions: { ru, uae, international: intl },
  };
}

/** Patches auditSummary regions + risk findings from the selected evidence VM. */
export function patchAuditSummaryWithSelectedEvidence(
  auditSummary: AuditSummary,
  vm: SelectedEvidenceReportVm
): AuditSummary {
  const regionPatches = [
    { code: "RU", patch: vm.regions.ru.auditRegion },
    { code: "UAE", patch: vm.regions.uae.auditRegion },
    { code: "INTERNATIONAL", patch: vm.regions.international.auditRegion },
  ];

  const regions = (auditSummary.regions ?? []).map((r) => {
    const match = regionPatches.find((p) => p.code === r.region);
    if (!match?.patch || Object.keys(match.patch).length === 0) return r;
    return { ...r, ...match.patch, region: r.region };
  });

  for (const { code, patch } of regionPatches) {
    if (!patch || Object.keys(patch).length === 0) continue;
    if (!regions.some((r) => r.region === code)) {
      regions.push({
        ...(patch as unknown as AuditSummary["regions"][number]),
        region: code as AuditSummary["regions"][number]["region"],
      });
    }
  }

  const riskSummary = auditSummary.riskSummary
    ? {
        ...auditSummary.riskSummary,
        topFindings: vm.riskFindings.selectedSubjectMatchedOnly,
        totalFindings: vm.riskFindings.selectedSubjectMatchedOnly.length,
      }
    : auditSummary.riskSummary;

  let overallRiskLevel = auditSummary.overallRiskLevel;
  if (!vm.compliance.providersRun && !vm.compliance.manualConfirmedOnly) {
    const hasComplianceCritical = vm.riskFindings.selectedSubjectMatchedOnly.some((f) =>
      COMPLIANCE_THEMES.has(String(f.theme ?? "").toLowerCase())
    );
    if (hasComplianceCritical && overallRiskLevel === "CRITICAL") {
      overallRiskLevel = "MEDIUM";
    }
  }

  return {
    ...auditSummary,
    regions,
    riskSummary,
    overallRiskLevel,
  };
}
