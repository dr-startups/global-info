/**
 * R10.8 — Classify manual-review queue items into R10.7c group reasons (client-safe).
 */

export type ManualReviewUiGroupReason =
  | "compliance_potential_match"
  | "court_legal_ambiguity"
  | "homonym_weak_binding"
  | "controversial_dual_use"
  | "insufficient_identifiers"
  | "source_reliability_limitation";

export const MANUAL_REVIEW_GROUP_LABELS: Record<ManualReviewUiGroupReason, string> = {
  compliance_potential_match: "Compliance / watchlist",
  court_legal_ambiguity: "Суд / правовая неоднозначность",
  homonym_weak_binding: "Омоним / слабая привязка",
  controversial_dual_use: "Спорный / dual-use",
  insufficient_identifiers: "Недостаточно идентификаторов",
  source_reliability_limitation: "Ограничение источника",
};

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
  if (/marketplace|forum|blog|unknown/i.test(item.sourceDomain ?? "")) {
    return "source_reliability_limitation";
  }
  return "insufficient_identifiers";
}
