/**
 * R10.7c — Context-aware recommendations from actual section/judgment state.
 */

import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import type { EvidenceCluster } from "./evidence-cluster";
import type { ManualReviewGroup } from "./manual-review-groups";
import type { OrionSectionAnalysis } from "../sections/orion-section-analysis";
import type { ExecutiveSynthesisOutput } from "../gpt/orion-executive-synthesis-from-sections";

export function buildPolishedRecommendations(input: {
  judgments: EvidenceJudgment[];
  clusters: EvidenceCluster[];
  manualGroups: ManualReviewGroup[];
  sectionAnalyses: OrionSectionAnalysis[];
  executiveSynthesis?: ExecutiveSynthesisOutput;
}): string[] {
  const recs: string[] = [];
  const j = input.judgments;
  const unknown = j.filter((x) => x.subjectBinding === "UNKNOWN").length;
  const weak = j.filter((x) => x.subjectBinding === "WEAK").length;
  const wrong = j.filter((x) => x.subjectBinding === "WRONG_SUBJECT").length;
  const confirmedInn = input.clusters.filter(
    (c) => c.identityAnchor?.inn && c.subjectBinding === "CONFIRMED" && c.clientUse === "AUTO_INCLUDE_CLIENT_REPORT"
  );
  const manualCompliance = input.manualGroups.find((g) => g.reason === "compliance_potential_match");
  const wiki = input.sectionAnalyses.find((s) => s.sectionId === "16_ru_wikipedia");
  const uaeSections = input.sectionAnalyses.filter((s) => s.sectionId.startsWith("3") && s.sectionId.includes("uae"));
  const uaePoor =
    uaeSections.length > 0 &&
    uaeSections.every((s) => s.status === "DATA_POOR" || s.status === "NOT_APPLICABLE" || s.status === "NO_FINDINGS");

  if (confirmedInn.length > 0) {
    const inn = confirmedInn[0]!.identityAnchor!.inn!;
    recs.push(
      `Использовать подтверждённые реестровые якоря (ИНН ${inn}` +
        (confirmedInn[0]!.identityAnchor?.ogrnip ? `, ОГРНИП ${confirmedInn[0]!.identityAnchor!.ogrnip}` : "") +
        `) как основу нейтрального цифрового профиля субъекта; не трактовать сам факт регистрации как риск.`
    );
  }

  if (unknown + weak > j.length * 0.4) {
    recs.push(
      `Значительная доля материалов имеет слабую/неизвестную привязку к субъекту (${unknown} UNKNOWN, ${weak} WEAK). ` +
        `Рекомендуется обогатить идентификаторы (ИНН, дата рождения, подтверждённые профили) до расширения ключевых выводов.`
    );
  }

  if (wrong > 0) {
    recs.push(
      `Исключено ${wrong} материал(ов) как вероятное совпадение с другим лицом. ` +
        `При дальнейших поисках сохранять фильтр по отчеству и уникальным идентификаторам.`
    );
  }

  if (manualCompliance && manualCompliance.items.length > 0) {
    recs.push(
      `Есть ${manualCompliance.items.length} compliance-материал(ов) на ручной проверке. ` +
        `До решения аналитика не формулировать клиентские выводы о санкциях/watchlist как подтверждённые.`
    );
  }

  const otherManual = input.manualGroups.reduce((n, g) => n + g.items.length, 0);
  if (otherManual > 0 && !manualCompliance) {
    recs.push(
      `${otherManual} материал(ов) остаются на ручной проверке. ` +
        `Аналитику следует закрыть очередь по группам причин до финализации риск-матрицы для клиента.`
    );
  }

  if (wiki && (wiki.status === "DATA_POOR" || wiki.status === "NO_FINDINGS")) {
    recs.push(
      `Энциклопедическая (Wikipedia) заметность не подтверждена достаточными материалами. ` +
        `Оценивать encyclopedic eligibility только после подтверждения устойчивой источниковой базы.`
    );
  }

  if (uaePoor) {
    recs.push(
      `По UAE-секциям недостаточно подтверждённых материалов. ` +
        `Не делать выводов о присутствии/рисках в ОАЭ на текущем этапе; при необходимости расширить региональный сбор.`
    );
  }

  const fromExec = (input.executiveSynthesis?.finalRecommendations ?? [])
    .map((r) => (typeof r === "string" ? r : String(r)))
    .filter((r) => r.trim().length > 20)
    .slice(0, 2);
  for (const r of fromExec) {
    if (!recs.some((x) => x.slice(0, 60) === r.slice(0, 60))) recs.push(r);
  }

  const fromSections = input.sectionAnalyses
    .flatMap((s) => s.recommendations ?? [])
    .filter((r) => r.trim().length > 25 && !/недостаточно/i.test(r))
    .slice(0, 3);
  for (const r of fromSections) {
    if (!recs.some((x) => x.slice(0, 50) === r.slice(0, 50))) recs.push(r);
  }

  return recs.slice(0, 8);
}
