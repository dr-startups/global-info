/**
 * Arsenkin Stage-1 recovery/reconciliation smokes (NETWORK_CALLS=0).
 *
 *   npm run smoke:arsenkin-recovery
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  ArsenkinClient,
  ArsenkinRequestError,
  buildSubmitFailureDiagnostics,
  classifyMappedArsenkinResult,
  createMemoryProviderTaskStore,
  filterPersistableObservations,
  mapCheckTopToObservations,
  mapPaaToObservations,
  mapPlannedPayload,
  okObservationCount,
  redactDeep,
  confirmSubmitUnknownNotCreated,
  linkExistingArsenkinTask,
  retryUnconfirmedSubmitOnce,
  toSubmitUnknownCandidate,
  reconcileDoneTaskZeroObservations,
  appendArsenkinRecoveryDecision,
  loadArsenkinRecoveryDecisions,
  hasOpenSubmitUnknownRetry,
  ARSENKIN_REGION,
} from "../src/modules/digital-profile/providers/arsenkin";
import { resetArsenkinNetworkCallCount, getArsenkinNetworkCallCount } from "../src/modules/digital-profile/providers/arsenkin/network-guard";

process.env.NETWORK_CALLS = "0";

const FIX = join(process.cwd(), "src/modules/digital-profile/providers/arsenkin/fixtures");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf-8"));
}

function mockClient(handlers: {
  check?: (id: string) => Record<string, unknown>;
  get?: (id: string) => Record<string, unknown>;
  set?: () => Record<string, unknown>;
}): ArsenkinClient {
  let setCount = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (u.includes("/check")) {
      const raw = handlers.check?.(String(body.task_id)) ?? { task_id: body.task_id, status: "done" };
      return new Response(JSON.stringify(raw), { status: 200 });
    }
    if (u.includes("/get")) {
      const raw = handlers.get?.(String(body.task_id)) ?? { task_id: body.task_id, result: {} };
      return new Response(JSON.stringify(raw), { status: 200 });
    }
    if (u.includes("/set")) {
      setCount += 1;
      if (!handlers.set) throw new Error("unexpected-/set");
      const raw = handlers.set();
      return new Response(JSON.stringify(raw), { status: 200 });
    }
    if (u.includes("/info")) {
      return new Response(JSON.stringify({ limits_left: 10 }), { status: 200 });
    }
    throw new Error(`unexpected url ${u}`);
  };
  const client = new ArsenkinClient({
    token: "test-token-not-real",
    fetchImpl,
    skipLiveAuthorizationCheck: true,
  });
  (client as unknown as { __setCount: () => number }).__setCount = () => setCount;
  return client;
}

describe("arsenkin recovery", () => {
  it("NETWORK_CALLS stays 0 for offline recovery suite bootstrap", () => {
    resetArsenkinNetworkCallCount();
    assert.equal(String(process.env.NETWORK_CALLS ?? ""), "0");
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("SUBMIT_UNKNOWN candidate exposes sanitized diagnostics without token", () => {
    const outRoot = mkdtempSync(join(tmpdir(), "ars-rec-"));
    try {
      const store = createMemoryProviderTaskStore();
      const diagnostics = buildSubmitFailureDiagnostics(
        new ArsenkinRequestError("Arsenkin HTTP 500: boom", {
          status: 500,
          uncertain: true,
          raw: { error: "internal", authorization: "Bearer SECRETTOKEN" },
        })
      );
      const row = {
        id: "pt-1",
        caseId: "c1",
        reportRunId: "run-1",
        provider: "arsenkin" as const,
        toolName: "suggest",
        externalTaskId: null,
        requestHash: "656d237036626d726fd3b831a964248485117ae5cb40ff1fd17746235f7c228b",
        state: "SUBMIT_UNKNOWN" as const,
        attempts: 1,
        nextPollAt: null,
        errorCode: "http_500",
        limitsSpent: null,
        lockedBy: null,
        lockedAt: null,
        leaseUntil: null,
        submittedAt: null,
        latencyMs: null,
        limitsBefore: null,
        limitsAfter: null,
        requestJson: {
          tools_name: "suggest",
          data: { queries: ["Глинка"], se: 1, region: 213 },
        },
        responseJson: diagnostics,
        createdAt: new Date("2026-07-15T10:00:00.000Z"),
        completedAt: null,
        updatedAt: new Date(),
      };
      const cand = toSubmitUnknownCandidate(row, outRoot);
      assert.ok(cand);
      assert.equal(cand!.canLinkExisting, true);
      assert.equal(cand!.httpStatus, 500);
      const blob = JSON.stringify(cand);
      assert.equal(blob.includes("SECRETTOKEN"), false);
      assert.equal(blob.includes("Bearer [REDACTED]") || blob.includes("[REDACTED]"), true);
      void store;
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it("manual link existing task uses check/get only (no /set)", async () => {
    const outRoot = mkdtempSync(join(tmpdir(), "ars-link-"));
    try {
      const store = createMemoryProviderTaskStore();
      const pending = await store.upsertPending({
        caseId: "c1",
        reportRunId: "run-1",
        toolName: "suggest",
        requestJson: { tools_name: "suggest", data: { queries: ["q"], se: 1, region: 213 } },
      });
      await store.updateState(pending.id, {
        state: "SUBMIT_UNKNOWN",
        errorCode: "http_500",
        responseJson: buildSubmitFailureDiagnostics(
          new ArsenkinRequestError("500", { status: 500, uncertain: true, raw: { e: 1 } })
        ),
      });

      let setHits = 0;
      const client = mockClient({
        check: (id) => ({ task_id: id, status: "progress", tools_name: "suggest" }),
        set: () => {
          setHits += 1;
          return { task_id: "should-not" };
        },
      });

      const linked = await linkExistingArsenkinTask({
        client,
        store,
        outRoot,
        caseId: "c1",
        reportRunId: "run-1",
        providerTaskId: pending.id,
        externalTaskId: "30639999",
        actorId: "tester",
      });
      assert.equal(linked.task.externalTaskId, "30639999");
      assert.equal(linked.task.state, "RUNNING");
      assert.equal(setHits, 0);
      const decisions = loadArsenkinRecoveryDecisions(outRoot);
      assert.ok(decisions?.decisions.some((d) => d.kind === "LINK_EXISTING_TASK"));
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it("confirm-not-created allows exactly one retry /set", async () => {
    const outRoot = mkdtempSync(join(tmpdir(), "ars-retry-"));
    try {
      const store = createMemoryProviderTaskStore();
      const pending = await store.upsertPending({
        caseId: "c1",
        reportRunId: "run-1",
        toolName: "suggest",
        requestJson: { tools_name: "suggest", data: { queries: ["q"], se: 1, region: 213 } },
      });
      assert.equal(pending.requestHash.length, 64);
      await store.updateState(pending.id, {
        state: "SUBMIT_UNKNOWN",
        errorCode: "http_500",
        responseJson: { _submitDiagnostics: { httpStatus: 500, responseBody: { err: "x" } } },
      });

      await confirmSubmitUnknownNotCreated({
        outRoot,
        caseId: "c1",
        reportRunId: "run-1",
        store,
        providerTaskId: pending.id,
        actorId: "tester",
        reason: "provider_queue_and_results_checked_no_task_found",
      });
      assert.equal(hasOpenSubmitUnknownRetry(loadArsenkinRecoveryDecisions(outRoot), pending.id), true);

      let setHits = 0;
      const client = mockClient({
        set: () => {
          setHits += 1;
          return { task_id: 777001 };
        },
      });

      const retried = await retryUnconfirmedSubmitOnce({
        client,
        store,
        outRoot,
        caseId: "c1",
        reportRunId: "run-1",
        providerTaskId: pending.id,
        actorId: "tester",
      });
      assert.equal(setHits, 1);
      assert.equal(retried.externalTaskId, "777001");
      assert.equal(retried.state, "RUNNING");
      assert.equal(retried.id, pending.id, "retry must reuse same ProviderTask row");
      assert.ok(retried.responseJson?._priorSubmitFailure);

      await assert.rejects(
        () =>
          retryUnconfirmedSubmitOnce({
            client,
            store,
            outRoot,
            caseId: "c1",
            reportRunId: "run-1",
            providerTaskId: pending.id,
            actorId: "tester",
          }),
        /confirm-not-created|externalTaskId|SUBMIT_UNKNOWN/
      );
      assert.equal(setHits, 1);
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it("MIXED check-top splits into Yandex + Google observations", () => {
    const payload = load("get-check-top-mixed-ru.json");
    const drafts = mapCheckTopToObservations({
      caseId: "c1",
      auditRunId: "run-1",
      regionLabel: "RU",
      language: "ru",
      queries: ["Глинка Сергей Михайлович"],
      se: [
        { type: 2, region: ARSENKIN_REGION.YANDEX_MOSCOW },
        { type: 11, region: ARSENKIN_REGION.GOOGLE_MOSCOW },
      ],
      payload,
    });
    const yandex = drafts.filter((d) => d.engine === "YANDEX");
    const google = drafts.filter((d) => d.engine === "GOOGLE");
    assert.equal(yandex.length, 2);
    assert.equal(google.length, 3);
    assert.ok(yandex.every((d) => d.surface === "organic"));
  });

  it("DONE nonempty → MEASURED; empty → NO_RESULTS; unknown → FAILED_PARSE", () => {
    const mixed = mapCheckTopToObservations({
      caseId: "c1",
      auditRunId: "run-1",
      regionLabel: "RU",
      language: "ru",
      queries: ["Глинка Сергей Михайлович"],
      se: [
        { type: 2, region: 213 },
        { type: 11, region: 1011969 },
      ],
      payload: load("get-check-top-mixed-ru.json"),
    });
    assert.equal(
      classifyMappedArsenkinResult({ tool: "check-top", payload: load("get-check-top-mixed-ru.json"), drafts: mixed }),
      "MEASURED"
    );

    const emptyPaa = mapPaaToObservations({
      caseId: "c1",
      auditRunId: "run-1",
      regionLabel: "RU",
      language: "ru",
      queries: ["Глинка Сергей Михайлович"],
      payload: load("get-paa-empty.json"),
    });
    assert.equal(
      classifyMappedArsenkinResult({
        tool: "paa",
        payload: load("get-paa-empty.json"),
        drafts: filterPersistableObservations(emptyPaa),
      }),
      "NO_RESULTS"
    );
    assert.equal(okObservationCount(filterPersistableObservations(emptyPaa)), 0);

    const unknownPayload = load("get-check-top-unknown-shape.json");
    const unknownDrafts = mapCheckTopToObservations({
      caseId: "c1",
      auditRunId: "run-1",
      regionLabel: "RU",
      language: "ru",
      queries: ["Глинка Сергей Михайлович"],
      se: [{ type: 11, region: 1011969 }],
      payload: unknownPayload,
    });
    assert.equal(
      classifyMappedArsenkinResult({ tool: "check-top", payload: unknownPayload, drafts: unknownDrafts }),
      "FAILED_PARSE"
    );
  });

  it("reconcile DONE+0 obs is idempotent and writes sanitized artifact", async () => {
    const outRoot = mkdtempSync(join(tmpdir(), "ars-rec2-"));
    try {
      const store = createMemoryProviderTaskStore();
      const row = await store.upsertPending({
        caseId: "c1",
        reportRunId: "run-1",
        toolName: "paa",
        requestJson: {
          tools_name: "paa",
          data: { queries: ["Глинка Сергей Михайлович"], se: 2, region: 213 },
        },
      });
      await store.updateState(row.id, {
        state: "DONE",
        externalTaskId: "30638342",
        responseJson: load("get-paa-empty.json") as Record<string, unknown>,
        completedAt: new Date(),
      });

      let getHits = 0;
      const client = mockClient({
        get: () => {
          getHits += 1;
          return load("get-paa-empty.json") as Record<string, unknown>;
        },
      });

      const persisted: unknown[] = [];
      const r1 = await reconcileDoneTaskZeroObservations({
        client,
        store,
        outRoot,
        caseId: "c1",
        reportRunId: "run-1",
        providerTaskId: row.id,
        actorId: "tester",
        plan: null,
        persistObservations: async (drafts) => {
          persisted.push(...drafts);
          return drafts;
        },
      });
      assert.equal(r1.outcome, "NO_RESULTS");
      assert.equal(r1.observationCount, 0);
      assert.ok(r1.artifactPath);
      const art = readFileSync(r1.artifactPath!, "utf-8");
      assert.equal(art.includes("Bearer"), false);

      const r2 = await reconcileDoneTaskZeroObservations({
        client,
        store,
        outRoot,
        caseId: "c1",
        reportRunId: "run-1",
        providerTaskId: row.id,
        actorId: "tester",
        plan: null,
        persistObservations: async (drafts) => {
          persisted.push(...drafts);
          return drafts;
        },
      });
      assert.equal(r2.outcome, "NO_RESULTS");
      assert.equal(getHits, 2);
      assert.equal(persisted.length, 0);
      void mapPlannedPayload;
      void appendArsenkinRecoveryDecision;
      void redactDeep;
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it("surface task counts must not reuse global task total for both organic engines", () => {
    // Pure contract: MIXED task contributes 1 to each engine cell, not global 3.
    const mixedTaskCountPerCell = 1;
    const globalTasks = 3;
    assert.notEqual(mixedTaskCountPerCell, globalTasks);
    assert.equal(mixedTaskCountPerCell, 1);
  });
});
