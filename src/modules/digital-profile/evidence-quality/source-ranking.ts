import type {
  GatedEvidenceItem,
  SourceQualityDecision,
  SourceQualityReason,
} from "./types";

const HIGH_TRUST_DOMAINS = [
  "wikipedia.org",
  "forbes.com",
  "reuters.com",
  "bloomberg.com",
  "ft.com",
  "wsj.com",
  "kommersant.ru",
  "vedomosti.ru",
];

const LOW_TRUST_HINTS = ["blogspot.", "tumblr.", "pinterest.", "facebook.com", "instagram.com"];
const ADVERSE_TERMS = ["санкц", "fraud", "criminal", "court", "суд", "арест", "offshore", "взятк"];
const GENERIC_MEDIA_TERMS = ["stock", "placeholder", "avatar", "thumbnail", "preview", "wallpaper"];

function asText(...parts: Array<string | null | undefined>): string {
  return parts
    .map((v) => String(v ?? "").trim())
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function subjectTokens(item: GatedEvidenceItem): string[] {
  return String(item.subjectFullName ?? "")
    .toLowerCase()
    .split(/[^a-z0-9а-яё]+/i)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2);
}

function providerDomain(item: GatedEvidenceItem): string {
  const domainRaw = String(item.domain ?? "").toLowerCase().trim();
  if (domainRaw) return domainRaw;
  try {
    return new URL(String(item.url ?? "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hasPatronymic(fullName: string | null | undefined): boolean {
  const parts = String(fullName ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return parts.length >= 3;
}

function queryPurpose(item: GatedEvidenceItem): string {
  const raw = item.rawMetadata as Record<string, unknown> | null | undefined;
  return String(raw?.queryPurpose ?? raw?.purpose ?? "").toLowerCase() || "unknown";
}

export interface SourceRankingResult {
  sourceRank: number;
  sourceScoreBucket: "high" | "medium" | "low" | "unknown";
  sourceQualityDecision: SourceQualityDecision;
  sourceQualityReason: SourceQualityReason;
  clientSafeReasonHint: string;
  internalReasonHint: string;
  rankingFactors: Record<string, number>;
  limitingFactors: string[];
}

export function rankSourceItem(item: GatedEvidenceItem, isDuplicate: boolean): SourceRankingResult {
  const text = asText(item.title, item.snippet, item.query, item.url, item.domain);
  const tokens = subjectTokens(item);
  const matched = tokens.filter((t) => text.includes(t));
  const hasGivenAndSurname = matched.length >= 2;
  const hasExactSubject = item.quality.identityDecision === "EXACT_SUBJECT";
  const likelySubject = item.quality.identityDecision === "LIKELY_SUBJECT";
  const possibleSubject = item.quality.identityDecision === "POSSIBLE_SUBJECT";
  const domain = providerDomain(item);
  const purpose = queryPurpose(item);
  const mediaSurface = item.surfaceType === "IMAGE_RESULT" || item.surfaceType === "VIDEO_RESULT";
  const patronymicPresent = hasPatronymic(item.subjectFullName);
  const title = String(item.title ?? "").toLowerCase();
  const snippet = String(item.snippet ?? "").toLowerCase();

  const identityScore = hasExactSubject ? 30 : likelySubject ? 20 : possibleSubject ? 10 : 0;
  const exactNameScore = hasGivenAndSurname ? 12 : matched.length > 0 ? 6 : 0;
  const patronymicScore =
    patronymicPresent && /романович|romanovich/i.test(text)
      ? hasExactSubject
        ? 5
        : -8
      : 0;
  const transliterationScore =
    /(konstantin|tomilin|константин|томилин)/i.test(text) && hasGivenAndSurname ? 6 : 0;
  const regionScore =
    String(item.region ?? "").toUpperCase() === "RU" && /ru|росси|моск|санкт/i.test(text) ? 4 : 0;
  const titleRelevanceScore = hasGivenAndSurname && title.length > 0 ? 10 : title.length > 0 ? 3 : -3;
  const domainTrustScore = HIGH_TRUST_DOMAINS.some((d) => domain.endsWith(d))
    ? 10
    : LOW_TRUST_HINTS.some((d) => domain.includes(d))
      ? -6
      : 2;
  const sourceTypeScore =
    item.surfaceType === "SEARCH_RESULT"
      ? 8
      : item.surfaceType === "WIKIPEDIA_RESULT"
        ? 9
        : mediaSurface
          ? 4
          : 2;
  const queryPurposeScore =
    purpose === "subject_lookup"
      ? 7
      : purpose === "media_lookup" || purpose === "image_lookup" || purpose === "video_lookup"
        ? 5
        : purpose === "adverse_lookup"
          ? 4
          : 2;
  const freshnessHintScore = 0;
  const duplicatePenalty = isDuplicate ? -40 : 0;
  const weakMatchPenalty =
    item.quality.identityDecision === "INSUFFICIENT_MATCH" ||
    item.quality.identityDecision === "NAMESAKE" ||
    item.quality.identityDecision === "ENTITY_MISMATCH"
      ? -30
      : possibleSubject
        ? -12
        : 0;
  const adverseTermContextPenalty =
    ADVERSE_TERMS.some((t) => snippet.includes(t) || title.includes(t)) && !hasGivenAndSurname ? -8 : 0;
  const mediaQualityPenalty =
    mediaSurface && GENERIC_MEDIA_TERMS.some((t) => text.includes(t))
      ? -10
      : mediaSurface && !hasGivenAndSurname
        ? -8
        : 0;

  const rankingFactors: Record<string, number> = {
    identityScore,
    exactNameScore,
    patronymicScore,
    transliterationScore,
    regionScore,
    titleRelevanceScore,
    domainTrustScore,
    sourceTypeScore,
    queryPurposeScore,
    freshnessHintScore,
    duplicatePenalty,
    weakMatchPenalty,
    adverseTermContextPenalty,
    mediaQualityPenalty,
  };
  const sourceRank = Object.values(rankingFactors).reduce((sum, v) => sum + v, 0);
  const sourceScoreBucket =
    sourceRank >= 40 ? "high" : sourceRank >= 18 ? "medium" : sourceRank >= 1 ? "low" : "unknown";

  const limitingFactors: string[] = [];
  if (duplicatePenalty < 0) limitingFactors.push("duplicate_penalty");
  if (weakMatchPenalty < 0) limitingFactors.push("weak_identity_penalty");
  if (mediaQualityPenalty < 0) limitingFactors.push("media_quality_penalty");
  if (adverseTermContextPenalty < 0) limitingFactors.push("adverse_context_without_identity");
  if (patronymicScore < 0) limitingFactors.push("patronymic_mismatch_risk");
  if (domainTrustScore < 0) limitingFactors.push("low_domain_trust");

  let sourceQualityDecision: SourceQualityDecision = "exclude";
  let sourceQualityReason: SourceQualityReason = "other";
  let clientSafeReasonHint = "Требуется дополнительная проверка";
  let internalReasonHint = "rank_other";

  if (isDuplicate) {
    sourceQualityDecision = "duplicate";
    sourceQualityReason = "duplicate_source";
    clientSafeReasonHint = "Дубликат источника объединен";
    internalReasonHint = "duplicate_cluster_non_canonical";
  } else if (item.quality.selectionReason === "provider_not_configured") {
    sourceQualityDecision = "unavailable";
    sourceQualityReason = "provider_unavailable";
    clientSafeReasonHint = "Источник временно недоступен";
    internalReasonHint = "provider_unavailable";
  } else if (item.quality.selectionReason === "weak_identity_override") {
    sourceQualityDecision = "review";
    sourceQualityReason = "weak_identity_match";
    clientSafeReasonHint = "Требуется проверка: слабое совпадение";
    internalReasonHint = "override_with_weak_identity";
  } else if (item.surfaceType === "MANUAL_COMPLIANCE" || item.surfaceType === "MANUAL_IMPORT") {
    sourceQualityDecision =
      item.quality.selectionReason === "manual_confirmed" ? "include" : "review";
    sourceQualityReason = "compliance_manual_import";
    clientSafeReasonHint =
      sourceQualityDecision === "include"
        ? "Подтверждено аналитиком"
        : "Материал из ручного импорта, требуется проверка";
    internalReasonHint = "manual_compliance_semantics_preserved";
  } else if (
    item.quality.identityDecision === "NAMESAKE" ||
    item.quality.identityDecision === "ENTITY_MISMATCH"
  ) {
    sourceQualityDecision = "exclude";
    sourceQualityReason = "namesake_risk";
    clientSafeReasonHint = "Исключено: риск однофамильца";
    internalReasonHint = "identity_namesake_or_mismatch";
  } else if (item.quality.identityDecision === "INSUFFICIENT_MATCH") {
    sourceQualityDecision = "review";
    sourceQualityReason = "weak_identity_match";
    clientSafeReasonHint = "Требуется проверка: слабое совпадение";
    internalReasonHint = "insufficient_identity_match";
  } else if (sourceRank >= 40 && item.quality.reportEligibility === "CLIENT_INCLUDE") {
    sourceQualityDecision = "include";
    sourceQualityReason = hasExactSubject ? "exact_subject_match" : "likely_subject_match";
    clientSafeReasonHint = hasExactSubject
      ? "Подтверждено: точное совпадение субъекта"
      : "Вероятное совпадение субъекта";
    internalReasonHint = "high_rank_identity_match";
  } else if (sourceRank >= 18 && item.quality.reportEligibility !== "EXCLUDE") {
    sourceQualityDecision = "review";
    sourceQualityReason = "manual_review_required";
    clientSafeReasonHint = "Требуется аналитическая проверка";
    internalReasonHint = "medium_rank_needs_review";
  } else if (item.quality.reportEligibility === "REVIEW_REQUIRED") {
    sourceQualityDecision = "review";
    sourceQualityReason = "manual_review_required";
    clientSafeReasonHint = "Требуется аналитическая проверка";
    internalReasonHint = "review_required_from_gate";
  } else {
    sourceQualityDecision = "exclude";
    sourceQualityReason = "low_information";
    clientSafeReasonHint = "Недостаточно информации";
    internalReasonHint = "low_rank_or_low_value";
  }

  return {
    sourceRank,
    sourceScoreBucket,
    sourceQualityDecision,
    sourceQualityReason,
    clientSafeReasonHint,
    internalReasonHint,
    rankingFactors,
    limitingFactors,
  };
}
