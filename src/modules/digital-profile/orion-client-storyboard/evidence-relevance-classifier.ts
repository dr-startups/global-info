/** R9.12 — Evidence relevance layer before GPT/storyboard composition. */

import type { NormalizedEvidenceV1 } from "../orion-report-spec/normalized-evidence";

export type EvidenceRelevanceType =
  | "relevant"
  | "potentially_relevant"
  | "weak_match"
  | "irrelevant"
  | "excluded";

export type EvidenceRelevanceReason =
  | "exact_subject_match"
  | "name_match_only"
  | "organization_match"
  | "domain_relevant"
  | "registry_relevant"
  | "compliance_relevant"
  | "sanctions_watchlist_relevant"
  | "adverse_media_relevant"
  | "commercial_product_noise"
  | "marketplace_noise"
  | "generic_government_service_noise"
  | "technical_noise"
  | "unrelated_domain"
  | "demo_fixture_noise"
  | "insufficient_context";

export interface ClassifiedEvidence {
  evidence: NormalizedEvidenceV1;
  type: EvidenceRelevanceType;
  reason: EvidenceRelevanceReason;
  humanReason: string;
}

export interface EvidenceRelevanceReport {
  version: "r912-evidence-relevance-v1";
  inputCount: number;
  relevantCount: number;
  potentiallyRelevantCount: number;
  weakMatchCount: number;
  excludedCount: number;
  topIncluded: Array<{ title: string; type: EvidenceRelevanceType; humanReason: string }>;
  topExcluded: Array<{ title: string; type: EvidenceRelevanceType; humanReason: string }>;
  noiseExcludedFromKeyResults: boolean;
  classified: ClassifiedEvidence[];
}

const MARKETPLACE_NOISE = [
  "aliexpress",
  "ozon",
  "wildberries",
  "market.yandex",
  "ebay",
  "amazon.",
  "lilygo",
  "esp32",
  "arduino",
];

const PRODUCT_NOISE = [
  "лампа",
  "led lamp",
  "светодиод",
  "прошивка vw",
  "navigator nll",
  "модуль",
  "датчик",
  "купить",
  "цена",
];

const GENERIC_GOV_NOISE = [
  "gosuslugi",
  "госуслуги",
  "esia.gosuslugi",
  "login",
  "войти",
  "личный кабинет",
  "авторизация",
];

const FIXTURE_NOISE = ["example.com", "example.ru", "ivan petrov", "иван петров"];

function haystack(ev: NormalizedEvidenceV1): string {
  return [ev.title, ev.snippet, ev.domain, ev.url, ev.clientSafeSummary, ev.sourceLabel]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((t) => text.includes(t));
}

function humanReasonFor(type: EvidenceRelevanceType, reason: EvidenceRelevanceReason): string {
  const map: Record<EvidenceRelevanceReason, string> = {
    exact_subject_match: "Прямое совпадение с идентификаторами или именем субъекта",
    name_match_only: "Совпадение только по имени без подтверждения связи",
    organization_match: "Совпадение по организации или должности",
    domain_relevant: "Домен относится к профессиональной или деловой тематике субъекта",
    registry_relevant: "Запись в реестре или официальном источнике",
    compliance_relevant: "Compliance-материал, требующий аналитической проверки",
    sanctions_watchlist_relevant: "Потенциальный санкционный или watchlist-сигнал — требует ручной верификации",
    adverse_media_relevant: "Публикация с чувствительной тематикой — связь с субъектом не подтверждена",
    commercial_product_noise: "Коммерческий товар без связи с субъектом — исключён из ключевых результатов",
    marketplace_noise: "Маркетплейс или товарная карточка — исключена как нерелевантный шум",
    generic_government_service_noise: "Общий портал или страница входа без идентификации субъекта",
    technical_noise: "Технический или несвязанный контент — исключён",
    unrelated_domain: "Домен не связан с профилем субъекта",
    demo_fixture_noise: "Демонстрационные или тестовые данные — исключены",
    insufficient_context: "Недостаточно контекста для подтверждения связи с субъектом",
  };
  if (type === "excluded" || type === "irrelevant") {
    return map[reason] ?? "Источник исключён как нерелевантный";
  }
  return map[reason] ?? "Материал включён для аналитической проверки";
}

export function classifyEvidenceRelevance(
  evidence: NormalizedEvidenceV1[],
  subjectName: string
): EvidenceRelevanceReport {
  const subjectTokens = subjectName
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);

  const classified: ClassifiedEvidence[] = evidence.map((ev) => {
    const text = haystack(ev);

    if (includesAny(text, FIXTURE_NOISE)) {
      return {
        evidence: ev,
        type: "excluded",
        reason: "demo_fixture_noise",
        humanReason: humanReasonFor("excluded", "demo_fixture_noise"),
      };
    }
    if (includesAny(text, MARKETPLACE_NOISE)) {
      return {
        evidence: ev,
        type: "excluded",
        reason: "marketplace_noise",
        humanReason: humanReasonFor("excluded", "marketplace_noise"),
      };
    }
    if (includesAny(text, PRODUCT_NOISE)) {
      return {
        evidence: ev,
        type: "excluded",
        reason: "commercial_product_noise",
        humanReason: humanReasonFor("excluded", "commercial_product_noise"),
      };
    }
    if (includesAny(text, GENERIC_GOV_NOISE) && !subjectTokens.some((t) => text.includes(t))) {
      return {
        evidence: ev,
        type: "excluded",
        reason: "generic_government_service_noise",
        humanReason: humanReasonFor("excluded", "generic_government_service_noise"),
      };
    }

    if (ev.riskTheme === "sanctions_watchlist") {
      return {
        evidence: ev,
        type: "potentially_relevant",
        reason: "sanctions_watchlist_relevant",
        humanReason: humanReasonFor("potentially_relevant", "sanctions_watchlist_relevant"),
      };
    }
    if (ev.riskTheme === "adverse_media" || ev.riskTheme === "pep") {
      return {
        evidence: ev,
        type: "potentially_relevant",
        reason: "adverse_media_relevant",
        humanReason: humanReasonFor("potentially_relevant", "adverse_media_relevant"),
      };
    }
    if (ev.reviewStatus === "official_record_found") {
      return {
        evidence: ev,
        type: "relevant",
        reason: "registry_relevant",
        humanReason: humanReasonFor("relevant", "registry_relevant"),
      };
    }
    if (subjectTokens.length > 0 && subjectTokens.filter((t) => text.includes(t)).length >= 2) {
      return {
        evidence: ev,
        type: "relevant",
        reason: "exact_subject_match",
        humanReason: humanReasonFor("relevant", "exact_subject_match"),
      };
    }
    if (subjectTokens.some((t) => text.includes(t))) {
      return {
        evidence: ev,
        type: "potentially_relevant",
        reason: "name_match_only",
        humanReason: humanReasonFor("potentially_relevant", "name_match_only"),
      };
    }
    if (ev.sourceKind === "lexisnexis" || ev.sourceKind === "compliance") {
      return {
        evidence: ev,
        type: "potentially_relevant",
        reason: "compliance_relevant",
        humanReason: humanReasonFor("potentially_relevant", "compliance_relevant"),
      };
    }
    if (ev.reviewStatus === "excluded_noise") {
      return {
        evidence: ev,
        type: "excluded",
        reason: "technical_noise",
        humanReason: humanReasonFor("excluded", "technical_noise"),
      };
    }
    return {
      evidence: ev,
      type: "weak_match",
      reason: "insufficient_context",
      humanReason: humanReasonFor("weak_match", "insufficient_context"),
    };
  });

  const counts = {
    relevant: classified.filter((c) => c.type === "relevant").length,
    potentially_relevant: classified.filter((c) => c.type === "potentially_relevant").length,
    weak_match: classified.filter((c) => c.type === "weak_match").length,
    excluded: classified.filter((c) => c.type === "excluded" || c.type === "irrelevant").length,
  };

  const included = classified.filter((c) => c.type === "relevant" || c.type === "potentially_relevant");
  const excluded = classified.filter((c) => c.type === "excluded" || c.type === "weak_match" || c.type === "irrelevant");

  const noiseInKey = included.some((c) =>
    ["marketplace_noise", "commercial_product_noise"].includes(c.reason)
  );

  return {
    version: "r912-evidence-relevance-v1",
    inputCount: evidence.length,
    relevantCount: counts.relevant,
    potentiallyRelevantCount: counts.potentially_relevant,
    weakMatchCount: counts.weak_match,
    excludedCount: counts.excluded,
    topIncluded: included.slice(0, 8).map((c) => ({
      title: c.evidence.title ?? c.evidence.domain ?? "Источник",
      type: c.type,
      humanReason: c.humanReason,
    })),
    topExcluded: excluded.slice(0, 8).map((c) => ({
      title: c.evidence.title ?? c.evidence.domain ?? "Источник",
      type: c.type,
      humanReason: c.humanReason,
    })),
    noiseExcludedFromKeyResults: !noiseInKey,
    classified,
  };
}

export function keyResultEvidence(report: EvidenceRelevanceReport): ClassifiedEvidence[] {
  return report.classified.filter((c) => c.type === "relevant" || c.type === "potentially_relevant");
}

export function excludedEvidenceSummary(report: EvidenceRelevanceReport): ClassifiedEvidence[] {
  return report.classified.filter(
    (c) => c.type === "excluded" || c.type === "weak_match" || c.type === "irrelevant"
  );
}
