/**
 * R10.4 — Manual review queue artifact for future admin panel.
 */

import type { EvidenceJudgment } from "./evidence-judgment";

export type ManualReviewQueueItem = {
  evidenceId: string;
  title: string;
  url?: string;
  sourceDomain?: string;
  snippet: string;
  proposedClassification: {
    subjectBinding: EvidenceJudgment["subjectBinding"];
    relevance: EvidenceJudgment["relevance"];
    riskSignal: EvidenceJudgment["riskSignal"];
    contentNature: EvidenceJudgment["contentNature"];
    reviewDecision: EvidenceJudgment["reviewDecision"];
  };
  whyAgentFlagged: string;
  riskInterpretation: string;
  neutralInterpretation: string;
  positiveInterpretation?: string;
  missingContext: string[];
  recommendedAdminAction: EvidenceJudgment["recommendedAdminAction"];
  adminReviewStatus: EvidenceJudgment["adminReviewStatus"];
  flags: string[];
};

export type ManualReviewQueue = {
  version: "r10-4-manual-review-queue-v1";
  generatedAt: string;
  caseId: string;
  reportRunId: string;
  pendingCount: number;
  items: ManualReviewQueueItem[];
};

export function buildManualReviewQueue(input: {
  caseId: string;
  reportRunId: string;
  judgments: EvidenceJudgment[];
  snippetById: Map<string, string>;
}): ManualReviewQueue {
  const items = input.judgments
    .filter((j) => j.reviewDecision === "MANUAL_REVIEW_REQUIRED")
    .map((j) => ({
      evidenceId: j.evidenceId,
      title: j.title,
      url: j.url,
      sourceDomain: j.sourceDomain,
      snippet: (input.snippetById.get(j.evidenceId) ?? j.clientSafeSummary).slice(0, 400),
      proposedClassification: {
        subjectBinding: j.subjectBinding,
        relevance: j.relevance,
        riskSignal: j.riskSignal,
        contentNature: j.contentNature,
        reviewDecision: j.reviewDecision,
      },
      whyAgentFlagged: j.manualReviewReason ?? j.whyRiskyOrNot,
      riskInterpretation: j.evidenceForRisk.join(" ") || j.whyRiskyOrNot,
      neutralInterpretation: j.alternativeInterpretations[0] ?? "Контекст может быть нейтральным.",
      positiveInterpretation: j.alternativeInterpretations.find((a) => /легаль|позитив|success/i.test(a)),
      missingContext: j.flags.includes("wrong_subject")
        ? ["Подтверждение идентичности субъекта", "ИНН/ОГРН/DOB", "Юрисдикция"]
        : ["Подтверждение первоисточника", "Роль субъекта", "Дата и контекст"],
      recommendedAdminAction: j.recommendedAdminAction,
      adminReviewStatus: j.adminReviewStatus,
      flags: j.flags,
    }));

  return {
    version: "r10-4-manual-review-queue-v1",
    generatedAt: new Date().toISOString(),
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    pendingCount: items.filter((i) => i.adminReviewStatus === "PENDING").length,
    items,
  };
}
