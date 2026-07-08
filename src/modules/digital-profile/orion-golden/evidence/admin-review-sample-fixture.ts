/**
 * R10.5 — Build QA-only admin review sample fixture from manual queue.
 */

import type { ManualReviewQueue } from "./manual-review-queue";
import type { EvidenceJudgment } from "./evidence-judgment";
import type { AdminReviewDecisionSet } from "./admin-review-decision";

export function buildAdminReviewSampleFixture(input: {
  caseId: string;
  manualQueue: ManualReviewQueue;
  judgments: EvidenceJudgment[];
}): AdminReviewDecisionSet {
  const queueItems = input.manualQueue.items;
  const wrongSubject = input.judgments.filter((j) => j.subjectBinding === "WRONG_SUBJECT");

  const pick = (index: number) => queueItems[index]?.evidenceId;
  const decisions: import("./admin-review-decision").AdminReviewDecision[] = [];

  const caveatId = pick(0);
  if (caveatId) {
    const item = queueItems[0]!;
    decisions.push({
      evidenceId: caveatId,
      status: "APPROVED_WITH_CAVEAT" as const,
      reviewedBy: "qa-fixture-analyst",
      reviewedAt: new Date().toISOString(),
      approvedClientSummary: item.proposedClassification
        ? `QA fixture: ${item.title.slice(0, 80)}`
        : undefined,
      caveatText: "QA-only: предварительный материал, требует подтверждения первоисточника.",
      reviewerNote: "QA sample fixture — not a real approval",
    });
  }

  const appendixId = pick(1);
  if (appendixId) {
    decisions.push({
      evidenceId: appendixId,
      status: "APPENDIX_ONLY" as const,
      reviewedBy: "qa-fixture-analyst",
      reviewedAt: new Date().toISOString(),
      reviewerNote: "QA sample fixture — appendix only",
    });
  }

  const excludedId = pick(2);
  if (excludedId) {
    decisions.push({
      evidenceId: excludedId,
      status: "EXCLUDED" as const,
      reviewedBy: "qa-fixture-analyst",
      reviewedAt: new Date().toISOString(),
      reviewerNote: "QA sample fixture — excluded",
    });
  }

  const needsSourcesId = pick(3);
  if (needsSourcesId) {
    decisions.push({
      evidenceId: needsSourcesId,
      status: "NEEDS_MORE_SOURCES" as const,
      reviewedBy: "qa-fixture-analyst",
      reviewedAt: new Date().toISOString(),
      requestedSources: ["Первоисточник", "Идентификатор субъекта"],
      reviewerNote: "QA sample fixture — needs more sources",
    });
  }

  const wrongId = wrongSubject[0]?.evidenceId ?? pick(4);
  if (wrongId) {
    decisions.push({
      evidenceId: wrongId,
      status: "WRONG_SUBJECT" as const,
      reviewedBy: "qa-fixture-analyst",
      reviewedAt: new Date().toISOString(),
      reviewerNote: "QA sample fixture — wrong subject",
    });
  }

  const decidedIds = new Set(decisions.map((d) => d.evidenceId));
  for (const item of queueItems) {
    if (decidedIds.has(item.evidenceId)) continue;
    decisions.push({ evidenceId: item.evidenceId, status: "PENDING" as const });
  }

  return {
    version: "r10-5-admin-review-decisions-v1",
    caseId: input.caseId,
    generatedAt: new Date().toISOString(),
    qaSampleOnly: true,
    decisions,
  };
}
