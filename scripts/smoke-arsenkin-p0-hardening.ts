/**
 * Focused offline smokes for Arsenkin P0 hardening (no live API).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ArsenkinClient, ArsenkinRequestError } from "../src/modules/digital-profile/providers/arsenkin/client";
import {
  createMemoryProviderTaskStore,
  hashProviderRequest,
} from "../src/modules/digital-profile/providers/arsenkin/provider-task-store";
import { ensureArsenkinTask, pollArsenkinTask, runDueArsenkinPolls } from "../src/modules/digital-profile/providers/arsenkin/poll-worker";
import { createMemoryArsenkinAccountLimiter, arsenkinAccountLimiterConfig } from "../src/modules/digital-profile/providers/arsenkin/account-rate-limit";
import { computeLimitsSpent, costStatusFromSpent } from "../src/modules/digital-profile/providers/arsenkin/cost";
// NOTE: legacy First36 acceptance-gate assertions were retired with the monolithic
// composer. Canonical acceptance (foreign/stale rejection + provider-task provenance)
// is covered by smoke:canonical-orchestration-e2e and smoke:canonical-report-prepare.
import { findSurfaceCoverageDuplicateGroups } from "../src/modules/digital-profile/providers/arsenkin/surface-coverage-duplicate-audit";

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
      skipLiveAuthorizationCheck: true,
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
      skipLiveAuthorizationCheck: true,
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

  it("coverage duplicate audit finds business-key groups (pure)", () => {
    const base = {
      reportRunId: "run",
      provider: "arsenkin",
      tool: "suggest",
      queryId: "q1",
      surface: "autocomplete",
      engine: "GOOGLE",
      region: "RU",
      language: "ru",
      device: "DESKTOP",
    };
    const audit = findSurfaceCoverageDuplicateGroups([
      { id: "a", ...base },
      { id: "b", ...base },
      { id: "c", ...base, queryId: "q2" },
    ]);
    assert.equal(audit.duplicateGroupCount, 1);
    assert.equal(audit.duplicateRowCount, 2);
    assert.deepEqual(audit.groups[0]!.ids, ["a", "b"]);
  });
});
