/**
 * Production canonical Arsenkin stage execution service (P0.5 acceptance repair).
 * CLI is a thin adapter; integration tests inject fake collector/transport + Prisma.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrismaClient } from "@prisma/client";
import {
  buildArsenkinExecutionPlan,
  type ArsenkinExecutionPlan,
  type ArsenkinLiveStage,
} from "./arsenkin-execution-plan";
import { buildArsenkinSubjectQueryPlan } from "./arsenkin-subject-query-plan";
import {
  buildPrepareCanaryRunSpec,
  canaryLifecycleOf,
  type CanaryRunRow,
} from "./arsenkin-canary-run-lifecycle";
import {
  evaluateCanonicalLiveGate,
  type EvaluateCanonicalLiveGateResult,
} from "./arsenkin-canonical-live-gate";
import {
  aggregateRunStatus,
  parseWorkflow,
  requiredStagesForWorkflow,
  workflowForStage,
  type ArsenkinWorkflow,
} from "./arsenkin-stage-ledger";
import { authorizationFromPlan } from "../../providers/arsenkin/execute-arsenkin-execution-plan";
import {
  collectArsenkinPilotSurfaces,
  type ArsenkinPilotCollectResult,
} from "../../providers/arsenkin/collect-pilot-surfaces";
import type { LiveExecutionAuthorization } from "../../providers/arsenkin/live-execution-authorization";
import {
  computeSchemaContentHash,
  computeSourceTreeHash,
  fingerprintDatabaseUrl,
  resolveBuildIdentity,
  validateDbReadinessArtifact,
  writeJsonAtomic,
  type ArsenkinDbReadinessArtifact,
  type BuildIdentity,
} from "../../providers/arsenkin/arsenkin-db-readiness";
import { buildPlannedCoverageMatrix } from "../../providers/arsenkin/planned-coverage-matrix";
import { pickEnrichmentUrls } from "./enrich-report-run-with-arsenkin";
import { persistSerpObservations } from "../../serp-observation/persist";
import type { SerpObservationDraft } from "../../serp-observation/types";

export type CanonicalStageMode = "prepare" | "plan-only" | "execute-live";

export type CanonicalStageCommand = {
  mode: CanonicalStageMode;
  caseId: string;
  reportRunId: string;
  stage: ArsenkinLiveStage;
  workflow?: ArsenkinWorkflow;
  maxNewTasks: number;
  maxEstimatedLimits: number;
  confirmPlanDigest?: string | null;
  liveConfirm?: boolean;
  dbReadinessPath: string;
  tokenPresent?: boolean;
  /** Hard-fail when true. */
  resumeExisting?: boolean;
  outRoot?: string;
};

export type CanonicalStageCollectorInput = {
  caseId: string;
  reportRunId: string;
  plan: ArsenkinExecutionPlan;
  liveAuthorization: LiveExecutionAuthorization;
};

export type CanonicalStageDeps = {
  prisma: PrismaClient;
  collect: (input: CanonicalStageCollectorInput) => Promise<ArsenkinPilotCollectResult>;
  persistObservations: (drafts: SerpObservationDraft[]) => Promise<unknown[]>;
  now: () => Date;
  createOwnerId: (reportRunId: string, stage: ArsenkinLiveStage) => string;
  resolveBuild: () => BuildIdentity;
  fingerprintDb: (databaseUrl: string) => string;
  computeSchemaHash: () => string;
  computeSourceHash: () => string;
  getNetworkCalls: () => number;
  databaseUrl: string;
};

export type CanonicalStageResult = {
  ok: boolean;
  phase: string;
  verdict: string;
  reportRunId: string;
  stage: ArsenkinLiveStage;
  workflow: ArsenkinWorkflow;
  digest?: string;
  networkCalls: number;
  collectorCalls?: number;
  plannedNewTasks?: number | null;
  estimatedLimitsTotal?: number | null;
  requestCount?: number;
  urlsEnrichment?: string[];
  stageStatus?: string | null;
  runStatus?: string | null;
  runAggregate?: string;
  blockers?: string[];
  gate?: EvaluateCanonicalLiveGateResult;
  exitCode: number;
  artifactPaths?: string[];
};

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function defaultOutRoot(caseId: string, reportRunId: string): string {
  return join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    caseId,
    reportRunId
  );
}

export function createProductionCanonicalStageDeps(
  prisma: PrismaClient,
  opts: {
    getNetworkCalls: () => number;
    databaseUrl?: string;
  }
): CanonicalStageDeps {
  return {
    prisma,
    collect: async ({ caseId, reportRunId, plan, liveAuthorization }) =>
      collectArsenkinPilotSurfaces({
        caseId,
        auditRunId: reportRunId,
        queriesRu: plan.queriesRu,
        queriesUae: plan.queriesUae,
        executionPlan: plan,
        liveAuthorization,
        tools: plan.tools,
        aiSerpTargets: plan.aiSerpTargets,
        urlsEnrichment: plan.urlsEnrichment,
      }),
    persistObservations: (drafts) => persistSerpObservations(drafts),
    now: () => new Date(),
    createOwnerId: (reportRunId, stage) =>
      `canary-${process.pid}-${createHash("sha256")
        .update(`${reportRunId}:${stage}:${Date.now()}`)
        .digest("hex")
        .slice(0, 8)}`,
    resolveBuild: () => resolveBuildIdentity(),
    fingerprintDb: fingerprintDatabaseUrl,
    computeSchemaHash: () => computeSchemaContentHash(),
    computeSourceHash: () => computeSourceTreeHash(),
    getNetworkCalls: opts.getNetworkCalls,
    databaseUrl: opts.databaseUrl ?? String(process.env.DATABASE_URL ?? ""),
  };
}

/**
 * Claim stage PREPARED→RUNNING and run PREPARED|RUNNING→RUNNING in one transaction.
 * Both updateMany must return count===1 or the whole claim rolls back.
 */
export async function claimCanonicalStageAndRun(
  prisma: PrismaClient,
  input: {
    reportRunId: string;
    caseId: string;
    stage: ArsenkinLiveStage;
    ownerId: string;
    plan: ArsenkinExecutionPlan;
    now: Date;
  }
): Promise<{ ok: true } | { ok: false; reason: string; stageCount: number; runCount: number }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const stageClaim = await tx.orionArsenkinStageRun.updateMany({
        where: {
          reportRunId: input.reportRunId,
          caseId: input.caseId,
          stage: input.stage,
          status: "PREPARED",
        },
        data: {
          status: "RUNNING",
          leaseOwnerId: input.ownerId,
          planDigest: input.plan.digest,
          maxNewTasks: input.plan.maxNewTasks,
          maxEstimatedLimits: input.plan.maxEstimatedLimits,
          estimatedLimitsTotal: input.plan.estimatedLimitsTotal,
          plannedNewTasks: input.plan.plannedNewTasks,
          startedAt: input.now,
        },
      });
      if (stageClaim.count !== 1) {
        throw Object.assign(new Error("cas-stage-claim-failed"), {
          stageCount: stageClaim.count,
          runCount: 0,
        });
      }
      const runClaim = await tx.orionReportRun.updateMany({
        where: {
          id: input.reportRunId,
          caseId: input.caseId,
          status: { in: ["PREPARED", "RUNNING"] },
        },
        data: { status: "RUNNING", startedAt: input.now },
      });
      if (runClaim.count !== 1) {
        throw Object.assign(new Error("cas-run-claim-failed"), {
          stageCount: stageClaim.count,
          runCount: runClaim.count,
        });
      }
      return { ok: true as const };
    });
  } catch (e) {
    const err = e as { message?: string; stageCount?: number; runCount?: number };
    return {
      ok: false,
      reason: err.message ?? "cas-claim-failed",
      stageCount: err.stageCount ?? -1,
      runCount: err.runCount ?? -1,
    };
  }
}

export class CasFinalizeError extends Error {
  readonly manualIntervention = true as const;
  constructor(
    message: string,
    readonly stageCount: number,
    readonly runCount: number
  ) {
    super(message);
    this.name = "CasFinalizeError";
  }
}

/**
 * Finalize stage RUNNING→DONE and run aggregate in one transaction.
 * If run CAS loses, stage DONE is rolled back — no partial DONE/RUNNING split.
 */
export async function finalizeCanonicalStageDone(
  prisma: PrismaClient,
  input: {
    reportRunId: string;
    caseId: string;
    stage: ArsenkinLiveStage;
    ownerId: string;
    planDigest: string;
    workflow: ArsenkinWorkflow;
    now: Date;
  }
): Promise<
  | { ok: true; runAggregate: string; runFinalized: boolean }
  | { ok: false; reason: string; manualIntervention: true; stageCount: number; runCount: number }
> {
  try {
    return await prisma.$transaction(async (tx) => {
      const stageDone = await tx.orionArsenkinStageRun.updateMany({
        where: {
          reportRunId: input.reportRunId,
          caseId: input.caseId,
          stage: input.stage,
          status: "RUNNING",
          leaseOwnerId: input.ownerId,
          planDigest: input.planDigest,
        },
        data: { status: "DONE", finishedAt: input.now },
      });
      if (stageDone.count !== 1) {
        throw new CasFinalizeError("cas-stage-done-failed", stageDone.count, 0);
      }

      const allStages = await tx.orionArsenkinStageRun.findMany({
        where: { reportRunId: input.reportRunId },
        select: { stage: true, status: true },
      });
      const agg = aggregateRunStatus({
        workflow: input.workflow,
        stages: allStages.map((s) => ({
          stage: s.stage as ArsenkinLiveStage,
          status: s.status,
        })),
      });

      if (agg === "DONE") {
        const runDone = await tx.orionReportRun.updateMany({
          where: { id: input.reportRunId, caseId: input.caseId, status: "RUNNING" },
          data: { status: "DONE", finishedAt: input.now },
        });
        if (runDone.count !== 1) {
          throw new CasFinalizeError("cas-run-done-failed", stageDone.count, runDone.count);
        }
        return { ok: true as const, runAggregate: agg, runFinalized: true };
      }

      // Stage progress without full workflow DONE: keep run RUNNING via exact CAS.
      const runKeep = await tx.orionReportRun.updateMany({
        where: { id: input.reportRunId, caseId: input.caseId, status: "RUNNING" },
        data: { status: "RUNNING" },
      });
      if (runKeep.count !== 1) {
        throw new CasFinalizeError(
          "cas-run-keep-RUNNING-failed",
          stageDone.count,
          runKeep.count
        );
      }
      return { ok: true as const, runAggregate: agg, runFinalized: false };
    });
  } catch (e) {
    if (e instanceof CasFinalizeError) {
      return {
        ok: false,
        reason: e.message,
        manualIntervention: true,
        stageCount: e.stageCount,
        runCount: e.runCount,
      };
    }
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      reason: message,
      manualIntervention: true,
      stageCount: -1,
      runCount: -1,
    };
  }
}

/** Fail stage+run in one transaction (fail-closed; count mismatches → manual intervention). */
export async function failCanonicalStageAndRun(
  prisma: PrismaClient,
  input: {
    reportRunId: string;
    caseId: string;
    stage: ArsenkinLiveStage;
    ownerId: string;
    message: string;
    now: Date;
  }
): Promise<{ stageCount: number; runCount: number; ok: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const stageFail = await tx.orionArsenkinStageRun.updateMany({
        where: {
          reportRunId: input.reportRunId,
          caseId: input.caseId,
          stage: input.stage,
          status: "RUNNING",
          leaseOwnerId: input.ownerId,
        },
        data: {
          status: "FAILED",
          finishedAt: input.now,
          errorJson: { message: input.message },
        },
      });
      if (stageFail.count !== 1) {
        throw new CasFinalizeError("cas-stage-fail-count-mismatch", stageFail.count, 0);
      }
      const runFail = await tx.orionReportRun.updateMany({
        where: { id: input.reportRunId, caseId: input.caseId, status: "RUNNING" },
        data: {
          status: "FAILED",
          finishedAt: input.now,
          errorsJson: { message: input.message, stage: input.stage },
        },
      });
      if (runFail.count !== 1) {
        throw new CasFinalizeError(
          "cas-run-fail-count-mismatch",
          stageFail.count,
          runFail.count
        );
      }
      return { stageCount: stageFail.count, runCount: runFail.count, ok: true };
    });
  } catch (e) {
    if (e instanceof CasFinalizeError) {
      return { stageCount: e.stageCount, runCount: e.runCount, ok: false };
    }
    return { stageCount: -1, runCount: -1, ok: false };
  }
}

export async function executeCanonicalArsenkinStage(
  deps: CanonicalStageDeps,
  command: CanonicalStageCommand
): Promise<CanonicalStageResult> {
  const { prisma } = deps;
  const stage = command.stage;
  const workflow: ArsenkinWorkflow = command.workflow ?? workflowForStage(stage);
  const caseId = command.caseId;
  const reportRunId = command.reportRunId;
  const outRoot = command.outRoot ?? defaultOutRoot(caseId, reportRunId);
  mkdirSync(outRoot, { recursive: true });
  const artifactPaths: string[] = [];

  const writeArt = (name: string, payload: unknown) => {
    const p = join(outRoot, name);
    writeJsonAtomic(p, payload);
    artifactPaths.push(p);
  };

  if (command.resumeExisting) {
    writeArt("resume-existing-blocked.json", {
      error: "resume-existing-not-supported",
      networkCalls: deps.getNetworkCalls(),
    });
    return {
      ok: false,
      phase: "blocked",
      verdict: "RESUME_BLOCKED",
      reportRunId,
      stage,
      workflow,
      networkCalls: deps.getNetworkCalls(),
      blockers: ["resume-existing-not-supported"],
      exitCode: 2,
      artifactPaths,
    };
  }

  if (!(command.maxNewTasks > 0) || !(command.maxEstimatedLimits > 0)) {
    throw new Error("--max-new-tasks and --max-estimated-limits are required (>0)");
  }

  const subject = await prisma.subject.findFirst({
    where: { caseId },
    select: { fullName: true, aliases: true },
  });
  const queryPlan = buildArsenkinSubjectQueryPlan({
    fullName: subject?.fullName,
    aliases: subject?.aliases ?? [],
  });

  const build = deps.resolveBuild();
  const currentFingerprint = deps.fingerprintDb(deps.databaseUrl);
  const schemaContentHash = deps.computeSchemaHash();
  const sourceTreeHash = deps.computeSourceHash();
  const dbReadiness = readJson<ArsenkinDbReadinessArtifact>(command.dbReadinessPath);

  const run = (await prisma.orionReportRun.findUnique({
    where: { id: reportRunId },
  })) as CanaryRunRow | null;

  const stageRowsRaw = await prisma.orionArsenkinStageRun.findMany({
    where: { reportRunId },
    select: {
      stage: true,
      status: true,
      planDigest: true,
      leaseOwnerId: true,
      id: true,
    },
  });
  const stageRows = stageRowsRaw.map((s) => ({
    stage: s.stage as ArsenkinLiveStage,
    status: s.status,
  }));
  const currentStage = stageRowsRaw.find((s) => s.stage === stage) ?? null;

  if (command.mode === "prepare") {
    const gate = evaluateCanonicalLiveGate({
      mode: "prepare",
      caseId,
      reportRunId,
      stage,
      workflow,
      run,
      stageRows,
      currentStageStatus: currentStage?.status ?? null,
      counts: { providerTaskCount: 0, observationCount: 0, coverageCount: 0 },
      queryPlan,
      executionPlan: null,
      content: null,
      binding: null,
      adminDecisions: null,
      dbReadiness,
      currentDbFingerprint: currentFingerprint,
      currentBuildCommit: build.buildCommit,
      currentSourceTreeHash: sourceTreeHash,
      currentSchemaContentHash: schemaContentHash,
      currentDirtyTree: build.dirtyTree,
      liveConfirm: false,
      confirmPlanDigest: null,
      tokenPresent: false,
      networkCalls: deps.getNetworkCalls(),
      resumeExisting: false,
    });
    if (!gate.ok) {
      writeArt("fresh-run-preflight.json", { ...gate, networkCalls: 0 });
      return {
        ok: false,
        phase: "prepare",
        verdict: gate.verdict,
        reportRunId,
        stage,
        workflow,
        networkCalls: 0,
        blockers: gate.blockers,
        gate,
        exitCode: 1,
        artifactPaths,
      };
    }

    const isFirst = stage === "SUGGEST_RU_CANARY" || stage === "FIRST36_STAGE1";
    if (isFirst && !run) {
      const spec = buildPrepareCanaryRunSpec({
        reportRunId,
        caseId,
        stage,
        preparedAtIso: deps.now().toISOString(),
      });
      await prisma.orionReportRun.create({
        data: {
          ...spec,
          metadataJson: { ...spec.metadataJson, workflow },
        },
      });
    }

    if (currentStage?.status && String(currentStage.status).toUpperCase() === "PREPARED") {
      writeArt("fresh-run-preflight.json", {
        verdict: "PREPARED",
        idempotentReuse: true,
        reportRunId,
        stage,
        workflow,
        networkCalls: deps.getNetworkCalls(),
      });
      return {
        ok: true,
        phase: "prepare",
        verdict: "PREPARED",
        reportRunId,
        stage,
        workflow,
        networkCalls: deps.getNetworkCalls(),
        stageStatus: "PREPARED",
        exitCode: 0,
        artifactPaths,
      };
    }

    await prisma.orionArsenkinStageRun.create({
      data: {
        reportRunId,
        caseId,
        stage,
        status: "PREPARED",
        metadataJson: { workflow, preparedAt: deps.now().toISOString() },
      },
    });
    writeArt("fresh-run-preflight.json", {
      verdict: "PREPARED",
      reportRunId,
      stage,
      workflow,
      networkCalls: deps.getNetworkCalls(),
    });
    return {
      ok: true,
      phase: "prepare",
      verdict: "PREPARED",
      reportRunId,
      stage,
      workflow,
      networkCalls: deps.getNetworkCalls(),
      stageStatus: "PREPARED",
      exitCode: 0,
      artifactPaths,
    };
  }

  const [providerTaskCount, observationCount, coverageCount] = await Promise.all([
    prisma.providerTask.count({ where: { reportRunId, provider: "arsenkin" } }),
    prisma.serpObservation.count({ where: { auditRunId: reportRunId, provider: "arsenkin" } }),
    prisma.surfaceCollectionCoverage.count({
      where: { reportRunId, provider: "arsenkin" },
    }),
  ]);

  const existingTasks = await prisma.providerTask.findMany({
    where: { reportRunId, provider: "arsenkin" },
    select: { id: true, requestHash: true, state: true },
  });

  let urlsEnrichment: string[] = [];
  if (stage === "FIRST36_STAGE2") {
    const organic = await prisma.serpObservation.findMany({
      where: { auditRunId: reportRunId, provider: "arsenkin", surface: "organic" },
      select: { url: true, domain: true, rank: true, surface: true },
      orderBy: { rank: "asc" },
      take: 100,
    });
    urlsEnrichment = pickEnrichmentUrls(organic, 5);
  }

  const plan = buildArsenkinExecutionPlan({
    caseId,
    reportRunId,
    stage,
    queriesRu: queryPlan.queriesRu,
    queriesUae: queryPlan.queriesUae,
    maxNewTasks: command.maxNewTasks,
    maxEstimatedLimits: command.maxEstimatedLimits,
    existingTasks,
    urlsEnrichment,
  });

  const content = readJson<{ caseId?: string; reportRunId?: string }>(
    join(outRoot, "orion-client-content.post-review.json")
  );
  const binding = readJson<{
    sourceReportRunId?: string;
    effectiveReportRunId?: string;
    overridden?: boolean;
  }>(join(outRoot, "client-content-binding.json"));
  const adminDecisions = readJson<{ caseId?: string; qaSampleOnly?: boolean }>(
    join(outRoot, "admin-review-decisions.json")
  );

  const coverageMatrix = buildPlannedCoverageMatrix(plan);
  writeArt("arsenkin-live-plan.json", plan);
  writeArt("planned-coverage-matrix.json", { targets: coverageMatrix, urlsEnrichment });

  const gate = evaluateCanonicalLiveGate({
    mode: command.mode === "execute-live" ? "execute-live" : "plan-only",
    caseId,
    reportRunId,
    stage,
    workflow,
    run,
    stageRows,
    currentStageStatus: currentStage?.status ?? null,
    counts: { providerTaskCount, observationCount, coverageCount },
    queryPlan,
    executionPlan: plan,
    content,
    binding,
    adminDecisions,
    dbReadiness,
    currentDbFingerprint: currentFingerprint,
    currentBuildCommit: build.buildCommit,
    currentSourceTreeHash: sourceTreeHash,
    currentSchemaContentHash: schemaContentHash,
    currentDirtyTree: build.dirtyTree,
    liveConfirm: Boolean(command.liveConfirm),
    confirmPlanDigest: command.confirmPlanDigest ?? null,
    tokenPresent: Boolean(command.tokenPresent),
    networkCalls: deps.getNetworkCalls(),
  });

  writeArt("fresh-run-preflight.json", {
    lifecycle: canaryLifecycleOf(run),
    stage,
    workflow,
    stageRows,
    counts: { providerTaskCount, observationCount, coverageCount },
    gate,
    networkCalls: deps.getNetworkCalls(),
  });

  if (gate.verdict === "IDEMPOTENT_REPLAY_DONE" || gate.verdict === "IDEMPOTENT_DONE") {
    writeArt("idempotent-replay.json", {
      verdict: "IDEMPOTENT_REPLAY_DONE",
      stage,
      networkCalls: 0,
      collectorCalls: 0,
      note: "replay-does-not-imply-live-readiness",
    });
    return {
      ok: true,
      phase: "idempotent-replay",
      verdict: "IDEMPOTENT_REPLAY_DONE",
      reportRunId,
      stage,
      workflow,
      digest: plan.digest,
      networkCalls: 0,
      collectorCalls: 0,
      plannedNewTasks: 0,
      requestCount: plan.requests.length,
      stageStatus: "DONE",
      exitCode: 0,
      artifactPaths,
    };
  }

  if (!gate.ok) {
    return {
      ok: false,
      phase: command.mode,
      verdict: gate.verdict,
      reportRunId,
      stage,
      workflow,
      digest: plan.digest,
      networkCalls: deps.getNetworkCalls(),
      plannedNewTasks: plan.plannedNewTasks,
      estimatedLimitsTotal: plan.estimatedLimitsTotal,
      requestCount: plan.requests.length,
      urlsEnrichment,
      blockers: gate.blockers,
      gate,
      exitCode: 1,
      artifactPaths,
    };
  }

  if (command.mode !== "execute-live") {
    if (deps.getNetworkCalls() !== 0) throw new Error("plan-only leaked network");
    // Still require readiness artifact to be loadable for PLAN_READY path consistency
    void validateDbReadinessArtifact;
    return {
      ok: true,
      phase: "plan-only",
      verdict: gate.verdict,
      reportRunId,
      stage,
      workflow,
      digest: plan.digest,
      networkCalls: 0,
      plannedNewTasks: plan.plannedNewTasks,
      estimatedLimitsTotal: plan.estimatedLimitsTotal,
      requestCount: plan.requests.length,
      urlsEnrichment,
      gate,
      exitCode: 0,
      artifactPaths,
    };
  }

  const ownerId = deps.createOwnerId(reportRunId, stage);
  const claim = await claimCanonicalStageAndRun(prisma, {
    reportRunId,
    caseId,
    stage,
    ownerId,
    plan,
    now: deps.now(),
  });
  if (!claim.ok) {
    writeArt("cas-claim-failed.json", {
      reason: claim.reason,
      stageCount: claim.stageCount,
      runCount: claim.runCount,
      fingerprint: currentFingerprint,
    });
    return {
      ok: false,
      phase: "claim",
      verdict: "CAS_CLAIM_FAILED",
      reportRunId,
      stage,
      workflow,
      digest: plan.digest,
      networkCalls: deps.getNetworkCalls(),
      collectorCalls: 0,
      blockers: [claim.reason],
      exitCode: 1,
      artifactPaths,
    };
  }

  let collectorCalls = 0;
  try {
    const auth = authorizationFromPlan(plan);
    const collected = await deps.collect({
      caseId,
      reportRunId,
      plan,
      liveAuthorization: auth,
    });
    collectorCalls = 1;
    const persisted = await deps.persistObservations(collected.drafts);

    const fin = await finalizeCanonicalStageDone(prisma, {
      reportRunId,
      caseId,
      stage,
      ownerId,
      planDigest: plan.digest,
      workflow,
      now: deps.now(),
    });

    if (!fin.ok) {
      writeArt("manual-intervention-required.json", {
        verdict: "MANUAL_INTERVENTION_REQUIRED",
        reason: fin.reason,
        stageCas: fin.stageCount,
        runCas: fin.runCount,
        networkCalls: deps.getNetworkCalls(),
        collectorCalls,
        fingerprint: currentFingerprint,
        note: "collect-may-have-persisted-but-CAS-finalize-lost-no-success-readiness",
      });
      return {
        ok: false,
        phase: "finalize",
        verdict: "MANUAL_INTERVENTION_REQUIRED",
        reportRunId,
        stage,
        workflow,
        digest: plan.digest,
        networkCalls: deps.getNetworkCalls(),
        collectorCalls,
        blockers: [fin.reason],
        exitCode: 1,
        artifactPaths,
      };
    }

    const runRow = await prisma.orionReportRun.findUnique({
      where: { id: reportRunId },
      select: { status: true },
    });
    writeArt("arsenkin-live-execute-result.json", {
      mode: collected.mode,
      persisted: persisted.length,
      bySurface: collected.bySurface,
      taskIds: collected.taskIds,
      networkCalls: deps.getNetworkCalls(),
      collectorCalls,
      digest: plan.digest,
      stage,
      stageStatus: "DONE",
      runAggregate: fin.runAggregate,
      runStatus: runRow?.status ?? null,
      requiredStages: requiredStagesForWorkflow(workflow),
    });

    return {
      ok: true,
      phase: "execute-live",
      verdict: "STAGE_DONE",
      reportRunId,
      stage,
      workflow,
      digest: plan.digest,
      networkCalls: deps.getNetworkCalls(),
      collectorCalls,
      plannedNewTasks: plan.plannedNewTasks,
      estimatedLimitsTotal: plan.estimatedLimitsTotal,
      requestCount: plan.requests.length,
      urlsEnrichment,
      stageStatus: "DONE",
      runStatus: runRow?.status ?? null,
      runAggregate: fin.runAggregate,
      exitCode: 0,
      artifactPaths,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const fail = await failCanonicalStageAndRun(prisma, {
      reportRunId,
      caseId,
      stage,
      ownerId,
      message,
      now: deps.now(),
    });
    if (!fail.ok) {
      writeArt("manual-intervention-required.json", {
        verdict: "MANUAL_INTERVENTION_REQUIRED",
        reason: "cas-fail-transition-count-mismatch",
        stageCas: fail.stageCount,
        runCas: fail.runCount,
        message,
      });
    }
    writeArt("arsenkin-live-execute-error.json", {
      message,
      status: "FAILED",
      stageCas: fail.stageCount,
      runCas: fail.runCount,
      collectorCalls,
      failTransitionOk: fail.ok,
    });
    return {
      ok: false,
      phase: "execute-error",
      verdict: fail.ok ? "STAGE_FAILED" : "MANUAL_INTERVENTION_REQUIRED",
      reportRunId,
      stage,
      workflow,
      digest: plan.digest,
      networkCalls: deps.getNetworkCalls(),
      collectorCalls,
      blockers: [message],
      exitCode: 1,
      artifactPaths,
    };
  }
}

export { parseWorkflow, workflowForStage };
