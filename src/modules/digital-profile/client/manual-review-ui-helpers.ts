/**
 * R10.8a — Manual review UI helpers: Russian labels, grouping, high-impact detection.
 */

export type ManualReviewUiGroupReason =
  | "compliance_potential_match"
  | "court_legal_ambiguity"
  | "homonym_weak_binding"
  | "controversial_dual_use"
  | "insufficient_identifiers"
  | "source_reliability_limitation";

export const MANUAL_REVIEW_GROUP_LABELS: Record<ManualReviewUiGroupReason, string> = {
  compliance_potential_match: "Потенциальные compliance-совпадения",
  court_legal_ambiguity: "Суд / правовая неоднозначность",
  homonym_weak_binding: "Омоним / слабая привязка",
  controversial_dual_use: "Спорный / dual-use контекст",
  insufficient_identifiers: "Недостаточно идентификаторов",
  source_reliability_limitation: "Ограничение надёжности источника",
};

export const ADMIN_STATUS_LABELS: Record<string, string> = {
  PENDING: "Требует проверки",
  APPROVED: "Одобрено",
  APPROVED_WITH_CAVEAT: "Одобрено с оговоркой",
  APPENDIX_ONLY: "Только приложение",
  EXCLUDED: "Исключено",
  NEEDS_MORE_SOURCES: "Нужны дополнительные источники",
  WRONG_SUBJECT: "Другой субъект",
};

export const RISK_SIGNAL_LABELS: Record<string, string> = {
  NO_RISK_SIGNAL: "Без сигнала риска",
  POSITIVE_SIGNAL: "Позитивный сигнал",
  NEUTRAL_CONTEXT: "Нейтральный контекст",
  POSSIBLE_ADVERSE: "Возможный adverse",
  ADVERSE_CONFIRMED: "Adverse подтверждён",
  COMPLIANCE_RELEVANT: "Compliance-релевантно",
  CONTROVERSIAL_DUAL_USE: "Спорный / dual-use",
  INSUFFICIENT_CONTEXT: "Недостаточно контекста",
};

export const BINDING_LABELS: Record<string, string> = {
  CONFIRMED: "Подтверждено",
  LIKELY: "Вероятно",
  WEAK: "Слабо",
  WRONG_SUBJECT: "Другой субъект",
  UNKNOWN: "Неизвестно",
};

export const RELIABILITY_LABELS: Record<string, string> = {
  AUTHORITATIVE: "Авторитетный",
  PUBLIC_REGISTRY: "Публичный реестр",
  BUSINESS_REGISTRY_AGGREGATOR: "Реестровый агрегатор",
  REPUTABLE_MEDIA: "Репутационные СМИ",
  SOCIAL_MEDIA: "Соцсети",
  BLOG_FORUM: "Блог / форум",
  MARKETPLACE: "Маркетплейс",
  UNKNOWN: "Неизвестно",
};

export const RECOMMENDED_ACTION_LABELS: Record<string, string> = {
  APPROVE_FOR_REPORT: "Одобрить для отчёта",
  APPROVE_AS_CAVEATED: "Одобрить с оговоркой",
  KEEP_APPENDIX_ONLY: "Оставить в приложении",
  EXCLUDE: "Исключить",
  REQUEST_MORE_SOURCES: "Запросить источники",
  MARK_WRONG_SUBJECT: "Отметить как другой субъект",
};

export type QuickFilterId =
  | "pending_only"
  | "high_impact_only"
  | "compliance_only"
  | "court_only"
  | "homonym_only"
  | "wrong_subject_candidates"
  | "decided_only";

export const QUICK_FILTER_LABELS: Record<QuickFilterId, string> = {
  pending_only: "Только на проверке",
  high_impact_only: "Только high-impact",
  compliance_only: "Compliance / Lexis / DJ",
  court_only: "Суд / правовая неоднозначность",
  homonym_only: "Омоним / слабая привязка",
  wrong_subject_candidates: "Кандидаты WRONG_SUBJECT",
  decided_only: "Уже решённые",
};

export function labelStatus(status: string): string {
  return ADMIN_STATUS_LABELS[status] ?? status;
}

export function labelRisk(risk: string): string {
  return RISK_SIGNAL_LABELS[risk] ?? risk;
}

export function labelBinding(binding: string): string {
  return BINDING_LABELS[binding] ?? binding;
}

export function labelReliability(rel: string): string {
  return RELIABILITY_LABELS[rel] ?? rel;
}

export function labelRecommendedAction(action: string): string {
  return RECOMMENDED_ACTION_LABELS[action] ?? action;
}

export function labelGroup(reason: ManualReviewUiGroupReason): string {
  return MANUAL_REVIEW_GROUP_LABELS[reason];
}

export function classifyQueueItemGroup(item: {
  title: string;
  sourceDomain?: string;
  snippet?: string;
  flags?: string[];
  proposedClassification?: {
    riskSignal?: string;
    subjectBinding?: string;
    contentNature?: string;
  };
}): ManualReviewUiGroupReason {
  const flags = item.flags ?? [];
  const risk = item.proposedClassification?.riskSignal ?? "";
  const binding = item.proposedClassification?.subjectBinding ?? "";
  const hay = `${item.title} ${item.sourceDomain ?? ""} ${item.snippet ?? ""}`;

  if (
    flags.includes("compliance_db_potential_match") ||
    risk === "COMPLIANCE_RELEVANT" ||
    /lexis|world[- ]?check|dow jones|watchlist|санкц/i.test(hay)
  ) {
    return "compliance_potential_match";
  }
  if (/суд|арбитраж|дело №|истец|ответчик|приговор|уголовн/i.test(hay)) {
    return "court_legal_ambiguity";
  }
  if (risk === "CONTROVERSIAL_DUAL_USE" || flags.some((f) => f.startsWith("controversial:"))) {
    return "controversial_dual_use";
  }
  if (
    binding === "WEAK" ||
    binding === "UNKNOWN" ||
    flags.includes("patronymic_mismatch") ||
    flags.includes("wrong_subject")
  ) {
    return "homonym_weak_binding";
  }
  if (/marketplace|forum|blog|unknown/i.test(item.sourceDomain ?? "") || !item.sourceDomain) {
    if (!item.sourceDomain) return "insufficient_identifiers";
    return "source_reliability_limitation";
  }
  return "insufficient_identifiers";
}

const HIGH_IMPACT_RISKS = new Set([
  "COMPLIANCE_RELEVANT",
  "POSSIBLE_ADVERSE",
  "ADVERSE_CONFIRMED",
  "CONTROVERSIAL_DUAL_USE",
]);

export function isHighImpactItem(item: {
  title: string;
  sourceDomain?: string;
  flags?: string[];
  proposedClassification?: { riskSignal?: string; subjectBinding?: string };
}): boolean {
  const group = classifyQueueItemGroup(item);
  if (
    group === "compliance_potential_match" ||
    group === "court_legal_ambiguity" ||
    group === "controversial_dual_use"
  ) {
    return true;
  }
  const risk = item.proposedClassification?.riskSignal ?? "";
  if (HIGH_IMPACT_RISKS.has(risk)) return true;
  if ((item.flags ?? []).includes("compliance_db_potential_match") || (item.flags ?? []).includes("high_impact_manual")) {
    return true;
  }
  return /lexis|world[- ]?check|dow jones|watchlist|санкц|pep|rca|offshore|офшор/i.test(
    `${item.title} ${item.sourceDomain ?? ""}`
  );
}

export function isWrongSubjectCandidate(item: {
  flags?: string[];
  proposedClassification?: { subjectBinding?: string };
}): boolean {
  const binding = item.proposedClassification?.subjectBinding ?? "";
  return (
    binding === "WRONG_SUBJECT" ||
    (item.flags ?? []).includes("wrong_subject") ||
    (item.flags ?? []).includes("patronymic_mismatch")
  );
}

export function isSafeLowImpactForBulkAppendix(item: {
  title: string;
  sourceDomain?: string;
  flags?: string[];
  proposedClassification?: { riskSignal?: string; subjectBinding?: string };
}): boolean {
  if (isHighImpactItem(item)) return false;
  const risk = item.proposedClassification?.riskSignal ?? "";
  return risk === "NO_RISK_SIGNAL" || risk === "NEUTRAL_CONTEXT" || risk === "INSUFFICIENT_CONTEXT" || risk === "POSITIVE_SIGNAL";
}

export function statusTone(status: string): "neutral" | "ok" | "warn" | "danger" | "info" {
  if (status === "APPROVED") return "ok";
  if (status === "APPROVED_WITH_CAVEAT") return "info";
  if (status === "APPENDIX_ONLY") return "neutral";
  if (status === "EXCLUDED" || status === "WRONG_SUBJECT") return "danger";
  if (status === "NEEDS_MORE_SOURCES" || status === "PENDING") return "warn";
  return "neutral";
}

export function decisionWarningRu(status: string): string | null {
  switch (status) {
    case "APPROVED_WITH_CAVEAT":
      return "«Одобрено с оговоркой» попадёт в клиентский анализ только вместе с текстом оговорки.";
    case "WRONG_SUBJECT":
      return "«Другой субъект» полностью исключит материал из клиентского анализа.";
    case "EXCLUDED":
      return "«Исключено» не попадёт в клиентский отчёт.";
    case "PENDING":
      return "«Требует проверки» не используется как подтверждённый риск.";
    case "APPENDIX_ONLY":
      return "«Только приложение» не попадает в основные выводы клиента.";
    case "APPROVED":
      return "«Одобрено» включает материал в клиентский анализ как одобренный вывод.";
    case "NEEDS_MORE_SOURCES":
      return "«Нужны дополнительные источники» оставляет материал на проверке до появления источников.";
    default:
      return null;
  }
}

export const GROUP_ORDER: ManualReviewUiGroupReason[] = [
  "compliance_potential_match",
  "court_legal_ambiguity",
  "controversial_dual_use",
  "homonym_weak_binding",
  "insufficient_identifiers",
  "source_reliability_limitation",
];
