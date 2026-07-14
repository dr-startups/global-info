/**
 * P0.5 acceptance repair — production canonical service on real test PostgreSQL
 * with fake Arsenkin transport (zero HTTP / NETWORK_CALLS=0).
 *
 * Requires:
 *   ARSENKIN_DB_INTEGRATION_REQUIRED=1
 *   ARSENKIN_DB_ENV=test|staging
 *   ARSENKIN_DB_MUTATION_CONFIRM=1
 *   DATABASE_URL=<isolated test/staging DSN>
 *
 * SKIP is forbidden when INTEGRATION_REQUIRED=1.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARSENKIN_DB_READINESS_VERSION,
  assertDbMutationAllowed,
  computeSchemaContentHash,
  computeSourceTreeHash,
  fingerprintDatabaseUrl,
  writeJsonAtomic,
  type ArsenkinDbReadinessArtifact,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import {
  createProductionCanonicalStageDeps,
  executeCanonicalArsenkinStage,
  type CanonicalStageDeps,
} from "../src/modules/digital-profile/orion-golden/classic/execute-canonical-arsenkin-stage";
import type { ArsenkinPilotCollectResult } from "../src/modules/digital-profile/providers/arsenkin/execute-arsenkin-execution-plan";
import type { SerpObservationDraft } from "../src/modules/digital-profile/serp-observation/types";
import { buildSerpQueryId } from "../src/modules/digital-profile/serp-observation/query-id";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";

const ART = join(process.cwd(), "storage", "digital-profile", "qa-arsenkin-p05");
mkdirSync(ART, { recursive: true });

const required = process.env.ARSENKIN_DB_INTEGRATION_REQUIRED === "1";
const mutation = assertDbMutationAllowed(process.env);
const dbUrl = String(process.env.DATABASE_URL ?? "").trim();

function fail(msg: string): never {
  console.error(JSON.stringify({ verdict: "FAIL", error: msg, networkCalls: getArsenkinNetworkCallCount() }));
  process.exit(1);
}

if (required && !mutation.ok) {
  fail(`mutation-gate:${mutation.blockers.join(",")}`);
}
if (required && !dbUrl) {
  fail("ARSENKIN_DB_INTEGRATION_REQUIRED=1 but DATABASE_URL missing — SKIP forbidden");
}
if (!required || !mutation.ok || !dbUrl) {
  console.log(
    JSON.stringify({
      verdict: "CODE_READY_DB_BLOCKED",
      note: "lifecycle integration not run — set mutation env + test DATABASE_URL",
      networkCalls: 0,
    })
  );
  process.exit(0);
}

let collectorCalls = 0;
const STAGE1_URL = "https://example-stage1-organic.test/subject-page";

async function main() {
  resetArsenkinNetworkCallCount();
  const { prisma } = await import("../src/server/prisma/client");

  const caseId = `p05-life-case-${randomUUID().slice(0, 8)}`;
  const reportRunId = `p05-life-run-${randomUUID().slice(0, 8)}`;
  const outRoot = join(ART, "lifecycle", reportRunId);
  mkdirSync(outRoot, { recursive: true });
  const readinessPath = join(outRoot, "arsenkin-db-readiness.json");

  const schemaContentHash = computeSchemaContentHash();
  const sourceTreeHash = computeSourceTreeHash();
  const fp = fingerprintDatabaseUrl(dbUrl);
  const buildCommit = "p05-acceptance-repair-test-build";

  const readiness: ArsenkinDbReadinessArtifact = {
    version: ARSENKIN_DB_READINESS_VERSION,
    verdict: "PASS",
    databaseFingerprint: fp,
    buildCommit,
    buildId: "lifecycle-suite",
    dirtyTree: false,
    sourceTreeHash,
    schemaContentHash,
    requiredMigration: "20260714180000_surface_coverage_biz_unique",
    migrationApplied: true,
    uniqueIndexPresent: true,
    duplicateGroupCount: 0,
    concurrentUpsert: "PASS",
    backfillRace: "PASS",
    environment: mutation.environment === "staging" ? "staging" : "test",
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    cleanupAttempted: true,
    cleanupOk: true,
    cleanupRemainingRows: { coverage: 0, providerTasks: 0, reportRuns: 0 },
    cleanupError: null,
  };
  writeJsonAtomic(readinessPath, readiness);

  // Binding artifacts for fresh reportRunId (no QA sample).
  writeJsonAtomic(join(outRoot, "orion-client-content.post-review.json"), {
    caseId,
    reportRunId,
  });
  writeJsonAtomic(join(outRoot, "client-content-binding.json"), {
    sourceReportRunId: reportRunId,
    effectiveReportRunId: reportRunId,
    overridden: false,
  });
  writeJsonAtomic(join(outRoot, "admin-review-decisions.json"), {
    caseId,
    qaSampleOnly: false,
  });

  await prisma.case.create({
    data: {
      id: caseId,
      caseNumber: `P05-LIFE-${Date.now()}`,
      title: "P0.5 lifecycle acceptance",
      createdBy: "p05-lifecycle-suite",
    },
  });
  await prisma.subject.create({
    data: {
      caseId,
      fullName: "Иванов Иван Иванович",
      aliases: ["Ivanov Ivan"],
    },
  });

  const fakeCollect = async (input: {
    caseId: string;
    reportRunId: string;
    plan: { requests: Array<{ tool: string; requestHash: string; engine: string; region: string; query?: string | null }>; digest: string };
  }): Promise<ArsenkinPilotCollectResult> => {
    collectorCalls += 1;
    const drafts: SerpObservationDraft[] = [];
    const taskIds: string[] = [];
    for (const req of input.plan.requests) {
      const taskId = `fake-task-${randomUUID().slice(0, 8)}-${createHash("sha256").update(req.requestHash).digest("hex").slice(0, 8)}`;
      await prisma.providerTask.create({
        data: {
          id: taskId,
          caseId: input.caseId,
          reportRunId: input.reportRunId,
          provider: "arsenkin",
          toolName: req.tool,
          requestHash: req.requestHash,
          requestJson: { tools_name: req.tool, data: {} },
          state: "DONE",
          externalTaskId: `ext-${taskId}`,
          responseJson: { fake: true },
        },
      });
      taskIds.push(taskId);
      if (req.tool === "check-top" || req.engine) {
        const engine = (req.engine === "YANDEX" ? "YANDEX" : "GOOGLE") as "YANDEX" | "GOOGLE";
        const queryText = req.query || "Иванов Иван Иванович";
        const queryId = buildSerpQueryId({
          auditRunId: input.reportRunId,
          provider: "arsenkin",
          engine,
          region: req.region === "UAE" ? "UAE" : "RU",
          language: req.region === "UAE" ? "en" : "ru",
          queryText,
          surface: "organic",
        });
        drafts.push({
          caseId: input.caseId,
          auditRunId: input.reportRunId,
          queryId,
          queryText,
          providerTaskId: taskId,
          provider: "arsenkin",
          engine,
          surface: "organic",
          region: req.region === "UAE" ? "UAE" : "RU",
          language: req.region === "UAE" ? "en" : "ru",
          rank: 1,
          url: STAGE1_URL,
          title: "Stage1 organic",
          snippet: "from fake transport",
          domain: "example-stage1-organic.test",
          providerStatus: "OK",
          capturedAt: new Date(),
        });
      }
    }
    return {
      mode: "fixtures",
      drafts,
      bySurface: {
        organic: drafts.length,
        autocomplete: 0,
        paa: 0,
        aiAnswer: 0,
        pageMeta: 0,
        indexation: 0,
      },
      taskIds,
      surfaceRuns: [],
    };
  };

  const baseDeps = createProductionCanonicalStageDeps(prisma, {
    getNetworkCalls: getArsenkinNetworkCallCount,
    databaseUrl: dbUrl,
  });

  const makeDeps = (overrides: Partial<CanonicalStageDeps> = {}): CanonicalStageDeps => ({
    ...baseDeps,
    collect: async (input) => fakeCollect(input),
    persistObservations: async (drafts) => {
      const { persistSerpObservations } = await import(
        "../src/modules/digital-profile/serp-observation/persist"
      );
      return persistSerpObservations(drafts);
    },
    resolveBuild: () => ({
      buildCommit,
      buildId: "lifecycle-suite",
      dirtyTree: false,
      source: "env",
    }),
    ...overrides,
  });

  const common = {
    caseId,
    reportRunId,
    dbReadinessPath: readinessPath,
    outRoot,
    tokenPresent: true,
    liveConfirm: true,
  };

  try {
    // Fresh counts = 0
    assert.equal(await prisma.providerTask.count({ where: { reportRunId } }), 0);
    assert.equal(await prisma.serpObservation.count({ where: { auditRunId: reportRunId } }), 0);

    // Prepare Stage1
    const prep1 = await executeCanonicalArsenkinStage(makeDeps(), {
      ...common,
      mode: "prepare",
      stage: "FIRST36_STAGE1",
      workflow: "first36-full",
      maxNewTasks: 20,
      maxEstimatedLimits: 20,
    });
    assert.equal(prep1.ok, true, prep1.blockers?.join(","));
    assert.equal(prep1.verdict, "PREPARED");

    // Plan-only Stage1
    const plan1 = await executeCanonicalArsenkinStage(makeDeps(), {
      ...common,
      mode: "plan-only",
      stage: "FIRST36_STAGE1",
      workflow: "first36-full",
      maxNewTasks: 20,
      maxEstimatedLimits: 20,
    });
    assert.equal(plan1.ok, true, plan1.blockers?.join(","));
    assert.ok(plan1.digest);
    const stage1Digest = plan1.digest!;
    assert.equal(getArsenkinNetworkCallCount(), 0);

    // Concurrent execute Stage1
    collectorCalls = 0;
    const [exA, exB] = await Promise.all([
      executeCanonicalArsenkinStage(makeDeps(), {
        ...common,
        mode: "execute-live",
        stage: "FIRST36_STAGE1",
        workflow: "first36-full",
        maxNewTasks: 20,
        maxEstimatedLimits: 20,
        confirmPlanDigest: stage1Digest,
      }),
      executeCanonicalArsenkinStage(makeDeps(), {
        ...common,
        mode: "execute-live",
        stage: "FIRST36_STAGE1",
        workflow: "first36-full",
        maxNewTasks: 20,
        maxEstimatedLimits: 20,
        confirmPlanDigest: stage1Digest,
      }),
    ]);
    const winners = [exA, exB].filter((r) => r.ok && r.verdict === "STAGE_DONE");
    const losers = [exA, exB].filter((r) => !r.ok);
    assert.equal(winners.length, 1, `expected 1 winner got ${winners.length}`);
    assert.equal(losers.length, 1, `expected 1 loser got ${losers.length}`);
    assert.equal(collectorCalls, 1, `expected 1 collector call got ${collectorCalls}`);
    assert.equal(getArsenkinNetworkCallCount(), 0);

    const stage1 = await prisma.orionArsenkinStageRun.findFirst({
      where: { reportRunId, stage: "FIRST36_STAGE1" },
    });
    const runAfter1 = await prisma.orionReportRun.findUnique({ where: { id: reportRunId } });
    assert.equal(stage1?.status, "DONE");
    assert.equal(runAfter1?.status, "RUNNING");

    const tasksAfter1 = await prisma.providerTask.count({
      where: { reportRunId, provider: "arsenkin" },
    });
    assert.ok(tasksAfter1 > 0);
    const organic = await prisma.serpObservation.findMany({
      where: { auditRunId: reportRunId, surface: "organic" },
    });
    assert.ok(organic.some((o) => o.url === STAGE1_URL));

    // Stage2 prepare
    const prep2 = await executeCanonicalArsenkinStage(makeDeps(), {
      ...common,
      mode: "prepare",
      stage: "FIRST36_STAGE2",
      workflow: "first36-full",
      maxNewTasks: 10,
      maxEstimatedLimits: 10,
    });
    assert.equal(prep2.ok, true, prep2.blockers?.join(","));

    const plan2 = await executeCanonicalArsenkinStage(makeDeps(), {
      ...common,
      mode: "plan-only",
      stage: "FIRST36_STAGE2",
      workflow: "first36-full",
      maxNewTasks: 10,
      maxEstimatedLimits: 10,
    });
    assert.equal(plan2.ok, true, plan2.blockers?.join(","));
    assert.ok(plan2.urlsEnrichment?.includes(STAGE1_URL), `Stage2 URLs=${JSON.stringify(plan2.urlsEnrichment)}`);
    assert.notEqual(plan2.digest, stage1Digest);
    const stage2Digest = plan2.digest!;

    collectorCalls = 0;
    const ex2 = await executeCanonicalArsenkinStage(makeDeps(), {
      ...common,
      mode: "execute-live",
      stage: "FIRST36_STAGE2",
      workflow: "first36-full",
      maxNewTasks: 10,
      maxEstimatedLimits: 10,
      confirmPlanDigest: stage2Digest,
    });
    assert.equal(ex2.ok, true, ex2.blockers?.join(","));
    assert.equal(collectorCalls, 1);
    assert.equal(ex2.runStatus, "DONE");
    assert.equal(ex2.runAggregate, "DONE");

    const tasksAfter2 = await prisma.providerTask.count({
      where: { reportRunId, provider: "arsenkin" },
    });

    // Replay DONE stages → 0 collector / 0 new tasks
    collectorCalls = 0;
    const replay1 = await executeCanonicalArsenkinStage(makeDeps(), {
      ...common,
      mode: "execute-live",
      stage: "FIRST36_STAGE1",
      workflow: "first36-full",
      maxNewTasks: 20,
      maxEstimatedLimits: 20,
      confirmPlanDigest: stage1Digest,
    });
    assert.equal(replay1.verdict, "IDEMPOTENT_REPLAY_DONE");
    assert.equal(collectorCalls, 0);

    collectorCalls = 0;
    const replay2 = await executeCanonicalArsenkinStage(makeDeps(), {
      ...common,
      mode: "execute-live",
      stage: "FIRST36_STAGE2",
      workflow: "first36-full",
      maxNewTasks: 10,
      maxEstimatedLimits: 10,
      confirmPlanDigest: stage2Digest,
    });
    assert.equal(replay2.verdict, "IDEMPOTENT_REPLAY_DONE");
    assert.equal(collectorCalls, 0);
    assert.equal(
      await prisma.providerTask.count({ where: { reportRunId, provider: "arsenkin" } }),
      tasksAfter2
    );

    // Wrong caseId blocked before collector
    collectorCalls = 0;
    const wrongCase = await executeCanonicalArsenkinStage(makeDeps(), {
      ...common,
      caseId: "wrong-case-id",
      mode: "execute-live",
      stage: "FIRST36_STAGE2",
      workflow: "first36-full",
      maxNewTasks: 10,
      maxEstimatedLimits: 10,
      confirmPlanDigest: stage2Digest,
    });
    assert.equal(wrongCase.ok, false);
    assert.equal(collectorCalls, 0);

    // Wrong digest blocked
    collectorCalls = 0;
    // Need a fresh PREPARED stage for digest test — use separate micro case
    const caseB = `p05-casb-${randomUUID().slice(0, 8)}`;
    const runB = `p05-runb-${randomUUID().slice(0, 8)}`;
    const outB = join(ART, "lifecycle", runB);
    mkdirSync(outB, { recursive: true });
    writeJsonAtomic(join(outB, "orion-client-content.post-review.json"), { caseId: caseB, reportRunId: runB });
    writeJsonAtomic(join(outB, "client-content-binding.json"), {
      sourceReportRunId: runB,
      effectiveReportRunId: runB,
      overridden: false,
    });
    writeJsonAtomic(join(outB, "admin-review-decisions.json"), { caseId: caseB, qaSampleOnly: false });
    writeJsonAtomic(join(outB, "arsenkin-db-readiness.json"), readiness);
    await prisma.case.create({
      data: {
        id: caseB,
        caseNumber: `P05-B-${Date.now()}`,
        title: "P0.5 CAS fail case",
        createdBy: "p05-lifecycle-suite",
      },
    });
    await prisma.subject.create({
      data: { caseId: caseB, fullName: "Петров Петр Петрович", aliases: [] },
    });
    await executeCanonicalArsenkinStage(makeDeps(), {
      caseId: caseB,
      reportRunId: runB,
      dbReadinessPath: join(outB, "arsenkin-db-readiness.json"),
      outRoot: outB,
      tokenPresent: true,
      liveConfirm: true,
      mode: "prepare",
      stage: "FIRST36_STAGE1",
      workflow: "first36-full",
      maxNewTasks: 20,
      maxEstimatedLimits: 20,
    });
    const planB = await executeCanonicalArsenkinStage(makeDeps(), {
      caseId: caseB,
      reportRunId: runB,
      dbReadinessPath: join(outB, "arsenkin-db-readiness.json"),
      outRoot: outB,
      tokenPresent: true,
      liveConfirm: true,
      mode: "plan-only",
      stage: "FIRST36_STAGE1",
      workflow: "first36-full",
      maxNewTasks: 20,
      maxEstimatedLimits: 20,
    });
    collectorCalls = 0;
    const badDigest = await executeCanonicalArsenkinStage(makeDeps(), {
      caseId: caseB,
      reportRunId: runB,
      dbReadinessPath: join(outB, "arsenkin-db-readiness.json"),
      outRoot: outB,
      tokenPresent: true,
      liveConfirm: true,
      mode: "execute-live",
      stage: "FIRST36_STAGE1",
      workflow: "first36-full",
      maxNewTasks: 20,
      maxEstimatedLimits: 20,
      confirmPlanDigest: "intentionally-wrong-digest",
    });
    assert.equal(badDigest.ok, false);
    assert.equal(collectorCalls, 0);
    assert.ok(badDigest.blockers?.some((b) => /digest/i.test(b)));

    // Real finalize CAS conflict: collector poisons ReportRun so run CAS count=0 → transaction rollback
    collectorCalls = 0;
    const conflictCollect: CanonicalStageDeps["collect"] = async (input) => {
      const collected = await fakeCollect(input);
      await prisma.orionReportRun.update({
        where: { id: input.reportRunId },
        data: {
          status: "FAILED",
          errorsJson: { injected: "finalize-run-cas-conflict" },
        },
      });
      return collected;
    };
    const forced = await executeCanonicalArsenkinStage(
      makeDeps({ collect: conflictCollect }),
      {
        caseId: caseB,
        reportRunId: runB,
        dbReadinessPath: join(outB, "arsenkin-db-readiness.json"),
        outRoot: outB,
        tokenPresent: true,
        liveConfirm: true,
        mode: "execute-live",
        stage: "FIRST36_STAGE1",
        workflow: "first36-full",
        maxNewTasks: 20,
        maxEstimatedLimits: 20,
        confirmPlanDigest: planB.digest!,
      }
    );
    assert.equal(forced.verdict, "MANUAL_INTERVENTION_REQUIRED");
    assert.equal(forced.ok, false);
    assert.equal(collectorCalls, 1);
    assert.equal(getArsenkinNetworkCallCount(), 0);
    assert.ok(existsSync(join(outB, "manual-intervention-required.json")));
    assert.ok(!existsSync(join(outB, "arsenkin-live-execute-result.json")));

    const stageAfterConflict = await prisma.orionArsenkinStageRun.findFirst({
      where: { reportRunId: runB, stage: "FIRST36_STAGE1" },
    });
    const runAfterConflict = await prisma.orionReportRun.findUnique({ where: { id: runB } });
    assert.equal(
      stageAfterConflict?.status,
      "RUNNING",
      "stage DONE must roll back when run CAS loses"
    );
    assert.notEqual(runAfterConflict?.status, "DONE");

    // Retry without recovery contract must not call collector again
    collectorCalls = 0;
    const retry = await executeCanonicalArsenkinStage(makeDeps(), {
      caseId: caseB,
      reportRunId: runB,
      dbReadinessPath: join(outB, "arsenkin-db-readiness.json"),
      outRoot: outB,
      tokenPresent: true,
      liveConfirm: true,
      mode: "execute-live",
      stage: "FIRST36_STAGE1",
      workflow: "first36-full",
      maxNewTasks: 20,
      maxEstimatedLimits: 20,
      confirmPlanDigest: planB.digest!,
    });
    assert.equal(retry.ok, false);
    assert.equal(collectorCalls, 0);

    // Cleanup primary + secondary
    for (const id of [reportRunId, runB]) {
      await prisma.serpObservation.deleteMany({ where: { auditRunId: id } });
      await prisma.surfaceCollectionCoverage.deleteMany({ where: { reportRunId: id } });
      await prisma.providerTask.deleteMany({ where: { reportRunId: id } });
      await prisma.orionArsenkinStageRun.deleteMany({ where: { reportRunId: id } });
      await prisma.searchDocument.deleteMany({
        where: { caseId: { in: [caseId, caseB] } },
      });
      await prisma.orionReportRun.deleteMany({ where: { id } });
    }
    await prisma.subject.deleteMany({ where: { caseId: { in: [caseId, caseB] } } });
    await prisma.case.deleteMany({ where: { id: { in: [caseId, caseB] } } });

    const remainTasks = await prisma.providerTask.count({
      where: { reportRunId: { in: [reportRunId, runB] } },
    });
    assert.equal(remainTasks, 0);

    const dossier = {
      version: "arsenkin-p05-acceptance-lifecycle-v1",
      verdict: "PASS",
      reportRunId,
      stage1Digest,
      stage2Digest,
      collectorCallsTotalExpected: "documented-per-step",
      networkCalls: getArsenkinNetworkCallCount(),
      fingerprint: fp,
      stage1Url: STAGE1_URL,
    };
    writeJsonAtomic(join(ART, "arsenkin-p05-lifecycle-result.json"), dossier);
    console.log(JSON.stringify({ ...dossier, ok: true }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
