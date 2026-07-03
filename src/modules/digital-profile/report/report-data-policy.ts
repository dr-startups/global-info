/**
 * Report data hygiene policy (Stage R1.1).
 *
 * Production/client/internal reports exclude mock/demo fixtures from factual
 * sections unless explicit demo mode is enabled (meta.demo === true).
 */

import { isRealSource } from "../serp-snapshot/data-loader";

export interface ReportDataPolicy {
  includeDemoData: boolean;
}

export function resolveReportDataPolicy(meta?: { demo?: boolean } | null): ReportDataPolicy {
  return { includeDemoData: meta?.demo === true };
}

const DEMO_DOMAIN_SUFFIXES = [".example.com", ".example.test", ".example.org", ".example.net", ".example"];
const MOCK_URL_HINTS = /example\.(com|test|org|net)|\/mock[/\-]|mock\.example/i;

function readMeta(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

export function isDemoSearchRow(row: {
  url?: string | null;
  title?: string | null;
  snippet?: string | null;
  source?: string | null;
  rawMetadata?: unknown;
}): boolean {
  const src = (row.source ?? "").toLowerCase();
  if (src.startsWith("mock:")) return true;
  const meta = readMeta(row.rawMetadata);
  if (meta.demo === true || meta.mock === true) return true;
  if (/^\[DEMO\]/i.test(row.title ?? "")) return true;
  const url = (row.url ?? "").toLowerCase();
  if (MOCK_URL_HINTS.test(url)) return true;
  try {
    const host = new URL(row.url ?? "http://invalid").hostname.replace(/^www\./, "").toLowerCase();
    if (host.endsWith(".example") || DEMO_DOMAIN_SUFFIXES.some((s) => host === s.slice(1) || host.endsWith(s))) {
      return true;
    }
  } catch {
    /* invalid url */
  }
  return false;
}

/** Prefer real rows per engine; never fall back to mock in production mode. */
export function filterSearchResultsForReport<T extends { engine: string; source?: string | null }>(
  rows: T[],
  isDemo: (row: T) => boolean,
  policy: ReportDataPolicy
): { rows: T[]; excluded: number } {
  if (policy.includeDemoData) return { rows, excluded: 0 };

  const byEngine = new Map<string, T[]>();
  for (const row of rows) {
    const engine = row.engine ?? "UNKNOWN";
    const list = byEngine.get(engine) ?? [];
    list.push(row);
    byEngine.set(engine, list);
  }

  const out: T[] = [];
  let excluded = 0;
  for (const engineRows of byEngine.values()) {
    const nonDemo = engineRows.filter((row) => !isDemo(row));
    const real = nonDemo.filter((row) => isRealSource(row.source ?? null));
    const chosen =
      real.length > 0
        ? real
        : nonDemo.filter((row) => !String(row.source ?? "").toLowerCase().startsWith("mock:"));
    excluded += engineRows.length - chosen.length;
    out.push(...chosen);
  }
  return { rows: out, excluded };
}

export function isDemoComplianceHit(row: {
  hitSource?: string | null;
  importedBy?: string | null;
  rawMetadataSafe?: unknown;
  rawPayload?: unknown;
}): boolean {
  if (row.hitSource === "MOCK") return true;
  if ((row.importedBy ?? "").startsWith("mock:")) return true;
  const safe = readMeta(row.rawMetadataSafe ?? row.rawPayload);
  return safe.demo === true;
}

export function filterComplianceForReport<T>(
  rows: T[],
  isDemo: (row: T) => boolean,
  policy: ReportDataPolicy
): { rows: T[]; excluded: number } {
  if (policy.includeDemoData) return { rows, excluded: 0 };
  const filtered = rows.filter((row) => !isDemo(row));
  return { rows: filtered, excluded: rows.length - filtered.length };
}

export function isDemoFinding(row: { title?: string | null; demo?: boolean | null }): boolean {
  if (row.demo === true) return true;
  const title = row.title ?? "";
  if (/^\[DEMO\]/i.test(title)) return true;
  if (/\bdemo finding\b/i.test(title)) return true;
  return false;
}

export function isDemoSurface(row: {
  source?: string | null;
  title?: string | null;
  rawMetadata?: unknown;
}): boolean {
  if ((row.source ?? "").toUpperCase() === "MOCK") return true;
  const meta = readMeta(row.rawMetadata);
  if (meta.demo === true || meta.mock === true) return true;
  if (/^\[DEMO\]/i.test(row.title ?? "")) return true;
  return false;
}

export function providersQueriedFromCompliance(
  rows: Array<{ provider: string; hitSource?: string | null }>
): string[] {
  return Array.from(
    new Set(
      rows
        .filter((r) => r.hitSource === "MANUAL" || r.hitSource === "OFFICIAL_API")
        .map((r) => r.provider)
    )
  );
}

export type ReportWarningAudience = "internal" | "client_safe" | "all";
export type ReportWarningCategory =
  | "DATA_HYGIENE"
  | "PROVIDER_STATUS"
  | "RENDER"
  | "GENERAL";

export interface ReportWarning {
  text: string;
  audience: ReportWarningAudience;
  category: ReportWarningCategory;
}

export const REPORT_WARNING_DEMO_SEARCH_EXCLUDED = {
  en: "Demo/mock search rows were excluded from production report metrics.",
  ru: "Demo/mock строки поиска исключены из метрик production-отчёта.",
} as const;

export const REPORT_WARNING_DEMO_COMPLIANCE_EXCLUDED = {
  en: "Demo/mock compliance hits were excluded from production report metrics.",
  ru: "Demo/mock compliance-записи исключены из метрик production-отчёта.",
} as const;

export function createInternalHygieneWarning(
  text: string,
  category: ReportWarningCategory = "DATA_HYGIENE"
): ReportWarning {
  return { text, audience: "internal", category };
}

/** Normalize legacy string[] or structured ReportWarning[] from stored report_json. */
export function normalizeReportWarnings(
  raw: unknown
): ReportWarning[] {
  if (!Array.isArray(raw)) return [];
  const out: ReportWarning[] = [];
  for (const item of raw) {
    if (typeof item === "string" && item.trim()) {
      out.push({
        text: item,
        audience: isInternalHygieneText(item) ? "internal" : "all",
        category: isInternalHygieneText(item) ? "DATA_HYGIENE" : "GENERAL",
      });
    } else if (item && typeof item === "object" && typeof (item as ReportWarning).text === "string") {
      const w = item as ReportWarning;
      out.push({
        text: w.text,
        audience: w.audience ?? "all",
        category: w.category ?? "GENERAL",
      });
    }
  }
  return out;
}

const INTERNAL_HYGIENE_PATTERNS = [
  /demo\s*\/\s*mock/i,
  /mock rows/i,
  /excluded from production report metrics/i,
  /исключены из метрик production/i,
  /data hygiene/i,
  /fixture/i,
  /sourcemode/i,
  /provideradapter/i,
  /raw metadata/i,
  /unlinked risk findings/i,
  /несвязанн/i,
  /serp snapshot.*refresh/i,
  /serp snapshot не удалось/i,
  /stale or inconsistent serp/i,
  /устаревший.*serp snapshot/i,
] as const;

export function isInternalHygieneText(text: string): boolean {
  return INTERNAL_HYGIENE_PATTERNS.some((p) => p.test(text));
}

/** Warnings visible for the given render audience (internal vs client). */
export function filterReportWarningsForAudience(
  warnings: ReportWarning[],
  audience: "internal" | "client"
): ReportWarning[] {
  if (audience === "internal") return warnings;
  return warnings.filter((w) => w.audience !== "internal");
}

export const REPORT_WARNING_UNLINKED_FINDINGS_EXCLUDED = {
  en: "Unlinked risk findings were excluded from SERP snapshot themes.",
  ru: "Несвязанные риск-находки исключены из тем SERP snapshot.",
} as const;

export function reportWarningTexts(warnings: ReportWarning[]): string[] {
  return warnings.map((w) => w.text);
}

/** Keys stripped from client-facing report_json at any depth. */
const CLIENT_FORBIDDEN_JSON_KEYS = new Set([
  "sourceMode",
  "sourcePreference",
  "providerAdapter",
  "rawMetadata",
  "rawMetadataSafe",
  "staleReason",
  "wasRegeneratedForReport",
  "reportEligibility",
  "contentClass",
  "debug",
  "thumbnailBase64",
  "thumbnailBytesBase64",
  "thumbnailMimeType",
  "imageBase64",
  // Stage R3.6 — defensive deep-strip of internal-only detail fields.
  "internalDetail",
  "internalReason",
  "topExclusionReasons",
  "skippedReason",
  "fallbackReason",
  // Stage R4.2 — internal source-quality details.
  "sourceQualityReason",
  "sourceFingerprint",
  "canonicalUrlKey",
  "canonicalTitleKey",
  "duplicateGroupId",
  "duplicateRank",
  "duplicateReason",
  "artifactPathInternal",
  "internalCaption",
  "warningCodes",
  "queryId",
  "screenshotId",
  "surfaceId",
  "sourceSurfaceIds",
  "relatedScreenshotIds",
  "fallbackReason",
  "missingConfigKeys",
  "requiredEnv",
  "requiredEnvKeys",
  "recommendedAction",
]);

export type ReportJsonAudience = "internal" | "client";

/**
 * Stage R3.6 — production report mode. "production" is a client-safe alias that
 * enforces strict sanitization; it never relaxes client hardening.
 */
export type ReportProductionMode = "internal" | "client" | "production";

export interface ReportAudiencePolicy {
  audience: ReportJsonAudience;
  /** Whether the internal-only diagnostics page is rendered. */
  includeDiagnosticsPage: boolean;
  /** Whether internal diagnostics blocks may travel in report_json. */
  includeInternalDiagnostics: boolean;
  /** Whether internal-only analyst notes may be shown. */
  allowInternalNotes: boolean;
  /** Deterministic slide count contract for this audience. */
  expectedSlideCount: number;
}

/** Internal report renders the diagnostics page as the final internal-only slide. */
export const REPORT_INTERNAL_SLIDE_COUNT = 73;
export const REPORT_CLIENT_SLIDE_COUNT = 72;

/** Normalize any requested report mode into a concrete audience. */
export function normalizeProductionReportMode(
  mode: string | null | undefined
): ReportJsonAudience {
  const m = String(mode ?? "").toLowerCase();
  // production is client-safe by contract; unknown modes default to client (safe).
  if (m === "internal") return "internal";
  return "client";
}

/** Resolve the display/report policy for an audience (or production mode). */
export function getReportAudiencePolicy(
  mode: ReportProductionMode | string | null | undefined
): ReportAudiencePolicy {
  const audience = normalizeProductionReportMode(mode);
  if (audience === "internal") {
    return {
      audience,
      includeDiagnosticsPage: true,
      includeInternalDiagnostics: true,
      allowInternalNotes: true,
      expectedSlideCount: REPORT_INTERNAL_SLIDE_COUNT,
    };
  }
  return {
    audience,
    includeDiagnosticsPage: false,
    includeInternalDiagnostics: false,
    allowInternalNotes: false,
    expectedSlideCount: REPORT_CLIENT_SLIDE_COUNT,
  };
}

/** Report_json blocks that are internal-only and must never reach the client. */
const INTERNAL_ONLY_REPORT_BLOCKS = ["providerDiagnostics"] as const;

/** Remove internal-only diagnostics blocks from a client report_json copy. */
export function stripInternalDiagnostics<T extends Record<string, unknown>>(copy: T): T {
  for (const key of INTERNAL_ONLY_REPORT_BLOCKS) {
    if (key in copy) delete (copy as Record<string, unknown>)[key];
  }
  return copy;
}

/**
 * Raw enum / debug tokens that must never appear in client report_json text.
 * Kept separate from field-name stripping so we can scan serialized JSON too.
 */
export const CLIENT_FORBIDDEN_TEXT_MARKERS: string[] = [
  "MATCH_CONFIRMED",
  "NEEDS_REVIEW",
  "FALSE_POSITIVE",
  "LIKELY_SUBJECT",
  "NOT_SUBJECT",
  "POSSIBLE_SUBJECT",
  "INSUFFICIENT_IDENTITY",
  "WARN_POTENTIAL_REVIEW",
  "UNCLASSIFIED",
  "PROVIDER_NOT_IMPLEMENTED",
  "providerAdapter",
  "sourceMode",
  "sourcePreference",
  "rawMetadata",
  "internalDetail",
  "internalReason",
  "sourceQualityReason",
  "sourceFingerprint",
  "duplicateGroupId",
  "duplicateRank",
  "duplicateReason",
  "artifactPathInternal",
  "internalCaption",
  "warningCodes",
  "queryId",
  "screenshotId",
  "surfaceId",
  "sourceSurfaceIds",
  "relatedScreenshotIds",
  "fallbackReason",
  "missingConfigKeys",
  "requiredEnv",
  "requiredEnvKeys",
  "runtimeKind",
  "topExclusionReasons",
  "process.env",
  ".env",
  "localhost",
  "127.0.0.1",
  "Traceback (most recent call last)",
];

/** Find client-report policy violations in a serialized report_json string. */
export function findClientReportPolicyViolations(jsonStr: string): string[] {
  const violations: string[] = [];
  for (const marker of CLIENT_FORBIDDEN_TEXT_MARKERS) {
    if (jsonStr.includes(marker)) violations.push(marker);
  }
  return violations;
}

/**
 * Assert client report_json is production-safe. Returns violations; optionally
 * throws so a production render can fail loudly instead of leaking internals.
 */
export function assertClientReportPolicy(
  jsonStr: string,
  options: { throwOnViolation?: boolean } = {}
): string[] {
  const violations = findClientReportPolicyViolations(jsonStr);
  if (violations.length > 0 && options.throwOnViolation) {
    throw new Error(
      `Client report policy violation — forbidden markers present: ${violations.join(", ")}`
    );
  }
  return violations;
}

function stripForbiddenKeysDeep(value: unknown, forbidden: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripForbiddenKeysDeep(item, forbidden));
  }
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (forbidden.has(key)) continue;
    out[key] = stripForbiddenKeysDeep(child, forbidden);
  }
  return out;
}

function sanitizeSerpSnapshotMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!metadata) return metadata;
  const meta = { ...metadata };
  delete meta.sourceMode;
  delete meta.sourcePreference;
  delete meta.staleReason;
  delete meta.wasRegeneratedForReport;
  if (meta.perEngine && typeof meta.perEngine === "object") {
    const perEngine: Record<string, unknown> = {};
    for (const [engine, stats] of Object.entries(meta.perEngine as Record<string, unknown>)) {
      if (stats && typeof stats === "object") {
        const { sourceMode: _sm, ...rest } = stats as Record<string, unknown>;
        perEngine[engine] = rest;
      }
    }
    meta.perEngine = perEngine;
  }
  return meta;
}

function sanitizeSearchSurfacesForClient(
  searchSurfaces: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!searchSurfaces) return searchSurfaces;
  const out = { ...searchSurfaces };
  const regions = out.regions as Record<string, Record<string, unknown>> | undefined;
  if (regions) {
    const nextRegions: Record<string, Record<string, unknown>> = {};
    for (const [code, block] of Object.entries(regions)) {
      const nextBlock = { ...block };
      for (const bucketKey of [
        "organic",
        "suggestions",
        "relatedQueries",
        "images",
        "videos",
        "knowledgePanel",
      ]) {
        const bucket = nextBlock[bucketKey] as Record<string, unknown> | undefined;
        if (!bucket) continue;
        const items = Array.isArray(bucket.items) ? bucket.items : [];
        const clientItems = items
          .filter((item) => {
            const row = item as Record<string, unknown>;
            const el = row.reportEligibility;
            return !el || el === "CLIENT_INCLUDE";
          })
          .map((item) => {
            const {
              reportEligibility: _re,
              contentClass: _cc,
              sourceQualityReason: _sqr,
              sourceFingerprint: _sf,
              canonicalUrlKey: _cuk,
              canonicalTitleKey: _ctk,
              duplicateGroupId: _dg,
              duplicateRank: _dr,
              duplicateReason: _dgr,
              internalReason: _ir,
              ...rest
            } = item as Record<
              string,
              unknown
            >;
            return rest;
          });
        const stats = bucket.qualityStats as Record<string, unknown> | undefined;
        const nextBucket: Record<string, unknown> = {
          ...bucket,
          items: clientItems,
          qualityStats: stats
            ? {
                totalCollected: stats.totalCollected,
                selectedForReport: stats.selectedForReport,
                clientIncluded: stats.clientIncluded,
                dataQualityStatus: stats.dataQualityStatus,
              }
            : undefined,
        };
        // R3.6 — excluded/review/noise detail is internal-only (count-only for client).
        delete nextBucket.excludedItems;
        delete nextBucket.reviewItems;
        delete nextBucket.noiseItems;
        nextBlock[bucketKey] = nextBucket;
      }
      nextRegions[code] = nextBlock;
    }
    out.regions = nextRegions;
  }
  if (Array.isArray(out.dataQualityWarnings)) {
    out.dataQualityWarnings = out.dataQualityWarnings.filter(
      (w) => !isInternalHygieneText(String(w))
    );
  }
  return out;
}

function sanitizeSourceQualitySummaryForClient(
  block: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!block) return block;
  return {
    uniqueSources: block.uniqueSources,
    includedCount: block.includedCount,
    reviewCount: block.reviewCount,
    excludedCount: block.excludedCount,
    duplicateCount: block.duplicateCount,
    explanation:
      (block.explanation as Record<string, unknown> | undefined)?.ru ??
      (block.explanation as Record<string, unknown> | undefined)?.en ??
      "Duplicate and low-relevance matches are filtered.",
  };
}

function sanitizeSearchProvenanceSummaryForClient(
  block: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!block) return block;
  return {
    searchSourcesReviewed: block.searchSourcesReviewed ?? block.queryCount,
    evidenceLinkedCount: block.evidenceLinkedCount ?? block.linkedEvidenceCount,
    screenshotSummaryLabel:
      block.screenshotSummaryLabel ??
      "Search snapshots are generated from collected search results.",
    safeNote:
      block.safeNote ??
      "Search snapshots are generated from collected search results.",
  };
}

function sanitizeSearchProvenanceForClient(
  block: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!block) return block;
  const surfaces = Array.isArray(block.surfaceProvenance)
    ? block.surfaceProvenance.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          surfaceType: r.surfaceType,
          region: r.region,
          language: r.language,
          providerLabel: r.providerLabel,
          sourceQualityDecision: r.sourceQualityDecision,
          clientSafeReason: r.clientSafeReason,
        };
      })
    : [];
  const screenshots = Array.isArray(block.screenshotProvenance)
    ? block.screenshotProvenance.map((row) => {
        const r = row as Record<string, unknown>;
        return {
          screenshotKind: r.screenshotKind,
          providerId: r.providerId,
          region: r.region,
          language: r.language,
          clientSafeCaption: r.clientSafeCaption,
          containsHighlightedEvidence: r.containsHighlightedEvidence,
        };
      })
    : [];
  return {
    surfaceProvenance: surfaces,
    screenshotProvenance: screenshots,
  };
}

function sanitizeProviderReadinessSummaryForClient(
  block: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!block) return block;
  return {
    totalProviders: block.totalProviders,
    readyCount: block.readyCount,
    realReadyCount: block.realReadyCount,
    unavailableCount: block.unavailableCount,
    safeSummaryLabel:
      block.safeSummaryLabel ?? "Provider source readiness is summarized for this report.",
    readySourcesLabel:
      block.readySourcesLabel ?? "Real source readiness is available in internal diagnostics.",
  };
}

function sanitizeEvidenceQualityForClient(
  evidenceQuality: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!evidenceQuality) return evidenceQuality;
  const totals = evidenceQuality.totals;
  if (!totals || typeof totals !== "object") return undefined;
  return { totals };
}

function sanitizeComplianceRiskIntelForClient(
  block: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!block) return block;
  const hits = Array.isArray(block.complianceHits) ? block.complianceHits : [];
  const safeHits = hits
    .map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : {}))
    // R3.5: excluded/noise hits are never client-confirmed evidence.
    .filter((row) => row.isClientVisible !== false && row.isExcludedNoise !== true)
    .map((row) => {
      const { internalReason: _internalReason, ...rest } = row;
      return rest;
    });
  return {
    ...block,
    complianceHits: safeHits,
  };
}

function sanitizeEntityFilteringForClient(
  block: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!block) return block;
  const subjectIdentitySummary =
    block.subjectIdentitySummary && typeof block.subjectIdentitySummary === "object"
      ? (block.subjectIdentitySummary as Record<string, unknown>)
      : undefined;
  const counts =
    block.counts && typeof block.counts === "object"
      ? (block.counts as Record<string, unknown>)
      : undefined;
  return {
    enabled: Boolean(block.enabled),
    subjectIdentitySummary,
    counts,
  };
}

/**
 * O5.2 — remove internal/debug fields from client-facing report_json.
 * Internal audience receives the stored payload unchanged.
 */
export function sanitizeReportJsonForAudience<T extends Record<string, unknown>>(
  reportJson: T,
  audience: ReportJsonAudience
): T {
  if (audience === "internal") return reportJson;

  const copy = JSON.parse(JSON.stringify(reportJson)) as T & {
    meta?: { reportWarnings?: unknown };
    auditSummary?: { dataQualitySummary?: { warnings?: string[] } };
    serpSnapshot?: { metadata?: Record<string, unknown> };
    searchSurfaces?: Record<string, unknown>;
    evidenceQuality?: Record<string, unknown>;
    selectedEvidence?: Record<string, unknown>;
    sourceQualitySummary?: Record<string, unknown>;
    searchProvenanceSummary?: Record<string, unknown>;
    searchProvenance?: Record<string, unknown>;
    providerReadinessSummary?: Record<string, unknown>;
    providerDiagnostics?: Record<string, unknown>;
    entityFiltering?: Record<string, unknown>;
    complianceRiskIntel?: Record<string, unknown>;
  };

  if (copy.meta) {
    copy.meta = {
      ...copy.meta,
      reportWarnings: filterReportWarningsForAudience(
        normalizeReportWarnings(copy.meta.reportWarnings),
        "client"
      ),
    };
  }

  if (copy.auditSummary?.dataQualitySummary?.warnings) {
    copy.auditSummary = {
      ...copy.auditSummary,
      dataQualitySummary: {
        ...copy.auditSummary.dataQualitySummary,
        warnings: copy.auditSummary.dataQualitySummary.warnings.filter(
          (t) => !isInternalHygieneText(t)
        ),
      },
    };
  }

  if (copy.serpSnapshot?.metadata) {
    copy.serpSnapshot = {
      ...copy.serpSnapshot,
      metadata: sanitizeSerpSnapshotMetadata(copy.serpSnapshot.metadata),
    };
  }

  if (copy.searchSurfaces) {
    copy.searchSurfaces = sanitizeSearchSurfacesForClient(copy.searchSurfaces);
  }

  copy.evidenceQuality = sanitizeEvidenceQualityForClient(copy.evidenceQuality);
  copy.entityFiltering = sanitizeEntityFilteringForClient(copy.entityFiltering);
  copy.complianceRiskIntel = sanitizeComplianceRiskIntelForClient(copy.complianceRiskIntel);
  copy.sourceQualitySummary = sanitizeSourceQualitySummaryForClient(copy.sourceQualitySummary);
  copy.searchProvenanceSummary = sanitizeSearchProvenanceSummaryForClient(copy.searchProvenanceSummary);
  copy.searchProvenance = sanitizeSearchProvenanceForClient(copy.searchProvenance);
  copy.providerReadinessSummary = sanitizeProviderReadinessSummaryForClient(
    copy.providerReadinessSummary
  );
  // Stage R3.6 — provider/runtime diagnostics are internal-only; never in client JSON.
  stripInternalDiagnostics(copy);

  if (copy.selectedEvidence && typeof copy.selectedEvidence === "object") {
    const se = copy.selectedEvidence as Record<string, unknown>;
    copy.selectedEvidence = {
      metrics: se.metrics,
      images: se.images,
      videos: se.videos,
      appendix: {
        confirmedSubjectEvidence: (se.appendix as Record<string, unknown> | undefined)
          ?.confirmedSubjectEvidence,
      },
      compliance: se.compliance,
    };
  }

  const stripped = stripForbiddenKeysDeep(copy, CLIENT_FORBIDDEN_JSON_KEYS);
  // Stage R3.6 — replace raw internal classification/decision enums with
  // client-safe tokens. The renderer maps these tokens back to the same display
  // labels, so client visuals are unchanged while the JSON carries no raw enums.
  return normalizeInternalEnumsDeep(stripped) as T;
}

/**
 * Raw internal enum values (identity/classification/review/provider) mapped to
 * client-safe tokens. The renderer recognizes these tokens for display so labels
 * and subject highlighting stay identical to the internal report.
 */
const RAW_ENUM_SAFE_MAP: Record<string, string> = {
  EXACT_SUBJECT: "subject_confirmed",
  LIKELY_SUBJECT: "subject_likely",
  POSSIBLE_SUBJECT: "subject_possible",
  INSUFFICIENT_IDENTITY: "identity_low",
  NOT_SUBJECT: "not_related",
  UNCLASSIFIED: "neutral",
  MATCH_CONFIRMED: "confirmed",
  NEEDS_REVIEW: "review",
  FALSE_POSITIVE: "excluded",
  WARN_POTENTIAL_REVIEW: "review",
  PROVIDER_NOT_IMPLEMENTED: "unavailable",
};

/** Deeply replace any string leaf that exactly matches a raw internal enum. */
function normalizeInternalEnumsDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeInternalEnumsDeep(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = normalizeInternalEnumsDeep(child);
    }
    return out;
  }
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(RAW_ENUM_SAFE_MAP, value)) {
    return RAW_ENUM_SAFE_MAP[value];
  }
  return value;
}

/** Assert client report_json string has no internal/debug markers. */
export function isClientSafeReportJson(jsonStr: string): boolean {
  const forbidden = [
    "sourceMode",
    "sourcePreference",
    "providerAdapter",
    "mock fixture",
    "debug",
    "rawMetadata",
    "rawMetadataSafe",
    "reviewQueue",
    "topExclusionReasons",
    "reportEligibility",
    "contentClass",
    "staleReason",
    "wasRegeneratedForReport",
    "internalDetail",
    "internalReason",
  ];
  const lower = jsonStr.toLowerCase();
  if (forbidden.some((f) => lower.includes(f.toLowerCase()))) return false;
  // Stage R3.6 — also block raw enum / env / stack-trace markers.
  return findClientReportPolicyViolations(jsonStr).length === 0;
}
