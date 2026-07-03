import type {
  GatedEvidenceItem,
  SourceConfidenceLabel,
  SourceFingerprint,
  SourceQualityDecision,
  SourceQualityMetadata,
  SourceQualityReason,
  SourceSurfaceType,
} from "./types";
import { buildSourceFingerprint, detectDuplicateGroups } from "./source-dedup";
import { rankSourceItem } from "./source-ranking";

export type ReportLang = "ru" | "en";

type SummaryCounter = Record<string, number>;

export interface SourceQualitySummary {
  totalCollected: number;
  uniqueSources: number;
  duplicateCount: number;
  includedCount: number;
  reviewCount: number;
  excludedCount: number;
  unavailableCount: number;
  bySurfaceType: Partial<Record<SourceSurfaceType, number>>;
  byProvider: Record<string, number>;
  topDuplicateDomains: Array<{ domain: string; count: number }>;
  bySourceScoreBucket?: Record<string, number>;
  byDecision?: Record<string, number>;
  byQueryPurpose?: Record<string, number>;
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  lowConfidenceCount: number;
  unknownConfidenceCount: number;
  namesakeSuppressionCount?: number;
  fallbackSourceCount?: number;
  weakMatchSuppressedCount?: number;
  mediaCandidateSuppressedCount?: number;
  warnings?: string[];
}

const REASON_TEXT: Record<ReportLang, Partial<Record<SourceQualityReason, string>>> = {
  ru: {
    exact_subject_match: "Подтверждено: точное совпадение субъекта",
    likely_subject_match: "Вероятное совпадение субъекта",
    weak_identity_match: "Требуется проверка: слабое совпадение",
    wrong_patronymic: "Исключено: несовпадение отчества",
    wrong_name: "Исключено: несовпадение имени",
    namesake_risk: "Исключено: риск однофамильца",
    duplicate_source: "Дубликат источника объединен",
    low_information: "Недостаточно информации",
    unsupported_surface: "Источник не поддерживается для включения",
    provider_unavailable: "Источник временно недоступен",
    manual_review_required: "Требуется аналитическая проверка",
    compliance_manual_import: "Материал из ручного импорта, требуется проверка",
    fallback_result: "Использован fallback-источник",
    no_url: "Нет ссылки на источник",
    no_title: "Нет заголовка источника",
    other: "Требуется дополнительная проверка",
  },
  en: {
    exact_subject_match: "Confirmed: exact subject match",
    likely_subject_match: "Likely subject match",
    weak_identity_match: "Review required: weak identity match",
    wrong_patronymic: "Excluded: patronymic mismatch",
    wrong_name: "Excluded: first-name mismatch",
    namesake_risk: "Excluded: namesake risk",
    duplicate_source: "Duplicate source collapsed",
    low_information: "Low information value",
    unsupported_surface: "Unsupported surface for inclusion",
    provider_unavailable: "Provider unavailable",
    manual_review_required: "Analyst review required",
    compliance_manual_import: "Manual compliance import requires review",
    fallback_result: "Fallback source used",
    no_url: "No source URL",
    no_title: "No source title",
    other: "Additional review required",
  },
};

function confidenceLabel(item: GatedEvidenceItem): SourceConfidenceLabel {
  if (item.quality.identityConfidence === "HIGH") return "high";
  if (item.quality.identityConfidence === "MEDIUM") return "medium";
  if (item.quality.identityConfidence === "LOW") return "low";
  if (item.quality.riskConfidence === "HIGH") return "high";
  if (item.quality.riskConfidence === "MEDIUM") return "medium";
  if (item.quality.riskConfidence === "LOW") return "low";
  return "unknown";
}

function mapReason(item: GatedEvidenceItem, dup: boolean): SourceQualityReason {
  const text = `${item.title ?? ""} ${item.snippet ?? ""}`.toLowerCase();
  if (dup) return "duplicate_source";
  if (item.surfaceType === "MANUAL_COMPLIANCE" || item.surfaceType === "MANUAL_IMPORT") {
    return "compliance_manual_import";
  }
  if (!String(item.url ?? "").trim()) return "no_url";
  if (!String(item.title ?? item.query ?? "").trim()) return "no_title";
  if (item.quality.identityDecision === "EXACT_SUBJECT") return "exact_subject_match";
  if (item.quality.identityDecision === "LIKELY_SUBJECT") return "likely_subject_match";
  if (item.quality.identityDecision === "NAMESAKE") return "namesake_risk";
  if (item.quality.identityDecision === "ENTITY_MISMATCH") {
    if (/отчеств|patronymic|romanovich|романович/.test(text)) return "wrong_patronymic";
    return "wrong_name";
  }
  if (item.quality.identityDecision === "INSUFFICIENT_MATCH") return "weak_identity_match";
  if (item.quality.selectionReason === "provider_not_configured") return "provider_unavailable";
  if (item.quality.selectionReason === "manual_review_required") return "manual_review_required";
  if (item.quality.selectionReason === "low_value_surface") return "low_information";
  return "other";
}

function localizedReason(lang: ReportLang, reason: SourceQualityReason): string {
  return REASON_TEXT[lang][reason] ?? REASON_TEXT.en[reason] ?? "Review required";
}

function withSourceQuality(
  item: GatedEvidenceItem,
  fingerprint: SourceFingerprint,
  decision: SourceQualityDecision,
  reason: SourceQualityReason,
  lang: ReportLang,
  duplicateMeta: { duplicateGroupId: string; duplicateRank: number; duplicateReason: string } | undefined,
  ranking: ReturnType<typeof rankSourceItem>
): SourceQualityMetadata {
  return {
    ...fingerprint,
    duplicateGroupId: duplicateMeta?.duplicateGroupId ?? null,
    duplicateRank: duplicateMeta?.duplicateRank ?? null,
    duplicateReason: duplicateMeta?.duplicateReason ?? null,
    sourceRank: ranking.sourceRank,
    sourceScoreBucket: ranking.sourceScoreBucket,
    sourceQualityDecision: decision,
    sourceQualityReason: reason,
    confidenceLabel: confidenceLabel(item),
    clientSafeReason:
      localizedReason(lang, reason) || ranking.clientSafeReasonHint,
    internalReason: `${decision}:${reason}:${ranking.internalReasonHint}`,
    rankingFactors: ranking.rankingFactors,
    limitingFactors: ranking.limitingFactors,
  };
}

export function annotateSourceQuality(
  items: GatedEvidenceItem[],
  lang: ReportLang = "ru"
): GatedEvidenceItem[] {
  const dup = detectDuplicateGroups(items);
  return items.map((item, idx) => {
    const fp = buildSourceFingerprint(item);
    const d = dup.get(idx);
    const isDup = Boolean(d && d.duplicateRank > 1);
    const ranking = rankSourceItem(item, isDup);
    const decision = ranking.sourceQualityDecision;
    const reason = ranking.sourceQualityReason || mapReason(item, isDup);
    const next = {
      ...item,
      quality: {
        ...item.quality,
        // Conservative: non-primary duplicates are excluded from main selection,
        // while still retained with diagnostics metadata.
        reportEligibility: isDup ? "EXCLUDE" : item.quality.reportEligibility,
        selectionReason: isDup ? "duplicate_url" : item.quality.selectionReason,
        sourceQuality: withSourceQuality(item, fp, decision, reason, lang, d, ranking),
      },
    };
    return next;
  });
}

export function summarizeSourceQuality(items: GatedEvidenceItem[]): SourceQualitySummary {
  const bySurfaceType: Partial<Record<SourceSurfaceType, number>> = {};
  const byProvider: SummaryCounter = {};
  const duplicateDomains: SummaryCounter = {};
  const bySourceScoreBucket: SummaryCounter = {};
  const byDecision: SummaryCounter = {};
  const byQueryPurpose: SummaryCounter = {};
  let duplicateCount = 0;
  let include = 0;
  let review = 0;
  let exclude = 0;
  let unavailable = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  let unknown = 0;
  let namesakeSuppression = 0;
  let fallbackCount = 0;
  let weakMatchSuppressed = 0;
  let mediaSuppressed = 0;

  const uniqueKeys = new Set<string>();
  for (const item of items) {
    const sq = item.quality.sourceQuality;
    if (!sq) continue;
    uniqueKeys.add(sq.sourceFingerprint);
    bySurfaceType[sq.surfaceType] = (bySurfaceType[sq.surfaceType] ?? 0) + 1;
    byProvider[sq.providerKey] = (byProvider[sq.providerKey] ?? 0) + 1;
    bySourceScoreBucket[sq.sourceScoreBucket ?? "unknown"] =
      (bySourceScoreBucket[sq.sourceScoreBucket ?? "unknown"] ?? 0) + 1;
    byDecision[sq.sourceQualityDecision] = (byDecision[sq.sourceQualityDecision] ?? 0) + 1;
    const purpose = String(
      (item.rawMetadata as Record<string, unknown> | undefined)?.queryPurpose ?? "unknown"
    ).toLowerCase();
    byQueryPurpose[purpose || "unknown"] = (byQueryPurpose[purpose || "unknown"] ?? 0) + 1;
    if (sq.sourceQualityDecision === "duplicate") {
      duplicateCount += 1;
      if (sq.canonicalDomain) {
        duplicateDomains[sq.canonicalDomain] = (duplicateDomains[sq.canonicalDomain] ?? 0) + 1;
      }
    } else if (sq.sourceQualityDecision === "include") include += 1;
    else if (sq.sourceQualityDecision === "review") review += 1;
    else if (sq.sourceQualityDecision === "exclude") exclude += 1;
    else if (sq.sourceQualityDecision === "unavailable") unavailable += 1;
    else if (sq.sourceQualityDecision === "fallback") fallbackCount += 1;

    if (sq.sourceQualityReason === "namesake_risk") namesakeSuppression += 1;
    if (sq.sourceQualityReason === "weak_identity_match") weakMatchSuppressed += 1;
    if (
      (item.surfaceType === "IMAGE_RESULT" || item.surfaceType === "VIDEO_RESULT") &&
      (sq.sourceQualityDecision === "exclude" || sq.sourceQualityDecision === "review")
    ) {
      mediaSuppressed += 1;
    }
    if (sq.confidenceLabel === "high") high += 1;
    else if (sq.confidenceLabel === "medium") medium += 1;
    else if (sq.confidenceLabel === "low") low += 1;
    else unknown += 1;
  }

  const topDuplicateDomains = Object.entries(duplicateDomains)
    .map(([domain, count]) => ({ domain, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalCollected: items.length,
    uniqueSources: uniqueKeys.size,
    duplicateCount,
    includedCount: include,
    reviewCount: review,
    excludedCount: exclude,
    unavailableCount: unavailable,
    bySurfaceType,
    byProvider,
    topDuplicateDomains,
    bySourceScoreBucket,
    byDecision,
    byQueryPurpose,
    highConfidenceCount: high,
    mediumConfidenceCount: medium,
    lowConfidenceCount: low,
    unknownConfidenceCount: unknown,
    namesakeSuppressionCount: namesakeSuppression,
    fallbackSourceCount: fallbackCount || undefined,
    weakMatchSuppressedCount: weakMatchSuppressed || undefined,
    mediaCandidateSuppressedCount: mediaSuppressed || undefined,
    warnings: duplicateCount > include + review ? ["high_duplicate_ratio"] : undefined,
  };
}
