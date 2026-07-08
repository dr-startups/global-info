/**
 * R10.5 — Artifact-backed admin review decision store.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ManualReviewQueue } from "./manual-review-queue";
import type { EvidenceJudgment } from "./evidence-judgment";
import {
  type AdminReviewDecision,
  type AdminReviewDecisionSet,
  type AdminReviewStatus,
} from "./admin-review-decision";

export const ORION_GOLDEN_QA_STORAGE_ROOT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-r10-orion-golden-parallel"
);

export function adminReviewDecisionsPath(_caseId: string): string {
  return join(ORION_GOLDEN_QA_STORAGE_ROOT, "admin-review-decisions.json");
}

export function adminReviewDecisionsSamplePath(_caseId: string): string {
  return join(ORION_GOLDEN_QA_STORAGE_ROOT, "admin-review-decisions.sample.json");
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export function buildPendingDecisionSet(input: {
  caseId: string;
  manualQueue: ManualReviewQueue;
  wrongSubjectJudgments?: EvidenceJudgment[];
}): AdminReviewDecisionSet {
  const pendingFromQueue: AdminReviewDecision[] = input.manualQueue.items.map((item) => ({
    evidenceId: item.evidenceId,
    status: "PENDING" as AdminReviewStatus,
  }));

  const wrongSubjectIds = new Set(pendingFromQueue.map((d) => d.evidenceId));
  for (const j of input.wrongSubjectJudgments ?? []) {
    if (wrongSubjectIds.has(j.evidenceId)) continue;
    pendingFromQueue.push({ evidenceId: j.evidenceId, status: "PENDING" });
  }

  return {
    version: "r10-5-admin-review-decisions-v1",
    caseId: input.caseId,
    generatedAt: new Date().toISOString(),
    decisions: pendingFromQueue,
  };
}

export function loadAdminReviewDecisions(caseId: string): AdminReviewDecisionSet | null {
  const path = adminReviewDecisionsPath(caseId);
  if (!existsSync(path)) return null;

  const raw = JSON.parse(readFileSync(path, "utf-8")) as AdminReviewDecisionSet;
  if (raw.caseId !== caseId) {
    return {
      version: "r10-5-admin-review-decisions-v1",
      caseId,
      generatedAt: new Date().toISOString(),
      decisions: [],
    };
  }
  return raw;
}

export function saveAdminReviewDecisions(caseId: string, decisionSet: AdminReviewDecisionSet): void {
  if (decisionSet.caseId !== caseId) {
    throw new Error(`admin-review-decision-case-mismatch:${decisionSet.caseId}!=${caseId}`);
  }
  const path = adminReviewDecisionsPath(caseId);
  writeJsonAtomic(path, {
    ...decisionSet,
    version: "r10-5-admin-review-decisions-v1",
    updatedAt: new Date().toISOString(),
    qaSampleOnly: false,
  });
}

export function ensureAdminReviewDecisions(input: {
  caseId: string;
  manualQueue: ManualReviewQueue;
  wrongSubjectJudgments?: EvidenceJudgment[];
}): AdminReviewDecisionSet {
  const existing = loadAdminReviewDecisions(input.caseId);
  if (existing && existing.decisions.length > 0 && !existing.qaSampleOnly) {
    return existing;
  }

  const pending = buildPendingDecisionSet(input);
  saveAdminReviewDecisions(input.caseId, pending);
  return pending;
}

export function applyAdminReviewDecision(
  caseId: string,
  evidenceId: string,
  decision: Omit<AdminReviewDecision, "evidenceId">
): AdminReviewDecisionSet {
  const current =
    loadAdminReviewDecisions(caseId) ??
    ({
      version: "r10-5-admin-review-decisions-v1",
      caseId,
      generatedAt: new Date().toISOString(),
      decisions: [],
    } satisfies AdminReviewDecisionSet);

  const nextDecision: AdminReviewDecision = {
    evidenceId,
    ...decision,
    reviewedAt: decision.reviewedAt ?? new Date().toISOString(),
  };

  const idx = current.decisions.findIndex((d) => d.evidenceId === evidenceId);
  const decisions =
    idx >= 0
      ? current.decisions.map((d, i) => (i === idx ? { ...d, ...nextDecision } : d))
      : [...current.decisions, nextDecision];

  const updated: AdminReviewDecisionSet = {
    ...current,
    caseId,
    decisions,
    qaSampleOnly: false,
  };
  saveAdminReviewDecisions(caseId, updated);
  return updated;
}

export function saveAdminReviewSampleFixture(decisionSet: AdminReviewDecisionSet): void {
  const path = adminReviewDecisionsSamplePath(decisionSet.caseId);
  writeJsonAtomic(path, {
    ...decisionSet,
    qaSampleOnly: true,
    _notice: "QA sample fixture only — not real admin approval",
  });
}
