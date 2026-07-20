/**
 * Arsenkin UI orchestration — split from arsenkin-ui-orchestration-service.ts
 * (REMEDIATION §9.5) — mechanical move only.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "@/server/prisma/client";
import {
  createProductionCanonicalStageDeps,
  executeCanonicalArsenkinStage,
  type CanonicalStageCommand,
  type CanonicalStageDeps,
  type CanonicalStageResult,
} from "../../orion-golden/classic/execute-canonical-arsenkin-stage";
import type { ArsenkinLiveStage } from "../../orion-golden/classic/arsenkin-execution-plan";
import {
  workflowForStage,
  workflowFromRunMetadata,
  type ArsenkinWorkflow,
} from "../../orion-golden/classic/arsenkin-stage-ledger";
import {
  caseScopedArtifactRoot,
  loadAdminReviewDecisions,
  ORION_GOLDEN_QA_STORAGE_ROOT,
} from "../../orion-golden/evidence/admin-review-decision-store";
import type { AdminReviewDecisionSet } from "../../orion-golden/evidence/admin-review-decision";
import { markUnifiedReportArtifactsStale } from "../unified-report-staleness";
import {
  loadArsenkinReportBinding,
  saveArsenkinReportBinding,
  inspectArsenkinTransferContentGate,
  toCompositeBindingModel,
  type ArsenkinReportBinding,
  type ArsenkinTransferStatus,
} from "../../orion-golden/classic/arsenkin-report-binding";
import {
  assertDbMutationAllowed,
  computeSchemaContentHash,
  computeSourceTreeHash,
  fingerprintDatabaseUrl,
  resolveBuildIdentity,
  validateDbReadinessArtifact,
  writeJsonAtomic,
  type ArsenkinDbReadinessArtifact,
} from "../../providers/arsenkin/arsenkin-db-readiness";
import {
  ensureArsenkinDbReadiness,
  refreshArsenkinDbReadiness,
  type EnsureArsenkinDbReadinessResult,
} from "../../providers/arsenkin/arsenkin-db-readiness-runner";
import {
  getDefaultReadinessArtifactPath,
  humanizeReadinessCode,
  mapReadinessBlockersToCode,
  type ArsenkinReadinessCode,
} from "../../providers/arsenkin/arsenkin-db-readiness-service";
import { isArsenkinConfigured, isArsenkinEnabled } from "../../providers/arsenkin/flags";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../../providers/arsenkin/network-guard";
import { toSubmitUnknownCandidate } from "../../providers/arsenkin/submit-unknown-recovery";
import { getArsenkinFullAuditStatus, scheduleOrchestrationTick } from "../../providers/arsenkin/full-audit-orchestrator";
import { isActiveOrchestrationState } from "../../providers/arsenkin/full-audit-job-store";
import {
  FIRST36_FULL_EXPECTED_SURFACES,
  isTerminalSurfaceStatus,
  SUGGEST_CANARY_EXPECTED_SURFACES,
} from "../../providers/arsenkin/workflow-contract";
import {
  isArsenkinProviderRunId,
  isValidBaseOrionReportRunId,
  resolveCanonicalBaseOrionReportRunId,
  repairFirst36FullSourceBinding,
  needsSourceBindingRepair,
} from "../../providers/arsenkin/source-binding-repair";
import { ConflictError, ValidationError } from "../../http/errors";

import type { ArsenkinUiOrchestrationDeps, ArsenkinUiStage, ArsenkinUiStatusDto } from "./types";
import {
  DEFAULT_DB_READINESS,
  arsenkinCanaryOutRoot,
  arsenkinOrionCaseRoot,
  ensureBindingArtifacts,
  productionDeps,
  readJson,
  resolveDbReadinessGate,
  resolveMappedArsenkinReportRunId,
} from "./shared";
import { getArsenkinUiStatus } from "./poll";

export async function syncArsenkinResultsToOrion(input: {
  caseId: string;
  reportRunId: string;
  stage: ArsenkinUiStage;
  deps?: ArsenkinUiOrchestrationDeps;
}): Promise<ArsenkinUiStatusDto & { orphanedEvidenceIds: string[] }> {
  const prisma = input.deps?.prisma ?? defaultPrisma;
  const rebuild = input.deps?.rebuild ?? null;
  resetArsenkinNetworkCallCount();

  const workflow = workflowForStage(input.stage);
  const { mapping, arsenkinReportRunId } = resolveMappedArsenkinReportRunId({
    caseId: input.caseId,
    workflow,
    clientReportRunId: input.reportRunId,
    requireMapping: true,
  });
  if (!arsenkinReportRunId || !mapping) {
    throw new ConflictError("Arsenkin reportRunId mapping отсутствует");
  }

  const run = await prisma.orionReportRun.findUnique({ where: { id: arsenkinReportRunId } });
  if (!run || run.caseId !== input.caseId) {
    throw new ConflictError("Arsenkin reportRunId не принадлежит кейсу");
  }

  const stageRow = await prisma.orionArsenkinStageRun.findFirst({
    where: { reportRunId: arsenkinReportRunId, stage: input.stage },
  });
  if (!stageRow || stageRow.status !== "DONE") {
    throw new ConflictError("Sync доступен только после STAGE_DONE");
  }

  if (workflow === "first36-full") {
    const stages = await prisma.orionArsenkinStageRun.findMany({
      where: { reportRunId: arsenkinReportRunId },
    });
    const s1 = stages.find((s) => s.stage === "FIRST36_STAGE1");
    const s2 = stages.find((s) => s.stage === "FIRST36_STAGE2");
    if (input.stage === "FIRST36_STAGE2" || (s1?.status === "DONE" && s2?.status === "DONE")) {
      if (s1?.status !== "DONE" || s2?.status !== "DONE") {
        if (input.stage === "FIRST36_STAGE2" && s2?.status !== "DONE") {
          throw new ConflictError("Полный First36 sync требует обе стадии DONE");
        }
      }
    }
  }

  const obs = await prisma.serpObservation.findMany({
    where: { auditRunId: arsenkinReportRunId, provider: "arsenkin" },
    select: { id: true, providerTaskId: true, surface: true, engine: true, region: true },
  });
  if (obs.length === 0) throw new ConflictError("Нет Arsenkin observations для sync");
  if (obs.some((o) => !o.providerTaskId)) {
    throw new ConflictError("Наблюдения без providerTaskId — sync заблокирован");
  }

  if (input.stage === "SUGGEST_RU_CANARY") {
    const ok = obs.every(
      (o) => o.surface === "autocomplete" && o.region === "RU" && (o.engine === "YANDEX" || o.engine === "GOOGLE")
    );
    if (!ok) {
      const has = obs.some((o) => o.region === "RU" && (o.surface === "autocomplete" || o.surface === "organic"));
      if (!has) throw new ConflictError("Canary sync ожидает RU suggest observations");
    }
  }

  const [providerTaskCount, coverageCount] = await Promise.all([
    prisma.providerTask.count({ where: { reportRunId: arsenkinReportRunId, provider: "arsenkin" } }),
    prisma.surfaceCollectionCoverage.count({
      where: { reportRunId: arsenkinReportRunId, provider: "arsenkin" },
    }),
  ]);

  const existingBinding = loadArsenkinReportBinding(input.caseId);
  const caseRoot = arsenkinOrionCaseRoot(input.caseId);
  const postReviewPath = join(caseRoot, "orion-client-content.post-review.json");

  // Idempotent replay: same effective run already transferred with matching client content.
  if (
    existingBinding &&
    (existingBinding.status === "TRANSFERRED" || existingBinding.status === "REPORT_BOUND") &&
    existingBinding.effectiveReportRunId === arsenkinReportRunId &&
    existsSync(postReviewPath)
  ) {
    const post = readJson<{ reportRunId?: string; caseId?: string }>(postReviewPath);
    if (post?.reportRunId === arsenkinReportRunId && post?.caseId === input.caseId) {
      if (getArsenkinNetworkCallCount() !== 0) {
        throw new ConflictError("sync leaked network calls");
      }
      const status = await getArsenkinUiStatus(
        input.caseId,
        input.reportRunId,
        input.stage,
        input.deps
      );
      return { ...status, status: "TRANSFERRED", synced: true, orphanedEvidenceIds: [] };
    }
  }

  const existing = loadAdminReviewDecisions(input.caseId);
  if (existing?.qaSampleOnly) {
    throw new ConflictError("QA sample decisions cannot sync to production");
  }
  const preserved = (existing?.decisions ?? []).filter((d) => d.status !== "PENDING");

  saveArsenkinReportBinding({
    caseId: input.caseId,
    sourceReportRunId: mapping.sourceReportRunId,
    effectiveReportRunId: arsenkinReportRunId,
    provider: "arsenkin",
    workflow,
    stage: input.stage,
    status: "TRANSFERRING",
    transferredAt: new Date().toISOString(),
    providerTaskCount,
    observationCount: obs.length,
    coverageCount,
    lastError: null,
  });

  // Diagnostic-only production path: NO legacy client-content rebuild, NO report
  // generation, NO REPORT_READY. Persist the enrichment run in the binding as
  // TRANSFERRED, record provenance and mark any accepted canonical report stale.
  // Full report generation stays with the unified CTA / canonical job.
  if (!rebuild) {
    const transferredAt = new Date().toISOString();
    // Preserve any previously appended enrichment runs on the binding.
    const priorBinding = loadArsenkinReportBinding(input.caseId);
    const priorEnrichmentRuns = priorBinding
      ? toCompositeBindingModel(priorBinding).enrichmentRuns
      : [];
    // Diagnostic-only: record the enrichment as READY_TO_TRANSFER (collected +
    // provenance persisted, but NOT render-ready). This is intentionally NOT
    // TRANSFERRED/REPORT_BOUND, so the client-content gate never treats it as a
    // completed report transfer. The canonical unified CTA owns report generation.
    saveArsenkinReportBinding({
      caseId: input.caseId,
      sourceReportRunId: mapping.sourceReportRunId,
      effectiveReportRunId: arsenkinReportRunId,
      provider: "arsenkin",
      workflow,
      stage: input.stage,
      status: "READY_TO_TRANSFER",
      transferredAt,
      providerTaskCount,
      observationCount: obs.length,
      coverageCount,
      version: "arsenkin-report-binding-v2",
      enrichmentRuns: priorEnrichmentRuns,
      lastError: null,
      contentPromotionError: null,
    });
    writeJsonAtomic(join(caseRoot, "arsenkin-ui-sync.json"), {
      synced: true,
      diagnosticOnly: true,
      reportGenerated: false,
      reportRunId: arsenkinReportRunId,
      sourceReportRunId: mapping.sourceReportRunId,
      effectiveReportRunId: arsenkinReportRunId,
      stage: input.stage,
      workflow,
      status: "READY_TO_TRANSFER",
      at: transferredAt,
      observationCount: obs.length,
      providerTaskCount,
      coverageCount,
    });
    // Any accepted canonical report is now stale (new enrichment collected).
    await markUnifiedReportArtifactsStale(input.caseId, "arsenkin-standalone-diagnostic-sync");
    if (getArsenkinNetworkCallCount() !== 0) {
      throw new ConflictError("sync leaked network calls");
    }
    const status = await getArsenkinUiStatus(
      input.caseId,
      input.reportRunId,
      input.stage,
      input.deps
    );
    return { ...status, orphanedEvidenceIds: [] };
  }

  const tempRoot = join(caseRoot, `.arsenkin-sync-tmp-${process.pid}-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });

  let orphanedEvidenceIds: string[] = [];
  try {
    await rebuild(input.caseId, arsenkinReportRunId, tempRoot, {
      requireAi: false,
      sourceReportRunId: mapping.sourceReportRunId,
    });

    const rebuiltPost = readJson<{ reportRunId?: string; caseId?: string }>(
      join(tempRoot, "orion-client-content.post-review.json")
    );
    if (!rebuiltPost || rebuiltPost.reportRunId !== arsenkinReportRunId) {
      throw new ConflictError(
        `ARSENKIN_CLIENT_CONTENT_RUN_MISMATCH: rebuilt reportRunId=${rebuiltPost?.reportRunId ?? "missing"} expected=${arsenkinReportRunId}`
      );
    }

    const queue = readJson<{ items?: Array<{ evidenceId?: string; id?: string }> }>(
      join(tempRoot, "manual-review-queue.json")
    );
    const evidenceIds = new Set(
      (queue?.items ?? [])
        .map((i) => i.evidenceId ?? i.id)
        .filter((x): x is string => Boolean(x))
    );

    const reapplied: typeof preserved = [];
    for (const d of preserved) {
      if (evidenceIds.has(d.evidenceId) || evidenceIds.size === 0) {
        reapplied.push(d);
      } else {
        orphanedEvidenceIds.push(d.evidenceId);
      }
    }

    const merged: AdminReviewDecisionSet = {
      version: "r10-5-admin-review-decisions-v1",
      caseId: input.caseId,
      generatedAt: existing?.generatedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      qaSampleOnly: false,
      decisions: reapplied,
    };
    writeJsonAtomic(join(tempRoot, "admin-review-decisions.json"), merged);
    writeJsonAtomic(join(tempRoot, "client-content-binding.json"), {
      sourceReportRunId: mapping.sourceReportRunId,
      effectiveReportRunId: arsenkinReportRunId,
      overridden: false,
      rebuilt: true,
    });
    writeJsonAtomic(join(tempRoot, "arsenkin-ui-sync-diagnostics.json"), {
      orphanedEvidenceIds,
      preservedCount: reapplied.length,
      reportRunId: arsenkinReportRunId,
      sourceReportRunId: mapping.sourceReportRunId,
    });

    // Atomic promote: case-root artifacts including inventory (prevents regenerate fallback).
    for (const name of [
      "orion-client-content.post-review.json",
      "orion-client-content.pre-review.json",
      "orion-client-content.post-review.md",
      "orion-client-content.pre-review.md",
      "client-content-binding.json",
      "admin-review-decisions.json",
      "run-scoped-serp-merge.json",
      "manual-review-queue.json",
      "full-evidence-inventory.json",
      "evidence-judgment-inspection.json",
      "r10-4-evidence-bundles.json",
      "report-assets.json",
      "final-deck-manifest.json",
    ]) {
      const src = join(tempRoot, name);
      if (!existsSync(src)) continue;
      const dest = join(caseRoot, name);
      writeFileSync(dest, readFileSync(src));
    }

    const merge = readJson<{ usedRunScoped?: boolean; observationCount?: number; auditRunId?: string }>(
      join(caseRoot, "run-scoped-serp-merge.json")
    );
    if (merge && merge.usedRunScoped === false) {
      throw new ConflictError("run-scoped merge не использован");
    }
    if (merge?.auditRunId && merge.auditRunId !== arsenkinReportRunId) {
      throw new ConflictError(
        `ARSENKIN_REPORT_BINDING_MISMATCH: merge.auditRunId=${merge.auditRunId} expected=${arsenkinReportRunId}`
      );
    }

    const transferredAt = new Date().toISOString();
    const bindingPayload: ArsenkinReportBinding = {
      caseId: input.caseId,
      sourceReportRunId: mapping.sourceReportRunId,
      effectiveReportRunId: arsenkinReportRunId,
      provider: "arsenkin",
      workflow,
      stage: input.stage,
      status: "TRANSFERRED",
      transferredAt,
      providerTaskCount,
      observationCount: obs.length,
      coverageCount,
      lastError: null,
    };
    saveArsenkinReportBinding(bindingPayload);
    writeJsonAtomic(join(caseRoot, "arsenkin-ui-sync.json"), {
      synced: true,
      reportRunId: arsenkinReportRunId,
      sourceReportRunId: mapping.sourceReportRunId,
      effectiveReportRunId: arsenkinReportRunId,
      stage: input.stage,
      workflow,
      status: "TRANSFERRED",
      at: transferredAt,
      observationCount: obs.length,
      providerTaskCount,
      coverageCount,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    saveArsenkinReportBinding({
      caseId: input.caseId,
      sourceReportRunId: mapping.sourceReportRunId,
      effectiveReportRunId: arsenkinReportRunId,
      provider: "arsenkin",
      workflow,
      stage: input.stage,
      status: "TRANSFER_FAILED",
      transferredAt: new Date().toISOString(),
      providerTaskCount,
      observationCount: obs.length,
      coverageCount,
      lastError: message,
    });
    throw err;
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  if (getArsenkinNetworkCallCount() !== 0) {
    throw new ConflictError("sync leaked network calls");
  }

  const status = await getArsenkinUiStatus(
    input.caseId,
    input.reportRunId,
    input.stage,
    input.deps
  );
  return { ...status, status: "TRANSFERRED", synced: true, orphanedEvidenceIds };
}

