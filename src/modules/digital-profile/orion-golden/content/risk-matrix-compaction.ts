/**
 * R10.7c — Compact section-derived risk matrix for client readability.
 */

import type { SectionDerivedRiskMatrix } from "../sections/orion-risk-matrix-from-sections";
import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import type { EvidenceCluster } from "./evidence-cluster";

const HIGH_IMPACT = new Set([
  "CONTROVERSIAL_DUAL_USE",
  "POSSIBLE_ADVERSE",
  "COMPLIANCE_RELEVANT",
  "ADVERSE_CONFIRMED",
]);

function normalizeTheme(theme: string): string {
  return theme
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .replace(/требует проверки/gi, "")
    .trim()
    .slice(0, 60);
}

/**
 * Compact noisy risk matrix rows: merge similar "Требует проверки" themes,
 * add summary rows for confirmed-neutral / insufficient / wrong-subject.
 */
export function compactRiskMatrixForClient(input: {
  riskMatrix: SectionDerivedRiskMatrix;
  judgments?: EvidenceJudgment[];
  clusters?: EvidenceCluster[];
  maxRows?: number;
}): SectionDerivedRiskMatrix & { compaction?: { before: number; after: number } } {
  const maxRows = input.maxRows ?? 14;
  const before = input.riskMatrix.rows.length;
  const judgments = input.judgments ?? [];

  const confirmedNeutral = (input.clusters ?? []).filter(
    (c) =>
      c.clientUse === "AUTO_INCLUDE_CLIENT_REPORT" &&
      (c.riskSignal === "NEUTRAL_CONTEXT" || c.riskSignal === "NO_RISK_SIGNAL" || c.riskSignal === "POSITIVE_SIGNAL") &&
      (c.subjectBinding === "CONFIRMED" || c.subjectBinding === "LIKELY")
  );
  const wrong = judgments.filter((j) => j.subjectBinding === "WRONG_SUBJECT").length;
  const insufficient = judgments.filter(
    (j) => j.riskSignal === "INSUFFICIENT_CONTEXT" || j.subjectBinding === "UNKNOWN"
  ).length;
  const pendingManual = judgments.filter((j) => j.reviewDecision === "MANUAL_REVIEW_REQUIRED").length;
  const highImpactManual = judgments.filter(
    (j) => j.reviewDecision === "MANUAL_REVIEW_REQUIRED" && HIGH_IMPACT.has(j.riskSignal)
  ).length;

  const structural: SectionDerivedRiskMatrix["rows"] = [];

  if (confirmedNeutral.length > 0) {
    const inns = [
      ...new Set(confirmedNeutral.map((c) => c.identityAnchor?.inn).filter(Boolean)),
    ] as string[];
    structural.push({
      theme: "Подтверждённые нейтральные реестровые факты",
      level: "Низкий",
      summary:
        `${confirmedNeutral.length} кластер(ов) подтверждённых нейтральных реестровых/профильных сведений` +
        (inns.length ? ` (в т.ч. ИНН ${inns.slice(0, 2).join(", ")})` : "") +
        `. Не трактуются как негативный фактор.`,
      evidenceRefs: confirmedNeutral.flatMap((c) => c.evidenceIds).slice(0, 12),
      sourceSectionIds: [...new Set(confirmedNeutral.flatMap((c) => c.sectionIds))].slice(0, 6),
      requiresManualReview: false,
    });
  }

  if (pendingManual > 0) {
    structural.push({
      theme: "Очередь ручной проверки",
      level: "Требует проверки",
      summary:
        `${pendingManual} материал(ов) ожидают решения аналитика` +
        (highImpactManual > 0 ? ` (из них ${highImpactManual} с потенциально значимым compliance/adverse-контекстом)` : "") +
        `. Не являются подтверждённым риском.`,
      evidenceRefs: judgments
        .filter((j) => j.reviewDecision === "MANUAL_REVIEW_REQUIRED")
        .slice(0, 15)
        .map((j) => j.evidenceId),
      sourceSectionIds: ["50_manual_review_required"],
      requiresManualReview: true,
      caveat: "Не подтверждено автоматически",
    });
  }

  if (insufficient > 0) {
    structural.push({
      theme: "Недостаточно доказательной базы / слабая идентификация",
      level: "Требует проверки",
      summary: `${insufficient} материал(ов) с недостаточным контекстом или неизвестной привязкой; не используются как сильные выводы.`,
      evidenceRefs: [],
      sourceSectionIds: ["52_limitations"],
      requiresManualReview: false,
      caveat: "Ограничение доказательной базы",
    });
  }

  if (wrong > 0) {
    structural.push({
      theme: "Исключённые совпадения с другим лицом",
      level: "Низкий",
      summary: `${wrong} материал(ов) исключены как WRONG_SUBJECT и не входят в клиентские выводы и GPT-входы секций.`,
      evidenceRefs: [],
      sourceSectionIds: ["51_excluded_noise_summary"],
      requiresManualReview: false,
    });
  }

  // Merge original rows by normalized theme; collapse repetitive "Требует проверки"
  const merged = new Map<string, SectionDerivedRiskMatrix["rows"][0]>();
  for (const row of input.riskMatrix.rows) {
    const isGenericPending =
      row.level === "Требует проверки" &&
      (/требует/i.test(row.summary) || /ручн/i.test(row.summary) || row.requiresManualReview);
    const key = isGenericPending
      ? `pending::${normalizeTheme(row.theme)}`
      : `${normalizeTheme(row.theme)}::${row.level}`;

    const existing = merged.get(key);
    if (existing) {
      existing.evidenceRefs = [...new Set([...existing.evidenceRefs, ...row.evidenceRefs])].slice(0, 20);
      existing.sourceSectionIds = [...new Set([...existing.sourceSectionIds, ...row.sourceSectionIds])];
      if (row.summary.length > existing.summary.length) existing.summary = row.summary;
      continue;
    }
    merged.set(key, { ...row, evidenceRefs: [...row.evidenceRefs], sourceSectionIds: [...row.sourceSectionIds] });
  }

  // Prefer structural rows first, then distinct thematic rows (skip ones already covered)
  const coveredThemes = new Set(structural.map((r) => normalizeTheme(r.theme)));
  const thematic = [...merged.values()]
    .filter((r) => {
      const t = normalizeTheme(r.theme);
      if (coveredThemes.has(t)) return false;
      if (/материалы на ручной проверке/i.test(r.theme)) return false;
      return true;
    })
    .sort((a, b) => {
      const rank = (l: string) =>
        l === "Критический" ? 4 : l === "Высокий" ? 3 : l === "Требует проверки" ? 2 : l === "Средний" ? 1 : 0;
      return rank(b.level) - rank(a.level);
    });

  const rows = [...structural, ...thematic].slice(0, maxRows);

  return {
    ...input.riskMatrix,
    rows,
    globalRiskLevel:
      pendingManual > 0 || highImpactManual > 0
        ? "Требует проверки"
        : input.riskMatrix.globalRiskLevel === "Требует проверки" && pendingManual === 0
          ? "Низкий"
          : input.riskMatrix.globalRiskLevel,
    compaction: { before, after: rows.length },
  };
}
