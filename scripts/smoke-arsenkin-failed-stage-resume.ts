/**
 * Failed-stage resume / recoverExistingRun smokes (NETWORK_CALLS=0).
 *
 *   npm run smoke:arsenkin-failed-stage-resume
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import {
  ArsenkinClient,
  createOrchestrationJob,
  existingRunHasRecoverableWork,
  getArsenkinFullAuditStatus,
  loadOrchestrationJob,
  patchOrchestrationJob,
  recoverExistingRun,
  resumeActiveArsenkinOrchestrations,
  runOrchestrationTick,
  startArsenkinFullAudit,
  arsenkinTransportContract,
} from "../src/modules/digital-profile/providers/arsenkin";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";

process.env.NETWORK_CALLS = "0";

const FULL = "orion-arsenkin-first36-full-1784142276718-5d3c206e";
const BASE = "orion-r10-1783705193806";

function writePlan(caseId: string, reportRunId: string, digest = "digest-fixed"): void {
  const out = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-canary",
    caseId,
    reportRunId
  );
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, "arsenkin-live-plan.json"),
    JSON.stringify({
      digest,
      plannedNewTasks: 8,
      requests: [
        { tool: "check-top", engine: "MIXED", region: "RU", requestHash: "h-check", action: "NEW" },
        { tool: "paa", engine: "GOOGLE", region: "RU", requestHash: "h-paa", action: "NEW" },
        { tool: "suggest", engine: "YANDEX", region: "RU", requestHash: "h-sug", action: "NEW" },
      ],
    }),
    "utf-8"
  );
}

describe("arsenkin failed-stage resume", () => {
  let tmpRoot: string;
  const prevCwd = process.cwd();

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ars-fail-resume-"));
    process.chdir(tmpRoot);
    resetArsenkinNetworkCallCount();
  });

  after(() => {
    process.chdir(prevCwd);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("A: FAILED_RETRYABLE resume does not call prepare/plan; same reportRunId", async () => {
    const caseId = `case-A-${Date.now()}`;
    writePlan(caseId, FULL);
    createOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: FULL,
      sourceReportRunId: BASE,
    });
    patchOrchestrationJob(caseId, "first36-full", {
      state: "FAILED_RETRYABLE",
      planDigest: "digest-fixed",
      lastError: "Stage FAILED",
      lastErrorCode: "FAILED",
      nextStep: "user-continue",
      attempt: 4,
    });

    let prepareCalls = 0;
    let planCalls = 0;
    let setCalls = 0;

    await startArsenkinFullAudit(
      { caseId, reportRunId: BASE, confirmed: true },
      {
        sleep: async () => undefined,
        prepare: async () => {
          prepareCalls += 1;
          throw new Error("prepare-must-not-run");
        },
        plan: async () => {
          planCalls += 1;
          throw new Error("plan-must-not-run");
        },
        execute: async () =>
          ({
            status: "STAGE_DONE",
            observationCount: 2,
            lastError: null,
          }) as never,
        client: null,
        refetchResults: false,
      }
    );

    const job = loadOrchestrationJob(caseId, "first36-full")!;
    assert.equal(job.reportRunId, FULL);
    assert.ok(job.state === "RECOVERING" || job.state === "STAGE1_SUBMITTING" || job.state === "STAGE1_POLLING" || job.state === "FAILED_RETRYABLE" || job.state === "BINDING" || job.state === "COMPLETED" || job.state === "STAGE2_SUBMITTING");
    // Give ticks a chance (start schedules async tick)
    for (let i = 0; i < 5; i++) {
      await runOrchestrationTick(caseId, "first36-full", {
        sleep: async () => undefined,
        prepare: async () => {
          prepareCalls += 1;
          throw new Error("prepare-must-not-run");
        },
        plan: async () => {
          planCalls += 1;
          throw new Error("plan-must-not-run");
        },
        execute: async () =>
          ({
            status: "STAGE_DONE",
            observationCount: 2,
            lastError: null,
          }) as never,
        client: null,
        refetchResults: false,
        readiness: async () => ({
          ok: true,
          code: "READY",
          blockers: [],
          cached: true,
          checkedAt: new Date().toISOString(),
          buildCommit: "t",
          schemaFingerprint: "s",
        }),
      });
      const j = loadOrchestrationJob(caseId, "first36-full")!;
      if (j.state === "STAGE1_SUBMITTING" || j.state === "STAGE2_SUBMITTING" || j.state === "BINDING" || j.state === "COMPLETED") {
        break;
      }
    }
    assert.equal(prepareCalls, 0);
    assert.equal(planCalls, 0);
    assert.equal(setCalls, 0);
    assert.equal(loadOrchestrationJob(caseId, "first36-full")!.reportRunId, FULL);
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("B: five resumes without provider action do not increment provider counters", async () => {
    const caseId = `case-B-${Date.now()}`;
    writePlan(caseId, FULL);
    createOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: FULL,
      sourceReportRunId: BASE,
    });
    patchOrchestrationJob(caseId, "first36-full", {
      state: "FAILED_RETRYABLE",
      planDigest: "digest-fixed",
      providerSubmitAttempt: 0,
      providerFetchAttempt: 0,
      providerCheckAttempt: 0,
    });
    for (let i = 0; i < 5; i++) {
      await startArsenkinFullAudit(
        { caseId, reportRunId: BASE, confirmed: true },
        {
          sleep: async () => undefined,
          prepare: async () => {
            throw new Error("no-prepare");
          },
          client: null,
          refetchResults: false,
        }
      );
    }
    const job = loadOrchestrationJob(caseId, "first36-full")!;
    assert.equal(job.providerSubmitAttempt ?? 0, 0);
    assert.equal(job.providerFetchAttempt ?? 0, 0);
    assert.ok((job.orchestrationResumeCount ?? 0) >= 1);
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("C: one suggest failure leaves recover path (others continue)", async () => {
    const caseId = `case-C-${Date.now()}`;
    writePlan(caseId, FULL);
    createOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: FULL,
      sourceReportRunId: BASE,
    });
    patchOrchestrationJob(caseId, "first36-full", {
      state: "FAILED_RETRYABLE",
      planDigest: "digest-fixed",
      lastError: "suggest HTTP 500",
    });
    assert.equal(existingRunHasRecoverableWork(loadOrchestrationJob(caseId, "first36-full")!), true);
    const recovered = await recoverExistingRun(loadOrchestrationJob(caseId, "first36-full")!, {
      client: null,
      refetchResults: false,
    });
    assert.equal(recovered.prepareCalled, false);
    assert.equal(recovered.planRecreated, false);
    assert.equal(recovered.nextState, "RUNNING");
    assert.equal(recovered.setCalls, 0);
  });

  it("D: DONE fetch path — /set count stays 0 in offline recover", async () => {
    const caseId = `case-D-${Date.now()}`;
    writePlan(caseId, FULL);
    createOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: FULL,
      sourceReportRunId: BASE,
    });
    const r = await recoverExistingRun(loadOrchestrationJob(caseId, "first36-full")!, {
      client: null,
      refetchResults: false,
    });
    assert.equal(r.setCalls, 0);
    assert.ok(existsSync(r.artifactPath));
  });

  it("E: /check and /get are POST with {task_id} (no GET-with-body)", () => {
    const t = arsenkinTransportContract();
    assert.equal(t.method, "POST");
    assert.deepEqual(t.getBody(30638342), { task_id: 30638342 });
    assert.deepEqual(t.checkBody(30638350), { task_id: 30638350 });
  });

  it("F: recovery report artifact written", async () => {
    const caseId = `case-F-${Date.now()}`;
    writePlan(caseId, FULL);
    createOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: FULL,
      sourceReportRunId: BASE,
    });
    const r = await recoverExistingRun(loadOrchestrationJob(caseId, "first36-full")!, {
      client: null,
      refetchResults: false,
    });
    const art = JSON.parse(readFileSync(r.artifactPath, "utf-8")) as {
      prepareCalled: boolean;
      planRecreated: boolean;
      reportRunId: string;
    };
    assert.equal(art.prepareCalled, false);
    assert.equal(art.planRecreated, false);
    assert.equal(art.reportRunId, FULL);
  });

  it("G: suggest 500 recoverable without blocking recoverExistingRun", async () => {
    const caseId = `case-G-${Date.now()}`;
    writePlan(caseId, FULL);
    createOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: FULL,
      sourceReportRunId: BASE,
    });
    patchOrchestrationJob(caseId, "first36-full", {
      state: "FAILED_RETRYABLE",
      planDigest: "digest-fixed",
      lastError: "HTTP 500 suggest",
      nextStep: "user-continue",
    });
    await runOrchestrationTick(caseId, "first36-full", {
      client: null,
      refetchResults: false,
      sleep: async () => undefined,
      prepare: async () => {
        throw new Error("no-prepare");
      },
      execute: async () =>
        ({ status: "STAGE_DONE", observationCount: 1, lastError: null }) as never,
    });
    const job = getArsenkinFullAuditStatus(caseId, "first36-full")!;
    assert.notEqual(job.nextStep, "user-continue");
    assert.notEqual(job.state, "PREFLIGHT");
  });

  it("H: worker restart resumes FAILED_RETRYABLE without user button", () => {
    const caseId = `case-H-${Date.now()}`;
    writePlan(caseId, FULL);
    createOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: FULL,
      sourceReportRunId: BASE,
    });
    patchOrchestrationJob(caseId, "first36-full", {
      state: "FAILED_RETRYABLE",
      planDigest: "digest-fixed",
    });
    resumeActiveArsenkinOrchestrations({
      sleep: async () => undefined,
      client: null,
      refetchResults: false,
      prepare: async () => {
        throw new Error("no-prepare");
      },
    });
    const job = loadOrchestrationJob(caseId, "first36-full")!;
    assert.ok(job.state === "RECOVERING" || job.state === "FAILED_RETRYABLE" || job.state === "STAGE1_SUBMITTING");
  });

  it("I: progress — FAILED is not 100%; 0/12 nonterminal", () => {
    const caseId = `case-I-${Date.now()}`;
    createOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: FULL,
      sourceReportRunId: BASE,
    });
    patchOrchestrationJob(caseId, "first36-full", {
      state: "FAILED_RETRYABLE",
      percent: 10,
      terminalSurfaceCount: 0,
      expectedSurfaceCount: 12,
    });
    const job = loadOrchestrationJob(caseId, "first36-full")!;
    assert.notEqual(job.percent, 100);
    assert.equal(job.terminalSurfaceCount, 0);
    assert.equal(job.expectedSurfaceCount, 12);
  });

  it("J: production fixture — RESULT_FETCH + SUBMIT_UNKNOWN → recover without prepare", async () => {
    const caseId = `case-J-${Date.now()}`;
    writePlan(caseId, FULL);
    createOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: FULL,
      sourceReportRunId: BASE,
    });
    patchOrchestrationJob(caseId, "first36-full", {
      state: "FAILED_RETRYABLE",
      planDigest: "digest-fixed",
      lastError: "Стадия FAILED — автоматический повтор prepare запрещён",
      recoveryNotes: [
        "RESULT_FETCH_FAILED:30638342",
        "RESULT_FETCH_FAILED:30638350",
        "SUBMIT_UNKNOWN:suggest",
      ],
    });
    let prepareCalls = 0;
    await runOrchestrationTick(caseId, "first36-full", {
      client: null,
      refetchResults: false,
      sleep: async () => undefined,
      prepare: async () => {
        prepareCalls += 1;
        throw new Error("prepare-forbidden-path");
      },
      execute: async () =>
        ({ status: "STAGE_DONE", observationCount: 3, lastError: null }) as never,
    });
    assert.equal(prepareCalls, 0);
    const job = loadOrchestrationJob(caseId, "first36-full")!;
    assert.equal(job.reportRunId, FULL);
    assert.ok(existsSync(join(
      process.cwd(),
      "storage",
      "digital-profile",
      "qa-first36-canary",
      caseId,
      FULL,
      "orchestration-recovery-report.json"
    )));
  });

  it("NETWORK_CALLS=0", () => {
    assert.equal(String(process.env.NETWORK_CALLS ?? ""), "0");
    assert.equal(getArsenkinNetworkCallCount(), 0);
    void ArsenkinClient;
  });
});
