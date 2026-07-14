/**
 * P0.4 live runner closure — production-function + offline integration smokes.
 * No live Arsenkin API. No production DB.
 *
 *   node --import tsx scripts/smoke-arsenkin-p04-live-runner.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildArsenkinSubjectQueryPlan } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-subject-query-plan";
import { buildArsenkinExecutionPlan } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-execution-plan";
import {
  validateFreshCanaryRun,
  transitionCanaryRun,
  buildPrepareCanaryRunSpec,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-canary-run-lifecycle";
import { validateClientBindingArtifacts } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-client-binding-gate";
import { evaluateCanonicalLiveGate } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-canonical-live-gate";
import {
  validateDbReadinessArtifact,
  fingerprintDatabaseUrl,
  ARSENKIN_DB_READINESS_VERSION,
  REQUIRED_COVERAGE_UNIQUE_MIGRATION,
  type ArsenkinDbReadinessArtifact,
} from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import { buildPlannedCoverageMatrix } from "../src/modules/digital-profile/providers/arsenkin/planned-coverage-matrix";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";
import { createArsenkinClientFromEnv } from "../src/modules/digital-profile/providers/arsenkin/client";
import { collectArsenkinPilotSurfaces } from "../src/modules/digital-profile/providers/arsenkin/collect-pilot-surfaces";

const ART = join(process.cwd(), "storage", "digital-profile", "qa-arsenkin-p04");
mkdirSync(ART, { recursive: true });

function passArtifact(overrides: Partial<ArsenkinDbReadinessArtifact> = {}): ArsenkinDbReadinessArtifact {
  const now = Date.now();
  return {
    version: ARSENKIN_DB_READINESS_VERSION,
    verdict: "PASS",
    databaseFingerprint: "fp-test",
    buildCommit: "abc",
    buildId: null,
    dirtyTree: false,
    sourceTreeHash: "src-test",
    schemaContentHash: "schema-test",
    requiredMigration: REQUIRED_COVERAGE_UNIQUE_MIGRATION,
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

const dbCurrent = {
  currentDbFingerprint: "fp-test",
  currentBuildCommit: "abc",
  currentSourceTreeHash: "src-test",
  currentSchemaContentHash: "schema-test",
  currentDirtyTree: false,
};

function suggestGateBase(plan: ReturnType<typeof buildArsenkinExecutionPlan>, q: ReturnType<typeof buildArsenkinSubjectQueryPlan>) {
  return {
    caseId: "c",
    reportRunId: "r",
    stage: "SUGGEST_RU_CANARY" as const,
    workflow: "suggest-canary" as const,
    run: { id: "r", caseId: "c", status: "PREPARED" },
    stageRows: [{ stage: "SUGGEST_RU_CANARY" as const, status: "PREPARED" }],
    currentStageStatus: "PREPARED",
    counts: { providerTaskCount: 0, observationCount: 0, coverageCount: 0 },
    queryPlan: q,
    executionPlan: plan,
    content: { caseId: "c", reportRunId: "r" },
    binding: { sourceReportRunId: "r", effectiveReportRunId: "r", overridden: false },
    adminDecisions: { caseId: "c", qaSampleOnly: false },
    dbReadiness: passArtifact(),
    ...dbCurrent,
    tokenPresent: true,
    networkCalls: 0 as number,
  };
}

function scanNetworkEntrypoints(): string[] {
  const roots = [
    "src/modules/digital-profile/providers/arsenkin",
    "scripts",
  ];
  const hits = new Set<string>();
  const patterns = [
    /createArsenkinClientFromEnv/,
    /\.setTask\(/,
    /collectArsenkinPilotSurfaces/,
    /ensureArsenkinTask/,
    /\/set["'`]/,
  ];
  for (const root of roots) {
    const abs = join(process.cwd(), root);
    if (!existsSync(abs)) continue;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) {
          if (name.name === "fixtures" || name.name === "node_modules") continue;
          walk(p);
          continue;
        }
        if (!/\.(ts|tsx|mjs|js)$/.test(name.name)) continue;
        const src = readFileSync(p, "utf-8");
        if (patterns.some((re) => re.test(src))) {
          hits.add(p.replace(process.cwd() + "\\", "").replace(process.cwd() + "/", "").replace(/\\/g, "/"));
        }
      }
    };
    walk(abs);
  }
  return [...hits].sort();
}

describe("arsenkin P0.4 live runner closure", () => {
  it("subject query builder differs across subjects and changes digest", () => {
    const a = buildArsenkinSubjectQueryPlan({
      fullName: "Иванов Иван Иванович",
      aliases: ["Ivanov Ivan"],
    });
    const b = buildArsenkinSubjectQueryPlan({
      fullName: "Петров Пётр Петрович",
      aliases: ["Petrov Petr"],
    });
    assert.ok(a.queriesRu[0] !== b.queriesRu[0]);
    assert.ok(a.queriesUae[0] !== b.queriesUae[0]);
    assert.equal(a.blockers.length, 0);
    const planA = buildArsenkinExecutionPlan({
      caseId: "c1",
      reportRunId: "r1",
      stage: "SUGGEST_RU_CANARY",
      queriesRu: a.queriesRu,
      queriesUae: a.queriesUae,
      maxNewTasks: 2,
      maxEstimatedLimits: 2,
    });
    const planB = buildArsenkinExecutionPlan({
      caseId: "c1",
      reportRunId: "r1",
      stage: "SUGGEST_RU_CANARY",
      queriesRu: b.queriesRu,
      queriesUae: b.queriesUae,
      maxNewTasks: 2,
      maxEstimatedLimits: 2,
    });
    assert.notEqual(planA.digest, planB.digest);
    assert.ok(!JSON.stringify(planA).includes("Glinka"));
  });

  it("empty subject blocks", () => {
    const q = buildArsenkinSubjectQueryPlan({ fullName: "  ", aliases: [] });
    assert.ok(q.blockers.includes("empty-subject-name"));
  });

  it("fresh canary validates PREPARED + empty counts", () => {
    const bad = validateFreshCanaryRun({
      caseId: "c",
      reportRunId: "r",
      run: null,
      counts: { providerTaskCount: 0, observationCount: 0, coverageCount: 0 },
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.blockers.includes("run-absent"));

    const dirty = validateFreshCanaryRun({
      caseId: "c",
      reportRunId: "r",
      run: { id: "r", caseId: "c", status: "PREPARED" },
      counts: { providerTaskCount: 1, observationCount: 0, coverageCount: 0 },
    });
    assert.equal(dirty.ok, false);

    const ok = validateFreshCanaryRun({
      caseId: "c",
      reportRunId: "r",
      run: { id: "r", caseId: "c", status: "PREPARED" },
      counts: { providerTaskCount: 0, observationCount: 0, coverageCount: 0 },
    });
    assert.equal(ok.ok, true);
  });

  it("DONE execute blocked; transitions PREPARED→RUNNING→DONE/FAILED", () => {
    assert.equal(
      transitionCanaryRun({ from: "PREPARED", to: "RUNNING", currentStatus: "PREPARED" }).ok,
      true
    );
    assert.equal(
      transitionCanaryRun({ from: "RUNNING", to: "DONE", currentStatus: "RUNNING" }).ok,
      true
    );
    assert.equal(
      transitionCanaryRun({ from: "RUNNING", to: "FAILED", currentStatus: "RUNNING" }).ok,
      true
    );
    assert.equal(
      transitionCanaryRun({ from: "DONE", to: "RUNNING", currentStatus: "DONE" }).ok,
      false
    );
    const spec = buildPrepareCanaryRunSpec({
      reportRunId: "r",
      caseId: "c",
      stage: "SUGGEST_RU_CANARY",
      preparedAtIso: new Date().toISOString(),
    });
    assert.equal(spec.status, "PREPARED");
  });

  it("client binding validates three artifacts", () => {
    const ok = validateClientBindingArtifacts({
      caseId: "c",
      reportRunId: "r",
      content: { caseId: "c", reportRunId: "r" },
      binding: {
        sourceReportRunId: "r",
        effectiveReportRunId: "r",
        overridden: false,
      },
      adminDecisions: { caseId: "c", qaSampleOnly: false },
    });
    assert.equal(ok.ok, true);

    const qa = validateClientBindingArtifacts({
      caseId: "c",
      reportRunId: "r",
      content: { caseId: "c", reportRunId: "r" },
      binding: {
        sourceReportRunId: "r",
        effectiveReportRunId: "r",
        overridden: false,
      },
      adminDecisions: { caseId: "c", qaSampleOnly: true },
    });
    assert.equal(qa.ok, false);
    assert.ok(qa.blockers.includes("qa-sample-decisions-forbidden"));

    const missing = validateClientBindingArtifacts({
      caseId: "c",
      reportRunId: "r",
      content: null,
      binding: null,
      adminDecisions: null,
    });
    assert.equal(missing.ok, false);
  });

  it("DB readiness: missing/stale/wrong fingerprint blocked; env alone not PASS", () => {
    assert.equal(
      validateDbReadinessArtifact({
        artifact: null,
        currentFingerprint: "fp",
        currentBuildCommit: "c",
        currentSourceTreeHash: "s",
        currentSchemaContentHash: "h",
        currentDirtyTree: false,
      }).ok,
      false
    );
    assert.equal(
      validateDbReadinessArtifact({
        artifact: passArtifact({ databaseFingerprint: "other" }),
        ...{
          currentFingerprint: "fp-test",
          currentBuildCommit: "abc",
          currentSourceTreeHash: "src-test",
          currentSchemaContentHash: "schema-test",
          currentDirtyTree: false,
        },
      }).ok,
      false
    );
    assert.equal(
      validateDbReadinessArtifact({
        artifact: passArtifact({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
        currentFingerprint: "fp-test",
        currentBuildCommit: "abc",
        currentSourceTreeHash: "src-test",
        currentSchemaContentHash: "schema-test",
        currentDirtyTree: false,
      }).ok,
      false
    );
    assert.equal(
      validateDbReadinessArtifact({
        artifact: passArtifact(),
        currentFingerprint: "fp-test",
        currentBuildCommit: "abc",
        currentSourceTreeHash: "src-test",
        currentSchemaContentHash: "schema-test",
        currentDirtyTree: false,
      }).ok,
      true
    );
    const fp = fingerprintDatabaseUrl("postgresql://secret:pass@db.example:5432/gi?schema=public");
    assert.ok(!fp.includes("secret"));
    assert.ok(!fp.includes("pass"));
  });

  it("evaluateCanonicalLiveGate: plan-only missing run → PLAN_BLOCKED network 0", () => {
    resetArsenkinNetworkCallCount();
    const q = buildArsenkinSubjectQueryPlan({ fullName: "Тестов Тест Тестович" });
    const plan = buildArsenkinExecutionPlan({
      caseId: "c",
      reportRunId: "r",
      stage: "SUGGEST_RU_CANARY",
      queriesRu: q.queriesRu,
      queriesUae: q.queriesUae,
      maxNewTasks: 2,
      maxEstimatedLimits: 2,
    });
    const gate = evaluateCanonicalLiveGate({
      mode: "plan-only",
      ...suggestGateBase(plan, q),
      run: null,
      stageRows: [],
      currentStageStatus: null,
      liveConfirm: false,
      confirmPlanDigest: null,
    });
    assert.equal(gate.verdict, "PLAN_BLOCKED");
    assert.ok(gate.blockers.includes("run-absent"));
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("execute-live missing confirm / digest / QA / DB blocked with network 0", async () => {
    resetArsenkinNetworkCallCount();
    const q = buildArsenkinSubjectQueryPlan({ fullName: "Тестов Тест Тестович" });
    const plan = buildArsenkinExecutionPlan({
      caseId: "c",
      reportRunId: "r",
      stage: "SUGGEST_RU_CANARY",
      queriesRu: q.queriesRu,
      queriesUae: [],
      maxNewTasks: 2,
      maxEstimatedLimits: 2,
    });
    const base = { mode: "execute-live" as const, ...suggestGateBase(plan, q) };
    assert.equal(
      evaluateCanonicalLiveGate({ ...base, liveConfirm: false, confirmPlanDigest: plan.digest }).verdict,
      "EXECUTE_BLOCKED"
    );
    assert.equal(
      evaluateCanonicalLiveGate({ ...base, liveConfirm: true, confirmPlanDigest: null }).verdict,
      "EXECUTE_BLOCKED"
    );
    assert.equal(
      evaluateCanonicalLiveGate({ ...base, liveConfirm: true, confirmPlanDigest: "deadbeef" }).verdict,
      "EXECUTE_BLOCKED"
    );
    assert.equal(
      evaluateCanonicalLiveGate({
        ...base,
        liveConfirm: true,
        confirmPlanDigest: plan.digest,
        adminDecisions: { caseId: "c", qaSampleOnly: true },
      }).verdict,
      "EXECUTE_BLOCKED"
    );
    assert.equal(
      evaluateCanonicalLiveGate({
        ...base,
        liveConfirm: true,
        confirmPlanDigest: plan.digest,
        dbReadiness: null,
      }).verdict,
      "EXECUTE_BLOCKED"
    );
    assert.equal(getArsenkinNetworkCallCount(), 0);

    process.env.ARSENKIN_API_TOKEN = "dummy";
    process.env.ARSENKIN_ENABLED = "1";
    const client = createArsenkinClientFromEnv();
    await assert.rejects(() => client!.setTask({ tools_name: "suggest", data: { queries: ["x"] } }));
    assert.equal(getArsenkinNetworkCallCount(), 0);
    delete process.env.ARSENKIN_API_TOKEN;
  });

  it("SUGGEST_RU_CANARY exact two request hashes + coverage matrix", () => {
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
    assert.ok(plan.requests.every((r) => r.tool === "suggest" && r.region === "RU"));
    const matrix = buildPlannedCoverageMatrix(plan);
    assert.equal(matrix.length, 2);
    assert.ok(matrix.every((t) => t.surface === "autocomplete"));
    writeFileSync(join(ART, "planned-coverage-matrix.json"), `${JSON.stringify({ targets: matrix }, null, 2)}\n`);
    writeFileSync(join(ART, "arsenkin-live-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  });

  it("caseId is part of digest", () => {
    const q = buildArsenkinSubjectQueryPlan({ fullName: "А А А" });
    const a = buildArsenkinExecutionPlan({
      caseId: "case-a",
      reportRunId: "r",
      stage: "SUGGEST_RU_CANARY",
      queriesRu: q.queriesRu,
      queriesUae: [],
      maxNewTasks: 2,
      maxEstimatedLimits: 2,
    });
    const b = buildArsenkinExecutionPlan({
      caseId: "case-b",
      reportRunId: "r",
      stage: "SUGGEST_RU_CANARY",
      queriesRu: q.queriesRu,
      queriesUae: [],
      maxNewTasks: 2,
      maxEstimatedLimits: 2,
    });
    assert.notEqual(a.digest, b.digest);
  });

  it("fixtures collect remains network-free; live without plan blocked", async () => {
    resetArsenkinNetworkCallCount();
    await collectArsenkinPilotSurfaces({
      caseId: "c",
      auditRunId: "r",
      queriesRu: ["q"],
      queriesUae: [],
      fixturesOnly: true,
      tools: ["suggest"],
    });
    assert.equal(getArsenkinNetworkCallCount(), 0);
    await assert.rejects(() =>
      collectArsenkinPilotSurfaces({
        caseId: "c",
        auditRunId: "r",
        queriesRu: ["q"],
        queriesUae: [],
        fixturesOnly: false,
      })
    );
  });

  it("network entrypoint inventory via static scanner", () => {
    const files = scanNetworkEntrypoints();
    assert.ok(files.some((f) => f.includes("client.ts")));
    assert.ok(files.some((f) => f.includes("collect-pilot-surfaces.ts")));
    assert.ok(files.some((f) => f.includes("arsenkin-canonical-live-runner.ts")));
    writeFileSync(
      join(ART, "network-entrypoint-inventory.json"),
      `${JSON.stringify({ files, count: files.length }, null, 2)}\n`
    );
  });

  it("write readiness artifacts (BLOCKED without real DB PASS)", () => {
    const dbUrl = String(process.env.DATABASE_URL ?? "");
    const hasReal =
      Boolean(dbUrl.trim()) &&
      !/postgresql:\/\/u:p@127\.0\.0\.1:5432\/db/i.test(dbUrl) &&
      process.env.ARSENKIN_DB_INTEGRATION_REQUIRED === "1";
    const readiness = {
      version: "arsenkin-p04-live-readiness-v1",
      verdict: hasReal ? "LIVE_READY_PENDING_HUMAN" : "BLOCKED",
      reasons: hasReal
        ? []
        : ["test-postgresql-db-readiness-PASS-missing", "run generate-arsenkin-db-readiness.ts on staging"],
      liveApiCalled: false,
      productionApply: false,
      gitCommitHint: "local",
    };
    writeFileSync(join(ART, "arsenkin-p04-live-readiness.json"), `${JSON.stringify(readiness, null, 2)}\n`);
    writeFileSync(
      join(ART, "runner-integration-test-summary.json"),
      `${JSON.stringify({ suite: "smoke-arsenkin-p04-live-runner", offline: true }, null, 2)}\n`
    );
    writeFileSync(
      join(ART, "fresh-run-preflight.json"),
      `${JSON.stringify({ note: "see canonical runner output per run" }, null, 2)}\n`
    );
    writeFileSync(
      join(ART, "client-content-binding-validation.json"),
      `${JSON.stringify({ pureGate: "validateClientBindingArtifacts" }, null, 2)}\n`
    );
    if (!existsSync(join(ART, "arsenkin-db-readiness.json"))) {
      writeFileSync(
        join(ART, "arsenkin-db-readiness.json"),
        `${JSON.stringify(passArtifact({ verdict: "FAIL", environment: "unknown", buildCommit: "unknown", dirtyTree: true }), null, 2)}\n`
      );
    }
    assert.equal(readiness.verdict, "BLOCKED");
  });

  it("EXECUTE_READY when all gates satisfied (pure)", () => {
    const q = buildArsenkinSubjectQueryPlan({ fullName: "Готов Готов Готович" });
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
      ...suggestGateBase(plan, q),
      liveConfirm: true,
      confirmPlanDigest: plan.digest,
    });
    assert.equal(gate.verdict, "EXECUTE_READY");
    assert.equal(gate.ok, true);
  });
});
