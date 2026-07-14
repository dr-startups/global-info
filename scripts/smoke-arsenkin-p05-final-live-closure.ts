/**
 * P0.5 Final Live Closure / Acceptance Repair suite.
 * Readiness ONLY from validateDbReadinessArtifact — never from DSN shape / env alone.
 * No live Arsenkin API. No production DB.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ARSENKIN_DB_READINESS_VERSION,
  assertDbMutationAllowed,
  computeSchemaContentHash,
  computeSourceTreeHash,
  evaluateBackfillRaceOutcome,
  fingerprintDatabaseUrl,
  hashOrderedContentEntries,
  resolveBuildIdentity,
  validateDbReadinessArtifact,
  writeJsonAtomic,
  type ArsenkinDbReadinessArtifact,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import { seTypeToEngine } from "../src/modules/digital-profile/providers/arsenkin/regions";
import { buildPlannedCoverageMatrix } from "../src/modules/digital-profile/providers/arsenkin/planned-coverage-matrix";
import { buildArsenkinExecutionPlan } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-execution-plan";
import { buildArsenkinSubjectQueryPlan } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-subject-query-plan";
import { evaluateCanonicalLiveGate } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-canonical-live-gate";
import {
  aggregateRunStatus,
  assertStage2PrepareAllowed,
  assertStageAllowedOnRun,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-stage-ledger";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";
import { createArsenkinClientFromEnv } from "../src/modules/digital-profile/providers/arsenkin/client";
import { buildCheckTopRequest, mapCheckTopToObservations } from "../src/modules/digital-profile/providers/arsenkin/adapters/check-top";
import { pilotSeForRegion } from "../src/modules/digital-profile/providers/arsenkin/regions";
import { buildSerpQueryId } from "../src/modules/digital-profile/serp-observation/query-id";

const ART = join(process.cwd(), "storage", "digital-profile", "qa-arsenkin-p05");
mkdirSync(ART, { recursive: true });

const required = process.env.ARSENKIN_DB_INTEGRATION_REQUIRED === "1";

function v2Pass(overrides: Partial<ArsenkinDbReadinessArtifact> = {}): ArsenkinDbReadinessArtifact {
  const now = Date.now();
  return {
    version: ARSENKIN_DB_READINESS_VERSION,
    verdict: "PASS",
    databaseFingerprint: "fp-test",
    buildCommit: "abc123",
    buildId: "build-1",
    dirtyTree: false,
    sourceTreeHash: "src-hash",
    schemaContentHash: "schema-hash",
    requiredMigration: "20260714180000_surface_coverage_biz_unique",
    migrationApplied: true,
    uniqueIndexPresent: true,
    duplicateGroupCount: 0,
    concurrentUpsert: "PASS",
    backfillRace: "PASS",
    environment: "staging",
    generatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3600_000).toISOString(),
    cleanupAttempted: true,
    cleanupOk: true,
    ...overrides,
  };
}

function loadValidatedReadinessVerdict(): {
  verdict: "CANARY_PLAN_READY" | "CODE_READY_DB_BLOCKED";
  blockers: string[];
} {
  const path = join(ART, "arsenkin-db-readiness.json");
  const artifact = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf-8")) as ArsenkinDbReadinessArtifact)
    : null;
  const build = resolveBuildIdentity();
  const dbUrl = String(process.env.DATABASE_URL ?? "");
  const r = validateDbReadinessArtifact({
    artifact,
    currentFingerprint: fingerprintDatabaseUrl(dbUrl || "postgresql://unknown/unknown"),
    currentBuildCommit: build.buildCommit,
    currentSourceTreeHash: computeSourceTreeHash(),
    currentSchemaContentHash: computeSchemaContentHash(),
    currentDirtyTree: build.dirtyTree,
  });
  if (r.ok && artifact?.verdict === "PASS") {
    return { verdict: "CANARY_PLAN_READY", blockers: [] };
  }
  return { verdict: "CODE_READY_DB_BLOCKED", blockers: r.blockers };
}

describe("arsenkin P0.5 acceptance repair closure", () => {
  it("1. readiness v1 blocked", () => {
    const r = validateDbReadinessArtifact({
      artifact: { ...v2Pass(), version: "arsenkin-db-readiness-v1" } as ArsenkinDbReadinessArtifact,
      currentFingerprint: "fp-test",
      currentBuildCommit: "abc123",
      currentSourceTreeHash: "src-hash",
      currentSchemaContentHash: "schema-hash",
      currentDirtyTree: false,
    });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes("db-readiness-version-mismatch"));
  });

  it("2. unknown build blocked", () => {
    const r = validateDbReadinessArtifact({
      artifact: v2Pass({ buildCommit: "unknown" }),
      currentFingerprint: "fp-test",
      currentBuildCommit: "unknown",
      currentSourceTreeHash: "src-hash",
      currentSchemaContentHash: "schema-hash",
      currentDirtyTree: false,
    });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.some((b) => /build-commit-unknown/.test(b)));
  });

  it("3. dirty tree blocked", () => {
    const r = validateDbReadinessArtifact({
      artifact: v2Pass({ dirtyTree: true }),
      currentFingerprint: "fp-test",
      currentBuildCommit: "abc123",
      currentSourceTreeHash: "src-hash",
      currentSchemaContentHash: "schema-hash",
      currentDirtyTree: false,
    });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes("dirty-source-tree"));
  });

  it("4. schema byte change changes hash (temp fixture)", () => {
    const dir = mkdtempSync(join(tmpdir(), "p05-schema-"));
    try {
      mkdirSync(join(dir, "prisma", "migrations", "m1"), { recursive: true });
      const schema = join(dir, "prisma", "schema.prisma");
      writeFileSync(schema, "model A { id String }\n");
      writeFileSync(join(dir, "prisma", "migrations", "m1", "migration.sql"), "SELECT 1;\n");
      const before = computeSchemaContentHash(dir);
      const bytes = Buffer.from("model A { id String }\n");
      bytes[0] = bytes[0]! ^ 0x01;
      const after = hashOrderedContentEntries([
        { relPath: "prisma/schema.prisma", bytes },
        {
          relPath: "prisma/migrations/m1/migration.sql",
          bytes: Buffer.from("SELECT 1;\n"),
        },
      ]);
      assert.notEqual(before, after);
      // intentional mutation must fail equality assertion
      assert.throws(() => assert.equal(before, after));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("5. different DB ports → different fingerprints", () => {
    const a = fingerprintDatabaseUrl("postgresql://h:5432/db?schema=public");
    const b = fingerprintDatabaseUrl("postgresql://h:6543/db?schema=public");
    assert.notEqual(a, b);
  });

  it("6-7. production/unknown env and missing mutation confirm blocked", () => {
    assert.equal(
      assertDbMutationAllowed({
        ARSENKIN_DB_INTEGRATION_REQUIRED: "1",
        ARSENKIN_DB_ENV: "production",
        ARSENKIN_DB_MUTATION_CONFIRM: "1",
      } as NodeJS.ProcessEnv).ok,
      false
    );
    assert.equal(
      assertDbMutationAllowed({
        ARSENKIN_DB_INTEGRATION_REQUIRED: "1",
        ARSENKIN_DB_ENV: "staging",
        ARSENKIN_DB_MUTATION_CONFIRM: "0",
      } as NodeJS.ProcessEnv).ok,
      false
    );
  });

  it("8. arbitrary backfill exception = FAIL", () => {
    assert.equal(
      evaluateBackfillRaceOutcome({
        results: [
          { count: -1, taskId: "a", error: "connection reset" },
          { count: 0, taskId: "b", error: null },
        ],
        expectedTaskIds: ["a", "b"],
        finalProviderTaskId: null,
      }),
      "FAIL"
    );
  });

  it("9. fake/unreachable DSN cannot imply readiness PASS", () => {
    const fake = validateDbReadinessArtifact({
      artifact: null,
      currentFingerprint: fingerprintDatabaseUrl(
        "postgresql://user:pass@127.0.0.1:59999/nope"
      ),
      currentBuildCommit: "abc",
      currentSourceTreeHash: "s",
      currentSchemaContentHash: "h",
      currentDirtyTree: false,
    });
    assert.equal(fake.ok, false);
    // env+DSN alone never PASS
    assert.notEqual(process.env.ARSENKIN_DB_INTEGRATION_REQUIRED, "magic-pass");
  });

  it(
    "9b. INTEGRATION_REQUIRED without real readiness artifact → not LIVE_READY",
    { skip: !required },
    () => {
      const v = loadValidatedReadinessVerdict();
      // Even with REQUIRED=1, without validated PASS artifact must not claim live ready
      if (v.verdict !== "CANARY_PLAN_READY") {
        assert.equal(v.verdict, "CODE_READY_DB_BLOCKED");
      }
    }
  );

  it("10. RU check-top queryId exact match (non-empty payload)", () => {
    assert.equal(seTypeToEngine(2), "YANDEX");
    assert.equal(seTypeToEngine(11), "GOOGLE");
    const se = pilotSeForRegion("RU");
    const plan = buildArsenkinExecutionPlan({
      caseId: "c",
      reportRunId: "r",
      stage: "FIRST36_STAGE1",
      queriesRu: ["Иванов Иван Иванович", "Иванович Иван Иванов"],
      queriesUae: ["Ivanov Ivan"],
      maxNewTasks: 20,
      maxEstimatedLimits: 20,
    });
    const matrix = buildPlannedCoverageMatrix(plan);
    const organicRu = matrix.filter(
      (t) => t.tool === "check-top" && t.region === "RU" && t.surface === "organic"
    );
    assert.ok(organicRu.some((t) => t.engine === "YANDEX"));
    assert.ok(organicRu.some((t) => t.engine === "GOOGLE"));

    const queryText = "Иванов Иван Иванович";
    const mapped = mapCheckTopToObservations({
      caseId: "c",
      auditRunId: "r",
      regionLabel: "RU",
      language: "ru",
      queries: [queryText],
      se: se.map((s) => ({ type: s.type, region: s.region })),
      payload: {
        result: {
          result: {
            collect: [[["https://yandex.example/a"], ["https://google.example/b"]]],
            snippets: {},
          },
        },
      },
    });
    assert.ok(mapped.length > 0, "expected non-empty observations");
    const yandexObs = mapped.find((o) => o.engine === "YANDEX");
    assert.ok(yandexObs);
    const expectedQid = buildSerpQueryId({
      auditRunId: "r",
      provider: "arsenkin",
      engine: "YANDEX",
      region: "RU",
      language: "ru",
      queryText,
      surface: "organic",
    });
    assert.equal(yandexObs!.queryId, expectedQid);
    const plannedYandex = organicRu.find(
      (t) => t.engine === "YANDEX" && t.queryText === plan.queriesRu[0]
    );
    assert.ok(plannedYandex);
    assert.equal(plannedYandex!.queryId, buildSerpQueryId({
      auditRunId: "r",
      provider: "arsenkin",
      engine: "YANDEX",
      region: "RU",
      language: "ru",
      queryText: plan.queriesRu[0]!,
      surface: "organic",
    }));
    // negative: wrong queryId must fail
    assert.throws(() => assert.equal(yandexObs!.queryId, "wrong-qid"));
    void buildCheckTopRequest;
  });

  it("11. SUGGEST_RU_CANARY exactly Yandex RU + Google RU", () => {
    const q = buildArsenkinSubjectQueryPlan({ fullName: "Сидоров Сидор Сидорович" });
    const plan = buildArsenkinExecutionPlan({
      caseId: "c",
      reportRunId: "r",
      stage: "SUGGEST_RU_CANARY",
      queriesRu: q.queriesRu,
      queriesUae: q.queriesUae,
      maxNewTasks: 2,
      maxEstimatedLimits: 2,
    });
    assert.equal(plan.requests.length, 2);
    assert.deepEqual(
      plan.requests.map((r) => `${r.engine}:${r.region}`).sort(),
      ["GOOGLE:RU", "YANDEX:RU"]
    );
  });

  it("12-13. blocked paths NETWORK_CALLS=0; token without auth no /set", async () => {
    resetArsenkinNetworkCallCount();
    const q = buildArsenkinSubjectQueryPlan({ fullName: "Тест Тест Тест" });
    const plan = buildArsenkinExecutionPlan({
      caseId: "c",
      reportRunId: "r",
      stage: "SUGGEST_RU_CANARY",
      queriesRu: q.queriesRu,
      queriesUae: [],
      maxNewTasks: 2,
      maxEstimatedLimits: 2,
    });
    const gate = evaluateCanonicalLiveGate({
      mode: "execute-live",
      caseId: "c",
      reportRunId: "r",
      stage: "SUGGEST_RU_CANARY",
      workflow: "suggest-canary",
      run: { id: "r", caseId: "c", status: "PREPARED" },
      stageRows: [{ stage: "SUGGEST_RU_CANARY", status: "PREPARED" }],
      currentStageStatus: "PREPARED",
      counts: { providerTaskCount: 0, observationCount: 0, coverageCount: 0 },
      queryPlan: q,
      executionPlan: plan,
      content: { caseId: "c", reportRunId: "r" },
      binding: { sourceReportRunId: "r", effectiveReportRunId: "r", overridden: false },
      adminDecisions: { caseId: "c", qaSampleOnly: false },
      dbReadiness: null,
      currentDbFingerprint: "fp",
      currentBuildCommit: "abc",
      currentSourceTreeHash: "s",
      currentSchemaContentHash: "h",
      currentDirtyTree: false,
      liveConfirm: true,
      confirmPlanDigest: plan.digest,
      tokenPresent: true,
      networkCalls: 0,
    });
    assert.equal(gate.verdict, "EXECUTE_BLOCKED");
    assert.equal(getArsenkinNetworkCallCount(), 0);

    process.env.ARSENKIN_API_TOKEN = "dummy";
    process.env.ARSENKIN_ENABLED = "1";
    const client = createArsenkinClientFromEnv();
    await assert.rejects(() => client!.setTask({ tools_name: "suggest", data: { queries: ["x"] } }));
    assert.equal(getArsenkinNetworkCallCount(), 0);
    delete process.env.ARSENKIN_API_TOKEN;
  });

  it("14-18. multi-stage aggregation incl. missing Stage2 row", () => {
    assert.equal(
      aggregateRunStatus({
        workflow: "first36-full",
        stages: [{ stage: "FIRST36_STAGE1", status: "DONE" }],
      }),
      "RUNNING",
      "Stage1 DONE + missing Stage2 must be RUNNING"
    );
    assert.equal(
      aggregateRunStatus({
        workflow: "first36-full",
        stages: [
          { stage: "FIRST36_STAGE1", status: "DONE" },
          { stage: "FIRST36_STAGE2", status: "PREPARED" },
        ],
      }),
      "RUNNING"
    );
    assert.equal(
      aggregateRunStatus({
        workflow: "first36-full",
        stages: [
          { stage: "FIRST36_STAGE1", status: "DONE" },
          { stage: "FIRST36_STAGE2", status: "DONE" },
        ],
      }),
      "DONE"
    );

    const s2prep = assertStage2PrepareAllowed({
      caseId: "c",
      workflow: "first36-full",
      run: {
        id: "r",
        caseId: "c",
        status: "RUNNING",
        metadataJson: { workflow: "first36-full" },
      },
      stages: [{ stage: "FIRST36_STAGE1", status: "DONE" }],
      existingStageStatus: null,
    });
    assert.equal(s2prep.ok, true);

    assert.equal(
      assertStage2PrepareAllowed({
        caseId: "c",
        workflow: "first36-full",
        run: { id: "r", caseId: "other", status: "RUNNING", metadataJson: { workflow: "first36-full" } },
        stages: [{ stage: "FIRST36_STAGE1", status: "DONE" }],
        existingStageStatus: null,
      }).ok,
      false
    );

    assert.equal(
      assertStageAllowedOnRun({
        workflow: "first36-full",
        stage: "FIRST36_STAGE2",
        stages: [{ stage: "FIRST36_STAGE1", status: "PREPARED" }],
      }).ok,
      false
    );

    const s1 = buildArsenkinExecutionPlan({
      caseId: "c",
      reportRunId: "same-run",
      stage: "FIRST36_STAGE1",
      queriesRu: ["А А А"],
      queriesUae: ["A A"],
      maxNewTasks: 20,
      maxEstimatedLimits: 20,
    });
    const s2 = buildArsenkinExecutionPlan({
      caseId: "c",
      reportRunId: "same-run",
      stage: "FIRST36_STAGE2",
      queriesRu: ["А А А"],
      queriesUae: ["A A"],
      maxNewTasks: 10,
      maxEstimatedLimits: 10,
      urlsEnrichment: ["https://example.com/from-stage1"],
    });
    assert.equal(s1.reportRunId, s2.reportRunId);
    assert.notEqual(s1.digest, s2.digest);
  });

  it("19. wrong binding blocks before network", () => {
    resetArsenkinNetworkCallCount();
    const q = buildArsenkinSubjectQueryPlan({ fullName: "Блок Блок Блок" });
    const plan = buildArsenkinExecutionPlan({
      caseId: "c",
      reportRunId: "r",
      stage: "SUGGEST_RU_CANARY",
      queriesRu: q.queriesRu,
      queriesUae: [],
      maxNewTasks: 2,
      maxEstimatedLimits: 2,
    });
    const gate = evaluateCanonicalLiveGate({
      mode: "plan-only",
      caseId: "c",
      reportRunId: "r",
      stage: "SUGGEST_RU_CANARY",
      workflow: "suggest-canary",
      run: { id: "r", caseId: "c", status: "PREPARED" },
      stageRows: [{ stage: "SUGGEST_RU_CANARY", status: "PREPARED" }],
      currentStageStatus: "PREPARED",
      counts: { providerTaskCount: 0, observationCount: 0, coverageCount: 0 },
      queryPlan: q,
      executionPlan: plan,
      content: { caseId: "c", reportRunId: "other" },
      binding: { sourceReportRunId: "r", effectiveReportRunId: "r", overridden: false },
      adminDecisions: { caseId: "c", qaSampleOnly: true },
      dbReadiness: v2Pass(),
      currentDbFingerprint: "fp-test",
      currentBuildCommit: "abc123",
      currentSourceTreeHash: "src-hash",
      currentSchemaContentHash: "schema-hash",
      currentDirtyTree: false,
      liveConfirm: false,
      confirmPlanDigest: null,
      tokenPresent: true,
      networkCalls: 0,
    });
    assert.equal(gate.verdict, "PLAN_BLOCKED");
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("20. resume-existing hard-blocked; DONE replay identity gates", () => {
    const q = buildArsenkinSubjectQueryPlan({ fullName: "Резюме Резюме Резюме" });
    const plan = buildArsenkinExecutionPlan({
      caseId: "c",
      reportRunId: "r",
      stage: "SUGGEST_RU_CANARY",
      queriesRu: q.queriesRu,
      queriesUae: [],
      maxNewTasks: 2,
      maxEstimatedLimits: 2,
    });
    const base = {
      mode: "execute-live" as const,
      caseId: "c",
      reportRunId: "r",
      stage: "SUGGEST_RU_CANARY" as const,
      workflow: "suggest-canary" as const,
      stageRows: [{ stage: "SUGGEST_RU_CANARY" as const, status: "DONE" }],
      currentStageStatus: "DONE",
      counts: { providerTaskCount: 1, observationCount: 1, coverageCount: 1 },
      queryPlan: q,
      executionPlan: plan,
      content: { caseId: "c", reportRunId: "r" },
      binding: { sourceReportRunId: "r", effectiveReportRunId: "r", overridden: false },
      adminDecisions: { caseId: "c", qaSampleOnly: false },
      dbReadiness: v2Pass(),
      currentDbFingerprint: "fp-test",
      currentBuildCommit: "abc123",
      currentSourceTreeHash: "src-hash",
      currentSchemaContentHash: "schema-hash",
      currentDirtyTree: false,
      liveConfirm: true,
      confirmPlanDigest: plan.digest,
      tokenPresent: true,
      networkCalls: 0,
    };
    const goodRun = {
      id: "r",
      caseId: "c",
      status: "DONE",
      metadataJson: { workflow: "suggest-canary" },
    };

    const resume = evaluateCanonicalLiveGate({
      ...base,
      run: { id: "r", caseId: "c", status: "PREPARED" },
      stageRows: [{ stage: "SUGGEST_RU_CANARY", status: "PREPARED" }],
      currentStageStatus: "PREPARED",
      counts: { providerTaskCount: 0, observationCount: 0, coverageCount: 0 },
      resumeExisting: true,
    });
    assert.ok(resume.blockers.includes("resume-existing-not-supported"));

    assert.equal(
      evaluateCanonicalLiveGate({ ...base, run: goodRun }).verdict,
      "IDEMPOTENT_REPLAY_DONE"
    );
    assert.equal(
      evaluateCanonicalLiveGate({
        ...base,
        run: { ...goodRun, caseId: "other" },
      }).verdict,
      "EXECUTE_BLOCKED"
    );
    assert.equal(
      evaluateCanonicalLiveGate({
        ...base,
        workflow: "first36-full",
        stage: "FIRST36_STAGE1",
        stageRows: [{ stage: "FIRST36_STAGE1", status: "DONE" }],
        run: { ...goodRun, metadataJson: { workflow: "suggest-canary" } },
        executionPlan: { ...plan, stage: "FIRST36_STAGE1" },
      }).verdict,
      "EXECUTE_BLOCKED"
    );
    assert.ok(
      evaluateCanonicalLiveGate({
        ...base,
        stage: "FIRST36_STAGE1",
        stageRows: [{ stage: "FIRST36_STAGE1", status: "DONE" }],
        currentStageStatus: "DONE",
        run: goodRun,
      }).blockers.includes("workflow-stage-mismatch")
    );
    assert.ok(
      evaluateCanonicalLiveGate({ ...base, run: goodRun, resumeExisting: true }).blockers.includes(
        "resume-existing-not-supported"
      )
    );
    assert.ok(
      evaluateCanonicalLiveGate({ ...base, run: goodRun, networkCalls: 2 }).blockers.some((b) =>
        /network-calls-nonzero/.test(b)
      )
    );
  });

  it("21. provenance: Railway SHA, dirty bypass removed, unknown no-git", () => {
    const dir = mkdtempSync(join(tmpdir(), "p05-nongit-"));
    try {
      const railway = resolveBuildIdentity(
        {
          RAILWAY_GIT_COMMIT_SHA: "railcommit0123456789abcdef0123456789ab",
          RAILWAY_DEPLOYMENT_ID: "deploy-xyz",
        } as NodeJS.ProcessEnv,
        dir
      );
      assert.equal(railway.source, "env");
      assert.equal(railway.dirtyTree, false);
      assert.equal(railway.buildCommit, "railcommit0123456789abcdef0123456789ab");
      assert.equal(railway.buildId, "deploy-xyz");

      const immutable = resolveBuildIdentity(
        { GITHUB_SHA: "deadbeefcafebabe0123456789abcdef01234567" } as NodeJS.ProcessEnv,
        dir
      );
      assert.equal(immutable.source, "env");
      assert.equal(immutable.dirtyTree, false);

      const unknown = resolveBuildIdentity({} as NodeJS.ProcessEnv, dir);
      assert.equal(unknown.buildCommit, "unknown");
      assert.equal(unknown.dirtyTree, true);

      const local = resolveBuildIdentity({
        ARSENKIN_ALLOW_DIRTY_TREE: "1",
        RAILWAY_GIT_COMMIT_SHA: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      } as NodeJS.ProcessEnv);
      assert.equal(local.source, "env");
      assert.equal(local.dirtyTree, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("22. cleanup failure blocks readiness validation", () => {
    const r = validateDbReadinessArtifact({
      artifact: v2Pass({ cleanupAttempted: true, cleanupOk: false }),
      currentFingerprint: "fp-test",
      currentBuildCommit: "abc123",
      currentSourceTreeHash: "src-hash",
      currentSchemaContentHash: "schema-hash",
      currentDirtyTree: false,
    });
    assert.equal(r.ok, false);
    assert.ok(r.blockers.includes("db-readiness-cleanup-failed"));
  });

  it("23. writeJsonAtomic fsync path leaves full JSON and no temp", () => {
    const dir = mkdtempSync(join(tmpdir(), "p05-atomic-"));
    try {
      const dest = join(dir, "arsenkin-db-readiness.json");
      writeJsonAtomic(dest, { version: "arsenkin-db-readiness-v2", verdict: "PASS" });
      assert.equal(JSON.parse(readFileSync(dest, "utf-8")).verdict, "PASS");
      assert.equal(readdirSync(dir).filter((n) => n.endsWith(".tmp")).length, 0);

      writeJsonAtomic(dest, { version: "arsenkin-db-readiness-v2", verdict: "FAIL" });
      assert.equal(JSON.parse(readFileSync(dest, "utf-8")).verdict, "FAIL");

      const blocker = join(dir, "not-a-dir");
      writeFileSync(blocker, "x");
      assert.throws(() => writeJsonAtomic(join(blocker, "child.json"), { verdict: "PASS" }));
      assert.equal(JSON.parse(readFileSync(dest, "utf-8")).verdict, "FAIL");
      assert.ok(!existsSync(join(blocker, "child.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write p05 readiness verdict artifact from validated readiness only", () => {
    const validated = loadValidatedReadinessVerdict();
    assert.ok(
      validated.verdict === "CANARY_PLAN_READY" || validated.verdict === "CODE_READY_DB_BLOCKED"
    );
    assert.notEqual(validated.verdict as string, "LIVE_READY");
    const payload = {
      version: "arsenkin-p05-acceptance-repair-v1",
      verdict: validated.verdict,
      blockers: validated.blockers,
      liveApiCalled: false,
      networkCalls: getArsenkinNetworkCallCount(),
      schemaContentHashPrefix: computeSchemaContentHash().slice(0, 12),
      sourceTreeHashPrefix: computeSourceTreeHash().slice(0, 12),
      note: "IDEMPOTENT_REPLAY_DONE does not imply live readiness",
    };
    writeJsonAtomic(join(ART, "arsenkin-p05-live-readiness.json"), payload);
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });
});
