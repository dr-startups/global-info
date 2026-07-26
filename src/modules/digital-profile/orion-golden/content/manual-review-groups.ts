/**
 * R10.7c — Manual review grouping for client-facing presentation.
 * Groups pending items by reason; never presents them as confirmed negatives.
 */

import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import type { ManualReviewQueue } from "../evidence/manual-review-queue";

export type ManualReviewGroupReason =
  | "compliance_potential_match"
  | "court_legal_ambiguity"
  | "homonym_weak_binding"
  | "controversial_dual_use"
  | "insufficient_identifiers"
  | "source_reliability_limitation";

export type ManualReviewGroup = {
  reason: ManualReviewGroupReason;
  title: string;
  whyNeedsReview: string;
  whatIsMissing: string;
  analystShouldCheck: string;
  items: Array<{
    title: string;
    summary: string;
    evidenceId?: string;
    evidenceRefs?: string[];
    adminStatus?: string;
    binding?: string;
    riskSignal?: string;
  }>;
};

const GROUP_META: Record<
  ManualReviewGroupReason,
  { title: string; whyNeedsReview: string; whatIsMissing: string; analystShouldCheck: string }
> = {
  compliance_potential_match: {
    title: "Потенциальные compliance-совпадения",
    whyNeedsReview:
      "Материалы из compliance/watchlist-контекста или с флагом потенциального совпадения не подтверждены автоматически.",
    whatIsMissing: "Подтверждение идентичности субъекта и проверка первоисточника совпадения.",
    analystShouldCheck:
      "Сверить ФИО/идентификаторы с карточкой совпадения; исключить однофамильцев; не публиковать как подтверждённый риск до решения.",
  },
  court_legal_ambiguity: {
    title: "Судебные / правовые упоминания с неоднозначностью",
    whyNeedsReview: "Судебный или правовой контекст требует интерпретации и привязки к субъекту.",
    whatIsMissing: "Подтверждение стороны процесса, статуса дела и связи с проверяемым лицом.",
    analystShouldCheck: "Проверить реквизиты дела, роль субъекта и актуальность статуса; не трактовать как установленный adverse-факт.",
  },
  homonym_weak_binding: {
    title: "Слабая привязка / возможный однофамилец",
    whyNeedsReview: "Совпадение по ФИО без достаточных идентификаторов или с признаками омонимии.",
    whatIsMissing: "ИНН/дата рождения/подтверждённый профиль или иное уникальное сопоставление.",
    analystShouldCheck: "Сравнить отчество, регион, компании и идентификаторы; при расхождении исключить как WRONG_SUBJECT.",
  },
  controversial_dual_use: {
    title: "Спорный / dual-use контекст",
    whyNeedsReview: "Тема может быть интерпретирована по-разному и не должна автоматически попадать в негативные выводы.",
    whatIsMissing: "Контекст первоисточника и оценка, относится ли материал к субъекту.",
    analystShouldCheck: "Прочитать первоисточник; отделить факт от мнения/слуха; зафиксировать оговорку при необходимости.",
  },
  insufficient_identifiers: {
    title: "Недостаточно идентификаторов",
    whyNeedsReview: "Материал потенциально релевантен, но не содержит устойчивых идентификаторов субъекта.",
    whatIsMissing: "Дополнительные идентификаторы (ИНН, реестровая карточка, подтверждённый профиль).",
    analystShouldCheck: "Запросить/найти дополнительные якоря идентичности до включения в ключевые выводы.",
  },
  source_reliability_limitation: {
    title: "Ограничения надёжности источника",
    whyNeedsReview: "Источник имеет ограниченную надёжность или агрегаторный характер без первичной верификации.",
    whatIsMissing: "Подтверждение из более авторитетного первоисточника.",
    analystShouldCheck: "Найти официальный/первичный источник; при отсутствии — оставить в приложении или на проверке.",
  },
};

function classifyManualReason(j: EvidenceJudgment): ManualReviewGroupReason {
  if (
    j.flags.includes("compliance_db_potential_match") ||
    j.riskSignal === "COMPLIANCE_RELEVANT" ||
    /lexis|world[- ]?check|dow jones|watchlist|санкц/i.test(`${j.title} ${j.sourceDomain ?? ""}`)
  ) {
    return "compliance_potential_match";
  }
  if (/суд|арбитраж|дело №|истец|ответчик|приговор|уголовн/i.test(`${j.title} ${j.clientSafeSummary}`)) {
    return "court_legal_ambiguity";
  }
  if (
    j.riskSignal === "CONTROVERSIAL_DUAL_USE" ||
    j.flags.some((f) => f.startsWith("controversial:"))
  ) {
    return "controversial_dual_use";
  }
  if (
    j.subjectBinding === "WEAK" ||
    j.subjectBinding === "UNKNOWN" ||
    j.flags.includes("patronymic_mismatch") ||
    j.flags.includes("wrong_subject")
  ) {
    return "homonym_weak_binding";
  }
  if (
    j.sourceReliability === "UNKNOWN" ||
    j.sourceReliability === "MARKETPLACE" ||
    j.sourceReliability === "BLOG_FORUM"
  ) {
    return "source_reliability_limitation";
  }
  return "insufficient_identifiers";
}

export function buildManualReviewGroups(input: {
  judgments: EvidenceJudgment[];
  manualQueue?: ManualReviewQueue;
  maxItemsPerGroup?: number;
}): ManualReviewGroup[] {
  const max = input.maxItemsPerGroup ?? 8;
  const manual = input.judgments.filter(
    (j) =>
      j.reviewDecision === "MANUAL_REVIEW_REQUIRED" ||
      (input.manualQueue?.items.some((m) => m.evidenceId === j.evidenceId) ?? false)
  );

  const byReason = new Map<ManualReviewGroupReason, EvidenceJudgment[]>();
  for (const j of manual) {
    if (j.subjectBinding === "WRONG_SUBJECT") continue;
    const reason = classifyManualReason(j);
    const list = byReason.get(reason) ?? [];
    list.push(j);
    byReason.set(reason, list);
  }

  const order: ManualReviewGroupReason[] = [
    "compliance_potential_match",
    "court_legal_ambiguity",
    "controversial_dual_use",
    "homonym_weak_binding",
    "insufficient_identifiers",
    "source_reliability_limitation",
  ];

  return order
    .filter((r) => (byReason.get(r)?.length ?? 0) > 0)
    .map((reason) => {
      const meta = GROUP_META[reason];
      const items = (byReason.get(reason) ?? []).slice(0, max).map((j) => ({
        title: j.title.slice(0, 120),
        summary: `[Требует проверки] ${j.clientSafeSummary.slice(0, 220)}`,
        evidenceId: j.evidenceId,
        evidenceRefs: [j.evidenceId],
        adminStatus: j.adminReviewStatus,
        binding: j.subjectBinding,
        riskSignal: j.riskSignal,
      }));
      return {
        reason,
        title: meta.title,
        whyNeedsReview: meta.whyNeedsReview,
        whatIsMissing: meta.whatIsMissing,
        analystShouldCheck: meta.analystShouldCheck,
        items,
      };
    });
}

export function flattenManualReviewGroupsForClient(
  groups: ManualReviewGroup[]
): Array<{
  title: string;
  summary: string;
  whyFlagged: string;
  adminStatus?: string;
  evidenceRefs?: string[];
  evidenceId?: string;
}> {
  const out: Array<{
    title: string;
    summary: string;
    whyFlagged: string;
    adminStatus?: string;
    evidenceRefs?: string[];
    evidenceId?: string;
  }> = [];

  for (const g of groups) {
    out.push({
      title: `Группа: ${g.title}`,
      summary: `${g.whyNeedsReview} Недостаёт: ${g.whatIsMissing} Аналитику: ${g.analystShouldCheck}`,
      whyFlagged: g.reason,
      adminStatus: "PENDING",
      evidenceRefs: g.items.flatMap((i) => i.evidenceRefs ?? []).slice(0, 12),
    });
    for (const item of g.items) {
      out.push({
        title: item.title,
        summary: item.summary,
        whyFlagged: `${g.title}: ${g.whyNeedsReview}`,
        adminStatus: item.adminStatus,
        evidenceRefs: item.evidenceRefs,
        evidenceId: item.evidenceId,
      });
    }
  }
  return out;
}
