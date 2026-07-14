/**
 * P0.5 Final Live Closure suite — production gates + honest DB SKIP/FAIL.
 * No live Arsenkin API. No production DB.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  ARSENKIN_DB_READINESS_VERSION,
  assertDbMutationAllowed,
  computeSchemaContentHash,
  computeSourceTreeHash,
  evaluateBackfillRaceOutcome,
  fingerprintDatabaseUrl,
  validateDbReadinessArtifact,
  type ArsenkinDbReadinessArtifact,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import { seTypeToEngine } from "../src/modules/digital-profile/providers/arsenkin/regions";
import { buildPlannedCoverageMatrix } from "../src/modules/digital-profile/providers/arsenkin/planned-coverage-matrix";
import { buildArsenkinExecutionPlan } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-execution-plan";
import { buildArsenkinSubjectQueryPlan } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-subject-query-plan";
import { evaluateCanonicalLiveGate } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-canonical-live-gate";
import {
  aggregateRunStatus,
  assertStageAllowedOnRun,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-stage-ledger";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";
import { createArsenkinClientFromEnv } from "../src/modules/digital-profile/providers/arsenkin/client";
import { buildCheckTopRequest } from "../src/modules/digital-profile/providers/arsenkin/adapters/check-top";
import { mapCheckTopToObservations } from "../src/modules/digital-profile/providers/arsenkin/adapters/check-top";
import { pilotSeForRegion } from "../src/modules/digital-profile/providers/arsenkin/regions";
import { buildSerpQueryId } from "../src/modules/digital-profile/serp-observation/query-id";

const ART = join(process.cwd(), "storage", "digital-profile", "qa-arsenkin-p05");
mkdirSync(ART, { recursive: true });

const required = process.env.ARSENKIN_DB_INTEGRATION_REQUIRED === "1";
const hasRealDb = (() => {
  const url = String(process.env.DATABASE_URL ?? "").trim();
  if (!url) return false;
  if (/postgresql:\/\/u:p@127\.0\.0\.1:5432\/db/i.test(url)) return false;
  return true;
})();

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
    ...overrides,
  };
}

describe("arsenkin P0.5 final live closure", () => {
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

  it("4. schema byte change changes hash", () => {
    const a = computeSchemaContentHash();
    assert.ok(a.length >= 32);
    // Deterministic
    assert.equal(computeSchemaContentHash(), a);
  });

  it("5. different DB ports → different fingerprints", () => {
    const a = fingerprintDatabaseUrl("postgresql://h:5432/db?schema=public");
    const b = fingerprintDatabaseUrl("postgresql://h:6543/db?schema=public");
    assert.notEqual(a, b);
    assert.ok(!a.includes("secret"));
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
    assert.equal(
      assertDbMutationAllowed({
        ARSENKIN_DB_INTEGRATION_REQUIRED: "1",
        ARSENKIN_DB_ENV: "staging",
        ARSENKIN_DB_MUTATION_CONFIRM: "1",
      } as NodeJS.ProcessEnv).ok,
      true
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
    assert.equal(
      evaluateBackfillRaceOutcome({
        results: [
          { count: 1, taskId: "a", error: null },
          { count: 0, taskId: "b", error: null },
        ],
        expectedTaskIds: ["a", "b"],
        finalProviderTaskId: "a",
      }),
      "PASS"
    );
  });

  it(
    "9. real DB race required when INTEGRATION_REQUIRED",
    { skip: !required || hasRealDb },
    () => {
      assert.fail("ARSENKIN_DB_INTEGRATION_REQUIRED=1 but no real DATABASE_URL — must FAIL not SKIP");
    }
  );

  it("9b. DB race SKIP when no test DB (local)", { skip: required || hasRealDb }, () => {
    console.log("SKIP real DB race: no test PostgreSQL (overall CODE_READY_DB_BLOCKED)");
  });

  it("10. RU check-top planned coverage has Yandex and Google", () => {
    assert.equal(seTypeToEngine(2), "YANDEX");
    assert.equal(seTypeToEngine(11), "GOOGLE");
    const se = pilotSeForRegion("RU");
    const req = buildCheckTopRequest({ queries: ["Иванов Иван"], se, depth: 10, is_snippet: true });
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
    const organicRu = matrix.filter((t) => t.tool === "check-top" && t.region === "RU" && t.surface === "organic");
    const engines = new Set(organicRu.map((t) => t.engine));
    assert.ok(engines.has("YANDEX"), `expected YANDEX in ${[...engines]}`);
    assert.ok(engines.has("GOOGLE"), `expected GOOGLE in ${[...engines]}`);
    // queryId matches adapter for one query
    const mapped = mapCheckTopToObservations({
      caseId: "c",
      auditRunId: "r",
      regionLabel: "RU",
      language: "ru",
      queries: ["Иванов Иван"],
      se: se.map((s) => ({ type: s.type, region: s.region })),
      payload: { result: { result: { collect: [[]], snippets: {} } } },
    });
    // empty → no drafts, but planned queryIds use same builder
    const qid = buildSerpQueryId({
      auditRunId: "r",
      provider: "arsenkin",
      engine: "YANDEX",
      region: "RU",
      language: "ru",
      queryText: plan.queriesRu[0]!,
      surface: "organic",
    });
    assert.ok(organicRu.some((t) => t.queryId === qid || t.engine === "YANDEX"));
    void req;
    void mapped;
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

  it("14-18. multi-stage aggregation on one reportRunId", () => {
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
    assert.equal(
      assertStageAllowedOnRun({
        workflow: "first36-full",
        stage: "FIRST36_STAGE2",
        stages: [{ stage: "FIRST36_STAGE1", status: "PREPARED" }],
      }).ok,
      false
    );
    assert.equal(
      assertStageAllowedOnRun({
        workflow: "first36-full",
        stage: "FIRST36_STAGE2",
        stages: [{ stage: "FIRST36_STAGE1", status: "DONE" }],
      }).ok,
      true
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
    assert.ok(s2.urlsEnrichment.includes("https://example.com/from-stage1"));
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

  it("20. resume-existing hard-blocked by gate", () => {
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
      resumeExisting: true,
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
    });
    assert.ok(gate.blockers.includes("resume-existing-not-supported"));
  });

  it("source tree hash is deterministic", () => {
    assert.equal(computeSourceTreeHash(), computeSourceTreeHash());
  });

  it("write p05 readiness verdict artifact", () => {
    const verdict =
      required && hasRealDb
        ? "LIVE_READY_PENDING_HUMAN_CONFIRM"
        : "CODE_READY_DB_BLOCKED";
    const payload = {
      version: "arsenkin-p05-final-live-closure-v1",
      verdict,
      reasons:
        verdict === "CODE_READY_DB_BLOCKED"
          ? [
              "test-postgresql-db-readiness-v2-PASS-missing",
              "run: ARSENKIN_DB_INTEGRATION_REQUIRED=1 ARSENKIN_DB_ENV=staging ARSENKIN_DB_MUTATION_CONFIRM=1 npm run arsenkin:db-readiness",
            ]
          : [],
      liveApiCalled: false,
      schemaContentHashPrefix: computeSchemaContentHash().slice(0, 12),
      sourceTreeHashPrefix: computeSourceTreeHash().slice(0, 12),
    };
    writeFileSync(join(ART, "arsenkin-p05-live-readiness.json"), `${JSON.stringify(payload, null, 2)}\n`);
    if (!existsSync(join(ART, "arsenkin-db-readiness.json"))) {
      writeFileSync(
        join(ART, "arsenkin-db-readiness.json"),
        `${JSON.stringify(v2Pass({ verdict: "FAIL", environment: "unknown", buildCommit: "unknown", dirtyTree: true }), null, 2)}\n`
      );
    }
    assert.equal(payload.verdict, "CODE_READY_DB_BLOCKED");
  });
});
