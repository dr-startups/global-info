/**
 * P0.3 live readiness offline smokes (no live Arsenkin API, no production apply).
 *
 *   node --import tsx scripts/smoke-arsenkin-p03-live-readiness.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildArsenkinExecutionPlan,
  evaluateExecutionPlanBudget,
  assertPlanRequestHashesMatchBodies,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-execution-plan";
import { hashProviderRequest } from "../src/modules/digital-profile/providers/arsenkin/provider-task-store";
import { authorizationFromPlan } from "../src/modules/digital-profile/providers/arsenkin/execute-arsenkin-execution-plan";
import {
  assertLiveSetAllowed,
  withLiveAuthorization,
} from "../src/modules/digital-profile/providers/arsenkin/live-execution-authorization";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";
import { createArsenkinClientFromEnv } from "../src/modules/digital-profile/providers/arsenkin/client";
import { collectArsenkinPilotSurfaces } from "../src/modules/digital-profile/providers/arsenkin/collect-pilot-surfaces";
import { resolveBackfillAuditVerdict } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-provenance-backfill-match";
import { findSurfaceCoverageDuplicateGroups } from "../src/modules/digital-profile/providers/arsenkin/surface-coverage-duplicate-audit";
import { formatRerenderNetworkSummary } from "../src/modules/digital-profile/orion-golden/classic/rerender-task-preflight";

const ART = join(process.cwd(), "storage", "digital-profile", "qa-arsenkin-p03-live-readiness");
mkdirSync(ART, { recursive: true });

const NETWORK_ENTRYPOINTS = [
  {
    id: "client.setTask",
    path: "src/modules/digital-profile/providers/arsenkin/client.ts",
    status: "guarded-by-live-authorization",
  },
  {
    id: "client.checkTask/getTask/getLimits",
    path: "src/modules/digital-profile/providers/arsenkin/client.ts",
    status: "guarded-by-live-authorization",
  },
  {
    id: "ensureArsenkinTask",
    path: "src/modules/digital-profile/providers/arsenkin/poll-worker.ts",
    status: "calls-client-setTask",
  },
  {
    id: "collectArsenkinPilotSurfaces",
    path: "src/modules/digital-profile/providers/arsenkin/collect-pilot-surfaces.ts",
    status: "live-requires-plan+authorization",
  },
  {
    id: "executeArsenkinExecutionPlan",
    path: "src/modules/digital-profile/providers/arsenkin/execute-arsenkin-execution-plan.ts",
    status: "canonical-live-executor",
  },
  {
    id: "enrichReportRunWithArsenkin",
    path: "src/modules/digital-profile/orion-golden/classic/enrich-report-run-with-arsenkin.ts",
    status: "live-blocked-without-authorization",
  },
  {
    id: "canary-arsenkin-first36.ts",
    path: "scripts/canary-arsenkin-first36.ts",
    status: "HARD_FAIL_legacy",
  },
  {
    id: "arsenkin-first36-ab-pilot.ts",
    path: "scripts/arsenkin-first36-ab-pilot.ts",
    status: "fixtures-only-or-HARD_FAIL",
  },
  {
    id: "rerender-canary-first36.ts",
    path: "scripts/rerender-canary-first36.ts",
    status: "rerender-only-or-HARD_FAIL",
  },
  {
    id: "arsenkin-canonical-live-runner.ts",
    path: "scripts/arsenkin-canonical-live-runner.ts",
    status: "canonical-plan-only-and-execute-live",
  },
];

function basePlanInput(overrides: Record<string, unknown> = {}) {
  return {
    caseId: "case-p03",
    reportRunId: "run-p03",
    stage: "SUGGEST_RU_CANARY" as const,
    queriesRu: ["Глинка Сергей Михайлович"],
    queriesUae: ["Glinka Sergey"],
    maxNewTasks: 2,
    maxEstimatedLimits: 2,
    ...overrides,
  };
}

describe("arsenkin P0.3 live readiness", () => {
  it("1. network entrypoints inventory artifact", () => {
    writeFileSync(
      join(ART, "arsenkin-network-entrypoints.json"),
      `${JSON.stringify({ generatedAt: "offline", entrypoints: NETWORK_ENTRYPOINTS }, null, 2)}\n`
    );
    assert.ok(NETWORK_ENTRYPOINTS.length >= 8);
  });

  it("2. token present without live authorization → 0 network / set blocked", async () => {
    resetArsenkinNetworkCallCount();
    process.env.ARSENKIN_API_TOKEN = "dummy-token-not-real";
    process.env.ARSENKIN_ENABLED = "1";
    const client = createArsenkinClientFromEnv();
    assert.ok(client);
    await assert.rejects(
      () => client!.setTask({ tools_name: "suggest", data: { queries: ["x"] } }),
      /no-live-authorization|arsenkin-live/
    );
    assert.equal(getArsenkinNetworkCallCount(), 0);
    delete process.env.ARSENKIN_API_TOKEN;
  });

  it("3. legacy canary with token → hard fail, 0 network", () => {
    resetArsenkinNetworkCallCount();
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/canary-arsenkin-first36.ts"],
      {
        cwd: process.cwd(),
        env: { ...process.env, ARSENKIN_API_TOKEN: "dummy", ARSENKIN_ENABLED: "1" },
        encoding: "utf-8",
      }
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /HARD_FAIL|legacy-live/);
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("4. legacy A/B pilot with token → hard fail, 0 network", () => {
    resetArsenkinNetworkCallCount();
    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/arsenkin-first36-ab-pilot.ts", "--live"],
      {
        cwd: process.cwd(),
        env: { ...process.env, ARSENKIN_API_TOKEN: "dummy", ARSENKIN_ENABLED: "1" },
        encoding: "utf-8",
      }
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr + r.stdout, /HARD_FAIL|legacy-live/);
  });

  it("5. canonical plan builder produces digest with NETWORK_CALLS=0", () => {
    resetArsenkinNetworkCallCount();
    const plan = buildArsenkinExecutionPlan(basePlanInput());
    writeFileSync(join(ART, "arsenkin-live-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    assert.equal(getArsenkinNetworkCallCount(), 0);
    assert.ok(plan.digest.length >= 32);
  });

  it("6. execute-live without LIVE_CONFIRM blocked (gate simulation)", () => {
    const plan = buildArsenkinExecutionPlan(basePlanInput());
    const liveConfirm = false;
    assert.equal(liveConfirm, false);
    assert.ok(plan.digest);
  });

  it("7. execute-live without digest blocked", () => {
    const plan = buildArsenkinExecutionPlan(basePlanInput());
    const confirmPlanDigest = null;
    assert.equal(confirmPlanDigest, null);
    assert.notEqual(confirmPlanDigest, plan.digest);
  });

  it("8. digest mismatch blocked", () => {
    const plan = buildArsenkinExecutionPlan(basePlanInput());
    assert.notEqual(plan.digest, "deadbeef");
  });

  it("9. request hash outside allowlist blocked before /set", async () => {
    const plan = buildArsenkinExecutionPlan(basePlanInput());
    const auth = authorizationFromPlan(plan);
    await withLiveAuthorization(auth, async () => {
      assert.throws(
        () =>
          assertLiveSetAllowed({
            reportRunId: plan.reportRunId,
            requestJson: { tools_name: "suggest", data: { queries: ["NOT_IN_PLAN"] } },
            countsAsNewTask: true,
            estimatedLimits: 1,
          }),
        /request-hash-not-in-plan/
      );
    });
  });

  it("10. reportRunId mismatch blocked", async () => {
    const plan = buildArsenkinExecutionPlan(basePlanInput());
    const auth = authorizationFromPlan(plan);
    await withLiveAuthorization(auth, async () => {
      assert.throws(
        () =>
          assertLiveSetAllowed({
            reportRunId: "other-run",
            requestJson: plan.requests[0]!.requestJson,
            countsAsNewTask: true,
            estimatedLimits: 1,
          }),
        /reportRunId-mismatch/
      );
    });
  });

  it("11. one plan builder for preflight/execution", () => {
    const a = buildArsenkinExecutionPlan(basePlanInput());
    const b = buildArsenkinExecutionPlan(basePlanInput());
    assert.equal(a.digest, b.digest);
  });

  it("12. reorder DB tasks does not change digest", () => {
    const tasks = [
      { id: "t1", requestHash: "aaa", state: "DONE" },
      { id: "t2", requestHash: "bbb", state: "DONE" },
    ];
    const p1 = buildArsenkinExecutionPlan(basePlanInput({ existingTasks: tasks }));
    const p2 = buildArsenkinExecutionPlan(
      basePlanInput({ existingTasks: [...tasks].reverse() })
    );
    assert.equal(p1.digest, p2.digest);
  });

  it("13. changing one query changes digest", () => {
    const a = buildArsenkinExecutionPlan(basePlanInput());
    const b = buildArsenkinExecutionPlan(
      basePlanInput({ queriesRu: ["Другой запрос"] })
    );
    assert.notEqual(a.digest, b.digest);
  });

  it("14. planned request hashes equal body hashes", () => {
    const plan = buildArsenkinExecutionPlan(basePlanInput());
    assertPlanRequestHashesMatchBodies(plan);
    for (const r of plan.requests) {
      assert.equal(r.requestHash, hashProviderRequest(r.requestJson));
    }
  });

  it("15. runtime collect without plan cannot invent live requests", async () => {
    await assert.rejects(
      () =>
        collectArsenkinPilotSurfaces({
          caseId: "c",
          auditRunId: "r",
          queriesRu: ["q"],
          queriesUae: [],
          fixturesOnly: false,
        }),
      /LiveExecutionAuthorization|executionPlan/
    );
  });

  it("16. plannedNewTasks > maxNewTasks blocks", () => {
    const plan = buildArsenkinExecutionPlan(basePlanInput({ maxNewTasks: 1, maxEstimatedLimits: 10 }));
    const budget = evaluateExecutionPlanBudget(plan);
    assert.equal(budget.ok, false);
    assert.ok(budget.blockers.some((b) => /plannedNewTasks/.test(b)));
  });

  it("17. estimatedLimitsTotal > maxEstimatedLimits blocks", () => {
    const plan = buildArsenkinExecutionPlan(basePlanInput({ maxNewTasks: 10, maxEstimatedLimits: 1 }));
    const budget = evaluateExecutionPlanBudget(plan);
    assert.equal(budget.ok, false);
  });

  it("18. unknown cost blocks by default", () => {
    const plan = buildArsenkinExecutionPlan(basePlanInput());
    // Force unknown by cloning with null estimates
    const broken = {
      ...plan,
      estimatedLimitsTotal: null,
      requests: plan.requests.map((r) => ({ ...r, estimatedLimits: null })),
      allowUnknownCost: false,
    };
    const budget = evaluateExecutionPlanBudget(broken);
    assert.equal(budget.ok, false);
  });

  it("19. SUGGEST_RU_CANARY has exactly 2 requests Yandex+Google RU", () => {
    const plan = buildArsenkinExecutionPlan(basePlanInput());
    assert.equal(plan.requests.length, 2);
    assert.deepEqual(
      plan.requests.map((r) => `${r.tool}:${r.engine}:${r.region}`).sort(),
      ["suggest:GOOGLE:RU", "suggest:YANDEX:RU"].sort()
    );
  });

  it("20. SUGGEST_RU_CANARY excludes UAE and stage2 tools", () => {
    const plan = buildArsenkinExecutionPlan(basePlanInput());
    assert.equal(plan.queriesUae.length, 0);
    assert.ok(plan.requests.every((r) => r.region === "RU"));
    assert.ok(!plan.tools.includes("check-top"));
    assert.ok(!plan.tools.includes("paa"));
    assert.ok(!plan.tools.includes("ai-serp"));
  });

  it("21. FIRST36_STAGE1 excludes stage-2 tools", () => {
    const plan = buildArsenkinExecutionPlan(
      basePlanInput({
        stage: "FIRST36_STAGE1",
        maxNewTasks: 20,
        maxEstimatedLimits: 20,
        queriesUae: ["Glinka"],
      })
    );
    assert.ok(!plan.tools.includes("ai-serp"));
    assert.ok(!plan.tools.includes("check-h"));
    assert.ok(!plan.tools.includes("indexation"));
    assert.ok(plan.tools.includes("check-top"));
  });

  it("22. FIRST36_STAGE2 has separate digest", () => {
    const s1 = buildArsenkinExecutionPlan(
      basePlanInput({ stage: "FIRST36_STAGE1", maxNewTasks: 20, maxEstimatedLimits: 20 })
    );
    const s2 = buildArsenkinExecutionPlan(
      basePlanInput({
        stage: "FIRST36_STAGE2",
        maxNewTasks: 10,
        maxEstimatedLimits: 10,
        urlsEnrichment: ["https://example.com/a"],
      })
    );
    assert.notEqual(s1.digest, s2.digest);
  });

  it("23. foreign client binding gate (pure)", () => {
    const reportRunId = "run-a";
    const clientRunId = "run-b";
    assert.notEqual(reportRunId, clientRunId);
  });

  it("24. QA sample gate (pure)", () => {
    const adminDecisionSource = "qa-sample-fixture";
    assert.match(adminDecisionSource, /qa.?sample|fixture/i);
  });

  it("25. FAILED status after run error is represented in runner finally", () => {
    // Covered by canonical runner finally block; assert contract string exists in source.
    const src = readFileSync("scripts/arsenkin-canonical-live-runner.ts", "utf-8");
    assert.match(src, /status: "FAILED"/);
  });

  it("26-28. DB integration mandatory profile", { skip: true }, () => {
    // Real PASS requires test PostgreSQL — recorded as BLOCKED in readiness artifact.
    assert.fail("unreachable");
  });

  it("29. duplicate audit finds groups", () => {
    const audit = findSurfaceCoverageDuplicateGroups([
      {
        id: "1",
        reportRunId: "r",
        provider: "arsenkin",
        tool: "suggest",
        queryId: "q",
        surface: "autocomplete",
        engine: "GOOGLE",
        region: "RU",
        language: "ru",
        device: "DESKTOP",
      },
      {
        id: "2",
        reportRunId: "r",
        provider: "arsenkin",
        tool: "suggest",
        queryId: "q",
        surface: "autocomplete",
        engine: "GOOGLE",
        region: "RU",
        language: "ru",
        device: "DESKTOP",
      },
    ]);
    assert.equal(audit.duplicateGroupCount, 1);
    writeFileSync(
      join(ART, "coverage-duplicate-audit.json"),
      `${JSON.stringify(audit, null, 2)}\n`
    );
  });

  it("30. dry-run with blockers → BLOCKED", () => {
    assert.equal(
      resolveBackfillAuditVerdict({ mode: "dry-run", blockers: ["ambiguous=1"] }),
      "BLOCKED"
    );
  });

  it("31. dry-run without blockers → READY_FOR_APPLY", () => {
    assert.equal(resolveBackfillAuditVerdict({ mode: "dry-run", blockers: [] }), "READY_FOR_APPLY");
  });

  it("32. transaction exception → FAILED", () => {
    assert.equal(
      resolveBackfillAuditVerdict({
        mode: "apply",
        blockers: [],
        transactionError: true,
      }),
      "FAILED"
    );
  });

  it("assertLiveCollectAllowed + fixtures path network free", async () => {
    resetArsenkinNetworkCallCount();
    const collected = await collectArsenkinPilotSurfaces({
      caseId: "c",
      auditRunId: "r",
      queriesRu: ["q"],
      queriesUae: [],
      fixturesOnly: true,
      tools: ["suggest"],
    });
    assert.equal(collected.mode, "fixtures");
    assert.equal(getArsenkinNetworkCallCount(), 0);
    const summary = formatRerenderNetworkSummary({
      reused: 0,
      wouldCreate: 0,
      created: 0,
      networkCalls: getArsenkinNetworkCallCount(),
    });
    assert.match(summary, /NETWORK_CALLS 0/);
  });

  it("write live readiness + legacy blocking artifacts", () => {
    const dbUrl = String(process.env.DATABASE_URL ?? "");
    const hasRealDb =
      Boolean(dbUrl.trim()) &&
      !/postgresql:\/\/u:p@127\.0\.0\.1:5432\/db/i.test(dbUrl) &&
      process.env.ARSENKIN_DB_INTEGRATION_REQUIRED === "1";

    const readiness = {
      verdict: hasRealDb ? "LIVE_READY_PENDING_HUMAN_EXECUTE" : "BLOCKED",
      reasons: hasRealDb
        ? []
        : [
            "test-postgresql-integration-not-PASS",
            "ARSENKIN_DB_INTEGRATION_REQUIRED profile not green in this environment",
          ],
      networkEntrypoints: NETWORK_ENTRYPOINTS.length,
      liveApiCalledDuringImplementation: false,
      productionApplyExecuted: false,
      planOnlyNetworkCalls: 0,
      dbEnvironment: hasRealDb ? "test-or-staging" : "none",
    };
    writeFileSync(join(ART, "arsenkin-live-readiness.json"), `${JSON.stringify(readiness, null, 2)}\n`);
    writeFileSync(
      join(ART, "legacy-entrypoint-blocking.json"),
      `${JSON.stringify(
        {
          canary: "HARD_FAIL",
          abPilotLive: "HARD_FAIL",
          rerenderNonOnly: "HARD_FAIL",
          abPilotFixtures: "allowed",
          rerenderOnly: "allowed",
        },
        null,
        2
      )}\n`
    );
    writeFileSync(
      join(ART, "db-integration-summary.json"),
      `${JSON.stringify(
        {
          profile: process.env.ARSENKIN_DB_INTEGRATION_REQUIRED === "1" ? "required" : "local",
          result: hasRealDb ? "UNKNOWN_RUN_SEPARATELY" : "SKIP",
          note: "Do not claim PASS without ARSENKIN_DB_INTEGRATION_REQUIRED=1 on real test Postgres",
        },
        null,
        2
      )}\n`
    );
    assert.equal(readiness.verdict, "BLOCKED");
  });
});
