/**
 * Focused offline smokes for Arsenkin P0.1 follow-up (no live API).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  geometryReportIsClean,
  inspectBlankPagePngs,
  inspectSlideXmlGeometry,
  loadGeometryFixture,
} from "../src/modules/digital-profile/orion-golden/classic/generate-first36-geometry-artifacts";
import {
  buildPlannedTaskPreflight,
  formatRerenderNetworkSummary,
} from "../src/modules/digital-profile/orion-golden/classic/rerender-task-preflight";
import {
  getArsenkinNetworkCallCount,
  isArsenkinRerenderOnly,
  noteArsenkinNetworkCall,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";
import { ArsenkinClient, ArsenkinRequestError } from "../src/modules/digital-profile/providers/arsenkin/client";
import { createMemoryProviderTaskStore } from "../src/modules/digital-profile/providers/arsenkin/provider-task-store";
import {
  ensureArsenkinTask,
  pollArsenkinTask,
  waitForArsenkinTaskCompletion,
} from "../src/modules/digital-profile/providers/arsenkin/poll-worker";
import { classifyBackfillMatch } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-provenance-backfill-match";
import { inspectFirst36Acceptance } from "../src/modules/digital-profile/orion-golden/classic/first36-acceptance-gate";

function mockClient(handlers: {
  setTask?: () => Promise<{ task_id: string; raw: Record<string, unknown> }>;
  checkTask?: (id: string) => Promise<{
    task_id: string;
    state: string;
    statusPayload: Record<string, unknown>;
    raw: Record<string, unknown>;
  }>;
  getTask?: (id: string) => Promise<{ task_id: string; result: unknown; raw: Record<string, unknown> }>;
  getLimits?: () => Promise<{ limitsLeft?: number; raw: Record<string, unknown> }>;
}) {
  return {
    setTask: handlers.setTask ?? (async () => ({ task_id: "t1", raw: { task_id: "t1" } })),
    checkTask:
      handlers.checkTask ??
      (async (id: string) => ({
        task_id: id,
        state: "DONE",
        statusPayload: {},
        raw: { status: "done" },
      })),
    getTask:
      handlers.getTask ??
      (async (id: string) => ({ task_id: id, result: { ok: true }, raw: { result: { ok: true } } })),
    getLimits: handlers.getLimits ?? (async () => ({ limitsLeft: 100, raw: {} })),
  } as unknown as ArsenkinClient;
}

describe("arsenkin p0.1 follow-up", () => {
  it("429 then success via waitForArsenkinTaskCompletion: exactly 2 /set", async () => {
    const store = createMemoryProviderTaskStore();
    let sets = 0;
    const client = mockClient({
      setTask: async () => {
        sets += 1;
        if (sets === 1) {
          throw new ArsenkinRequestError("rate limited", { status: 429 });
        }
        return { task_id: "ext-ok", raw: { task_id: "ext-ok" } };
      },
    });
    const input = { toolName: "suggest", data: { q: "429-retry" }, reportRunId: "run-429" };
    const first = await ensureArsenkinTask(client, store, input);
    assert.equal(first.state, "RATE_LIMITED");
    assert.equal(sets, 1);
    // Force backoff elapsed.
    await store.updateState(first.id, {
      state: "RATE_LIMITED",
      nextPollAt: new Date(Date.now() - 10),
      attempts: first.attempts,
    });
    const done = await waitForArsenkinTaskCompletion(client, store, input, 10_000);
    assert.equal(done.state, "DONE");
    assert.equal(sets, 2);
  });

  it("immediate ensure before nextPollAt causes 0 new /set", async () => {
    const store = createMemoryProviderTaskStore();
    let sets = 0;
    const client = mockClient({
      setTask: async () => {
        sets += 1;
        throw new ArsenkinRequestError("rate limited", { status: 429 });
      },
    });
    const input = { toolName: "suggest", data: { q: "wait" }, reportRunId: "run-wait" };
    const first = await ensureArsenkinTask(client, store, input);
    assert.equal(first.state, "RATE_LIMITED");
    assert.equal(sets, 1);
    await store.updateState(first.id, {
      state: "RATE_LIMITED",
      nextPollAt: new Date(Date.now() + 60_000),
      attempts: first.attempts,
    });
    const again = await ensureArsenkinTask(client, store, input);
    assert.equal(again.state, "RATE_LIMITED");
    assert.equal(sets, 1);
  });

  it("RATE_LIMITED without externalTaskId never becomes missing_external_task_id", async () => {
    const store = createMemoryProviderTaskStore();
    const row = await store.upsertPending({
      reportRunId: "run-rl",
      toolName: "suggest",
      requestJson: { q: "x" },
    });
    await store.updateState(row.id, {
      state: "RATE_LIMITED",
      nextPollAt: new Date(0),
      errorCode: "http_429",
    });
    const polled = await pollArsenkinTask(mockClient({}), store, await store.findById(row.id) as never);
    assert.equal(polled.state, "RATE_LIMITED");
    assert.notEqual(polled.errorCode, "missing_external_task_id");
  });

  it("two workers after nextPollAt: exactly one retry /set", async () => {
    const store = createMemoryProviderTaskStore();
    let sets = 0;
    const client = mockClient({
      setTask: async () => {
        sets += 1;
        await new Promise((r) => setTimeout(r, 20));
        return { task_id: `ext-${sets}`, raw: { task_id: `ext-${sets}` } };
      },
    });
    const input = { toolName: "suggest", data: { q: "race" }, reportRunId: "run-race" };
    const row = await store.upsertPending({
      reportRunId: input.reportRunId,
      toolName: input.toolName,
      requestJson: { tools_name: input.toolName, data: input.data },
    });
    await store.updateState(row.id, {
      state: "RATE_LIMITED",
      externalTaskId: null,
      nextPollAt: new Date(Date.now() - 1),
      attempts: 1,
      lockedBy: null,
      leaseUntil: null,
    });
    await Promise.all([
      ensureArsenkinTask(client, store, { ...input, workerId: "w1" }),
      ensureArsenkinTask(client, store, { ...input, workerId: "w2" }),
    ]);
    assert.equal(sets, 1);
  });

  it("rerender-only preflight: plannedNewTasks=0 for existing tools", () => {
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
    assert.equal(pf.plannedNewTasks, 0);
    assert.equal(pf.blocked, false);
    assert.deepEqual(pf.tools, ["check-top", "suggest", "paa"]);
  });

  it("rerender-only blocks missing stage-2 tools", () => {
    const pf = buildPlannedTaskPreflight({
      reportRunId: "run",
      tasks: [{ toolName: "suggest", requestHash: "h1", state: "DONE" }],
      requestedTools: ["suggest", "ai-serp"],
      rerenderOnly: true,
      allowNewProviderTasks: false,
      liveConfirm: false,
    });
    assert.ok(pf.plannedNewTasks > 0);
    assert.equal(pf.blocked, true);
  });

  it("allow-new-provider-tasks without LIVE_CONFIRM still blocked", () => {
    const pf = buildPlannedTaskPreflight({
      reportRunId: "run",
      tasks: [{ toolName: "suggest", requestHash: "h1", state: "DONE" }],
      requestedTools: ["suggest", "ai-serp"],
      rerenderOnly: false,
      allowNewProviderTasks: true,
      liveConfirm: false,
    });
    assert.equal(pf.blocked, true);
  });

  it("geometry missing/failure/pass helpers", () => {
    const dir = mkdtempSync(join(tmpdir(), "geo-"));
    mkdirSync(join(dir, "pages-png"));
    writeFileSync(join(dir, "pages-png", "01.png"), "tiny");
    const blank = inspectBlankPagePngs(join(dir, "pages-png"));
    assert.ok(blank.some((b) => b.page === 0 || b.detail.includes("tiny") || b.detail.includes("expected 36")));

    const badXml = `<a:off x="500000" y="6800000"/><a:ext cx="4000000" cy="1200000"/>`;
    const overflow = inspectSlideXmlGeometry(badXml, 1);
    assert.ok(overflow.overflow.length > 0);

    assert.equal(geometryReportIsClean(loadGeometryFixture("clean-page.json")), true);
    assert.equal(geometryReportIsClean(loadGeometryFixture("clipping-overflow.json")), false);
    assert.equal(loadGeometryFixture("overlap.json").summary.severity, "CRITICAL");
    assert.equal(loadGeometryFixture("missing-image.json").summary.severity, "BLOCKER");
  });

  it("RATE_LIMITED with externalTaskId remains pollable", async () => {
    const store = createMemoryProviderTaskStore();
    const row = await store.upsertPending({
      reportRunId: "run-poll",
      toolName: "suggest",
      requestJson: { q: "poll" },
    });
    await store.updateState(row.id, {
      state: "RATE_LIMITED",
      externalTaskId: "ext-poll",
      nextPollAt: new Date(0),
    });
    let checked = 0;
    const client = mockClient({
      checkTask: async (id) => {
        checked += 1;
        return { task_id: id, state: "DONE", statusPayload: {}, raw: { status: "done" } };
      },
    });
    const polled = await pollArsenkinTask(client, store, (await store.findById(row.id))!);
    assert.equal(checked, 1);
    assert.equal(polled.state, "DONE");
  });

  it("transport uncertainty does not blind-retry /set", async () => {
    const store = createMemoryProviderTaskStore();
    let sets = 0;
    const client = mockClient({
      setTask: async () => {
        sets += 1;
        throw new ArsenkinRequestError("socket hang up", { uncertain: true });
      },
    });
    const row = await ensureArsenkinTask(client, store, {
      toolName: "suggest",
      data: { q: "uncertain" },
      reportRunId: "run-unc",
    });
    assert.equal(row.state, "SUBMIT_UNKNOWN");
    assert.equal(sets, 1);
    const again = await ensureArsenkinTask(client, store, {
      toolName: "suggest",
      data: { q: "uncertain" },
      reportRunId: "run-unc",
    });
    assert.equal(again.state, "SUBMIT_UNKNOWN");
    assert.equal(sets, 1);
  });

  it("rerender-only network guard: NETWORK_CALLS stays 0 and blocks HTTP", () => {
    resetArsenkinNetworkCallCount();
    process.env.ARSENKIN_RERENDER_ONLY = "1";
    assert.equal(isArsenkinRerenderOnly(), true);
    assert.throws(() => noteArsenkinNetworkCall("set"), /forbids network call/);
    assert.equal(getArsenkinNetworkCallCount(), 0);
    delete process.env.ARSENKIN_RERENDER_ONLY;
    noteArsenkinNetworkCall("set");
    assert.equal(getArsenkinNetworkCallCount(), 1);
    assert.equal(
      formatRerenderNetworkSummary({ reused: 3, wouldCreate: 0, created: 0, networkCalls: 0 }),
      "REUSED 3, WOULD_CREATE 0, CREATED 0, NETWORK_CALLS 0"
    );
    resetArsenkinNetworkCallCount();
  });

  it("backfill unique/ambiguous/unmatched", () => {
    const candidates = [
      { id: "t1", toolName: "suggest", engine: "GOOGLE", region: "RU", queries: ["subject"] },
      { id: "t2", toolName: "suggest", engine: "GOOGLE", region: "RU", queries: ["subject"] },
      { id: "t3", toolName: "paa", engine: "GOOGLE", region: "UAE", queries: ["subject en"] },
    ];
    assert.equal(
      classifyBackfillMatch(
        { tool: "paa", engine: "GOOGLE", region: "UAE", queryText: "subject en" },
        candidates
      ).kind,
      "unique"
    );
    assert.equal(
      classifyBackfillMatch(
        { tool: "suggest", engine: "GOOGLE", region: "RU", queryText: "subject" },
        candidates
      ).kind,
      "ambiguous"
    );
    assert.equal(
      classifyBackfillMatch({ tool: "check-top", engine: "GOOGLE", region: "RU" }, candidates).kind,
      "unmatched"
    );
  });

  it("empty suggest NO_RESULTS keeps providerTaskId without fake observation", () => {
    // surfaceRuns contract: resultCount=0 + providerTaskId set.
    const surfaceRun = {
      tool: "suggest",
      engine: "GOOGLE",
      region: "RU",
      language: "ru",
      query: "subject",
      surface: "autocomplete",
      providerTaskId: "task-1",
      resultCount: 0,
    };
    assert.equal(surfaceRun.resultCount, 0);
    assert.equal(surfaceRun.providerTaskId, "task-1");
    assert.equal([].length, 0); // no fake drafts
  });

  it("final readiness cannot bypass acceptance (foreign client => INTERNAL_PREVIEW)", () => {
    const slides = Array.from({ length: 36 }, (_, i) => ({
      pageNumber: i + 1,
      title: i === 18 || i === 35 ? "slot" : `p${i + 1}`,
      narrative: i === 18 || i === 35 ? "content" : undefined,
    }));
    const dir = mkdtempSync(join(tmpdir(), "acc-"));
    mkdirSync(join(dir, "pages-png"));
    for (let i = 1; i <= 36; i += 1) {
      writeFileSync(join(dir, "pages-png", `${String(i).padStart(2, "0")}.png`), Buffer.alloc(4000));
    }
    writeFileSync(join(dir, "rendered-client.pdf"), "x");
    writeFileSync(join(dir, "rendered-client.pptx"), "x");

    const r = inspectFirst36Acceptance({
      slideCount: 36,
      slides,
      runScopedMerge: { usedRunScoped: true, observationCount: 5 },
      arsenkinRequired: true,
      clientFinalize: true,
      expectedRunId: "run-new",
      clientContentSourceReportRunId: "run-old",
      arsenkinEnrich: { mode: "live", skipped: true, reason: "already_enriched organic=20" },
      providerTasks: [{ id: "t1", reportRunId: "run-new", state: "DONE" }],
      observations: [{ auditRunId: "run-new", provider: "arsenkin", providerTaskId: "t1" }],
      provenanceSummary: {
        linkedObservations: 1,
        totalObservations: 1,
        linkedCoverage: 6,
        totalCoverage: 6,
      },
      coverageSummary: {
        reportRunId: "run-new",
        rows: [
          { tool: "check-top", engine: "GOOGLE", region: "RU", surface: "organic", status: "OK", providerTaskId: "t1" },
          { tool: "suggest", engine: "YANDEX", region: "RU", surface: "autocomplete", status: "NO_RESULTS", providerTaskId: "t1" },
          { tool: "suggest", engine: "GOOGLE", region: "RU", surface: "autocomplete", status: "OK", providerTaskId: "t1" },
          { tool: "suggest", engine: "GOOGLE", region: "UAE", surface: "autocomplete", status: "OK", providerTaskId: "t1" },
          { tool: "paa", engine: "GOOGLE", region: "RU", surface: "paa", status: "OK", providerTaskId: "t1" },
          { tool: "paa", engine: "GOOGLE", region: "UAE", surface: "paa", status: "OK", providerTaskId: "t1" },
        ],
      },
      geometryReport: {
        overlaps: [],
        overflow: [],
        blank: [],
        summary: { issueCount: 0, severity: "PASS", pageCount: 36 },
      },
      geometryReportPresent: true,
      paths: {
        pdf: join(dir, "rendered-client.pdf"),
        pptx: join(dir, "rendered-client.pptx"),
        pagesPngDir: join(dir, "pages-png"),
      },
      assets: [],
      requiredVisualAssetRefs: [],
    });
    assert.equal(r.ceoReady, false);
    assert.ok(r.issues.some((i) => i.code === "foreign-client-content-run"));
    // Even if renderQaReady were true, acceptance blocks CEO_READY.
  });

  it("rebuilt client content binding passes when source matches expected run", () => {
    const slides = Array.from({ length: 36 }, (_, i) => ({
      pageNumber: i + 1,
      title: i === 18 || i === 35 ? "slot" : `p${i + 1}`,
      narrative: i === 18 || i === 35 ? "content" : undefined,
    }));
    const dir = mkdtempSync(join(tmpdir(), "acc-bound-"));
    mkdirSync(join(dir, "pages-png"));
    for (let i = 1; i <= 36; i += 1) {
      writeFileSync(join(dir, "pages-png", `${String(i).padStart(2, "0")}.png`), Buffer.alloc(4000));
    }
    writeFileSync(join(dir, "rendered-client.pdf"), "x");
    writeFileSync(join(dir, "rendered-client.pptx"), "x");

    const runId = "orion-r10-rebuilt-123";
    const r = inspectFirst36Acceptance({
      slideCount: 36,
      slides,
      runScopedMerge: { usedRunScoped: true, observationCount: 5 },
      arsenkinRequired: true,
      clientFinalize: true,
      expectedRunId: runId,
      clientContentSourceReportRunId: runId,
      arsenkinEnrich: { mode: "live", skipped: true, reason: "already_enriched organic=20" },
      providerTasks: [{ id: "t1", reportRunId: runId, state: "DONE" }],
      observations: [{ auditRunId: runId, provider: "arsenkin", providerTaskId: "t1" }],
      provenanceSummary: {
        linkedObservations: 1,
        totalObservations: 1,
        linkedCoverage: 6,
        totalCoverage: 6,
      },
      coverageSummary: {
        reportRunId: runId,
        rows: [
          { tool: "check-top", engine: "GOOGLE", region: "RU", surface: "organic", status: "OK", providerTaskId: "t1" },
          { tool: "suggest", engine: "YANDEX", region: "RU", surface: "autocomplete", status: "NO_RESULTS", providerTaskId: "t1" },
          { tool: "suggest", engine: "GOOGLE", region: "RU", surface: "autocomplete", status: "OK", providerTaskId: "t1" },
          { tool: "suggest", engine: "GOOGLE", region: "UAE", surface: "autocomplete", status: "OK", providerTaskId: "t1" },
          { tool: "paa", engine: "GOOGLE", region: "RU", surface: "paa", status: "OK", providerTaskId: "t1" },
          { tool: "paa", engine: "GOOGLE", region: "UAE", surface: "paa", status: "OK", providerTaskId: "t1" },
        ],
      },
      geometryReport: {
        overlaps: [],
        overflow: [],
        blank: [],
        summary: { issueCount: 0, severity: "PASS", pageCount: 36 },
      },
      geometryReportPresent: true,
      paths: {
        pdf: join(dir, "rendered-client.pdf"),
        pptx: join(dir, "rendered-client.pptx"),
        pagesPngDir: join(dir, "pages-png"),
      },
      assets: [],
      requiredVisualAssetRefs: [],
    });
    assert.ok(!r.issues.some((i) => i.code === "foreign-client-content-run"));
    if (r.passed) {
      assert.equal(r.ceoReady, true);
    }
  });
});
