/**
 * Focused offline smokes for P0.2 fail-closed provenance + live-confirm gap.
 * LIVE API NOT RUN. No production --apply.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyBackfillMatch,
  computeBackfillPlanDigest,
  evaluateBackfillApplyGate,
  normalizeBackfillQuery,
  queriesMatchExact,
  sortProposedBackfillLinks,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-provenance-backfill-match";
import {
  buildPlannedTaskPreflight,
  computePlanDigest,
  formatRerenderNetworkSummary,
  planArsenkinExactTasks,
} from "../src/modules/digital-profile/orion-golden/classic/rerender-task-preflight";
import { findSurfaceCoverageDuplicateGroups } from "../src/modules/digital-profile/providers/arsenkin/surface-coverage-duplicate-audit";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";

describe("arsenkin p0.2 fail-closed", () => {
  it("exact normalized query match", () => {
    assert.equal(normalizeBackfillQuery("  Foo\u00A0BAR  "), "foo bar");
    assert.ok(queriesMatchExact("Subject Name", "subject   name"));
    assert.equal(
      classifyBackfillMatch(
        { tool: "suggest", engine: "GOOGLE", region: "RU", queryText: "Subject Name" },
        [{ id: "t1", toolName: "suggest", engine: "GOOGLE", region: "RU", queries: ["subject   name"] }]
      ).kind,
      "unique"
    );
  });

  it("similar substring does not match", () => {
    assert.equal(
      classifyBackfillMatch(
        { tool: "suggest", engine: "GOOGLE", region: "RU", queryText: "subject" },
        [
          {
            id: "t1",
            toolName: "suggest",
            engine: "GOOGLE",
            region: "RU",
            queries: ["subject long variant"],
          },
        ]
      ).kind,
      "unmatched"
    );
  });

  it("ambiguous blocks apply", () => {
    const gate = evaluateBackfillApplyGate({
      reportRunId: "run",
      mode: "apply",
      proposed: [{ kind: "observation", id: "o1", providerTaskId: "t1" }],
      ambiguous: [{ kind: "observation", id: "o2", candidateIds: ["t1", "t2"] }],
      unmatched: [],
      allowUnmatched: false,
      confirmPlanDigest: "abc",
      expectObservations: 1,
      expectCoverage: 0,
      planDigest: "abc",
    });
    assert.equal(gate.ok, false);
    assert.ok(gate.blockers.some((b) => b.startsWith("ambiguous=")));
  });

  it("unmatched blocks apply by default", () => {
    const gate = evaluateBackfillApplyGate({
      reportRunId: "run",
      mode: "apply",
      proposed: [],
      ambiguous: [],
      unmatched: [{ kind: "observation", id: "o1", tip: {} }],
      allowUnmatched: false,
      confirmPlanDigest: "abc",
      expectObservations: 0,
      expectCoverage: 0,
      planDigest: "abc",
    });
    assert.equal(gate.ok, false);
    assert.ok(gate.blockers.some((b) => b.includes("unmatched")));
  });

  it("--allow-unmatched does not permit ambiguous", () => {
    const gate = evaluateBackfillApplyGate({
      reportRunId: "run",
      mode: "apply",
      proposed: [],
      ambiguous: [{ kind: "coverage", id: "c1", candidateIds: ["a", "b"] }],
      unmatched: [{ kind: "observation", id: "o1", tip: {} }],
      allowUnmatched: true,
      confirmPlanDigest: "abc",
      expectObservations: 0,
      expectCoverage: 0,
      planDigest: "abc",
    });
    assert.equal(gate.ok, false);
    assert.ok(gate.blockers.some((b) => b.startsWith("ambiguous=")));
    assert.ok(!gate.blockers.some((b) => b.includes("unmatched")));
  });

  it("missing expected counts block apply", () => {
    const gate = evaluateBackfillApplyGate({
      reportRunId: "run",
      mode: "apply",
      proposed: [],
      ambiguous: [],
      unmatched: [],
      allowUnmatched: false,
      confirmPlanDigest: "abc",
      planDigest: "abc",
    });
    assert.equal(gate.ok, false);
    assert.ok(gate.blockers.includes("missing-expect-observations"));
    assert.ok(gate.blockers.includes("missing-expect-coverage"));
  });

  it("wrong expected counts block apply", () => {
    const gate = evaluateBackfillApplyGate({
      reportRunId: "run",
      mode: "apply",
      proposed: [
        { kind: "observation", id: "o1", providerTaskId: "t1" },
        { kind: "coverage", id: "c1", providerTaskId: "t1" },
      ],
      ambiguous: [],
      unmatched: [],
      allowUnmatched: false,
      confirmPlanDigest: "abc",
      expectObservations: 5,
      expectCoverage: 9,
      planDigest: "abc",
    });
    assert.equal(gate.ok, false);
    assert.ok(gate.blockers.some((b) => b.includes("expect-observations-mismatch")));
    assert.ok(gate.blockers.some((b) => b.includes("expect-coverage-mismatch")));
  });

  it("missing digest blocks apply", () => {
    const gate = evaluateBackfillApplyGate({
      reportRunId: "run",
      mode: "apply",
      proposed: [],
      ambiguous: [],
      unmatched: [],
      allowUnmatched: false,
      expectObservations: 0,
      expectCoverage: 0,
      planDigest: "abc",
    });
    assert.equal(gate.ok, false);
    assert.ok(gate.blockers.includes("missing-confirm-plan-digest"));
  });

  it("digest mismatch blocks apply", () => {
    const gate = evaluateBackfillApplyGate({
      reportRunId: "run",
      mode: "apply",
      proposed: [],
      ambiguous: [],
      unmatched: [],
      allowUnmatched: false,
      confirmPlanDigest: "wrong",
      expectObservations: 0,
      expectCoverage: 0,
      planDigest: "right",
    });
    assert.equal(gate.ok, false);
    assert.ok(gate.blockers.some((b) => b.startsWith("plan-digest-mismatch")));
  });

  it("deterministic plan digest is stable under row reorder", () => {
    const a = [
      { kind: "coverage" as const, id: "c2", providerTaskId: "t2" },
      { kind: "observation" as const, id: "o1", providerTaskId: "t1" },
    ];
    const b = sortProposedBackfillLinks([...a].reverse());
    const d1 = computeBackfillPlanDigest({
      reportRunId: "run",
      proposed: a,
      ambiguous: [],
      unmatched: [],
      allowUnmatched: false,
    });
    const d2 = computeBackfillPlanDigest({
      reportRunId: "run",
      proposed: b,
      ambiguous: [],
      unmatched: [],
      allowUnmatched: false,
    });
    assert.equal(d1, d2);
  });

  it("successful fixture gate passes with matching digest/counts", () => {
    const proposed = sortProposedBackfillLinks([
      { kind: "observation", id: "o1", providerTaskId: "t1" },
      { kind: "coverage", id: "c1", providerTaskId: "t1" },
    ]);
    const planDigest = computeBackfillPlanDigest({
      reportRunId: "run",
      proposed,
      ambiguous: [],
      unmatched: [],
      allowUnmatched: false,
    });
    const gate = evaluateBackfillApplyGate({
      reportRunId: "run",
      mode: "apply",
      proposed,
      ambiguous: [],
      unmatched: [],
      allowUnmatched: false,
      confirmPlanDigest: planDigest,
      expectObservations: 1,
      expectCoverage: 1,
      planDigest,
    });
    assert.equal(gate.ok, true);
    assert.deepEqual(gate.blockers, []);
  });

  it("reuse-only live without ARSENKIN_LIVE_CONFIRM is blocked", () => {
    const planned = planArsenkinExactTasks({
      queriesRu: ["Имя"],
      queriesUae: [],
      tools: ["suggest"],
    });
    const yandex = planned.find((p) => p.engine === "YANDEX")!;
    // Mark all planned hashes as DONE → WOULD_CREATE=0 but still live.
    const tasks = planned.map((p, i) => ({
      toolName: p.tool,
      requestHash: p.requestHash,
      state: "DONE",
      id: `t${i}`,
    }));
    const pf = buildPlannedTaskPreflight({
      reportRunId: "run",
      tasks,
      requestedTools: ["suggest"],
      rerenderOnly: false,
      allowNewProviderTasks: false,
      liveConfirm: false,
      queriesRu: ["Имя"],
      queriesUae: [],
    });
    assert.equal(pf.plannedNewTasks, 0);
    assert.equal(pf.blocked, true);
    assert.ok(String(pf.blockReason).includes("ARSENKIN_LIVE_CONFIRM"));
    void yandex;
  });

  it("rerender-only remains network-free summary", () => {
    resetArsenkinNetworkCallCount();
    const pf = buildPlannedTaskPreflight({
      reportRunId: "run",
      tasks: [
        { toolName: "check-top", requestHash: "h1", state: "DONE" },
        { toolName: "suggest", requestHash: "h2", state: "DONE" },
        { toolName: "paa", requestHash: "h3", state: "DONE" },
      ],
      requestedTools: null,
      rerenderOnly: true,
      allowNewProviderTasks: false,
      liveConfirm: false,
    });
    assert.equal(pf.blocked, false);
    assert.equal(pf.plannedNewTasks, 0);
    assert.equal(getArsenkinNetworkCallCount(), 0);
    assert.equal(
      formatRerenderNetworkSummary({
        reused: pf.reusedTasks,
        wouldCreate: pf.wouldCreate,
        created: 0,
        networkCalls: 0,
      }),
      `REUSED ${pf.reusedTasks}, WOULD_CREATE 0, CREATED 0, NETWORK_CALLS 0`
    );
  });

  it("CREATE requires allow-new + live confirm + digest", () => {
    const planned = planArsenkinExactTasks({
      queriesRu: ["A"],
      queriesUae: ["B"],
      tools: ["suggest"],
    });
    const digest = computePlanDigest(planned);
    const base = {
      reportRunId: "run",
      tasks: [] as Array<{ toolName: string; requestHash: string; state: string }>,
      requestedTools: ["suggest"],
      rerenderOnly: false,
      queriesRu: ["A"],
      queriesUae: ["B"],
    };
    assert.equal(
      buildPlannedTaskPreflight({ ...base, allowNewProviderTasks: false, liveConfirm: true, confirmPlanDigest: digest })
        .blocked,
      true
    );
    assert.equal(
      buildPlannedTaskPreflight({ ...base, allowNewProviderTasks: true, liveConfirm: false, confirmPlanDigest: digest })
        .blocked,
      true
    );
    assert.equal(
      buildPlannedTaskPreflight({ ...base, allowNewProviderTasks: true, liveConfirm: true }).blocked,
      true
    );
    const ok = buildPlannedTaskPreflight({
      ...base,
      allowNewProviderTasks: true,
      liveConfirm: true,
      confirmPlanDigest: digest,
    });
    assert.equal(ok.blocked, false);
    assert.ok(ok.plannedNewTasks > 0);
  });

  it("duplicate audit correctly finds groups", () => {
    const audit = findSurfaceCoverageDuplicateGroups([
      {
        id: "1",
        reportRunId: "r",
        provider: "arsenkin",
        tool: "paa",
        queryId: "q",
        surface: "paa",
        engine: "GOOGLE",
        region: "RU",
        language: "ru",
        device: "DESKTOP",
      },
      {
        id: "2",
        reportRunId: "r",
        provider: "arsenkin",
        tool: "paa",
        queryId: "q",
        surface: "paa",
        engine: "GOOGLE",
        region: "RU",
        language: "ru",
        device: "DESKTOP",
      },
    ]);
    assert.equal(audit.duplicateGroupCount, 1);
    assert.equal(audit.groups[0]!.count, 2);
  });
});
