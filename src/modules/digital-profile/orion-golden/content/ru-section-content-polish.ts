/**
 * R10.7c — Polish RU digital-profile section narratives using clusters + judgments.
 */

import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import type { EvidenceCluster } from "./evidence-cluster";
import type { OrionSectionAnalysis } from "../sections/orion-section-analysis";

const RU_POLISH_SECTIONS = new Set([
  "10_ru_audit_summary",
  "11_ru_search_links",
  "13_ru_undesirable_theme_clusters",
  "16_ru_wikipedia",
  "46_other_public_databases",
]);

export function polishRuSectionAnalysis(
  analysis: OrionSectionAnalysis,
  input: {
    judgments: EvidenceJudgment[];
    clusters: EvidenceCluster[];
  }
): OrionSectionAnalysis {
  if (!RU_POLISH_SECTIONS.has(analysis.sectionId)) return analysis;
  if (analysis.status === "NOT_APPLICABLE") return analysis;

  const wrong = input.judgments.filter((j) => j.subjectBinding === "WRONG_SUBJECT").length;
  const manual = input.judgments.filter((j) => j.reviewDecision === "MANUAL_REVIEW_REQUIRED").length;
  const registry = input.clusters.filter(
    (c) =>
      (c.identityAnchor?.inn || c.clusterId.startsWith("cl-") && c.identityAnchor?.inn) &&
      (c.subjectBinding === "CONFIRMED" || c.subjectBinding === "LIKELY")
  );
  const confirmedRegistry = input.clusters.filter(
    (c) => c.subjectBinding === "CONFIRMED" && c.clientUse === "AUTO_INCLUDE_CLIENT_REPORT" && c.identityAnchor?.inn
  );

  const inn = confirmedRegistry[0]?.identityAnchor?.inn;
  const ogrnip = confirmedRegistry[0]?.identityAnchor?.ogrnip;
  const refs = confirmedRegistry.flatMap((c) => c.evidenceIds).slice(0, 8);

  if (analysis.sectionId === "16_ru_wikipedia") {
    if (analysis.status === "DATA_POOR" || analysis.status === "NO_FINDINGS" || analysis.keyFindings.length === 0) {
      return {
        ...analysis,
        status: analysis.status === "HAS_FINDINGS" ? analysis.status : "DATA_POOR",
        clientNarrative:
          "По субъекту не выявлено устойчивой энциклопедической (Wikipedia) заметности в подтверждённых материалах. " +
          "Отсутствие статьи не является негативным фактором и не заменяет проверку иных открытых источников.",
        keyFindings: [],
        recommendations: [
          "Оценивать encyclopedic eligibility только после подтверждения устойчивой источниковой базы.",
        ],
      };
    }
    return analysis;
  }

  if (analysis.sectionId === "13_ru_undesirable_theme_clusters") {
    const controversial = input.judgments.filter(
      (j) =>
        j.riskSignal === "CONTROVERSIAL_DUAL_USE" ||
        j.flags.some((f) => f.startsWith("controversial:"))
    );
    if (controversial.length === 0 && analysis.keyFindings.length === 0) {
      return {
        ...analysis,
        status: "NO_FINDINGS",
        clientNarrative:
          "Устойчивых подтверждённых кластеров нежелательных тем по субъекту в автоматически пригодных материалах не выявлено. " +
          (manual > 0
            ? `${manual} материал(ов) остаются на ручной проверке и не представлены как подтверждённый негатив.`
            : "Материалы с неоднозначным контекстом при наличии направляются на ручную проверку."),
        keyFindings: [],
      };
    }
  }

  // Strengthen registry narrative for audit / search / databases
  if (
    (analysis.sectionId === "10_ru_audit_summary" ||
      analysis.sectionId === "11_ru_search_links" ||
      analysis.sectionId === "46_other_public_databases") &&
    confirmedRegistry.length > 0
  ) {
    const idBits = [
      inn ? `ИНН ${inn}` : null,
      ogrnip ? `ОГРНИП ${ogrnip}` : null,
    ]
      .filter(Boolean)
      .join(" и ");

    const narrative =
      `По российскому цифровому следу субъекта выявлены подтверждённые реестровые сведения` +
      (idBits ? ` с совпадением по ${idBits}` : "") +
      `. Сгруппировано ${confirmedRegistry.length} кластер(ов) нейтральных карточек ` +
      `(${confirmedRegistry.reduce((n, c) => n + c.evidenceIds.length, 0)} исходных совпадений до дедупликации). ` +
      `Эти материалы используются как нейтральное подтверждение присутствия в открытых деловых/реестровых источниках ` +
      `и не трактуются как негативный фактор. ` +
      (wrong > 0
        ? `${wrong} материал(ов) с расхождением идентичности (в т.ч. по отчеству) исключены и не входят в основные выводы. `
        : "") +
      (manual > 0
        ? `${manual} материал(ов) на ручной проверке не представлены как подтверждённые негативные факты.`
        : "Автоматически подтверждённых adverse/compliance-выводов по данной секции нет.");

    const registryFinding = {
      title: "Подтверждённые реестровые сведения",
      summary:
        `Нейтральные реестровые/деловые карточки` +
        (idBits ? ` (${idBits})` : "") +
        `. Дубликаты объединены; факт регистрации не является негативным фактором.`,
      evidenceRefs: refs,
      confidence: "Высокая" as const,
    };

    const otherFindings = analysis.keyFindings
      .filter((f) => !/инн|огрн|реестр|ип томилин/i.test(`${f.title} ${f.summary}`))
      .slice(0, 4);

    return {
      ...analysis,
      status: "HAS_FINDINGS",
      clientNarrative: narrative,
      keyFindings: [registryFinding, ...otherFindings],
      limitations: [
        ...(analysis.limitations ?? []),
        wrong > 0 ? `Исключено WRONG_SUBJECT: ${wrong}.` : "",
      ].filter(Boolean),
    };
  }

  // Soft polish when registry exists but section was DATA_POOR
  if (analysis.status === "DATA_POOR" && registry.length > 0 && analysis.sectionId === "10_ru_audit_summary") {
    return {
      ...analysis,
      status: "HAS_FINDINGS",
      clientNarrative:
        "Доступны подтверждённые реестровые якоря субъекта; подробности отражены в сгруппированных нейтральных выводах. " +
        "Иные категории цифрового следа остаются ограниченными или на проверке.",
      keyFindings: [
        {
          title: "Реестровые якоря идентичности",
          summary: confirmedRegistry[0]?.summary ?? registry[0]!.summary,
          evidenceRefs: refs,
          confidence: "Высокая",
        },
      ],
    };
  }

  return analysis;
}

export function polishSectionAnalysesForClient(
  analyses: OrionSectionAnalysis[],
  input: { judgments: EvidenceJudgment[]; clusters: EvidenceCluster[] }
): OrionSectionAnalysis[] {
  return analyses.map((a) => polishRuSectionAnalysis(a, input));
}
