/**
 * Focused offline smokes for Arsenkin P0 hardening (no live API).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArsenkinClient, ArsenkinRequestError } from "../src/modules/digital-profile/providers/arsenkin/client";
import {
  createMemoryProviderTaskStore,
  hashProviderRequest,
} from "../src/modules/digital-profile/providers/arsenkin/provider-task-store";
import { ensureArsenkinTask, pollArsenkinTask, runDueArsenkinPolls } from "../src/modules/digital-profile/providers/arsenkin/poll-worker";
import { createMemoryArsenkinAccountLimiter, arsenkinAccountLimiterConfig } from "../src/modules/digital-profile/providers/arsenkin/account-rate-limit";
import { computeLimitsSpent, costStatusFromSpent } from "../src/modules/digital-profile/providers/arsenkin/cost";
import { inspectFirst36Acceptance } from "../src/modules/digital-profile/orion-golden/classic/first36-acceptance-gate";

function mockClient(handlers: {
  setTask?: (body: unknown) => Promise<{ task_id: string; raw: Record<string, unknown> }>;
  checkTask?: (id: string) => Promise<{ task_id: string; state: string; statusPayload: Record<string, unknown>; raw: Record<string, unknown> }>;
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

describe("arsenkin p0 hardening", () => {
  it("concurrent ensure: exactly one /set", async () => {
    const store = createMemoryProviderTaskStore();
    let sets = 0;
    const client = mockClient({
      setTask: async () => {
        sets += 1;
        await new Promise((r) => setTimeout(r, 30));
        return { task_id: `ext-${sets}`, raw: { task_id: `ext-${sets}` } };
      },
    });
    const input = { toolName: "suggest", data: { q: "subject" }, reportRunId: "run-1" };
    const [a, b] = await Promise.all([
      ensureArsenkinTask(client, store, { ...input, workerId: "w1" }),
      ensureArsenkinTask(client, store, { ...input, workerId: "w2" }),
    ]);
    assert.equal(sets, 1);
    assert.equal(a.id, b.id);
    assert.ok(a.externalTaskId || b.externalTaskId || a.state === "SUBMITTING" || b.state === "SUBMITTING");
    // Winner becomes RUNNING; loser returns SUBMITTING or RUNNING after re-read.
    const final = await store.findById(a.id);
    assert.ok(final);
    assert.notEqual(final.state, "QUEUED");
  });

  it("restart while SUBMITTING does not re-POST /set and expires to SUBMIT_UNKNOWN", async () => {
    const store = createMemoryProviderTaskStore();
    let sets = 0;
    const client = mockClient({
      setTask: async () => {
        sets += 1;
        return { task_id: "ext-1", raw: { task_id: "ext-1" } };
      },
    });
    const requestJson = { tools_name: "suggest", data: { q: "x" } };
    const row = await store.upsertPending({
      reportRunId: "run-1",
      toolName: "suggest",
      requestJson: requestJson as unknown as Record<string, unknown>,
      requestHash: hashProviderRequest(requestJson),
    });
    await store.updateState(row.id, {
      state: "SUBMITTING",
      lockedBy: "dead-worker",
      lockedAt: new Date(Date.now() - 120_000),
      leaseUntil: new Date(Date.now() - 60_000),
    });
    const after = await ensureArsenkinTask(client, store, {
      toolName: "suggest",
      data: { q: "x" },
      reportRunId: "run-1",
      workerId: "restart",
    });
    assert.equal(sets, 0);
    assert.equal(after.state, "SUBMIT_UNKNOWN");
  });

  it("HTTP 5xx / transport after POST becomes SUBMIT_UNKNOWN", async () => {
    const store = createMemoryProviderTaskStore();
    const client5xx = mockClient({
      setTask: async () => {
        throw new ArsenkinRequestError("server error", { status: 503, uncertain: true });
      },
    });
    const a = await ensureArsenkinTask(client5xx, store, {
      toolName: "suggest",
      data: { q: "5xx" },
      reportRunId: "run-5xx",
    });
    assert.equal(a.state, "SUBMIT_UNKNOWN");

    const store2 = createMemoryProviderTaskStore();
    const clientTransport = mockClient({
      setTask: async () => {
        throw new ArsenkinRequestError("socket hang up", { uncertain: true });
      },
    });
    const b = await ensureArsenkinTask(clientTransport, store2, {
      toolName: "suggest",
      data: { q: "transport" },
      reportRunId: "run-transport",
    });
    assert.equal(b.state, "SUBMIT_UNKNOWN");
  });

  it("QUEUED task is never claimed by poll worker", async () => {
    const store = createMemoryProviderTaskStore();
    await store.upsertPending({
      reportRunId: "run-q",
      toolName: "suggest",
      requestJson: { q: "queued" },
    });
    const claimed = await store.claimDue("poller", new Date(), 10, 30_000);
    assert.equal(claimed.length, 0);
    const due = await runDueArsenkinPolls(mockClient({}), store, { workerId: "poller" });
    assert.equal(due.length, 0);
  });

  it("expired poll lease can be reclaimed by another worker", async () => {
    const store = createMemoryProviderTaskStore();
    const row = await store.upsertPending({
      reportRunId: "run-lease",
      toolName: "suggest",
      requestJson: { q: "lease" },
    });
    await store.updateState(row.id, {
      state: "RUNNING",
      externalTaskId: "ext-lease",
      nextPollAt: new Date(Date.now() - 1000),
      lockedBy: "w1",
      lockedAt: new Date(Date.now() - 60_000),
      leaseUntil: new Date(Date.now() - 1),
    });
    const claimed = await store.claimDue("w2", new Date(), 1, 30_000);
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0]!.lockedBy, "w2");
  });

  it("account slot frees after release and after lease expiry", async () => {
    const limiter = createMemoryArsenkinAccountLimiter({ maxConcurrent: 1, maxRpm: 10, leaseMs: 50 });
    const first = await limiter.acquire("a");
    assert.equal(limiter.activeCount(), 1);
    await first.release();
    assert.equal(limiter.activeCount(), 0);

    const second = await limiter.acquire("b");
    assert.equal(limiter.activeCount(), 1);
    limiter.expireAll();
    assert.equal(limiter.activeCount(), 0);
    const third = await limiter.acquire("c");
    assert.equal(limiter.activeCount(), 1);
    await third.release();
  });

  it("sliding RPM does not allow burst above maxRpm", async () => {
    const limiter = createMemoryArsenkinAccountLimiter({ maxConcurrent: 10, maxRpm: 3, leaseMs: 5_000 });
    const leases = [];
    for (let i = 0; i < 3; i += 1) {
      leases.push(await limiter.acquire(`u${i}`));
    }
    assert.equal(limiter.rpmCount(), 3);
    assert.equal(await limiter.tryAcquire("u3"), null);
    await leases[0]!.release();
    assert.equal(limiter.activeCount(), 2);
    assert.equal(limiter.rpmCount(), 3);
    assert.equal(await limiter.tryAcquire("u4"), null);
    for (const lease of leases.slice(1)) await lease.release();
  });

  it("same request different reportRunId => different ProviderTask", async () => {
    const store = createMemoryProviderTaskStore();
    const req = { q: "same" };
    const a = await store.upsertPending({ reportRunId: "run-A", toolName: "suggest", requestJson: req });
    const b = await store.upsertPending({ reportRunId: "run-B", toolName: "suggest", requestJson: req });
    assert.notEqual(a.id, b.id);
  });

  it("rerun same request same reportRunId reuses DONE with 0 /set", async () => {
    const store = createMemoryProviderTaskStore();
    let sets = 0;
    const client = mockClient({
      setTask: async () => {
        sets += 1;
        return { task_id: "ext-done", raw: { task_id: "ext-done" } };
      },
      getLimits: async () => ({ limitsLeft: sets === 0 ? 50 : 48, raw: {} }),
    });
    const input = { toolName: "suggest", data: { q: "idem" }, reportRunId: "run-idem" };
    const first = await ensureArsenkinTask(client, store, input);
    const polled = await pollArsenkinTask(client, store, first);
    assert.equal(polled.state, "DONE");
    assert.equal(polled.limitsSpent, 2);
    assert.equal(costStatusFromSpent(polled.limitsSpent), "KNOWN");
    sets = 0;
    const again = await ensureArsenkinTask(client, store, input);
    assert.equal(again.id, polled.id);
    assert.equal(again.state, "DONE");
    assert.equal(sets, 0);
  });

  it("limitsSpent null stays UNKNOWN", () => {
    assert.equal(computeLimitsSpent(10, null), null);
    assert.equal(computeLimitsSpent(null, 5), null);
    assert.equal(costStatusFromSpent(null), "UNKNOWN");
    assert.equal(computeLimitsSpent(10, 7), 3);
  });

  it("acceptance fails on incomplete task, missing geometry, missing PNG, foreign runId, null providerTaskId", () => {
    const dir = mkdtempSync(join(tmpdir(), "f36-accept-"));
    mkdirSync(join(dir, "pages-png"));
    writeFileSync(join(dir, "rendered-client.pdf"), "x");
    writeFileSync(join(dir, "rendered-client.pptx"), "x");
    // only 1 png
    writeFileSync(join(dir, "pages-png", "01.png"), "x");

    const baseSlides = Array.from({ length: 36 }, (_, i) => ({
      pageNumber: i + 1,
      title: i === 18 || i === 35 ? "slot" : `p${i + 1}`,
      narrative: i === 18 || i === 35 ? "content" : undefined,
    }));

    const r = inspectFirst36Acceptance({
      slideCount: 36,
      slides: baseSlides,
      runScopedMerge: { usedRunScoped: true, observationCount: 10 },
      arsenkinRequired: true,
      clientFinalize: true,
      expectedRunId: "run-new",
      clientContentSourceReportRunId: "run-old",
      arsenkinEnrich: { mode: "live", skipped: false },
      providerTasks: [{ reportRunId: "run-new", state: "RUNNING", id: "t1" }],
      observations: [{ auditRunId: "run-new", provider: "arsenkin", providerTaskId: null }],
      coverageSummary: {
        reportRunId: "run-new",
        rows: [
          {
            reportRunId: "run-new",
            tool: "check-top",
            engine: "GOOGLE",
            region: "RU",
            surface: "organic",
            status: "OK",
            providerTaskId: null,
          },
        ],
      },
      geometryReportPresent: false,
      paths: {
        pdf: join(dir, "rendered-client.pdf"),
        pptx: join(dir, "rendered-client.pptx"),
        pagesPngDir: join(dir, "pages-png"),
      },
    });
    assert.equal(r.passed, false);
    const codes = new Set(r.issues.map((i) => i.code));
    assert.ok(codes.has("arsenkin-task-incomplete"));
    assert.ok(codes.has("geometry-missing"));
    assert.ok(codes.has("png-count"));
    assert.ok(codes.has("foreign-client-content-run"));
    assert.ok(codes.has("observation-missing-provider-task") || codes.has("coverage-missing-provider-task"));
  });

  it("100% observation/coverage provenance is required in ARSENKIN_REQUIRED", () => {
    const r = inspectFirst36Acceptance({
      slideCount: 36,
      slides: Array.from({ length: 36 }, (_, i) => ({
        pageNumber: i + 1,
        title: i === 18 || i === 35 ? "slot" : `p${i + 1}`,
        narrative: i === 18 || i === 35 ? "content" : undefined,
      })),
      runScopedMerge: { usedRunScoped: true, observationCount: 2 },
      arsenkinRequired: true,
      arsenkinEnrich: { mode: "live", skipped: true, reason: "already_enriched organic=20" },
      providerTasks: [{ reportRunId: "run", state: "DONE", id: "t1" }],
      observations: [
        { auditRunId: "run", provider: "arsenkin", providerTaskId: "t1" },
        { auditRunId: "run", provider: "arsenkin", providerTaskId: null },
      ],
      provenanceSummary: { linkedObservations: 1, totalObservations: 2, linkedCoverage: 1, totalCoverage: 1 },
      coverageSummary: {
        reportRunId: "run",
        rows: [
          { tool: "check-top", engine: "GOOGLE", region: "RU", surface: "organic", status: "OK", providerTaskId: "t1" },
          { tool: "suggest", engine: "YANDEX", region: "RU", surface: "autocomplete", status: "OK", providerTaskId: "t1" },
          { tool: "suggest", engine: "GOOGLE", region: "RU", surface: "autocomplete", status: "NO_RESULTS", providerTaskId: "t1" },
          { tool: "suggest", engine: "GOOGLE", region: "UAE", surface: "autocomplete", status: "OK", providerTaskId: "t1" },
          { tool: "paa", engine: "GOOGLE", region: "RU", surface: "paa", status: "OK", providerTaskId: "t1" },
          { tool: "paa", engine: "GOOGLE", region: "UAE", surface: "paa", status: "OK", providerTaskId: "t1" },
        ],
      },
      expectedRunId: "run",
      geometryReport: { overlaps: [], overflow: [], blank: [] },
      geometryReportPresent: true,
      clientFinalize: false,
    });
    assert.equal(r.passed, false);
    assert.ok(r.issues.some((i) => /provenance|provider-task/i.test(i.code)));
  });

  it("HTTP /set timeout is uncertain (SUBMIT_UNKNOWN path); check may retry", async () => {
    let setCalls = 0;
    let checkCalls = 0;
    const hangUntilAbort = (init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (init?.signal?.aborted) onAbort();
        else init?.signal?.addEventListener("abort", onAbort, { once: true });
      });

    const client = new ArsenkinClient({
      token: "test",
      httpTimeoutMs: 30,
      maxRetries: 2,
      sleep: async () => undefined,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        setCalls += 1;
        return hangUntilAbort(init);
      }) as typeof fetch,
    });
    await assert.rejects(
      () => client.setTask({ tools_name: "suggest", data: { queries: ["x"] } }),
      (err: unknown) => {
        assert.ok(err instanceof ArsenkinRequestError);
        assert.equal(err.options.uncertain, true);
        assert.equal(err.options.code, "http_timeout");
        return true;
      }
    );
    assert.equal(setCalls, 1);

    const checkClient = new ArsenkinClient({
      token: "test",
      httpTimeoutMs: 20,
      maxRetries: 1,
      sleep: async () => undefined,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        checkCalls += 1;
        return hangUntilAbort(init);
      }) as typeof fetch,
    });
    await assert.rejects(() => checkClient.checkTask("tid"));
    assert.ok(checkCalls >= 2);
  });

  it("account lease TTL is strictly greater than HTTP timeout", () => {
    const cfg = arsenkinAccountLimiterConfig({
      ARSENKIN_HTTP_TIMEOUT_MS: "25000",
      ARSENKIN_ACCOUNT_LEASE_MS: "30000",
    });
    assert.ok(cfg.leaseMs > 25_000);
  });

  it("surface coverage concurrent upsert does not duplicate business key", async () => {
    const { prisma } = await import("../src/server/prisma/client");
    const { upsertSurfaceCollectionCoverage } = await import(
      "../src/modules/digital-profile/providers/arsenkin/surface-coverage"
    );
    const reportRunId = `cov-race-${Date.now()}`;
    // Ensure OrionReportRun exists for FK — skip if DB unavailable
    try {
      await prisma.orionReportRun.create({
        data: {
          id: reportRunId,
          caseId: "cmreamy2t0002o30f29urzcog",
          status: "RUNNING",
        },
      });
    } catch (err) {
      // case may be missing — skip race test offline
      console.log("skip coverage race: cannot create report run", String(err).slice(0, 120));
      await prisma.$disconnect().catch(() => undefined);
      return;
    }
    const payload = {
      reportRunId,
      provider: "arsenkin",
      tool: "suggest",
      queryId: "q1",
      queryText: "test",
      engine: "GOOGLE",
      region: "RU",
      language: "ru",
      device: "DESKTOP",
      surface: "autocomplete",
      resultCount: 0,
    };
    try {
      await Promise.all([
        upsertSurfaceCollectionCoverage(payload),
        upsertSurfaceCollectionCoverage({ ...payload, resultCount: 1 }),
        upsertSurfaceCollectionCoverage({ ...payload, resultCount: 2 }),
      ]);
      const rows = await prisma.surfaceCollectionCoverage.findMany({
        where: { reportRunId, tool: "suggest", queryId: "q1" },
      });
      assert.equal(rows.length, 1);
    } finally {
      await prisma.surfaceCollectionCoverage.deleteMany({ where: { reportRunId } }).catch(() => undefined);
      await prisma.orionReportRun.delete({ where: { id: reportRunId } }).catch(() => undefined);
      await prisma.$disconnect().catch(() => undefined);
    }
  });
});
