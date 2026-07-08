/**
 * R10.5 — Manual review admin workflow service (artifact-backed).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ORION_GOLDEN_QA_STORAGE_ROOT,
  adminReviewDecisionsPath,
  applyAdminReviewDecision,
  ensureAdminReviewDecisions,
  loadAdminReviewDecisions,
} from "../evidence/admin-review-decision-store";
import { buildAdminReviewSampleFixture } from "../evidence/admin-review-sample-fixture";
import type { AdminReviewDecision, AdminReviewDecisionSet } from "../evidence/admin-review-decision";
import { buildGatedEvidenceBundles, type EvidenceBundlesArtifact } from "../evidence/evidence-client-gate";
import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import type { ManualReviewQueue } from "../evidence/manual-review-queue";
import {
  buildOrionClientContent,
  renderOrionClientContentMarkdown,
  type OrionClientContent,
} from "../content/orion-client-content-builder";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function loadJudgmentsFromArtifact(): EvidenceJudgment[] {
  const path = join(ORION_GOLDEN_QA_STORAGE_ROOT, "evidence-judgment-inspection.json");
  if (!existsSync(path)) throw new Error("evidence-judgment-inspection-missing");
  const data = readJson<{ judgments: EvidenceJudgment[] }>(path);
  return data.judgments;
}

function loadManualQueueFromArtifact(caseId: string): ManualReviewQueue {
  const path = join(ORION_GOLDEN_QA_STORAGE_ROOT, "manual-review-queue.json");
  if (!existsSync(path)) throw new Error("manual-review-queue-missing");
  const data = readJson<ManualReviewQueue>(path);
  if (data.caseId !== caseId) throw new Error("manual-review-queue-case-mismatch");
  return data;
}

function loadBundlesArtifact(caseId: string): EvidenceBundlesArtifact {
  const path = join(ORION_GOLDEN_QA_STORAGE_ROOT, "r10-4-evidence-bundles.json");
  if (!existsSync(path)) throw new Error("evidence-bundles-missing");
  const data = readJson<EvidenceBundlesArtifact>(path);
  if (data.caseId !== caseId) throw new Error("evidence-bundles-case-mismatch");
  return data;
}

export function getManualReviewQueue(caseId: string): ManualReviewQueue {
  return loadManualQueueFromArtifact(caseId);
}

export function getManualReviewItem(caseId: string, evidenceId: string) {
  const queue = getManualReviewQueue(caseId);
  const item = queue.items.find((i) => i.evidenceId === evidenceId);
  if (!item) throw new Error(`manual-review-item-not-found:${evidenceId}`);
  const decisions = loadAdminReviewDecisions(caseId);
  const adminDecision = decisions?.decisions.find((d) => d.evidenceId === evidenceId);
  return { ...item, adminDecision: adminDecision ?? { evidenceId, status: "PENDING" } };
}

export function submitAdminReviewDecision(
  caseId: string,
  evidenceId: string,
  decision: Omit<AdminReviewDecision, "evidenceId">
): AdminReviewDecisionSet {
  return applyAdminReviewDecision(caseId, evidenceId, decision);
}

export function listAdminReviewDecisions(caseId: string): AdminReviewDecisionSet {
  const queue = getManualReviewQueue(caseId);
  const judgments = loadJudgmentsFromArtifact();
  const wrongSubject = judgments.filter((j) => j.subjectBinding === "WRONG_SUBJECT");
  return ensureAdminReviewDecisions({ caseId, manualQueue: queue, wrongSubjectJudgments: wrongSubject });
}

export function regenerateClientContentAfterReview(caseId: string): {
  preReview: OrionClientContent;
  postReview: OrionClientContent;
  preReviewMarkdown: string;
  postReviewMarkdown: string;
} {
  const queue = getManualReviewQueue(caseId);
  const judgments = loadJudgmentsFromArtifact();
  const bundles = loadBundlesArtifact(caseId) as ReturnType<typeof buildGatedEvidenceBundles>;
  const productionDecisions = listAdminReviewDecisions(caseId);
  const sampleDecisions = buildAdminReviewSampleFixture({ caseId, manualQueue: queue, judgments });

  const subjectPath = join(ORION_GOLDEN_QA_STORAGE_ROOT, "full-evidence-inventory.json");
  const inventory = readJson<{ subject: { fullName: string; aliases: string[] }; reportRunId: string }>(subjectPath);

  const preReview = buildOrionClientContent({
    mode: "pre_review",
    caseId,
    reportRunId: bundles.reportRunId,
    subject: { fullName: inventory.subject.fullName, aliases: inventory.subject.aliases },
    bundles,
    manualQueue: queue,
    judgments,
  });

  const postReview = buildOrionClientContent({
    mode: "post_review",
    caseId,
    reportRunId: bundles.reportRunId,
    subject: { fullName: inventory.subject.fullName, aliases: inventory.subject.aliases },
    bundles,
    manualQueue: queue,
    judgments,
    adminDecisions: sampleDecisions.decisions,
  });

  return {
    preReview,
    postReview,
    preReviewMarkdown: renderOrionClientContentMarkdown(preReview),
    postReviewMarkdown: renderOrionClientContentMarkdown(postReview),
  };
}

export function persistRegeneratedClientContent(caseId: string): void {
  const { preReview, postReview, preReviewMarkdown, postReviewMarkdown } =
    regenerateClientContentAfterReview(caseId);
  const root = ORION_GOLDEN_QA_STORAGE_ROOT;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "orion-client-content.pre-review.json"), `${JSON.stringify(preReview, null, 2)}\n`, "utf-8");
  writeFileSync(join(root, "orion-client-content.post-review.json"), `${JSON.stringify(postReview, null, 2)}\n`, "utf-8");
  writeFileSync(join(root, "orion-client-content.pre-review.md"), preReviewMarkdown, "utf-8");
  writeFileSync(join(root, "orion-client-content.post-review.md"), postReviewMarkdown, "utf-8");
}

export { adminReviewDecisionsPath, ORION_GOLDEN_QA_STORAGE_ROOT };
