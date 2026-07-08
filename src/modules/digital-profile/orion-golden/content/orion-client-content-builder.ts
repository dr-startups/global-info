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

export type ClientContentMode = "pre_review" | "post_review";

export type OrionClientContent = {
  version: "r10-5-orion-client-content-v1";
  mode: ClientContentMode;
  generatedAt: string;
  caseId: string;
  reportRunId: string;
  subject: { displayName: string; aliases: string[] };
  executiveSummaryDraft: string;
  approvedFindings: Array<{ title: string; summary: string; domain?: string; caveat?: string }>;
  appendixFindings: Array<{ title: string; summary: string; caveat: string }>;
  manualReviewSection: {
    title: string;
    intro: string;
    items: Array<{ title: string; summary: string; whyFlagged: string; adminStatus?: string }>;
  };
  limitations: string[];
  methodologyNotes: string[];
  adminDecisionSummary?: Record<string, number>;
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
    version: "r10-5-orion-client-content-v1",
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
  };
}

export function renderOrionClientContentMarkdown(content: OrionClientContent): string {
  const lines: string[] = [];
  lines.push(`# ORION — клиентский контент (${content.mode})`);
  lines.push("");
  lines.push(`**Субъект:** ${content.subject.displayName}`);
  lines.push(`**Case:** ${content.caseId}`);
  lines.push("");
  lines.push(`## Резюме`);
  lines.push(content.executiveSummaryDraft);
  lines.push("");
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
