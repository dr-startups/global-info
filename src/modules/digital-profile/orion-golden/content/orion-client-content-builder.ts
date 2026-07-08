/**
 * R10.4 — Client-facing content artifact (no renderer dependency).
 */

import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import type { EvidenceBundlesArtifact } from "../evidence/evidence-client-gate";
import type { ManualReviewQueue } from "../evidence/manual-review-queue";

export type OrionClientContent = {
  version: "r10-4-orion-client-content-v1";
  generatedAt: string;
  caseId: string;
  reportRunId: string;
  subject: { displayName: string; aliases: string[] };
  executiveSummaryDraft: string;
  approvedFindings: Array<{ title: string; summary: string; domain?: string }>;
  appendixFindings: Array<{ title: string; summary: string; caveat: string }>;
  manualReviewSection: {
    title: string;
    intro: string;
    items: Array<{ title: string; summary: string; whyFlagged: string }>;
  };
  limitations: string[];
  methodologyNotes: string[];
};

export function buildOrionClientContent(input: {
  caseId: string;
  reportRunId: string;
  subject: { fullName: string; aliases: string[] };
  bundles: EvidenceBundlesArtifact;
  manualQueue: ManualReviewQueue;
  judgments: EvidenceJudgment[];
}): OrionClientContent {
  const approvedFindings = input.bundles.autoInclude.slice(0, 40).map((b) => ({
    title: b.title,
    summary: b.clientSafeSummary,
    domain: b.domain,
  }));

  const appendixFindings = input.bundles.appendixOnly.slice(0, 30).map((b) => ({
    title: b.title,
    summary: b.clientSafeSummary,
    caveat: "Материал учтён в приложении; не используется как подтверждённый ключевой вывод.",
  }));

  const manualItems = input.bundles.manualReview.slice(0, 50).map((b) => {
    const j = input.judgments.find((x) => x.evidenceId === b.evidenceId);
    return {
      title: b.title,
      summary: b.clientSafeSummary,
      whyFlagged: j?.manualReviewReason ?? "Требуется ручная проверка аналитиком.",
    };
  });

  const wrongSubjectCount = input.judgments.filter((j) => j.subjectBinding === "WRONG_SUBJECT").length;
  const excludedNoise = input.bundles.excluded.filter((e) => e.reviewDecision === "EXCLUDE_NOISE").length;

  const executiveSummaryDraft = [
    `Предварительная проверка ORION по субъекту «${input.subject.fullName}».`,
    `В ключевые выводы включено ${approvedFindings.length} материал(ов) после автоматической фильтрации и политики доказательств.`,
    manualItems.length > 0
      ? `${manualItems.length} материал(ов) направлены на ручную проверку и не представлены как подтверждённые негативные факты.`
      : "Материалы, требующие ручной проверки, отсутствуют или не включены в ключевые выводы.",
    "Окончательные compliance-выводы возможны только после проверки первоисточников и идентификации субъекта.",
  ].join(" ");

  return {
    version: "r10-4-orion-client-content-v1",
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
        "Следующие материалы имеют потенциальную значимость, но не подтверждены автоматически. Они не должны трактоваться как установленный негативный факт до решения аналитика.",
      items: manualItems,
    },
    limitations: [
      `${excludedNoise} шумовых материалов исключены из клиентского отчёта.`,
      wrongSubjectCount > 0
        ? `${wrongSubjectCount} материал(ов) исключены как вероятное совпадение с другим лицом.`
        : "Совпадения с другим лицом не выявлены в автоматической фильтрации.",
      "GPT-анализ использует только одобренные, приложенческие и явно помеченные материалы.",
    ],
    methodologyNotes: [
      "Двусмысленные high-impact факты не маркируются автоматически как негативные.",
      "Allegations/rumors без авторитетного источника направляются на ручную проверку.",
      "Политика маршрутизации применяется детерминированно до GPT-анализа.",
    ],
  };
}

export function renderOrionClientContentMarkdown(content: OrionClientContent): string {
  const lines: string[] = [];
  lines.push(`# ORION — клиентский контент (черновик)`);
  lines.push("");
  lines.push(`**Субъект:** ${content.subject.displayName}`);
  lines.push(`**Case:** ${content.caseId}`);
  lines.push("");
  lines.push(`## Резюме`);
  lines.push(content.executiveSummaryDraft);
  lines.push("");
  lines.push(`## Ключевые подтверждённые материалы (${content.approvedFindings.length})`);
  for (const f of content.approvedFindings.slice(0, 15)) {
    lines.push(`- **${f.title}**${f.domain ? ` (${f.domain})` : ""}: ${f.summary}`);
  }
  lines.push("");
  lines.push(`## ${content.manualReviewSection.title}`);
  lines.push(content.manualReviewSection.intro);
  for (const item of content.manualReviewSection.items.slice(0, 15)) {
    lines.push(`- **${item.title}**: ${item.summary}`);
    lines.push(`  - *Почему на проверке:* ${item.whyFlagged}`);
  }
  lines.push("");
  lines.push(`## Ограничения`);
  for (const l of content.limitations) lines.push(`- ${l}`);
  return lines.join("\n");
}
