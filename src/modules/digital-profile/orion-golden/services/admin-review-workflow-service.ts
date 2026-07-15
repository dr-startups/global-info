/**
 * R10.5 / R10.8b — Manual review admin workflow service.
 * Persistence via AdminReviewDecisionRepository (artifact default; DB deferred).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ORION_GOLDEN_QA_STORAGE_ROOT,
  adminReviewDecisionsPath,
  caseScopedArtifactRoot,
  ensureAdminReviewDecisions,
  loadAdminReviewDecisions,
} from "../evidence/admin-review-decision-store";
import type { AdminReviewDecision, AdminReviewDecisionSet } from "../evidence/admin-review-decision";
import { recordToLegacyDecision } from "../evidence/admin-review-decision-record";
import { getAdminReviewDecisionRepository } from "../evidence/admin-review-decision-repository-factory";
import { resolveAdminReviewDecisionStoreMode } from "../evidence/admin-review-decision-store-config";
import { buildGatedEvidenceBundles, type EvidenceBundlesArtifact } from "../evidence/evidence-client-gate";
import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import type { ManualReviewQueue } from "../evidence/manual-review-queue";
import {
  buildOrionClientContent,
  assembleOrionClientContentFromSections,
  renderOrionClientContentMarkdown,
  type OrionClientContent,
} from "../content/orion-client-content-builder";
import { countAdminDecisionsByStatus } from "../evidence/admin-review-decision";
import { applyAdminDecisionsToJudgments } from "../evidence/apply-admin-decisions-to-judgments";
import { runGptAutoAnalystDecisions, shouldUseGptAutoAnalyst } from "../evidence/gpt-auto-analyst";
import { buildOrionSectionBundles } from "../sections/orion-section-bundle-builder";
import { buildRiskMatrixFromSections } from "../sections/orion-risk-matrix-from-sections";
import {
  hasSectionBasedClientArtifacts,
  loadExecutiveSynthesisFromRoot,
  loadOrionSectionAnalysesFromRoot,
  loadSectionDerivedRiskMatrixFromRoot,
} from "../sections/orion-section-analysis-loader";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import { digitalProfileConfig } from "../../config";
import {
  loadArsenkinReportBinding,
  resolveEffectiveReportRunIdForCase,
} from "../classic/arsenkin-report-binding";
import { rebuildClientContentForReportRun } from "../rebuild-client-content-for-report-run";

function artifactRootsForCase(caseId: string): string[] {
  // Prefer case-scoped artifacts (UI prepare / multi-case), then shared root, then calibration.
  const roots = [
    caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId),
    ORION_GOLDEN_QA_STORAGE_ROOT,
  ];
  if (caseId === "cmqzz1vbr00d2vdrsrjsgie2g") {
    roots.unshift(
      join(process.cwd(), "storage", "digital-profile", "qa-r10-7-real-subject-calibration")
    );
  }
  return roots;
}

function resolveArtifactFile(caseId: string, fileName: string): string {
  for (const root of artifactRootsForCase(caseId)) {
    const path = join(root, fileName);
    if (existsSync(path)) return path;
  }
  return join(ORION_GOLDEN_QA_STORAGE_ROOT, fileName);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function loadJudgmentsFromArtifact(caseId: string): EvidenceJudgment[] {
  const path = resolveArtifactFile(caseId, "evidence-judgment-inspection.json");
  if (!existsSync(path)) throw new Error("evidence-judgment-inspection-missing");
  const data = readJson<{ judgments: EvidenceJudgment[] }>(path);
  return data.judgments;
}

function loadManualQueueFromArtifact(caseId: string): ManualReviewQueue {
  const path = resolveArtifactFile(caseId, "manual-review-queue.json");
  if (!existsSync(path)) throw new Error("manual-review-queue-missing");
  const data = readJson<ManualReviewQueue>(path);
  if (data.caseId !== caseId) throw new Error("manual-review-queue-case-mismatch");
  return data;
}

function loadBundlesArtifact(caseId: string): EvidenceBundlesArtifact {
  const path = resolveArtifactFile(caseId, "r10-4-evidence-bundles.json");
  if (!existsSync(path)) throw new Error("evidence-bundles-missing");
  const data = readJson<EvidenceBundlesArtifact>(path);
  if (data.caseId !== caseId) throw new Error("evidence-bundles-case-mismatch");
  return data;
}

export function getManualReviewQueue(caseId: string): ManualReviewQueue & {
  statusCounts: Record<string, number>;
  items: Array<
    ManualReviewQueue["items"][number] & {
      sourceReliability?: string;
      subjectBindingScore?: number;
    }
  >;
} {
  const queue = loadManualQueueFromArtifact(caseId);
  const decisions = loadAdminReviewDecisions(caseId);
  const decisionById = new Map((decisions?.decisions ?? []).map((d) => [d.evidenceId, d]));
  let judgmentById = new Map<string, EvidenceJudgment>();
  try {
    judgmentById = new Map(loadJudgmentsFromArtifact(caseId).map((j) => [j.evidenceId, j]));
  } catch {
    // optional
  }

  const statusCounts: Record<string, number> = {
    PENDING: 0,
    APPROVED: 0,
    APPROVED_WITH_CAVEAT: 0,
    APPENDIX_ONLY: 0,
    EXCLUDED: 0,
    NEEDS_MORE_SOURCES: 0,
    WRONG_SUBJECT: 0,
  };

  const items = queue.items.map((item) => {
    const decision = decisionById.get(item.evidenceId);
    const status = decision?.status ?? item.adminReviewStatus ?? "PENDING";
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    const j = judgmentById.get(item.evidenceId);
    return {
      ...item,
      adminReviewStatus: status,
      sourceReliability: j?.sourceReliability,
      subjectBindingScore: j?.subjectBindingScore,
    };
  });

  // Count WRONG_SUBJECT decisions that may not be in manual queue
  for (const d of decisions?.decisions ?? []) {
    if (d.status === "WRONG_SUBJECT" && !queue.items.some((i) => i.evidenceId === d.evidenceId)) {
      statusCounts.WRONG_SUBJECT = (statusCounts.WRONG_SUBJECT ?? 0) + 1;
    }
  }

  return {
    ...queue,
    items,
    pendingCount: statusCounts.PENDING ?? queue.pendingCount,
    statusCounts,
  };
}

export function getManualReviewItem(caseId: string, evidenceId: string) {
  const queue = getManualReviewQueue(caseId);
  const item = queue.items.find((i) => i.evidenceId === evidenceId);
  if (!item) throw new Error(`manual-review-item-not-found:${evidenceId}`);
  const decisions = loadAdminReviewDecisions(caseId);
  const adminDecision = decisions?.decisions.find((d) => d.evidenceId === evidenceId);
  let judgmentExtras: {
    sourceReliability?: string;
    subjectBindingScore?: number;
    subjectBindingExplanation?: string;
    subjectBindingPositiveSignals?: string[];
    subjectBindingNegativeSignals?: string[];
    contentNature?: string;
    clientSafeSummary?: string;
  } = {};
  try {
    const judgments = loadJudgmentsFromArtifact(caseId);
    const j = judgments.find((x) => x.evidenceId === evidenceId);
    if (j) {
      judgmentExtras = {
        sourceReliability: j.sourceReliability,
        subjectBindingScore: j.subjectBindingScore,
        subjectBindingExplanation: j.subjectBindingExplanation,
        subjectBindingPositiveSignals: j.subjectBindingPositiveSignals,
        subjectBindingNegativeSignals: j.subjectBindingNegativeSignals,
        contentNature: j.contentNature,
        clientSafeSummary: j.clientSafeSummary,
      };
    }
  } catch {
    // judgments artifact optional for detail enrichment
  }
  return {
    ...item,
    ...judgmentExtras,
    adminDecision: adminDecision ?? { evidenceId, status: "PENDING" as const },
    decisionStoreMode: resolveAdminReviewDecisionStoreMode(),
  };
}

/**
 * Submit via repository abstraction (artifact default).
 * Preserves history; does not silently overwrite prior versions.
 */
export async function submitAdminReviewDecision(
  caseId: string,
  evidenceId: string,
  decision: Omit<AdminReviewDecision, "evidenceId">
): Promise<AdminReviewDecisionSet> {
  const repo = getAdminReviewDecisionRepository();
  await repo.saveDecision(caseId, evidenceId, {
    status: decision.status,
    reviewerNote: decision.reviewerNote,
    approvedClientSummary: decision.approvedClientSummary,
    caveatText: decision.caveatText,
    requestedSources: decision.requestedSources,
    reviewedBy: decision.reviewedBy,
    reviewedAt: decision.reviewedAt,
    source: "admin_ui",
  });
  const active = await repo.listDecisions(caseId);
  const existing = loadAdminReviewDecisions(caseId);
  return {
    version: "r10-5-admin-review-decisions-v1",
    caseId,
    generatedAt: existing?.generatedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    qaSampleOnly: false,
    decisions: active.map(recordToLegacyDecision),
  };
}

export async function listAdminReviewDecisionHistory(caseId: string, evidenceId: string) {
  const repo = getAdminReviewDecisionRepository();
  return repo.listDecisionHistory(caseId, evidenceId);
}

export async function getActiveAdminReviewDecision(caseId: string, evidenceId: string) {
  const repo = getAdminReviewDecisionRepository();
  return repo.getActiveDecision(caseId, evidenceId);
}

export function listAdminReviewDecisions(caseId: string): AdminReviewDecisionSet {
  const queue = getManualReviewQueue(caseId);
  const judgments = loadJudgmentsFromArtifact(caseId);
  const wrongSubject = judgments.filter((j) => j.subjectBinding === "WRONG_SUBJECT");
  return ensureAdminReviewDecisions({ caseId, manualQueue: queue, wrongSubjectJudgments: wrongSubject });
}

export function regenerateClientContentAfterReview(caseId: string): {
  preReview: OrionClientContent;
  postReview: OrionClientContent;
  preReviewMarkdown: string;
  postReviewMarkdown: string;
  artifactRoot: string;
  generatedAt: string;
} {
  const artifactRoot = resolveArtifactFile(caseId, "manual-review-queue.json");
  const artifactRootDir = join(artifactRoot, "..");
  const queue = getManualReviewQueue(caseId);
  const judgments = loadJudgmentsFromArtifact(caseId);
  const generatedAt = new Date().toISOString();

  const subjectPath = resolveArtifactFile(caseId, "full-evidence-inventory.json");
  const inventory = readJson<{ subject: { fullName: string; aliases: string[] }; reportRunId: string }>(subjectPath);
  const { reportRunId } = resolveEffectiveReportRunIdForCase(caseId, inventory.reportRunId);

  if (hasSectionBasedClientArtifacts(artifactRootDir)) {
    return regenerateSectionBasedClientContent({
      caseId,
      artifactRootDir,
      queue,
      judgments,
      inventory,
      reportRunId,
      generatedAt,
    });
  }

  const bundles = loadBundlesArtifact(caseId) as ReturnType<typeof buildGatedEvidenceBundles>;
  const productionDecisions = listAdminReviewDecisions(caseId);

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
    adminDecisions: productionDecisions.decisions,
  });

  return {
    preReview,
    postReview,
    preReviewMarkdown: renderOrionClientContentMarkdown(preReview),
    postReviewMarkdown: renderOrionClientContentMarkdown(postReview),
    artifactRoot: caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId),
    generatedAt,
  };
}

async function regenerateSectionBasedClientContentAsync(input: {
  caseId: string;
  artifactRootDir: string;
  queue: ReturnType<typeof getManualReviewQueue>;
  judgments: EvidenceJudgment[];
  inventory: { subject: { fullName: string; aliases: string[] }; reportRunId: string };
  reportRunId: string;
  generatedAt: string;
}): Promise<{
  preReview: OrionClientContent;
  postReview: OrionClientContent;
  preReviewMarkdown: string;
  postReviewMarkdown: string;
  artifactRoot: string;
  generatedAt: string;
}> {
  let productionDecisions = listAdminReviewDecisions(input.caseId);
  const pendingCount = productionDecisions.decisions.filter((d) => d.status === "PENDING").length;
  if (shouldUseGptAutoAnalyst() && pendingCount > 0) {
    const auto = await runGptAutoAnalystDecisions({
      caseId: input.caseId,
      judgments: input.judgments,
      manualQueue: input.queue,
      subject: { fullName: input.inventory.subject.fullName, aliases: input.inventory.subject.aliases },
      existingDecisionSet: productionDecisions,
    });
    productionDecisions = auto.decisionSet;
    writeFileSync(
      join(input.artifactRootDir, "gpt-auto-analyst-decisions.json"),
      `${JSON.stringify(auto.report, null, 2)}\n`,
      "utf-8"
    );
  }

  return buildSectionBasedClientContent({ ...input, productionDecisions });
}

function buildSectionBasedClientContent(input: {
  caseId: string;
  artifactRootDir: string;
  queue: ReturnType<typeof getManualReviewQueue>;
  judgments: EvidenceJudgment[];
  inventory: { subject: { fullName: string; aliases: string[] }; reportRunId: string };
  reportRunId: string;
  generatedAt: string;
  productionDecisions: AdminReviewDecisionSet;
}): {
  preReview: OrionClientContent;
  postReview: OrionClientContent;
  preReviewMarkdown: string;
  postReviewMarkdown: string;
  artifactRoot: string;
  generatedAt: string;
} {
  const sectionAnalyses = loadOrionSectionAnalysesFromRoot(input.artifactRootDir);
  const executiveSynthesis = loadExecutiveSynthesisFromRoot(input.artifactRootDir);
  const riskMatrix =
    loadSectionDerivedRiskMatrixFromRoot(input.artifactRootDir) ??
    buildRiskMatrixFromSections({
      caseId: input.caseId,
      sectionAnalyses,
      sectionBundles: [],
    });

  if (!executiveSynthesis || sectionAnalyses.length === 0) {
    throw new Error("section-based-client-artifacts-incomplete");
  }

  const subject = {
    fullName: input.inventory.subject.fullName,
    aliases: input.inventory.subject.aliases,
  };

  const preReview = assembleOrionClientContentFromSections({
    mode: "pre_review",
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    subject,
    sectionAnalyses,
    executiveSynthesis,
    riskMatrix,
    manualQueue: input.queue,
    adminDecisionSummary: countAdminDecisionsByStatus(input.productionDecisions.decisions),
    judgments: input.judgments,
  });

  const applied = applyAdminDecisionsToJudgments(
    input.judgments,
    input.productionDecisions.decisions
  ).judgments;

  const fullInventoryPath = join(input.artifactRootDir, "full-evidence-inventory.json");
  const fullInventory = existsSync(fullInventoryPath)
    ? readJson<FullEvidenceInventory>(fullInventoryPath)
    : null;

  const sectionBundlesPost = fullInventory
    ? buildOrionSectionBundles({
        caseInfo: {
          caseId: input.caseId,
          reportRunId: input.reportRunId,
          subjectName: subject.fullName,
          aliases: subject.aliases,
        },
        inventory: fullInventory,
        judgments: applied,
        manualQueue: input.queue,
        adminDecisions: input.productionDecisions.decisions,
        regionSettings: { ruEnabled: true, uaeEnabled: true },
      })
    : [];

  const postReview = assembleOrionClientContentFromSections({
    mode: "post_review",
    caseId: input.caseId,
    reportRunId: input.reportRunId,
    subject,
    sectionAnalyses,
    executiveSynthesis,
    riskMatrix: buildRiskMatrixFromSections({
      caseId: input.caseId,
      sectionAnalyses,
      sectionBundles: sectionBundlesPost,
    }),
    manualQueue: input.queue,
    adminDecisionSummary: countAdminDecisionsByStatus(input.productionDecisions.decisions),
    judgments: applied,
  });

  return {
    preReview,
    postReview,
    preReviewMarkdown: renderOrionClientContentMarkdown(preReview),
    postReviewMarkdown: renderOrionClientContentMarkdown(postReview),
    artifactRoot: input.artifactRootDir,
    generatedAt: input.generatedAt,
  };
}

function regenerateSectionBasedClientContent(input: {
  caseId: string;
  artifactRootDir: string;
  queue: ReturnType<typeof getManualReviewQueue>;
  judgments: EvidenceJudgment[];
  inventory: { subject: { fullName: string; aliases: string[] }; reportRunId: string };
  reportRunId: string;
  generatedAt: string;
}): {
  preReview: OrionClientContent;
  postReview: OrionClientContent;
  preReviewMarkdown: string;
  postReviewMarkdown: string;
  artifactRoot: string;
  generatedAt: string;
} {
  // Sync wrapper: auto-analyst requires async GPT — use deasync pattern via spawnSync alternative.
  // For regenerate API we block on a minimal sync path when auto-analyst is off.
  let productionDecisions = listAdminReviewDecisions(input.caseId);
  const pendingCount = productionDecisions.decisions.filter((d) => d.status === "PENDING").length;

  if (shouldUseGptAutoAnalyst() && pendingCount > 0) {
    throw new Error(
      "gpt-auto-analyst-regenerate-requires-async: re-run ORION Golden prepare with ORION_GPT_AUTO_ANALYST=1"
    );
  }

  return buildSectionBasedClientContent({
    ...input,
    productionDecisions,
  });
}

export async function regenerateClientContentAfterReviewAsync(caseId: string): Promise<{
  preReview: OrionClientContent;
  postReview: OrionClientContent;
  preReviewMarkdown: string;
  postReviewMarkdown: string;
  artifactRoot: string;
  generatedAt: string;
}> {
  const artifactRootDir = join(resolveArtifactFile(caseId, "manual-review-queue.json"), "..");
  const queue = getManualReviewQueue(caseId);
  const judgments = loadJudgmentsFromArtifact(caseId);
  const generatedAt = new Date().toISOString();
  const inventory = readJson<{ subject: { fullName: string; aliases: string[] }; reportRunId: string }>(
    resolveArtifactFile(caseId, "full-evidence-inventory.json")
  );
  const { reportRunId } = resolveEffectiveReportRunIdForCase(caseId, inventory.reportRunId);

  if (!hasSectionBasedClientArtifacts(artifactRootDir)) {
    return regenerateClientContentAfterReview(caseId);
  }

  return regenerateSectionBasedClientContentAsync({
    caseId,
    artifactRootDir,
    queue,
    judgments,
    inventory,
    reportRunId,
    generatedAt,
  });
}

export function isGptAutoAnalystModeEnabled(): boolean {
  return shouldUseGptAutoAnalyst() || digitalProfileConfig.orionGptAutoAnalyst;
}

export function persistRegeneratedClientContent(caseId: string): {
  artifactRoot: string;
  generatedAt: string;
  preReviewApprovedCount: number;
  postReviewApprovedCount: number;
} {
  const { preReview, postReview, preReviewMarkdown, postReviewMarkdown, artifactRoot, generatedAt } =
    regenerateClientContentAfterReview(caseId);
  const root = artifactRoot;
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "orion-client-content.pre-review.json"), `${JSON.stringify(preReview, null, 2)}\n`, "utf-8");
  writeFileSync(join(root, "orion-client-content.post-review.json"), `${JSON.stringify(postReview, null, 2)}\n`, "utf-8");
  writeFileSync(join(root, "orion-client-content.pre-review.md"), preReviewMarkdown, "utf-8");
  writeFileSync(join(root, "orion-client-content.post-review.md"), postReviewMarkdown, "utf-8");
  return {
    artifactRoot: root,
    generatedAt,
    preReviewApprovedCount: preReview.approvedFindings.length,
    postReviewApprovedCount: postReview.approvedFindings.length,
  };
}

export async function persistRegeneratedClientContentAsync(caseId: string): Promise<{
  artifactRoot: string;
  generatedAt: string;
  preReviewApprovedCount: number;
  postReviewApprovedCount: number;
}> {
  const binding = loadArsenkinReportBinding(caseId);
  const root = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);

  // After Arsenkin transfer: honest rebuild for effective Arsenkin run (never fall back to source).
  if (
    binding &&
    (binding.status === "TRANSFERRED" || binding.status === "REPORT_BOUND") &&
    binding.effectiveReportRunId
  ) {
    mkdirSync(root, { recursive: true });
    await rebuildClientContentForReportRun(caseId, binding.effectiveReportRunId, root, {
      requireAi: false,
      sourceReportRunId: binding.sourceReportRunId,
    });

    const existing = loadAdminReviewDecisions(caseId);
    if (existing && !existing.qaSampleOnly) {
      const preserved = existing.decisions.filter((d) => d.status !== "PENDING");
      const queuePath = join(root, "manual-review-queue.json");
      const queue = existsSync(queuePath)
        ? (JSON.parse(readFileSync(queuePath, "utf-8")) as {
            items?: Array<{ evidenceId?: string; id?: string }>;
          })
        : null;
      const evidenceIds = new Set(
        (queue?.items ?? [])
          .map((i) => i.evidenceId ?? i.id)
          .filter((x): x is string => Boolean(x))
      );
      const reapplied = preserved.filter(
        (d) => evidenceIds.size === 0 || evidenceIds.has(d.evidenceId)
      );
      writeFileSync(
        join(root, "admin-review-decisions.json"),
        `${JSON.stringify(
          {
            ...existing,
            updatedAt: new Date().toISOString(),
            decisions: reapplied,
          },
          null,
          2
        )}\n`,
        "utf-8"
      );
    }

    writeFileSync(
      join(root, "client-content-binding.json"),
      `${JSON.stringify(
        {
          sourceReportRunId: binding.sourceReportRunId,
          effectiveReportRunId: binding.effectiveReportRunId,
          overridden: false,
          rebuilt: true,
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    const post = JSON.parse(
      readFileSync(join(root, "orion-client-content.post-review.json"), "utf-8")
    ) as OrionClientContent;
    const pre = existsSync(join(root, "orion-client-content.pre-review.json"))
      ? (JSON.parse(
          readFileSync(join(root, "orion-client-content.pre-review.json"), "utf-8")
        ) as OrionClientContent)
      : post;
    if (post.reportRunId !== binding.effectiveReportRunId) {
      throw new Error(
        `ARSENKIN_CLIENT_CONTENT_RUN_MISMATCH: post.reportRunId=${post.reportRunId} expected=${binding.effectiveReportRunId}`
      );
    }
    return {
      artifactRoot: root,
      generatedAt: new Date().toISOString(),
      preReviewApprovedCount: pre.approvedFindings?.length ?? 0,
      postReviewApprovedCount: post.approvedFindings?.length ?? 0,
    };
  }

  const { preReview, postReview, preReviewMarkdown, postReviewMarkdown, artifactRoot, generatedAt } =
    await regenerateClientContentAfterReviewAsync(caseId);
  mkdirSync(artifactRoot, { recursive: true });
  writeFileSync(join(artifactRoot, "orion-client-content.pre-review.json"), `${JSON.stringify(preReview, null, 2)}\n`, "utf-8");
  writeFileSync(join(artifactRoot, "orion-client-content.post-review.json"), `${JSON.stringify(postReview, null, 2)}\n`, "utf-8");
  writeFileSync(join(artifactRoot, "orion-client-content.pre-review.md"), preReviewMarkdown, "utf-8");
  writeFileSync(join(artifactRoot, "orion-client-content.post-review.md"), postReviewMarkdown, "utf-8");
  return {
    artifactRoot,
    generatedAt,
    preReviewApprovedCount: preReview.approvedFindings.length,
    postReviewApprovedCount: postReview.approvedFindings.length,
  };
}

export { adminReviewDecisionsPath, ORION_GOLDEN_QA_STORAGE_ROOT };
export { resolveAdminReviewDecisionStoreMode } from "../evidence/admin-review-decision-store-config";
export {
  getAdminReviewDecisionRepository,
  createAdminReviewDecisionRepository,
} from "../evidence/admin-review-decision-repository-factory";
