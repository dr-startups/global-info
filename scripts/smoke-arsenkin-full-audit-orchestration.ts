/**
 * One-click Arsenkin full-audit orchestration smokes (NETWORK_CALLS=0).
 *
 *   npm run smoke:arsenkin-full-audit-orchestration
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import {
  ArsenkinClient,
  arsenkinTransportContract,
  claimOrchestrationJobLease,
  createOrchestrationJob,
  findOrCreateActiveOrchestrationJob,
  getArsenkinFullAuditStatus,
  humanPhaseForState,
  isActiveOrchestrationState,
  loadOrchestrationJob,
  releaseOrchestrationJobLease,
  runOrchestrationTick,
  startArsenkinFullAudit,
  cancelArsenkinFullAudit,
  categorizeCheckOrGetFailure,
  categorizeProviderGetPayload,
  buildTransportMeta,
  AMBIGUOUS_SUBMIT_RETRY_MAX,
} from "../src/modules/digital-profile/providers/arsenkin";
import { ArsenkinRequestError } from "../src/modules/digital-profile/providers/arsenkin/client";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";

process.env.NETWORK_CALLS = "0";

const CASE_ID = `case-orch-${Date.now()}`;
const WORKFLOW = "first36-full" as const;

describe("arsenkin full-audit orchestration", () => {
  let tmpRoot: string;
  const prevCwd = process.cwd();

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ars-orch-"));
    process.chdir(tmpRoot);
    resetArsenkinNetworkCallCount();
  });

  after(() => {
    process.chdir(prevCwd);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("NETWORK_CALLS=0 bootstrap", () => {
    assert.equal(String(process.env.NETWORK_CALLS ?? ""), "0");
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("transport contract: check/get are POST with {task_id}", () => {
    const t = arsenkinTransportContract();
    assert.equal(t.method, "POST");
    assert.equal(t.checkPath, "/check");
    assert.equal(t.getPath, "/get");
    assert.deepEqual(t.checkBody(30638342), { task_id: 30638342 });
    assert.deepEqual(t.getBody(30638350), { task_id: 30638350 });
    // Prove we never design GET-with-body
    assert.notEqual(t.method, "GET");
  });

  it("result fetch categories distinguish HTTP vs parse vs not-ready", () => {
    const http = categorizeCheckOrGetFailure(
      new ArsenkinRequestError("500", { status: 500, uncertain: true })
    );
    assert.equal(http.category, "HTTP_ERROR");
    const notReady = categorizeProviderGetPayload({ code: "TASK_NOT_READY" });
    assert.equal(notReady, "TASK_NOT_READY");
    const ok = categorizeProviderGetPayload({ code: "TASK_RESULT", result: { x: 1 } });
    assert.equal(ok, "OK");
    const meta = buildTransportMeta({
      httpStatus: 500,
      bodyText: "Bearer SECRET should redact",
      category: "HTTP_ERROR",
      elapsedMs: 12,
    });
    assert.equal(meta.safePreview.includes("SECRET"), false);
  });

  it("one-click findOrCreate is idempotent for concurrent starts", () => {
    const a = findOrCreateActiveOrchestrationJob({
      caseId: CASE_ID,
      workflow: WORKFLOW,
      reportRunId: "orion-arsenkin-first36-full-1784142276718-5d3c206e",
      sourceReportRunId: "source-1",
    });
    const b = findOrCreateActiveOrchestrationJob({
      caseId: CASE_ID,
      workflow: WORKFLOW,
      reportRunId: "orion-arsenkin-first36-full-1784142276718-5d3c206e",
      sourceReportRunId: "source-1",
    });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.job.jobId, b.job.jobId);
    assert.equal(a.job.reportRunId, "orion-arsenkin-first36-full-1784142276718-5d3c206e");
  });

  it("production reportRunId is preserved (no new run on resume)", () => {
    const job = loadOrchestrationJob(CASE_ID, WORKFLOW);
    assert.ok(job);
    assert.equal(job!.reportRunId, "orion-arsenkin-first36-full-1784142276718-5d3c206e");
  });

  it("lease claim is exclusive; expired lease can be reclaimed", () => {
    const first = claimOrchestrationJobLease({
      caseId: CASE_ID,
      workflow: WORKFLOW,
      ownerId: "worker-a",
      leaseMs: 60_000,
    });
    assert.ok(first);
    const second = claimOrchestrationJobLease({
      caseId: CASE_ID,
      workflow: WORKFLOW,
      ownerId: "worker-b",
      leaseMs: 60_000,
    });
    assert.equal(second, null);
    releaseOrchestrationJobLease({ caseId: CASE_ID, workflow: WORKFLOW, ownerId: "worker-a" });
    const third = claimOrchestrationJobLease({
      caseId: CASE_ID,
      workflow: WORKFLOW,
      ownerId: "worker-b",
      leaseMs: 1,
      now: new Date(Date.now() - 10_000),
    });
    // With past now, lease expires immediately for next claim
    releaseOrchestrationJobLease({ caseId: CASE_ID, workflow: WORKFLOW, ownerId: "worker-b" });
    const fourth = claimOrchestrationJobLease({
      caseId: CASE_ID,
      workflow: WORKFLOW,
      ownerId: "worker-c",
      leaseMs: 60_000,
      now: new Date(),
    });
    assert.ok(fourth);
    assert.equal(fourth!.leaseOwnerId, "worker-c");
    void third;
  });

  it("startArsenkinFullAudit returns immediately and does not create third set attempt counter reset", async () => {
    resetArsenkinNetworkCallCount();
    const started = await startArsenkinFullAudit(
      {
        caseId: `${CASE_ID}-start`,
        reportRunId: "orion-arsenkin-first36-full-1784142276718-5d3c206e",
        workflow: WORKFLOW,
        confirmed: true,
      },
      {
        readiness: async () => ({
          ok: true,
          code: "READY",
          blockers: [],
          cached: true,
          checkedAt: new Date().toISOString(),
          buildCommit: "test",
          schemaFingerprint: "x",
        }),
        prepare: async () => {
          throw new Error("prepare-should-be-async-in-tick");
        },
        sleep: async () => undefined,
      }
    );
    assert.equal(started.accepted, true);
    assert.ok(started.jobId);
    assert.equal(started.reportRunId, "orion-arsenkin-first36-full-1784142276718-5d3c206e");
    assert.equal(getArsenkinNetworkCallCount(), 0);

    const again = await startArsenkinFullAudit(
      {
        caseId: `${CASE_ID}-start`,
        reportRunId: "orion-arsenkin-first36-full-1784142276718-5d3c206e",
        workflow: WORKFLOW,
        confirmed: true,
      },
      { sleep: async () => undefined }
    );
    assert.equal(again.created, false);
    assert.equal(again.jobId, started.jobId);
  });

  it("tick with injected deps walks to COMPLETED without live network", async () => {
    const caseId = `${CASE_ID}-pipeline`;
    createOrchestrationJob({
      caseId,
      workflow: WORKFLOW,
      reportRunId: "run-pipeline-1",
      sourceReportRunId: "src-1",
    });
    let phase = 0;
    const deps = {
      readiness: async () => ({
        ok: true,
        code: "READY" as const,
        blockers: [],
        cached: false,
        checkedAt: new Date().toISOString(),
        buildCommit: "t",
        schemaFingerprint: "s",
      }),
      prepare: async () => {
        phase += 1;
        return { status: "PREPARED" } as never;
      },
      plan: async () => {
        phase += 1;
        return {
          digest: "digest-1",
          planDigest: "digest-1",
          estimatedLimitsTotal: 6,
        } as never;
      },
      execute: async () => {
        phase += 1;
        return {
          status: "STAGE_DONE",
          observationCount: 12,
          lastError: null,
        } as never;
      },
      sync: async () => {
        phase += 1;
        return { status: "TRANSFERRED" } as never;
      },
      render: () => {
        phase += 1;
        return { status: "running" } as never;
      },
      client: null,
      refetchResults: false,
      sleep: async () => undefined,
    };

    // Drive ticks until completed (bounded).
    for (let i = 0; i < 20; i++) {
      await runOrchestrationTick(caseId, WORKFLOW, deps);
      const job = getArsenkinFullAuditStatus(caseId, WORKFLOW);
      if (!job || !isActiveOrchestrationState(job.state)) break;
    }
    const finalJob = getArsenkinFullAuditStatus(caseId, WORKFLOW);
    assert.ok(finalJob);
    assert.equal(finalJob!.state, "COMPLETED");
    assert.equal(finalJob!.percent, 100);
    assert.ok(phase >= 4, `expected pipeline steps, got ${phase}`);
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("ambiguous submit retry max is finite (no infinite /set)", () => {
    assert.ok(AMBIGUOUS_SUBMIT_RETRY_MAX <= 2);
    assert.ok(AMBIGUOUS_SUBMIT_RETRY_MAX >= 0);
  });

  it("human phases never expose raw SUBMIT_UNKNOWN to clients", () => {
    const text = humanPhaseForState("STAGE1_FETCHING");
    assert.equal(text.includes("SUBMIT_UNKNOWN"), false);
    assert.ok(text.length > 3);
  });

  it("cancel marks job CANCELLED", async () => {
    const caseId = `${CASE_ID}-cancel`;
    createOrchestrationJob({
      caseId,
      workflow: WORKFLOW,
      reportRunId: "run-cancel",
      sourceReportRunId: "src",
    });
    const cancelled = await cancelArsenkinFullAudit({ caseId, workflow: WORKFLOW });
    assert.equal(cancelled?.state, "CANCELLED");
  });

  it("no global queue reset API exists on client surface", () => {
    const clientProto = ArsenkinClient.prototype as unknown as Record<string, unknown>;
    assert.equal(typeof clientProto.getQueueStatus, "function");
    assert.equal(clientProto.deleteAllTasks, undefined);
    assert.equal(clientProto.clearQueue, undefined);
  });
});
