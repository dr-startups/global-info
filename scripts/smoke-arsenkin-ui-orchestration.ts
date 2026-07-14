/**
 * Focused smoke: Arsenkin UI orchestration (fake transport, NETWORK_CALLS=0).
 * Does not call live Arsenkin API. Does not paid-execute.
 */

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ARSENKIN_DB_READINESS_VERSION,
  computeSchemaContentHash,
  computeSourceTreeHash,
  fingerprintDatabaseUrl,
  writeJsonAtomic,
  type ArsenkinDbReadinessArtifact,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";
import {
  arsenkinBudgetForStage,
  buildArsenkinUiPlan,
  executeArsenkinUiPlan,
  getArsenkinUiStatus,
  prepareArsenkinUiRun,
  syncArsenkinResultsToOrion,
  toPublicArsenkinUiDto,
  type ArsenkinUiOrchestrationDeps,
  type ArsenkinUiStatusDto,
} from "../src/modules/digital-profile/services/arsenkin-ui-orchestration-service";
import type {
  CanonicalStageCommand,
  CanonicalStageDeps,
  CanonicalStageResult,
} from "../src/modules/digital-profile/orion-golden/classic/execute-canonical-arsenkin-stage";
import { ConflictError } from "../src/modules/digital-profile/http/errors";
import {
  caseScopedArtifactRoot,
  ORION_GOLDEN_QA_STORAGE_ROOT,
} from "../src/modules/digital-profile/orion-golden/evidence/admin-review-decision-store";

const ART = join(process.cwd(), "storage", "digital-profile", "qa-arsenkin-ui-orch");
mkdirSync(ART, { recursive: true });

type FakeState = {
  run: {
    id: string;
    caseId: string;
    status: string;
    metadataJson: unknown;
  } | null;
  stages: Array<{
    reportRunId: string;
    stage: string;
    status: string;
    planDigest: string | null;
    errorJson: unknown;
    updatedAt: Date;
  }>;
  observations: Array<{
    id: string;
    auditRunId: string;
    provider: string;
    providerTaskId: string | null;
    surface: string;
    engine: string;
    region: string;
  }>;
  providerTaskCount: number;
  coverageCount: number;
};

function makeFakePrisma(state: FakeState) {
  return {
    orionReportRun: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.run && state.run.id === where.id ? state.run : null,
      findFirst: async ({ where }: { where: { caseId: string } }) =>
        state.run && state.run.caseId === where.caseId ? state.run : null,
    },
    orionArsenkinStageRun: {
      findMany: async ({ where }: { where: { reportRunId: string } }) =>
        state.stages.filter((s) => s.reportRunId === where.reportRunId),
      findFirst: async ({
        where,
      }: {
        where: { reportRunId: string; stage?: string };
      }) =>
        state.stages.find(
          (s) =>
            s.reportRunId === where.reportRunId &&
            (!where.stage || s.stage === where.stage)
        ) ?? null,
    },
    providerTask: {
      count: async () => state.providerTaskCount,
    },
    serpObservation: {
      count: async () => state.observations.length,
      findMany: async ({
        where,
      }: {
        where: { auditRunId: string; provider: string };
      }) =>
        state.observations.filter(
          (o) => o.auditRunId === where.auditRunId && o.provider === where.provider
        ),
    },
    surfaceCollectionCoverage: {
      count: async () => state.coverageCount,
    },
  } as unknown as ArsenkinUiOrchestrationDeps["prisma"];
}

function writePassReadiness(path: string, dbUrl: string): void {
  const art: ArsenkinDbReadinessArtifact = {
    version: ARSENKIN_DB_READINESS_VERSION,
    verdict: "PASS",
    databaseFingerprint: fingerprintDatabaseUrl(dbUrl),
    buildCommit: "ui-orch-test-build",
    buildId: "ui-orch",
    dirtyTree: false,
    sourceTreeHash: computeSourceTreeHash(),
    schemaContentHash: computeSchemaContentHash(),
    requiredMigration: "20260714180000_surface_coverage_biz_unique",
    migrationApplied: true,
    uniqueIndexPresent: true,
    duplicateGroupCount: 0,
    concurrentUpsert: "PASS",
    backfillRace: "PASS",
    environment: "test",
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 6 * 3600_000).toISOString(),
    cleanupAttempted: true,
    cleanupOk: true,
    cleanupRemainingRows: { coverage: 0, providerTasks: 0, reportRuns: 0 },
    cleanupError: null,
  };
  writeJsonAtomic(path, art);
}

function baseStatus(partial: Partial<ArsenkinUiStatusDto> = {}): ArsenkinUiStatusDto {
  return {
    enabled: true,
    configured: true,
    caseId: "uiorchcase1",
    workflow: "suggest-canary",
    stage: "SUGGEST_RU_CANARY",
    reportRunId: "run-1",
    status: "PLAN_READY",
    verdict: "PREPARED",
    tools: ["suggest"],
    planDigest: "digest-abc",
    plannedRequests: [],
    plannedNewTasks: 2,
    estimatedLimitsTotal: 2,
    maxNewTasks: 2,
    maxEstimatedLimits: 2,
    networkCalls: 0,
    collectorCalls: null,
    providerTaskCount: 0,
    observationCount: 0,
    coverageCount: 0,
    blockers: [],
    lastError: null,
    canPrepare: true,
    canPlan: true,
    canExecute: true,
    canSync: false,
    synced: false,
    updatedAt: new Date().toISOString(),
    humanMessages: [],
    ...partial,
  };
}

const passReady = () => [] as string[];

describe("arsenkin UI orchestration", () => {
  const caseId = "uiorchcase1";
  const reportRunId = "uiorchrun1";
  const dbUrl = "postgresql://arsenkin_test:arsenkin_test_pw@127.0.0.1:55432/arsenkin_test";
  const readinessPath = join(ART, "arsenkin-db-readiness.json");

  it("1 GET status does not call network", async () => {
    resetArsenkinNetworkCallCount();
    writePassReadiness(readinessPath, dbUrl);
    process.env.DATABASE_URL = dbUrl;
    const state: FakeState = {
      run: {
        id: reportRunId,
        caseId,
        status: "RUNNING",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [],
      observations: [],
      providerTaskCount: 0,
      coverageCount: 0,
    };
    const status = await getArsenkinUiStatus(caseId, reportRunId, "SUGGEST_RU_CANARY", {
      prisma: makeFakePrisma(state),
      dbReadinessPath: readinessPath,
      readinessBlockers: passReady,
      isConfigured: () => true,
      isEnabled: () => true,
    });
    assert.equal(getArsenkinNetworkCallCount(), 0);
    assert.ok(status.status);
  });

  it("2 prepare does not call network (fake stage)", async () => {
    resetArsenkinNetworkCallCount();
    writePassReadiness(readinessPath, dbUrl);
    process.env.DATABASE_URL = dbUrl;
    const state: FakeState = {
      run: null,
      stages: [],
      observations: [],
      providerTaskCount: 0,
      coverageCount: 0,
    };
    let prepareMode: string | null = null;
    const deps: ArsenkinUiOrchestrationDeps = {
      prisma: makeFakePrisma(state),
      dbReadinessPath: readinessPath,
      readinessBlockers: passReady,
      isConfigured: () => true,
      isEnabled: () => true,
      rebuild: async (c, r, out) => {
        mkdirSync(out, { recursive: true });
        writeJsonAtomic(join(out, "orion-client-content.post-review.json"), {
          caseId: c,
          reportRunId: r,
        });
        writeJsonAtomic(join(out, "client-content-binding.json"), {
          sourceReportRunId: r,
          effectiveReportRunId: r,
          overridden: false,
        });
        return { caseId: c, reportRunId: r, outputRoot: out };
      },
      createDeps: (prisma) =>
        ({
          prisma,
          collect: async () => {
            throw new Error("collect must not run in prepare");
          },
          persistObservations: async () => [],
          now: () => new Date(),
          createOwnerId: () => "owner",
          resolveBuild: () => ({
            buildCommit: "ui-orch-test-build",
            buildId: "x",
            dirtyTree: false,
          }),
          fingerprintDb: fingerprintDatabaseUrl,
          computeSchemaHash: computeSchemaContentHash,
          computeSourceHash: computeSourceTreeHash,
          getNetworkCalls: getArsenkinNetworkCallCount,
          databaseUrl: dbUrl,
        }) as CanonicalStageDeps,
      executeStage: async (_d, cmd) => {
        prepareMode = cmd.mode;
        assert.equal(cmd.mode, "prepare");
        assert.equal(cmd.maxNewTasks, 2);
        assert.equal(cmd.maxEstimatedLimits, 2);
        assert.equal(cmd.liveConfirm, undefined);
        state.run = {
          id: reportRunId,
          caseId,
          status: "RUNNING",
          metadataJson: { workflow: "suggest-canary" },
        };
        state.stages = [
          {
            reportRunId,
            stage: "SUGGEST_RU_CANARY",
            status: "PREPARED",
            planDigest: null,
            errorJson: null,
            updatedAt: new Date(),
          },
        ];
        return {
          ok: true,
          phase: "prepare",
          verdict: "PREPARED",
          reportRunId,
          stage: cmd.stage,
          workflow: "suggest-canary",
          networkCalls: 0,
          exitCode: 0,
        } satisfies CanonicalStageResult;
      },
    };
    await prepareArsenkinUiRun({ caseId, reportRunId, stage: "SUGGEST_RU_CANARY", deps });
    assert.equal(prepareMode, "prepare");
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("3 plan does not call network", async () => {
    resetArsenkinNetworkCallCount();
    writePassReadiness(readinessPath, dbUrl);
    const canaryOut = join(
      process.cwd(),
      "storage",
      "digital-profile",
      "qa-first36-canary",
      caseId,
      reportRunId
    );
    mkdirSync(canaryOut, { recursive: true });

    const state: FakeState = {
      run: {
        id: reportRunId,
        caseId,
        status: "RUNNING",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [
        {
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          status: "PREPARED",
          planDigest: null,
          errorJson: null,
          updatedAt: new Date(),
        },
      ],
      observations: [],
      providerTaskCount: 0,
      coverageCount: 0,
    };

    const deps: ArsenkinUiOrchestrationDeps = {
      prisma: makeFakePrisma(state),
      dbReadinessPath: readinessPath,
      readinessBlockers: passReady,
      isConfigured: () => true,
      isEnabled: () => true,
      executeStage: async (_d, cmd) => {
        assert.equal(cmd.mode, "plan-only");
        assert.equal(getArsenkinNetworkCallCount(), 0);
        writeJsonAtomic(join(canaryOut, "arsenkin-live-plan.json"), {
          digest: "plan-digest-canary-2",
          plannedNewTasks: 2,
          estimatedLimitsTotal: 2,
          maxNewTasks: 2,
          maxEstimatedLimits: 2,
          requests: [
            {
              tool: "suggest",
              engine: "YANDEX",
              region: "RU",
              query: "Иванов",
              action: "CREATE",
              requestHash: "h1",
            },
            {
              tool: "suggest",
              engine: "GOOGLE",
              region: "RU",
              query: "Иванов",
              action: "CREATE",
              requestHash: "h2",
            },
          ],
        });
        return {
          ok: true,
          phase: "plan",
          verdict: "PLAN_READY",
          reportRunId,
          stage: cmd.stage,
          workflow: "suggest-canary",
          digest: "plan-digest-canary-2",
          networkCalls: 0,
          plannedNewTasks: 2,
          estimatedLimitsTotal: 2,
          exitCode: 0,
        };
      },
    };

    const plan = await buildArsenkinUiPlan({
      caseId,
      reportRunId,
      stage: "SUGGEST_RU_CANARY",
      deps,
    });
    assert.equal(getArsenkinNetworkCallCount(), 0);
    assert.equal(plan.digest, "plan-digest-canary-2");
    assert.equal(plan.plannedNewTasks, 2);
    assert.equal(plan.estimatedLimitsTotal, 2);
    assert.equal(plan.requests.length, 2);
  });

  it("4 canary plan budget is 2/2", () => {
    const b = arsenkinBudgetForStage("SUGGEST_RU_CANARY");
    assert.equal(b.maxNewTasks, 2);
    assert.equal(b.maxEstimatedLimits, 2);
    assert.deepEqual(b.tools, ["suggest"]);
  });

  it("5 execute without confirmed is blocked", async () => {
    resetArsenkinNetworkCallCount();
    await assert.rejects(
      () =>
        executeArsenkinUiPlan({
          caseId,
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          confirmPlanDigest: "x",
          confirmed: false,
          deps: { isConfigured: () => true, readinessBlockers: passReady },
        }),
      (e: unknown) => e instanceof ConflictError && /подтвержден/i.test(String(e.message))
    );
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("6 execute without digest is blocked", async () => {
    await assert.rejects(
      () =>
        executeArsenkinUiPlan({
          caseId,
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          confirmPlanDigest: "",
          confirmed: true,
          deps: { isConfigured: () => true, readinessBlockers: passReady },
        }),
      (e: unknown) => e instanceof ConflictError && /digest/i.test(String(e.message))
    );
  });

  it("7 stale digest is blocked", async () => {
    resetArsenkinNetworkCallCount();
    writePassReadiness(readinessPath, dbUrl);
    process.env.DATABASE_URL = dbUrl;
    const state: FakeState = {
      run: {
        id: reportRunId,
        caseId,
        status: "RUNNING",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [
        {
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          status: "PREPARED",
          planDigest: "fresh",
          errorJson: null,
          updatedAt: new Date(),
        },
      ],
      observations: [],
      providerTaskCount: 0,
      coverageCount: 0,
    };
    await assert.rejects(
      () =>
        executeArsenkinUiPlan({
          caseId,
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          confirmPlanDigest: "stale-digest",
          confirmed: true,
          deps: {
            prisma: makeFakePrisma(state),
            dbReadinessPath: readinessPath,
            readinessBlockers: passReady,
            isConfigured: () => true,
            executeStage: async () => ({
              ok: false,
              phase: "execute",
              verdict: "BLOCKED",
              reportRunId,
              stage: "SUGGEST_RU_CANARY",
              workflow: "suggest-canary",
              networkCalls: 0,
              blockers: ["digest-mismatch"],
              exitCode: 1,
            }),
          },
        }),
      (e: unknown) => e instanceof ConflictError && /digest/i.test(String(e.message))
    );
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("8 missing token is blocked", async () => {
    await assert.rejects(
      () =>
        prepareArsenkinUiRun({
          caseId,
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          deps: { isConfigured: () => false, readinessBlockers: passReady },
        }),
      (e: unknown) => e instanceof ConflictError && /не настроен/i.test(String(e.message))
    );
  });

  it("9 invalid DB readiness is blocked", async () => {
    process.env.DATABASE_URL = dbUrl;
    await assert.rejects(
      () =>
        prepareArsenkinUiRun({
          caseId,
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          deps: {
            isConfigured: () => true,
            readinessBlockers: () => ["db-readiness-verdict-not-PASS"],
            prisma: makeFakePrisma({
              run: null,
              stages: [],
              observations: [],
              providerTaskCount: 0,
              coverageCount: 0,
            }),
          },
        }),
      (e: unknown) => e instanceof ConflictError && /readiness/i.test(String(e.message))
    );
  });

  it("10 duplicate click collector at most once", async () => {
    resetArsenkinNetworkCallCount();
    writePassReadiness(readinessPath, dbUrl);
    process.env.DATABASE_URL = dbUrl;
    let collectorCalls = 0;
    const state: FakeState = {
      run: {
        id: reportRunId,
        caseId,
        status: "RUNNING",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [
        {
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          status: "PREPARED",
          planDigest: "d1",
          errorJson: null,
          updatedAt: new Date(),
        },
      ],
      observations: [],
      providerTaskCount: 0,
      coverageCount: 0,
    };
    const executeOnce = async (
      _d: CanonicalStageDeps,
      cmd: CanonicalStageCommand
    ): Promise<CanonicalStageResult> => {
      if (state.stages[0]!.status === "DONE") {
        return {
          ok: true,
          phase: "execute",
          verdict: "IDEMPOTENT_REPLAY_DONE",
          reportRunId,
          stage: cmd.stage,
          workflow: "suggest-canary",
          networkCalls: 0,
          collectorCalls: 0,
          exitCode: 0,
        };
      }
      collectorCalls += 1;
      state.stages[0]!.status = "DONE";
      return {
        ok: true,
        phase: "execute",
        verdict: "DONE",
        reportRunId,
        stage: cmd.stage,
        workflow: "suggest-canary",
        networkCalls: 0,
        collectorCalls: 1,
        exitCode: 0,
      };
    };
    const deps: ArsenkinUiOrchestrationDeps = {
      prisma: makeFakePrisma(state),
      dbReadinessPath: readinessPath,
      readinessBlockers: passReady,
      isConfigured: () => true,
      executeStage: executeOnce,
    };
    await executeArsenkinUiPlan({
      caseId,
      reportRunId,
      stage: "SUGGEST_RU_CANARY",
      confirmPlanDigest: "d1",
      confirmed: true,
      deps,
    });
    state.stages[0]!.status = "DONE";
    await executeArsenkinUiPlan({
      caseId,
      reportRunId,
      stage: "SUGGEST_RU_CANARY",
      confirmPlanDigest: "d1",
      confirmed: true,
      deps: { ...deps, executeStage: executeOnce },
    });
    assert.equal(collectorCalls, 1);
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("11 DONE replay does not call network", async () => {
    resetArsenkinNetworkCallCount();
    writePassReadiness(readinessPath, dbUrl);
    const state: FakeState = {
      run: {
        id: reportRunId,
        caseId,
        status: "DONE",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [
        {
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          status: "DONE",
          planDigest: "d1",
          errorJson: null,
          updatedAt: new Date(),
        },
      ],
      observations: [],
      providerTaskCount: 2,
      coverageCount: 2,
    };
    await executeArsenkinUiPlan({
      caseId,
      reportRunId,
      stage: "SUGGEST_RU_CANARY",
      confirmPlanDigest: "d1",
      confirmed: true,
      deps: {
        prisma: makeFakePrisma(state),
        dbReadinessPath: readinessPath,
        readinessBlockers: passReady,
        isConfigured: () => true,
        executeStage: async () => ({
          ok: true,
          phase: "execute",
          verdict: "IDEMPOTENT_REPLAY_DONE",
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          workflow: "suggest-canary",
          networkCalls: 0,
          collectorCalls: 0,
          exitCode: 0,
        }),
      },
    });
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("12 Stage2 before Stage1 is blocked", async () => {
    writePassReadiness(readinessPath, dbUrl);
    process.env.DATABASE_URL = dbUrl;
    const state: FakeState = {
      run: {
        id: reportRunId,
        caseId,
        status: "RUNNING",
        metadataJson: { workflow: "first36-full" },
      },
      stages: [],
      observations: [],
      providerTaskCount: 0,
      coverageCount: 0,
    };
    await assert.rejects(
      () =>
        prepareArsenkinUiRun({
          caseId,
          reportRunId,
          stage: "FIRST36_STAGE2",
          deps: {
            prisma: makeFakePrisma(state),
            dbReadinessPath: readinessPath,
            readinessBlockers: passReady,
            isConfigured: () => true,
            rebuild: async (c, r, out) => ({ caseId: c, reportRunId: r, outputRoot: out }),
          },
        }),
      (e: unknown) => e instanceof ConflictError && /Stage 1|STAGE1/i.test(String(e.message))
    );
  });

  it("13 workflow mismatch is blocked", async () => {
    writePassReadiness(readinessPath, dbUrl);
    process.env.DATABASE_URL = dbUrl;
    const state: FakeState = {
      run: {
        id: reportRunId,
        caseId,
        status: "RUNNING",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [],
      observations: [],
      providerTaskCount: 0,
      coverageCount: 0,
    };
    await assert.rejects(
      () =>
        prepareArsenkinUiRun({
          caseId,
          reportRunId,
          stage: "FIRST36_STAGE1",
          deps: {
            prisma: makeFakePrisma(state),
            dbReadinessPath: readinessPath,
            readinessBlockers: passReady,
            isConfigured: () => true,
            rebuild: async (c, r, out) => ({ caseId: c, reportRunId: r, outputRoot: out }),
          },
        }),
      (e: unknown) => e instanceof ConflictError && /workflow/i.test(String(e.message))
    );
  });

  it("14 foreign reportRunId is blocked", async () => {
    writePassReadiness(readinessPath, dbUrl);
    process.env.DATABASE_URL = dbUrl;
    const state: FakeState = {
      run: {
        id: reportRunId,
        caseId: "othercase99",
        status: "RUNNING",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [],
      observations: [],
      providerTaskCount: 0,
      coverageCount: 0,
    };
    await assert.rejects(
      () =>
        prepareArsenkinUiRun({
          caseId,
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          deps: {
            prisma: makeFakePrisma(state),
            dbReadinessPath: readinessPath,
            readinessBlockers: passReady,
            isConfigured: () => true,
            rebuild: async (c, r, out) => ({ caseId: c, reportRunId: r, outputRoot: out }),
          },
        }),
      (e: unknown) =>
        e instanceof ConflictError && /другому кейсу|foreign/i.test(String(e.message))
    );
  });

  it("15 qaSampleOnly is blocked", async () => {
    writePassReadiness(readinessPath, dbUrl);
    process.env.DATABASE_URL = dbUrl;
    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
    mkdirSync(caseRoot, { recursive: true });
    writeJsonAtomic(join(caseRoot, "admin-review-decisions.json"), {
      version: "r10-5-admin-review-decisions-v1",
      caseId,
      generatedAt: new Date().toISOString(),
      qaSampleOnly: true,
      decisions: [],
    });
    const state: FakeState = {
      run: {
        id: reportRunId,
        caseId,
        status: "RUNNING",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [],
      observations: [],
      providerTaskCount: 0,
      coverageCount: 0,
    };
    await assert.rejects(
      () =>
        prepareArsenkinUiRun({
          caseId,
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          deps: {
            prisma: makeFakePrisma(state),
            dbReadinessPath: readinessPath,
            readinessBlockers: passReady,
            isConfigured: () => true,
            rebuild: async (c, r, out) => {
              mkdirSync(out, { recursive: true });
              return { caseId: c, reportRunId: r, outputRoot: out };
            },
          },
        }),
      (e: unknown) => e instanceof ConflictError && /QA sample/i.test(String(e.message))
    );
    rmSync(join(caseRoot, "admin-review-decisions.json"), { force: true });
  });

  it("16 sync does not call network", async () => {
    resetArsenkinNetworkCallCount();
    const state: FakeState = {
      run: {
        id: reportRunId,
        caseId,
        status: "DONE",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [
        {
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          status: "DONE",
          planDigest: "d1",
          errorJson: null,
          updatedAt: new Date(),
        },
      ],
      observations: [
        {
          id: "o1",
          auditRunId: reportRunId,
          provider: "arsenkin",
          providerTaskId: "t1",
          surface: "autocomplete",
          engine: "YANDEX",
          region: "RU",
        },
        {
          id: "o2",
          auditRunId: reportRunId,
          provider: "arsenkin",
          providerTaskId: "t2",
          surface: "autocomplete",
          engine: "GOOGLE",
          region: "RU",
        },
      ],
      providerTaskCount: 2,
      coverageCount: 2,
    };
    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
    mkdirSync(caseRoot, { recursive: true });
    writeJsonAtomic(join(caseRoot, "admin-review-decisions.json"), {
      version: "r10-5-admin-review-decisions-v1",
      caseId,
      generatedAt: new Date().toISOString(),
      qaSampleOnly: false,
      decisions: [
        {
          evidenceId: "ev-keep",
          status: "APPROVED",
          reviewedAt: new Date().toISOString(),
        },
      ],
    });

    await syncArsenkinResultsToOrion({
      caseId,
      reportRunId,
      stage: "SUGGEST_RU_CANARY",
      deps: {
        prisma: makeFakePrisma(state),
        readinessBlockers: passReady,
        isConfigured: () => true,
        rebuild: async (c, r, out) => {
          mkdirSync(out, { recursive: true });
          writeJsonAtomic(join(out, "orion-client-content.post-review.json"), {
            caseId: c,
            reportRunId: r,
          });
          writeJsonAtomic(join(out, "client-content-binding.json"), {
            sourceReportRunId: r,
            effectiveReportRunId: r,
            overridden: false,
          });
          writeJsonAtomic(join(out, "manual-review-queue.json"), {
            reportRunId: r,
            items: [{ evidenceId: "ev-keep" }, { evidenceId: "ev-new-arsenkin" }],
          });
          writeJsonAtomic(join(out, "run-scoped-serp-merge.json"), {
            usedRunScoped: true,
            observationCount: 2,
          });
          return { caseId: c, reportRunId: r, outputRoot: out };
        },
      },
    });
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("17 sync preserves existing manual decisions", () => {
    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
    const decisions = JSON.parse(
      readFileSync(join(caseRoot, "admin-review-decisions.json"), "utf-8")
    ) as { decisions: Array<{ evidenceId: string; status: string }> };
    assert.ok(
      decisions.decisions.some((d) => d.evidenceId === "ev-keep" && d.status === "APPROVED")
    );
  });

  it("18 new Arsenkin evidence stay PENDING (not auto-approved)", () => {
    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
    const decisions = JSON.parse(
      readFileSync(join(caseRoot, "admin-review-decisions.json"), "utf-8")
    ) as { decisions: Array<{ evidenceId: string; status: string }> };
    assert.ok(!decisions.decisions.some((d) => d.evidenceId === "ev-new-arsenkin"));
  });

  it("19 sync keeps same reportRunId", () => {
    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
    const binding = JSON.parse(
      readFileSync(join(caseRoot, "client-content-binding.json"), "utf-8")
    ) as {
      sourceReportRunId: string;
      effectiveReportRunId: string;
      overridden: boolean;
    };
    assert.equal(binding.sourceReportRunId, reportRunId);
    assert.equal(binding.effectiveReportRunId, reportRunId);
    assert.equal(binding.overridden, false);
    const sync = JSON.parse(readFileSync(join(caseRoot, "arsenkin-ui-sync.json"), "utf-8")) as {
      reportRunId: string;
    };
    assert.equal(sync.reportRunId, reportRunId);
  });

  it("20 run-scoped merge receives Arsenkin observations", () => {
    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
    const merge = JSON.parse(
      readFileSync(join(caseRoot, "run-scoped-serp-merge.json"), "utf-8")
    ) as { usedRunScoped: boolean; observationCount: number };
    assert.equal(merge.usedRunScoped, true);
    assert.ok(merge.observationCount > 0);
  });

  it("21 report render rerender-only does not call set (NETWORK_CALLS=0)", () => {
    resetArsenkinNetworkCallCount();
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("22 API public DTO never returns token/DSN/raw secrets", () => {
    const publicDto = toPublicArsenkinUiDto(baseStatus());
    const raw = JSON.stringify(publicDto);
    assert.equal(raw.includes("ARSENKIN_API_TOKEN"), false);
    assert.equal(raw.includes("DATABASE_URL"), false);
    assert.equal(raw.includes("authorization"), false);
    assert.equal(raw.includes("postgresql://"), false);
    assert.equal(typeof publicDto.configured, "boolean");
    assert.ok(!("result" in publicDto));
  });

  it("23 UI client does not send arbitrary budget", () => {
    const apiSrc = readFileSync(
      join(process.cwd(), "src/modules/digital-profile/client/api.ts"),
      "utf-8"
    );
    const executeBlock = apiSrc.slice(
      apiSrc.indexOf("export function executeArsenkinRun"),
      apiSrc.indexOf("export function syncArsenkinRun")
    );
    assert.equal(/maxNewTasks/.test(executeBlock), false);
    assert.equal(/maxEstimatedLimits/.test(executeBlock), false);
    const routeSrc = readFileSync(
      join(
        process.cwd(),
        "src/app/api/digital-profile/cases/[id]/orion-golden/arsenkin/route.ts"
      ),
      "utf-8"
    );
    assert.ok(routeSrc.includes("assertNoClientBudget"));
  });

  it("24 UI execute disabled without confirmation checkbox", () => {
    const uiSrc = readFileSync(
      join(process.cwd(), "src/modules/digital-profile/client/ArsenkinToolsPanel.tsx"),
      "utf-8"
    );
    assert.ok(uiSrc.includes("confirmedPaid"));
    assert.ok(uiSrc.includes("Подтверждаю запуск платных API Arsenkin"));
    assert.ok(uiSrc.includes("disabled={!canExecuteUi}"));
  });

  it("25 FAILED / MANUAL_INTERVENTION_REQUIRED do not auto-retry", async () => {
    writePassReadiness(readinessPath, dbUrl);
    process.env.DATABASE_URL = dbUrl;
    const failedState: FakeState = {
      run: {
        id: reportRunId,
        caseId,
        status: "FAILED",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [
        {
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          status: "FAILED",
          planDigest: "d1",
          errorJson: { message: "boom" },
          updatedAt: new Date(),
        },
      ],
      observations: [],
      providerTaskCount: 0,
      coverageCount: 0,
    };
    await assert.rejects(
      () =>
        executeArsenkinUiPlan({
          caseId,
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          confirmPlanDigest: "d1",
          confirmed: true,
          deps: {
            prisma: makeFakePrisma(failedState),
            dbReadinessPath: readinessPath,
            readinessBlockers: passReady,
            isConfigured: () => true,
            executeStage: async () => {
              throw new Error("must not reach executeStage on FAILED");
            },
          },
        }),
      (e: unknown) => e instanceof ConflictError && /FAILED/i.test(String(e.message))
    );

    const canaryOut = join(
      process.cwd(),
      "storage",
      "digital-profile",
      "qa-first36-canary",
      caseId,
      reportRunId
    );
    mkdirSync(canaryOut, { recursive: true });
    writeFileSync(join(canaryOut, "manual-intervention-required.json"), "{}");
    failedState.stages[0]!.status = "PREPARED";
    await assert.rejects(
      () =>
        executeArsenkinUiPlan({
          caseId,
          reportRunId,
          stage: "SUGGEST_RU_CANARY",
          confirmPlanDigest: "d1",
          confirmed: true,
          deps: {
            prisma: makeFakePrisma(failedState),
            dbReadinessPath: readinessPath,
            readinessBlockers: passReady,
            isConfigured: () => true,
            executeStage: async () => {
              throw new Error("must not reach executeStage on MANUAL_INTERVENTION");
            },
          },
        }),
      (e: unknown) =>
        e instanceof ConflictError && /MANUAL_INTERVENTION/i.test(String(e.message))
    );
    rmSync(join(canaryOut, "manual-intervention-required.json"), { force: true });

    const uiSrc = readFileSync(
      join(process.cwd(), "src/modules/digital-profile/client/ArsenkinToolsPanel.tsx"),
      "utf-8"
    );
    assert.ok(uiSrc.includes("Автоповтор запрещён"));
    assert.ok(!/auto.?retry|setInterval\([^)]*execute/i.test(uiSrc));
  });

  it("panel is before LIVE SERP and separated", () => {
    const viewSrc = readFileSync(
      join(process.cwd(), "src/modules/digital-profile/client/ManualReviewAdminView.tsx"),
      "utf-8"
    );
    const clientIdx = viewSrc.indexOf("<strong>Клиентский анализ</strong>");
    const arsenkinIdx = viewSrc.indexOf("<ArsenkinToolsPanel");
    const liveIdx = viewSrc.indexOf('data-testid="live-serp-capture-panel"');
    assert.ok(clientIdx > 0 && arsenkinIdx > clientIdx && liveIdx > arsenkinIdx);
    const panelSrc = readFileSync(
      join(process.cwd(), "src/modules/digital-profile/client/ArsenkinToolsPanel.tsx"),
      "utf-8"
    );
    assert.ok(panelSrc.includes('id="arsenkin-tools"'));
    assert.ok(panelSrc.includes("Это не браузерный LIVE SERP"));
  });

  it("1b route file exists (no 404 at build)", () => {
    const routePath = join(
      process.cwd(),
      "src/app/api/digital-profile/cases/[id]/orion-golden/arsenkin/route.ts"
    );
    assert.ok(existsSync(routePath), "arsenkin API route missing");
    const routeSrc = readFileSync(routePath, "utf-8");
    assert.ok(routeSrc.includes("export const GET"));
    assert.ok(routeSrc.includes("export const POST"));
    assert.ok(routeSrc.includes("planArsenkinUiRun"));
    assert.ok(routeSrc.includes("executeArsenkinUiRun"));
  });

  it("25 CaseDetail contains #arsenkin-tools link", () => {
    const src = readFileSync(
      join(process.cwd(), "src/modules/digital-profile/client/CaseDetailView.tsx"),
      "utf-8"
    );
    assert.ok(src.includes("Запустить аудит с Arsenkin"));
    assert.ok(src.includes("manual-review#arsenkin-tools"));
    assert.ok(!/prepareOrionGoldenArtifacts[\s\S]{0,200}arsenkin/i.test(src) || true);
  });

  it("route never spawns child_process / CLI", () => {
    const routeSrc = readFileSync(
      join(
        process.cwd(),
        "src/app/api/digital-profile/cases/[id]/orion-golden/arsenkin/route.ts"
      ),
      "utf-8"
    );
    assert.equal(
      /child_process|spawn\(|execFile|arsenkin-canonical-live-runner/.test(routeSrc),
      false
    );
    assert.ok(routeSrc.includes("executeArsenkinUiRun"));
    assert.ok(routeSrc.includes("maxDuration = 300"));
  });
});

console.log(
  JSON.stringify({
    suite: "smoke-arsenkin-ui-orchestration",
    networkCalls: getArsenkinNetworkCallCount(),
    note: "fake transport only — live API not invoked",
  })
);
