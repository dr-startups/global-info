/**
 * Canonical Arsenkin live runner — the ONLY paid entrypoint (P0.5).
 *
 *   --prepare [--workflow=suggest-canary|first36-full] --stage=...
 *   plan-only (default)
 *   --execute-live  (requires LIVE_CONFIRM + digest + DB readiness v2 PASS)
 *
 * Multi-stage First36 uses one reportRunId + OrionArsenkinStageRun ledger.
 * --resume-existing is hard-failed (not supported).
 * Never prints API token or full DATABASE_URL.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import {
  buildArsenkinExecutionPlan,
  type ArsenkinLiveStage,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-execution-plan";
import { buildArsenkinSubjectQueryPlan } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-subject-query-plan";
import {
  buildPrepareCanaryRunSpec,
  canaryLifecycleOf,
  type CanaryRunRow,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-canary-run-lifecycle";
import { evaluateCanonicalLiveGate } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-canonical-live-gate";
import {
  aggregateRunStatus,
  parseWorkflow,
  requiredStagesForWorkflow,
  workflowForStage,
  type ArsenkinWorkflow,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-stage-ledger";
import { authorizationFromPlan } from "../src/modules/digital-profile/providers/arsenkin/execute-arsenkin-execution-plan";
import { collectArsenkinPilotSurfaces } from "../src/modules/digital-profile/providers/arsenkin/collect-pilot-surfaces";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";
import { persistSerpObservations } from "../src/modules/digital-profile/serp-observation/persist";
import {
  computeSchemaContentHash,
  computeSourceTreeHash,
  fingerprintDatabaseUrl,
  resolveBuildIdentity,
  type ArsenkinDbReadinessArtifact,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import { buildPlannedCoverageMatrix } from "../src/modules/digital-profile/providers/arsenkin/planned-coverage-matrix";
import { pickEnrichmentUrls } from "../src/modules/digital-profile/orion-golden/classic/enrich-report-run-with-arsenkin";

function bootstrapEnv(): void {
  const envPath = join(process.cwd(), ".env");
  if (existsSync(envPath)) {
    const parsed = parse(readFileSync(envPath));
    for (const [k, v] of Object.entries(parsed)) {
      if (v && !process.env[k]) process.env[k] = v;
    }
  }
}

function arg(name: string): string | null {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length).trim() : null;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function writeJson(path: string, payload: unknown): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function parseStage(raw: string | null): ArsenkinLiveStage {
  const s = (raw ?? "SUGGEST_RU_CANARY").trim();
  if (s === "SUGGEST_RU_CANARY" || s === "FIRST36_STAGE1" || s === "FIRST36_STAGE2") return s;
  throw new Error(`invalid-stage:${s}`);
}

async function main() {
  bootstrapEnv();
  resetArsenkinNetworkCallCount();

  const prepare = flag("prepare");
  const executeLive = flag("execute-live");
  if (flag("resume-existing")) {
    console.error(
      JSON.stringify({
        error: "resume-existing-not-supported",
        hint: "Use stage ledger prepare/execute; FAILED stages need explicit retry contract (not implemented as silent resume).",
        networkCalls: 0,
      })
    );
    process.exit(2);
  }

  const caseId = arg("case-id");
  const reportRunId = arg("report-run-id");
  const stage = parseStage(arg("stage"));
  const workflow: ArsenkinWorkflow = arg("workflow")
    ? parseWorkflow(arg("workflow"))
    : workflowForStage(stage);
  const maxNewTasks = Number(arg("max-new-tasks") ?? 0);
  const maxEstimatedLimits = Number(arg("max-estimated-limits") ?? 0);
  const confirmPlanDigest = arg("confirm-plan-digest");
  const liveConfirm = process.env.ARSENKIN_LIVE_CONFIRM === "1";
  const dbReadinessPath =
    arg("db-readiness") ||
    join(process.cwd(), "storage", "digital-profile", "qa-arsenkin-p05", "arsenkin-db-readiness.json");

  if (!caseId) throw new Error("--case-id required");
  if (!reportRunId) throw new Error("--report-run-id required");
  if (!(maxNewTasks > 0) || !(maxEstimatedLimits > 0)) {
    throw new Error("--max-new-tasks and --max-estimated-limits are required (>0)");
  }
  if (prepare && executeLive) throw new Error("cannot combine --prepare and --execute-live");

  const outRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    caseId,
    reportRunId
  );
  mkdirSync(outRoot, { recursive: true });

  const { prisma } = await import("../src/server/prisma/client");
  const subject = await prisma.subject.findFirst({
    where: { caseId },
    select: { fullName: true, aliases: true },
  });
  const queryPlan = buildArsenkinSubjectQueryPlan({
    fullName: subject?.fullName,
    aliases: subject?.aliases ?? [],
  });

  const build = resolveBuildIdentity();
  const dbUrl = String(process.env.DATABASE_URL ?? "");
  const currentFingerprint = fingerprintDatabaseUrl(dbUrl);
  const schemaContentHash = computeSchemaContentHash();
  const sourceTreeHash = computeSourceTreeHash();
  const dbReadiness = readJson<ArsenkinDbReadinessArtifact>(dbReadinessPath);

  const run = (await prisma.orionReportRun.findUnique({
    where: { id: reportRunId },
  })) as CanaryRunRow | null;

  const stageRowsRaw = await prisma.orionArsenkinStageRun.findMany({
    where: { reportRunId },
    select: { stage: true, status: true, planDigest: true, leaseOwnerId: true, id: true },
  });
  const stageRows = stageRowsRaw.map((s) => ({
    stage: s.stage as ArsenkinLiveStage,
    status: s.status,
  }));
  const currentStage = stageRowsRaw.find((s) => s.stage === stage) ?? null;

  if (prepare) {
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
      networkCalls: getArsenkinNetworkCallCount(),
    });
    if (!gate.ok) {
      writeJson(join(outRoot, "fresh-run-preflight.json"), { ...gate, networkCalls: 0 });
      console.error(JSON.stringify({ error: "prepare-blocked", ...gate }, null, 2));
      process.exitCode = 1;
      return;
    }

    const isFirst = stage === "SUGGEST_RU_CANARY" || stage === "FIRST36_STAGE1";
    if (isFirst) {
      const spec = buildPrepareCanaryRunSpec({
        reportRunId,
        caseId,
        stage,
        preparedAtIso: new Date().toISOString(),
      });
      await prisma.orionReportRun.create({
        data: {
          ...spec,
          metadataJson: { ...spec.metadataJson, workflow },
        },
      });
    }
    await prisma.orionArsenkinStageRun.create({
      data: {
        reportRunId,
        caseId,
        stage,
        status: "PREPARED",
        metadataJson: { workflow, preparedAt: new Date().toISOString() },
      },
    });
    writeJson(join(outRoot, "fresh-run-preflight.json"), {
      verdict: "PREPARED",
      reportRunId,
      stage,
      workflow,
      networkCalls: getArsenkinNetworkCallCount(),
    });
    console.log(JSON.stringify({ phase: "prepare", status: "PREPARED", reportRunId, stage, workflow }, null, 2));
    return;
  }

  const [providerTaskCount, observationCount, coverageCount] = await Promise.all([
    prisma.providerTask.count({ where: { reportRunId, provider: "arsenkin" } }),
    prisma.serpObservation.count({ where: { auditRunId: reportRunId, provider: "arsenkin" } }),
    prisma.surfaceCollectionCoverage.count({ where: { reportRunId, provider: "arsenkin" } }),
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
    maxNewTasks,
    maxEstimatedLimits,
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
  writeJson(join(outRoot, "arsenkin-live-plan.json"), plan);
  writeJson(join(outRoot, "planned-coverage-matrix.json"), {
    targets: coverageMatrix,
    urlsEnrichment,
  });

  const gate = evaluateCanonicalLiveGate({
    mode: executeLive ? "execute-live" : "plan-only",
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
    liveConfirm,
    confirmPlanDigest,
    tokenPresent: Boolean(String(process.env.ARSENKIN_API_TOKEN ?? "").trim()),
    networkCalls: getArsenkinNetworkCallCount(),
  });

  writeJson(join(outRoot, "fresh-run-preflight.json"), {
    lifecycle: canaryLifecycleOf(run),
    stage,
    workflow,
    stageRows,
    counts: { providerTaskCount, observationCount, coverageCount },
    gate,
    networkCalls: getArsenkinNetworkCallCount(),
  });

  console.log(
    JSON.stringify(
      {
        phase: executeLive ? "execute-preflight" : "plan",
        verdict: gate.verdict,
        digest: plan.digest,
        stage,
        workflow,
        plannedNewTasks: plan.plannedNewTasks,
        estimatedLimitsTotal: plan.estimatedLimitsTotal,
        requestCount: plan.requests.length,
        networkCalls: getArsenkinNetworkCallCount(),
        blockers: gate.blockers,
      },
      null,
      2
    )
  );

  if (gate.verdict === "IDEMPOTENT_DONE") {
    console.log(JSON.stringify({ phase: "idempotent-done", stage, networkCalls: 0 }, null, 2));
    return;
  }

  if (!gate.ok) {
    process.exitCode = 1;
    return;
  }

  if (!executeLive) {
    if (getArsenkinNetworkCallCount() !== 0) throw new Error("plan-only leaked network");
    return;
  }

  const ownerId = `canary-${process.pid}-${createHash("sha256").update(`${reportRunId}:${stage}`).digest("hex").slice(0, 8)}`;

  // CAS stage PREPARED → RUNNING
  const stageClaim = await prisma.orionArsenkinStageRun.updateMany({
    where: { reportRunId, caseId, stage, status: "PREPARED" },
    data: {
      status: "RUNNING",
      leaseOwnerId: ownerId,
      planDigest: plan.digest,
      maxNewTasks: plan.maxNewTasks,
      maxEstimatedLimits: plan.maxEstimatedLimits,
      estimatedLimitsTotal: plan.estimatedLimitsTotal,
      plannedNewTasks: plan.plannedNewTasks,
      startedAt: new Date(),
    },
  });
  if (stageClaim.count !== 1) {
    writeJson(join(outRoot, "cas-stage-claim-failed.json"), { stage, reportRunId, count: stageClaim.count });
    console.error(JSON.stringify({ error: "cas-stage-claim-failed", stage }, null, 2));
    process.exitCode = 1;
    return;
  }

  // Ensure run is RUNNING (not DONE)
  await prisma.orionReportRun.updateMany({
    where: {
      id: reportRunId,
      caseId,
      status: { in: ["PREPARED", "RUNNING"] },
    },
    data: { status: "RUNNING", startedAt: new Date() },
  });

  const auth = authorizationFromPlan(plan);
  try {
    const collected = await collectArsenkinPilotSurfaces({
      caseId,
      auditRunId: reportRunId,
      queriesRu: plan.queriesRu,
      queriesUae: plan.queriesUae,
      executionPlan: plan,
      liveAuthorization: auth,
      tools: plan.tools,
      aiSerpTargets: plan.aiSerpTargets,
      urlsEnrichment: plan.urlsEnrichment,
    });
    const persisted = await persistSerpObservations(collected.drafts);

    const stageDone = await prisma.orionArsenkinStageRun.updateMany({
      where: {
        reportRunId,
        caseId,
        stage,
        status: "RUNNING",
        leaseOwnerId: ownerId,
        planDigest: plan.digest,
      },
      data: { status: "DONE", finishedAt: new Date() },
    });
    if (stageDone.count !== 1) {
      writeJson(join(outRoot, "cas-stage-done-failed.json"), { stage, count: stageDone.count, ownerId });
      process.exitCode = 1;
      return;
    }

    const allStages = await prisma.orionArsenkinStageRun.findMany({
      where: { reportRunId },
      select: { stage: true, status: true },
    });
    const agg = aggregateRunStatus({
      workflow,
      stages: allStages.map((s) => ({ stage: s.stage as ArsenkinLiveStage, status: s.status })),
    });

    if (agg === "DONE") {
      const runDone = await prisma.orionReportRun.updateMany({
        where: { id: reportRunId, caseId, status: "RUNNING" },
        data: { status: "DONE", finishedAt: new Date() },
      });
      if (runDone.count !== 1) {
        writeJson(join(outRoot, "cas-run-done-failed.json"), { count: runDone.count });
        process.exitCode = 1;
        return;
      }
    }

    writeJson(join(outRoot, "arsenkin-live-execute-result.json"), {
      mode: collected.mode,
      persisted: persisted.length,
      bySurface: collected.bySurface,
      taskIds: collected.taskIds,
      networkCalls: getArsenkinNetworkCallCount(),
      digest: plan.digest,
      stage,
      stageStatus: "DONE",
      runAggregate: agg,
      requiredStages: requiredStagesForWorkflow(workflow),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stageFail = await prisma.orionArsenkinStageRun.updateMany({
      where: {
        reportRunId,
        caseId,
        stage,
        status: "RUNNING",
        leaseOwnerId: ownerId,
      },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorJson: { message },
      },
    });
    const runFail = await prisma.orionReportRun.updateMany({
      where: { id: reportRunId, caseId, status: "RUNNING" },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorsJson: { message, stage },
      },
    });
    writeJson(join(outRoot, "arsenkin-live-execute-error.json"), {
      message,
      status: "FAILED",
      stageCas: stageFail.count,
      runCas: runFail.count,
    });
    console.error(JSON.stringify({ error: message }, null, 2));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
