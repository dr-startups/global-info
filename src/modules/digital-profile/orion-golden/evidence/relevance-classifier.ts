/**
 * R10 — Relevance and noise classifier (filtering layer).
 */

import type { EvidenceDecisionRecord, RawInventoryItem, RelevanceClass } from "../types";

export type RelevanceReason =
  | "exact_subject_match"
  | "subject_with_context"
  | "organization_match"
  | "sanctions_or_watchlist_context"
  | "adverse_media_context"
  | "public_profile_context"
  | "wiki_context"
  | "marketplace_noise"
  | "product_noise"
  | "generic_service_noise"
  | "login_page_noise"
  | "unrelated_person"
  | "unrelated_domain"
  | "duplicate"
  | "insufficient_context";

export interface RelevanceFilterInspection {
  version: "r10-relevance-filter-inspection-v1";
  inputCount: number;
  strongRelevant: number;
  relevant: number;
  potentiallyRelevant: number;
  weakMatch: number;
  excludedNoise: number;
  byReason: Record<string, number>;
  decisions: EvidenceDecisionRecord[];
}

const MARKETPLACE = ["aliexpress", "ozon", "wildberries", "market.yandex", "ebay", "amazon."];
const PRODUCT = ["лампа", "led lamp", "lilygo", "esp32", "arduino", "купить", "цена", "модуль"];
const LOGIN = ["gosuslugi", "госуслуги", "esia.gosuslugi", "login", "войти", "личный кабинет"];

function hay(item: RawInventoryItem): string {
  return [item.title, item.snippet, item.sourceUrl, item.provider, item.evidenceType]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((t) => text.includes(t));
}

function classifyOne(item: RawInventoryItem, subjectName: string, aliases: string[]): EvidenceDecisionRecord {
  const text = hay(item);
  const names = [subjectName, ...aliases].map((n) => n.toLowerCase()).filter(Boolean);
  const exact = names.some((n) => n.length > 2 && text.includes(n));
  const orgHint = /(?:ооо|ао|пао|llc|ltd|inc|group|holding|банк)/i.test(text);

  let relevanceClass: RelevanceClass = "potentially_relevant";
  let reason: RelevanceReason = "insufficient_context";
  let humanReason = "Недостаточно контекста для уверенной релевантности";

  if (includesAny(text, MARKETPLACE)) {
    relevanceClass = "excluded_noise";
    reason = "marketplace_noise";
    humanReason = "Маркетплейс / товарный шум, не относится к ключевым выводам";
  } else if (includesAny(text, PRODUCT)) {
    relevanceClass = "excluded_noise";
    reason = "product_noise";
    humanReason = "Товарный / коммерческий шум";
  } else if (includesAny(text, LOGIN) && !exact) {
    relevanceClass = "excluded_noise";
    reason = "login_page_noise";
    humanReason = "Общая страница входа / госуслуги без связи с субъектом";
  } else if (exact && /sanction|watchlist|санкц|pep|rca/i.test(text)) {
    relevanceClass = "strong_relevant";
    reason = "sanctions_or_watchlist_context";
    humanReason = "Совпадение с субъектом в контексте санкций / watchlist";
  } else if (exact && /adverse|негativ|скандал|суд|арест/i.test(text)) {
    relevanceClass = "strong_relevant";
    reason = "adverse_media_context";
    humanReason = "Совпадение с субъектом в контексте негативных публикаций";
  } else if (exact) {
    relevanceClass = "relevant";
    reason = "exact_subject_match";
    humanReason = "Прямое совпадение с идентификаторами или именем субъекта";
  } else if (orgHint) {
    relevanceClass = "potentially_relevant";
    reason = "organization_match";
    humanReason = "Возможное совпадение по организации — требует проверки";
  } else if (item.evidenceType === "wikipedia") {
    relevanceClass = "relevant";
    reason = "wiki_context";
    humanReason = "Wikipedia / публичный профиль";
  } else if (item.evidenceType === "compliance_hit") {
    relevanceClass = "potentially_relevant";
    reason = "sanctions_or_watchlist_context";
    humanReason = "Сигнал compliance-базы — предварительная оценка";
  } else if (names.some((n) => n.length > 4 && text.split(/\s+/).some((w) => w.includes(n.slice(0, 5))))) {
    relevanceClass = "weak_match";
    reason = "subject_with_context";
    humanReason = "Слабое совпадение по имени — требует ручной верификации";
  }

  const includeInClientReport =
    relevanceClass === "strong_relevant" ||
    relevanceClass === "relevant" ||
    relevanceClass === "potentially_relevant";
  const includeInAppendix =
    relevanceClass === "weak_match" || relevanceClass === "excluded_noise";

  return {
    inventoryId: item.inventoryId,
    normalizedTitle: item.title,
    normalizedSnippet: String(item.snippet ?? "").slice(0, 500),
    domain: item.sourceUrl?.replace(/^https?:\/\//i, "").split("/")[0],
    canonicalUrl: item.sourceUrl,
    language: item.region === "UAE" ? "en" : "ru",
    region: item.region,
    evidenceType: item.evidenceType,
    entityMatchScore: exact ? 0.95 : orgHint ? 0.6 : 0.3,
    relevanceClass,
    riskTheme: item.classification,
    riskLevel: relevanceClass === "strong_relevant" ? "medium" : "review_required",
    confidence: exact ? 0.9 : 0.5,
    includeInClientReport,
    includeInAppendix,
    exclusionReason: relevanceClass === "excluded_noise" ? reason : undefined,
    humanReason,
  };
}

export function classifyInventoryRelevance(
  items: RawInventoryItem[],
  subjectName: string,
  aliases: string[] = []
): RelevanceFilterInspection {
  const decisions = items.map((item) => classifyOne(item, subjectName, aliases));
  const byReason: Record<string, number> = {};
  for (const d of decisions) {
    const key = d.exclusionReason ?? d.relevanceClass;
    byReason[key] = (byReason[key] ?? 0) + 1;
  }
  return {
    version: "r10-relevance-filter-inspection-v1",
    inputCount: items.length,
    strongRelevant: decisions.filter((d) => d.relevanceClass === "strong_relevant").length,
    relevant: decisions.filter((d) => d.relevanceClass === "relevant").length,
    potentiallyRelevant: decisions.filter((d) => d.relevanceClass === "potentially_relevant").length,
    weakMatch: decisions.filter((d) => d.relevanceClass === "weak_match").length,
    excludedNoise: decisions.filter((d) => d.relevanceClass === "excluded_noise").length,
    byReason,
    decisions,
  };
}
