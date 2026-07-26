/**
 * R10.5 / R10.10a — Artifact-backed admin review decision store.
 * Decisions are case-scoped under cases/<safeCaseId>/ to prevent cross-case bleed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
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

/** Sanitize caseId for filesystem use; reject path traversal. */
export function sanitizeCaseIdForPath(caseId: string): string {
  const trimmed = caseId.trim();
  if (!trimmed) throw new Error("invalid-case-id");
  if (trimmed.includes("..") || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("invalid-case-id");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error("invalid-case-id");
  }
  return trimmed;
}

/** Case-scoped artifact directory under the given root. */
export function caseScopedArtifactRoot(root: string, caseId: string): string {
  const safe = sanitizeCaseIdForPath(caseId);
  const resolvedRoot = resolve(root);
  const caseRoot = resolve(join(resolvedRoot, "cases", safe));
  if (!caseRoot.startsWith(resolvedRoot + sep) && caseRoot !== resolvedRoot) {
    throw new Error("invalid-case-id");
  }
  return caseRoot;
}

export function adminReviewDecisionsPath(caseId: string): string {
  return join(caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId), "admin-review-decisions.json");
}

export function adminReviewDecisionsSamplePath(caseId: string): string {
  return join(
    caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId),
    "admin-review-decisions.sample.json"
  );
}

/** Legacy shared path (pre-R10.10a) — used only for one-time read migration. */
function legacySharedDecisionsPath(): string {
  return join(ORION_GOLDEN_QA_STORAGE_ROOT, "admin-review-decisions.json");
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

function readDecisionSetAt(path: string, caseId: string): AdminReviewDecisionSet | null {
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

export function loadAdminReviewDecisions(caseId: string): AdminReviewDecisionSet | null {
  const scoped = readDecisionSetAt(adminReviewDecisionsPath(caseId), caseId);
  if (scoped) return scoped;

  // One-time compatibility: if legacy shared file matches this caseId, use it
  // (do not write until save — avoids cross-case bleed on read of other cases).
  const legacy = readDecisionSetAt(legacySharedDecisionsPath(), caseId);
  if (legacy && legacy.caseId === caseId && (legacy.decisions?.length ?? 0) > 0) {
    return legacy;
  }
  return null;
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
    // Persist into case-scoped path if still only on legacy shared root
    if (!existsSync(adminReviewDecisionsPath(input.caseId))) {
      saveAdminReviewDecisions(input.caseId, existing);
    }
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
