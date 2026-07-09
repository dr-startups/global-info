/**
 * R10.4 / R10.5 / R10.7c — Client-facing content artifact (no renderer dependency).
 */

import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import type { EvidenceBundlesArtifact } from "../evidence/evidence-client-gate";
import type { ManualReviewQueue } from "../evidence/manual-review-queue";
import { buildGatedEvidenceBundles } from "../evidence/evidence-client-gate";
import { applyAdminDecisionsToJudgments } from "../evidence/apply-admin-decisions-to-judgments";
import type { AdminReviewDecision } from "../evidence/admin-review-decision";
import { countAdminDecisionsByStatus } from "../evidence/admin-review-decision";
import type { ExecutiveSynthesisOutput } from "../gpt/orion-executive-synthesis-from-sections";
import type { OrionSectionAnalysis } from "../sections/orion-section-analysis";
import type { SectionDerivedRiskMatrix } from "../sections/orion-risk-matrix-from-sections";
import { getClientAuditSections } from "../sections/orion-section-registry";
import {
  clusterEvidenceJudgments,
  countDuplicateFindingsRemoved,
  registryClusters,
  type EvidenceCluster,
} from "./evidence-cluster";
import {
  buildManualReviewGroups,
  flattenManualReviewGroupsForClient,
  type ManualReviewGroup,
} from "./manual-review-groups";
import { compactRiskMatrixForClient } from "./risk-matrix-compaction";
import { polishSectionAnalysesForClient } from "./ru-section-content-polish";
import { buildPolishedRecommendations } from "./section-content-recommendations";

export type ClientContentMode = "pre_review" | "post_review";

export type OrionClientContent = {
  version: "r10-6-orion-client-content-v1";
  mode: ClientContentMode;
  generatedAt: string;
  caseId: string;
  reportRunId: string;
  subject: { displayName: string; aliases: string[] };
  executiveSummaryDraft: string;
  approvedFindings: Array<{
    title: string;
    summary: string;
    domain?: string;
    caveat?: string;
    evidenceRefs?: string[];
    evidenceId?: string;
  }>;
  appendixFindings: Array<{ title: string; summary: string; caveat: string; evidenceRefs?: string[]; evidenceId?: string }>;
  manualReviewSection: {
    title: string;
    intro: string;
    items: Array<{
      title: string;
      summary: string;
      whyFlagged: string;
      adminStatus?: string;
      evidenceRefs?: string[];
      evidenceId?: string;
    }>;
  };
  limitations: string[];
  methodologyNotes: string[];
  adminDecisionSummary?: Record<string, number>;
  /** R10.6 — assembled by canonical ORION section order */
  sections?: Array<{
    sectionId: string;
    order: number;
    title: string;
    status: string;
    narrative: string;
    keyFindings: Array<{ title: string; summary: string; evidenceRefs: string[]; caveat?: string }>;
    evidenceRefs: string[];
  }>;
  riskMatrixSummary?: SectionDerivedRiskMatrix;
  assemblySource: "section_analyses" | "evidence_bundles_legacy";
  /** R10.7c — polished recommendations */
  recommendations?: string[];
  /** R10.7c — evidence clusters used for dedupe / registry summaries */
  evidenceClusters?: EvidenceCluster[];
  /** R10.7c — grouped manual review */
  manualReviewGroups?: ManualReviewGroup[];
  /** R10.7c — assembly polish stats */
  contentPolish?: {
    version: "r10-7c-content-polish-v1";
    sectionsRendered: number;
    sectionsCollapsedDataPoor: number;
    registryClusters: number;
    duplicateFindingsRemoved: number;
    riskMatrixRowsBefore: number;
    riskMatrixRowsAfter: number;
    manualReviewGroups: number;
    recommendationsCount: number;
  };
};

export function buildOrionClientContent(input: {
  mode: ClientContentMode;
  caseId: string;
  reportRunId: string;
  subject: { fullName: string; aliases: string[] };
  bundles: EvidenceBundlesArtifact;
  manualQueue: ManualReviewQueue;
  judgments: EvidenceJudgment[];
  adminDecisions?: AdminReviewDecision[];
}): OrionClientContent {
  let effectiveJudgments = input.judgments;
  let effectiveBundles = input.bundles;
  let adminDecisionSummary: Record<string, number> | undefined;

  if (input.mode === "post_review" && input.adminDecisions?.length) {
    const applied = applyAdminDecisionsToJudgments(input.judgments, input.adminDecisions);
    effectiveJudgments = applied.judgments;
    effectiveBundles = buildGatedEvidenceBundles({
      caseId: input.caseId,
      reportRunId: input.reportRunId,
      judgments: effectiveJudgments,
    });
    adminDecisionSummary = countAdminDecisionsByStatus(input.adminDecisions);
  }

  const approvedFindings = effectiveBundles.autoInclude.slice(0, 40).map((b) => {
    const j = effectiveJudgments.find((x) => x.evidenceId === b.evidenceId);
    const caveat =
      j?.adminReviewStatus === "APPROVED_WITH_CAVEAT" && j.flags.includes("admin_caveated")
        ? j.clientSafeSummary.match(/\[Оговорка: ([^\]]+)\]/)?.[1]
        : undefined;
    return {
      title: b.title,
      summary: j?.clientSafeSummary ?? b.clientSafeSummary,
      domain: b.domain,
      caveat,
      evidenceId: b.evidenceId,
      evidenceRefs: [b.evidenceId],
    };
  });

  const appendixFindings = effectiveBundles.appendixOnly.slice(0, 30).map((b) => ({
    title: b.title,
    summary: b.clientSafeSummary,
    caveat: "Материал учтён в приложении; не используется как подтверждённый ключевой вывод.",
    evidenceId: b.evidenceId,
    evidenceRefs: [b.evidenceId],
  }));

  const manualItems = effectiveBundles.manualReview.slice(0, 50).map((b) => {
    const j = effectiveJudgments.find((x) => x.evidenceId === b.evidenceId);
    return {
      title: b.title,
      summary: j?.clientSafeSummary ?? b.clientSafeSummary,
      whyFlagged: j?.manualReviewReason ?? "Требуется ручная проверка аналитиком.",
      adminStatus: j?.adminReviewStatus,
      evidenceId: b.evidenceId,
      evidenceRefs: [b.evidenceId],
    };
  });

  const needsMoreSources = effectiveJudgments.filter((j) => j.adminReviewStatus === "NEEDS_MORE_SOURCES");
  for (const j of needsMoreSources) {
    if (manualItems.some((m) => m.title === j.title)) continue;
    manualItems.push({
      title: j.title,
      summary: j.clientSafeSummary,
      whyFlagged: "Требуются дополнительные источники.",
      adminStatus: "NEEDS_MORE_SOURCES",
      evidenceId: j.evidenceId,
      evidenceRefs: [j.evidenceId],
    });
  }

  const wrongSubjectCount = effectiveJudgments.filter((j) => j.reviewDecision === "EXCLUDE_WRONG_SUBJECT").length;
  const excludedNoise = effectiveBundles.excluded.filter((e) => e.reviewDecision === "EXCLUDE_NOISE").length;

  const executiveSummaryDraft = [
    `По субъекту «${input.subject.fullName}» выполнен предварительный аудит открытого цифрового профиля.`,
    approvedFindings.length > 0
      ? `В ключевых выводах зафиксированы тематические сигналы по открытым источникам; комплаенс-интерпретация — предварительная.`
      : `Подтверждённые дифференцирующие сигналы на текущем этапе ограничены.`,
    "Окончательные комплаенс-выводы возможны только после сверки с первоисточниками и подтверждения идентификации субъекта.",
  ].join(" ");

  return {
    version: "r10-6-orion-client-content-v1",
    mode: input.mode,
    generatedAt: new Date().toISOString(),
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    subject: { displayName: input.subject.fullName, aliases: input.subject.aliases },
    executiveSummaryDraft,
    approvedFindings,
    appendixFindings,
    manualReviewSection: {
      title: "Материалы, требующие ручной проверки",
      intro:
        input.mode === "pre_review"
          ? "Следующие материалы имеют потенциальную значимость, но не подтверждены автоматически. Они не должны трактоваться как установленный негативный факт до решения аналитика."
          : "Материалы, по которым аналитик ещё не принял решение или запросил дополнительные источники. Не используются как подтверждённые негативные факты.",
      items: manualItems,
    },
    limitations: [
      `${excludedNoise} материал(ов) исключены из клиентского отчёта.`,
      wrongSubjectCount > 0
        ? `${wrongSubjectCount} материал(ов) исключены как вероятное совпадение с другим лицом.`
        : "Совпадения с другим лицом не включены в ключевые выводы.",
      input.mode === "post_review"
        ? "Клиентский контент учитывает artifact-backed решения admin-review-decisions."
        : "Клиентский контент сформирован до решений аналитика (pre-review).",
    ],
    methodologyNotes: [
      "Двусмысленные high-impact факты не маркируются автоматически как негативные.",
      "Решения аналитика применяются детерминированно поверх evidence judgment.",
      "GPT не является финальным арбитром негативных выводов.",
    ],
    adminDecisionSummary,
    assemblySource: "evidence_bundles_legacy",
  };
}

const seenNarrativeKeys = new Set<string>();

function dedupeNarrative(text: string): string {
  const key = text.trim().slice(0, 120);
  if (seenNarrativeKeys.has(key)) return "";
  seenNarrativeKeys.add(key);
  return text;
}

function isGenericDataPoorNarrative(narrative: string): boolean {
  return (
    /недостаточно подтверждённых материалов/i.test(narrative) ||
    /детерминированно без GPT/i.test(narrative) ||
    /недостаточно данных для аналитического вывода/i.test(narrative)
  );
}

function shouldCollapseDataPoorSection(analysis: OrionSectionAnalysis): boolean {
  if (analysis.sectionId === "01_executive_summary" || analysis.sectionId === "02_compliance_risk_matrix") {
    return false;
  }
  if (analysis.sectionId === "50_manual_review_required" || analysis.sectionId === "53_recommendations") {
    return false;
  }
  // R10.7c — also collapse empty NOT_APPLICABLE / NO_FINDINGS with generic text
  if (analysis.status === "NOT_APPLICABLE") {
    return (
      analysis.keyFindings.length === 0 &&
      (isGenericDataPoorNarrative(analysis.clientNarrative) || analysis.clientNarrative.trim().length < 160)
    );
  }
  if (analysis.status === "NO_FINDINGS" && analysis.keyFindings.length === 0) {
    return isGenericDataPoorNarrative(analysis.clientNarrative) || analysis.clientNarrative.trim().length < 120;
  }
  if (analysis.status !== "DATA_POOR") return false;
  if (analysis.keyFindings.length > 0) return false;
  return isGenericDataPoorNarrative(analysis.clientNarrative) || analysis.clientNarrative.trim().length < 140;
}

function dedupeApprovedFindings(
  findings: Array<{ title: string; summary: string; evidenceRefs?: string[]; domain?: string; caveat?: string; evidenceId?: string }>
): typeof findings {
  const seen = new Set<string>();
  const out: typeof findings = [];
  for (const f of findings) {
    const key = `${f.title.slice(0, 60).toLowerCase()}::${(f.summary ?? "").slice(0, 80).toLowerCase()}`;
    if (seen.has(key)) continue;
    // Collapse near-duplicate INN registry cards into first occurrence
    const inn = (f.summary + f.title).match(/\b(\d{12})\b/);
    if (inn) {
      const innKey = `inn:${inn[1]}`;
      if (seen.has(innKey)) continue;
      seen.add(innKey);
    }
    seen.add(key);
    out.push(f);
  }
  return out;
}

function buildExecutiveSectionFromSynthesis(
  analysis: OrionSectionAnalysis | undefined,
  synthesis: ExecutiveSynthesisOutput
): NonNullable<OrionClientContent["sections"]>[0] {
  const findings = [
    ...synthesis.mainRisks.slice(0, 6).map((r) => ({
      title: "Тема риска",
      summary: typeof r === "string" ? r : String(r),
      evidenceRefs: [] as string[],
    })),
    ...synthesis.finalRecommendations.slice(0, 4).map((r) => ({
      title: "Рекомендуемое действие",
      summary: typeof r === "string" ? r : String(r),
      evidenceRefs: [] as string[],
    })),
  ];
  return {
    sectionId: "01_executive_summary",
    order: analysis?.order ?? 1,
    title: analysis?.title ?? "Резюме для руководства",
    status: "HAS_FINDINGS",
    narrative: synthesis.executiveSummary,
    keyFindings: findings,
    evidenceRefs: [],
  };
}

function buildRiskMatrixSectionFromDerived(
  analysis: OrionSectionAnalysis | undefined,
  riskMatrix: SectionDerivedRiskMatrix
): NonNullable<OrionClientContent["sections"]>[0] {
  const topRows = riskMatrix.rows.slice(0, 14);
  const narrative = [
    `Матрица compliance-рисков сформирована из секционных анализов и сжата для читаемости (источник: ${riskMatrix.inputSource}).`,
    `Глобальный уровень: ${riskMatrix.globalRiskLevel}.`,
    riskMatrix.pendingManualReviewCount > 0
      ? `Материалов, требующих ручной проверки: ${riskMatrix.pendingManualReviewCount} (не подтверждённый риск).`
      : "Очередь ручной проверки по матрице пуста.",
    `Отображено строк: ${topRows.length}.`,
  ].join(" ");
  return {
    sectionId: "02_compliance_risk_matrix",
    order: analysis?.order ?? 2,
    title: analysis?.title ?? "Матрица compliance-рисков",
    status: topRows.length > 0 ? "HAS_FINDINGS" : "NO_FINDINGS",
    narrative,
    keyFindings: topRows.map((r) => ({
      title: r.theme,
      summary: `${r.level}: ${r.summary}`,
      evidenceRefs: r.evidenceRefs,
      caveat: r.requiresManualReview ? r.caveat ?? "Требует ручной проверки" : r.caveat,
    })),
    evidenceRefs: [...new Set(topRows.flatMap((r) => r.evidenceRefs))],
  };
}

function buildRecommendationsSection(
  analysis: OrionSectionAnalysis | undefined,
  recommendations: string[]
): NonNullable<OrionClientContent["sections"]>[0] {
  return {
    sectionId: "53_recommendations",
    order: analysis?.order ?? 53,
    title: analysis?.title ?? "Рекомендации",
    status: recommendations.length > 0 ? "HAS_FINDINGS" : "NO_FINDINGS",
    narrative:
      recommendations.length > 0
        ? "Рекомендации сформированы по фактическому состоянию секций, реестровых якорей и очереди ручной проверки."
        : "Отдельные рекомендации не сформированы — недостаточно дифференцирующих сигналов.",
    keyFindings: recommendations.map((r) => ({
      title: "Рекомендуемое действие",
      summary: r,
      evidenceRefs: [] as string[],
    })),
    evidenceRefs: [],
  };
}

export function assembleOrionClientContentFromSections(input: {
  mode: ClientContentMode;
  caseId: string;
  reportRunId: string;
  subject: { fullName: string; aliases: string[] };
  sectionAnalyses: OrionSectionAnalysis[];
  executiveSynthesis: ExecutiveSynthesisOutput;
  riskMatrix: SectionDerivedRiskMatrix;
  manualQueue: ManualReviewQueue;
  adminDecisionSummary?: Record<string, number>;
  /** R10.7b/c — judgments for identity limitations, clustering, polish */
  judgments?: EvidenceJudgment[];
}): OrionClientContent {
  seenNarrativeKeys.clear();
  const judgments = input.judgments ?? [];
  const clusters = clusterEvidenceJudgments(judgments);
  const regClusters = registryClusters(clusters);
  const duplicatesRemoved = countDuplicateFindingsRemoved(clusters);
  const polishedAnalyses = polishSectionAnalysesForClient(input.sectionAnalyses, { judgments, clusters });
  const compactMatrix = compactRiskMatrixForClient({
    riskMatrix: input.riskMatrix,
    judgments,
    clusters,
    maxRows: 14,
  });
  const manualGroups = buildManualReviewGroups({ judgments, manualQueue: input.manualQueue });
  const recommendations = buildPolishedRecommendations({
    judgments,
    clusters,
    manualGroups,
    sectionAnalyses: polishedAnalyses,
    executiveSynthesis: input.executiveSynthesis,
  });

  const registryOrder = getClientAuditSections().map((s) => s.sectionId);
  const analysisById = new Map(polishedAnalyses.map((a) => [a.sectionId, a]));
  const collapsedDataPoorTitles: string[] = [];

  const sections = registryOrder
    .map((sectionId) => {
      const analysis = analysisById.get(sectionId);
      if (!analysis) return null;

      if (sectionId === "01_executive_summary" && input.executiveSynthesis.executiveSummary.trim()) {
        return buildExecutiveSectionFromSynthesis(analysis, input.executiveSynthesis);
      }
      if (sectionId === "02_compliance_risk_matrix") {
        return buildRiskMatrixSectionFromDerived(analysis, compactMatrix);
      }
      if (sectionId === "53_recommendations") {
        return buildRecommendationsSection(analysis, recommendations);
      }

      if (shouldCollapseDataPoorSection(analysis)) {
        collapsedDataPoorTitles.push(analysis.title);
        return null;
      }

      if (analysis.status === "NOT_APPLICABLE") {
        return {
          sectionId,
          order: analysis.order,
          title: analysis.title,
          status: analysis.status,
          narrative: analysis.clientNarrative,
          keyFindings: [],
          evidenceRefs: [] as string[],
        };
      }

      const narrative = dedupeNarrative(analysis.clientNarrative);
      if (!narrative) {
        collapsedDataPoorTitles.push(analysis.title);
        return null;
      }
      const evidenceRefs = [
        ...new Set([
          ...analysis.keyFindings.flatMap((f) => f.evidenceRefs),
          ...analysis.risks.flatMap((r) => r.evidenceRefs),
        ]),
      ];
      return {
        sectionId,
        order: analysis.order,
        title: analysis.title,
        status: analysis.status,
        narrative,
        keyFindings: analysis.keyFindings.map((f) => ({
          title: f.title,
          summary: f.summary,
          evidenceRefs: f.evidenceRefs,
          caveat: f.caveat,
        })),
        evidenceRefs,
      };
    })
    .filter(Boolean) as NonNullable<OrionClientContent["sections"]>;

  if (collapsedDataPoorTitles.length > 0) {
    const limitationsIdx = sections.findIndex((s) => s.sectionId === "52_limitations");
    const collapseNote = {
      sectionId: "52_limitations_collapsed_note",
      order: 52.5,
      title: "Недостаточно данных / не выявлено значимых материалов",
      status: "DATA_POOR",
      narrative:
        `Недостаточно данных или не выявлено значимых материалов по секциям (${collapsedDataPoorTitles.length}): ` +
        `${collapsedDataPoorTitles.join(", ")}. ` +
        `Пустые блоки не развёрнуты в клиентском отчёте.`,
      keyFindings: [] as Array<{ title: string; summary: string; evidenceRefs: string[]; caveat?: string }>,
      evidenceRefs: [] as string[],
    };
    if (limitationsIdx >= 0) sections.splice(limitationsIdx + 1, 0, collapseNote);
    else sections.push(collapseNote);
  }

  sections.sort((a, b) => a.order - b.order);

  // Prefer clustered registry summaries in approved findings, then other section findings
  const clusterFindings = regClusters
    .filter((c) => c.clientUse === "AUTO_INCLUDE_CLIENT_REPORT")
    .slice(0, 8)
    .map((c) => ({
      title: c.title,
      summary: c.summary,
      domain: c.sourceDomains[0],
      evidenceRefs: c.evidenceIds.slice(0, 8),
      evidenceId: c.evidenceIds[0],
    }));

  const sectionFindings = sections
    .filter((s) => s.sectionId !== "02_compliance_risk_matrix" && s.sectionId !== "53_recommendations")
    .flatMap((s) =>
      s.keyFindings
        .filter((f) => !f.caveat && s.status !== "MANUAL_REVIEW_PENDING")
        .map((f) => ({
          title: f.title,
          summary: f.summary,
          evidenceRefs: f.evidenceRefs,
        }))
    );

  const approvedFindings = dedupeApprovedFindings([...clusterFindings, ...sectionFindings]).slice(0, 25);

  const manualItems =
    judgments.length > 0
      ? flattenManualReviewGroupsForClient(manualGroups).slice(0, 60)
      : input.manualQueue.items.slice(0, 50).map((item) => ({
          title: item.title,
          summary: item.snippet.slice(0, 200),
          whyFlagged: item.whyAgentFlagged,
          adminStatus: item.adminReviewStatus,
          evidenceRefs: [item.evidenceId],
          evidenceId: item.evidenceId,
        }));

  const appendixAnalysis = analysisById.get("54_evidence_appendix");
  const appendixFindings =
    appendixAnalysis?.keyFindings.map((f) => ({
      title: f.title,
      summary: f.summary,
      caveat: "Приложение — не ключевой вывод.",
      evidenceRefs: f.evidenceRefs,
    })) ?? [];

  const limitationsAnalysis = analysisById.get("52_limitations");
  const identityLimitations: string[] = [];
  if (judgments.length) {
    const wrong = judgments.filter((j) => j.subjectBinding === "WRONG_SUBJECT").length;
    const weakUnknown = judgments.filter(
      (j) => j.subjectBinding === "WEAK" || j.subjectBinding === "UNKNOWN"
    ).length;
    const patronymic = judgments.filter((j) => j.flags.includes("patronymic_mismatch")).length;
    const innConfirmed = judgments.filter(
      (j) => j.flags.includes("exact_inn_match") && j.subjectBinding === "CONFIRMED"
    ).length;
    if (innConfirmed > 0 || regClusters.length > 0) {
      identityLimitations.push(
        `Нейтральные реестровые сведения с совпадением по ИНН использованы как подтверждённые факты идентификации` +
          (regClusters[0]?.identityAnchor?.inn ? ` (ИНН ${regClusters[0].identityAnchor.inn})` : "") +
          `; дубликаты карточек объединены в ${regClusters.length} кластер(ов).`
      );
    }
    if (patronymic > 0) {
      identityLimitations.push(
        `Материалы с расхождением по отчеству (${patronymic}) не использовались в основных выводах как подтверждённая идентификация.`
      );
    }
    if (wrong > 0) {
      identityLimitations.push(
        `${wrong} материал(ов) исключены как вероятное совпадение с другим лицом (WRONG_SUBJECT).`
      );
    }
    if (weakUnknown > 0) {
      identityLimitations.push(
        `Часть найденных материалов (${weakUnknown}) содержит совпадение по ФИО или слабый контекст, однако не имеет дополнительных идентификаторов и не использована как сильный вывод.`
      );
    }
  }

  const limitations = [
    ...identityLimitations,
    collapsedDataPoorTitles.length > 0
      ? `Сжато пустых/DATA_POOR секций: ${collapsedDataPoorTitles.length}.`
      : "",
    ...(limitationsAnalysis?.limitations ?? []),
    ...(limitationsAnalysis?.clientNarrative && !isGenericDataPoorNarrative(limitationsAnalysis.clientNarrative)
      ? [limitationsAnalysis.clientNarrative]
      : []),
  ].filter(Boolean);

  return {
    version: "r10-6-orion-client-content-v1",
    mode: input.mode,
    generatedAt: new Date().toISOString(),
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    subject: { displayName: input.subject.fullName, aliases: input.subject.aliases },
    executiveSummaryDraft: input.executiveSynthesis.executiveSummary,
    approvedFindings,
    appendixFindings,
    manualReviewSection: {
      title: "Материалы, требующие ручной проверки",
      intro:
        "Материалы сгруппированы по причине проверки. Они не трактуются как установленный негативный факт до решения аналитика.",
      items: manualItems,
    },
    limitations,
    methodologyNotes: [
      "Клиентский контент собран из секционных GPT-анализов в каноническом порядке ORION.",
      "R10.7c: реестровые дубликаты кластеризованы; пустые секции сжаты; матрица рисков уплотнена.",
      "GPT не является финальным арбитром негативных выводов.",
      "Матрица рисков построена из секционных анализов без сканирования сырого инвентаря.",
    ],
    adminDecisionSummary: input.adminDecisionSummary,
    sections,
    riskMatrixSummary: compactMatrix,
    assemblySource: "section_analyses",
    recommendations,
    evidenceClusters: clusters.slice(0, 40),
    manualReviewGroups: manualGroups,
    contentPolish: {
      version: "r10-7c-content-polish-v1",
      sectionsRendered: sections.length,
      sectionsCollapsedDataPoor: collapsedDataPoorTitles.length,
      registryClusters: regClusters.length,
      duplicateFindingsRemoved: duplicatesRemoved,
      riskMatrixRowsBefore: compactMatrix.compaction?.before ?? input.riskMatrix.rows.length,
      riskMatrixRowsAfter: compactMatrix.rows.length,
      manualReviewGroups: manualGroups.length,
      recommendationsCount: recommendations.length,
    },
  };
}

export function renderOrionClientContentMarkdown(content: OrionClientContent): string {
  const lines: string[] = [];
  lines.push(`# ORION — клиентский отчёт (${content.mode})`);
  lines.push("");
  lines.push(`**Субъект:** ${content.subject.displayName}`);
  lines.push(`**Case:** ${content.caseId}`);
  lines.push("");
  lines.push(`## Резюме`);
  lines.push(content.executiveSummaryDraft);
  lines.push("");

  if (content.sections?.length) {
    lines.push(`## Секции ORION (канонический порядок)`);
    for (const section of content.sections) {
      if (section.status === "NOT_APPLICABLE") continue;
      lines.push("");
      lines.push(`### ${section.order}. ${section.title} (${section.sectionId})`);
      lines.push(`*Статус: ${section.status}*`);
      if (section.narrative) lines.push(section.narrative);
      for (const f of section.keyFindings.slice(0, 8)) {
        lines.push(`- **${f.title}**: ${f.summary}`);
        if (f.evidenceRefs.length) lines.push(`  - refs: ${f.evidenceRefs.join(", ")}`);
        if (f.caveat) lines.push(`  - *Оговорка:* ${f.caveat}`);
      }
    }
    lines.push("");
  }

  lines.push(`## Ключевые материалы (${content.approvedFindings.length})`);
  for (const f of content.approvedFindings.slice(0, 15)) {
    lines.push(`- **${f.title}**${f.domain ? ` (${f.domain})` : ""}: ${f.summary}`);
    if (f.caveat) lines.push(`  - *Оговорка:* ${f.caveat}`);
  }
  lines.push("");
  lines.push(`## ${content.manualReviewSection.title}`);
  lines.push(content.manualReviewSection.intro);
  for (const item of content.manualReviewSection.items.slice(0, 20)) {
    lines.push(`- **${item.title}**${item.adminStatus ? ` [${item.adminStatus}]` : ""}: ${item.summary}`);
    lines.push(`  - *Почему на проверке:* ${item.whyFlagged}`);
  }
  lines.push("");
  if (content.recommendations?.length) {
    lines.push(`## Рекомендации`);
    for (const r of content.recommendations) lines.push(`- ${r}`);
    lines.push("");
  }
  lines.push(`## Ограничения`);
  for (const l of content.limitations) lines.push(`- ${l}`);
  return lines.join("\n");
}

/** @deprecated use buildOrionClientContent with mode pre_review */
export function buildOrionClientContentLegacy(input: Omit<Parameters<typeof buildOrionClientContent>[0], "mode">) {
  return buildOrionClientContent({ ...input, mode: "pre_review" });
}
