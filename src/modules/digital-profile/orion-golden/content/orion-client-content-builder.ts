/**
 * R10.4 / R10.5 — Client-facing content artifact (no renderer dependency).
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

export type ClientContentMode = "pre_review" | "post_review";

export type OrionClientContent = {
  version: "r10-6-orion-client-content-v1";
  mode: ClientContentMode;
  generatedAt: string;
  caseId: string;
  reportRunId: string;
  subject: { displayName: string; aliases: string[] };
  executiveSummaryDraft: string;
  approvedFindings: Array<{ title: string; summary: string; domain?: string; caveat?: string; evidenceRefs?: string[] }>;
  appendixFindings: Array<{ title: string; summary: string; caveat: string; evidenceRefs?: string[] }>;
  manualReviewSection: {
    title: string;
    intro: string;
    items: Array<{ title: string; summary: string; whyFlagged: string; adminStatus?: string; evidenceRefs?: string[] }>;
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
    };
  });

  const appendixFindings = effectiveBundles.appendixOnly.slice(0, 30).map((b) => ({
    title: b.title,
    summary: b.clientSafeSummary,
    caveat: "Материал учтён в приложении; не используется как подтверждённый ключевой вывод.",
  }));

  const manualItems = effectiveBundles.manualReview.slice(0, 50).map((b) => {
    const j = effectiveJudgments.find((x) => x.evidenceId === b.evidenceId);
    return {
      title: b.title,
      summary: j?.clientSafeSummary ?? b.clientSafeSummary,
      whyFlagged: j?.manualReviewReason ?? "Требуется ручная проверка аналитиком.",
      adminStatus: j?.adminReviewStatus,
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
    });
  }

  const wrongSubjectCount = effectiveJudgments.filter((j) => j.reviewDecision === "EXCLUDE_WRONG_SUBJECT").length;
  const excludedNoise = effectiveBundles.excluded.filter((e) => e.reviewDecision === "EXCLUDE_NOISE").length;
  const pendingManual = manualItems.filter(
    (m) => !m.adminStatus || m.adminStatus === "PENDING" || m.adminStatus === "NEEDS_MORE_SOURCES"
  ).length;

  const modeLabel =
    input.mode === "pre_review"
      ? "до ручной проверки аналитиком"
      : "после применения решений аналитика (artifact-backed)";

  const executiveSummaryDraft = [
    `Проверка ORION по субъекту «${input.subject.fullName}» (${modeLabel}).`,
    `В ключевые выводы включено ${approvedFindings.length} материал(ов).`,
    pendingManual > 0
      ? `${pendingManual} материал(ов) остаются на ручной проверке или ожидают дополнительных источников.`
      : input.mode === "post_review"
        ? "Все материалы из очереди ручной проверки получили решение аналитика."
        : "Материалы на ручной проверке не представлены как подтверждённые негативные факты.",
    "Compliance-выводы возможны только после проверки первоисточников и идентификации субъекта.",
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
}): OrionClientContent {
  seenNarrativeKeys.clear();
  const registryOrder = getClientAuditSections().map((s) => s.sectionId);
  const analysisById = new Map(input.sectionAnalyses.map((a) => [a.sectionId, a]));

  const sections = registryOrder
    .map((sectionId) => {
      const analysis = analysisById.get(sectionId);
      if (!analysis) return null;
      const narrative = dedupeNarrative(analysis.clientNarrative);
      if (!narrative && analysis.status === "NOT_APPLICABLE") {
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
      if (!narrative) return null;
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

  const approvedFindings = sections
    .flatMap((s) =>
      s.keyFindings
        .filter((f) => !f.caveat && s.status !== "MANUAL_REVIEW_PENDING")
        .map((f) => ({
          title: f.title,
          summary: f.summary,
          evidenceRefs: f.evidenceRefs,
        }))
    )
    .slice(0, 40);

  const manualAnalysis = analysisById.get("50_manual_review_required");
  const manualItems =
    manualAnalysis?.keyFindings.map((f) => ({
      title: f.title,
      summary: f.summary,
      whyFlagged: "Требуется решение аналитика.",
      adminStatus: "PENDING",
      evidenceRefs: f.evidenceRefs,
    })) ??
    input.manualQueue.items.slice(0, 50).map((item) => ({
      title: item.title,
      summary: item.snippet.slice(0, 200),
      whyFlagged: item.whyAgentFlagged,
      adminStatus: item.adminReviewStatus,
      evidenceRefs: [item.evidenceId],
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
  const limitations = [
    ...(limitationsAnalysis?.limitations ?? []),
    ...(limitationsAnalysis?.clientNarrative ? [limitationsAnalysis.clientNarrative] : []),
    ...input.riskMatrix.rows.filter((r) => r.requiresManualReview).map((r) => r.summary),
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
        "Материалы с потенциальной значимостью, не подтверждённые автоматически. Не трактуются как установленный негативный факт.",
      items: manualItems,
    },
    limitations,
    methodologyNotes: [
      "Клиентский контент собран из секционных GPT-анализов в каноническом порядке ORION.",
      "GPT не является финальным арбитром негативных выводов.",
      "Матрица рисков построена из секционных анализов без сканирования сырого инвентаря.",
    ],
    adminDecisionSummary: input.adminDecisionSummary,
    sections,
    riskMatrixSummary: input.riskMatrix,
    assemblySource: "section_analyses",
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
      for (const f of section.keyFindings.slice(0, 5)) {
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
  for (const item of content.manualReviewSection.items.slice(0, 15)) {
    lines.push(`- **${item.title}**${item.adminStatus ? ` [${item.adminStatus}]` : ""}: ${item.summary}`);
    lines.push(`  - *Почему на проверке:* ${item.whyFlagged}`);
  }
  lines.push("");
  lines.push(`## Ограничения`);
  for (const l of content.limitations) lines.push(`- ${l}`);
  return lines.join("\n");
}

/** @deprecated use buildOrionClientContent with mode pre_review */
export function buildOrionClientContentLegacy(input: Omit<Parameters<typeof buildOrionClientContent>[0], "mode">) {
  return buildOrionClientContent({ ...input, mode: "pre_review" });
}
