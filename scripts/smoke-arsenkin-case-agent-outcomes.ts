/**
 * Arsenkin CaseAgent durable outcomes — NETWORK_CALLS=0.
 * Enqueue-only must never be SUCCESS.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import {
  computeArsenkinCaseAgentOutcome,
  plannedSurfacesForTools,
  startArsenkinCaseAgentDurable,
  loadArsenkinCaseAgentExecution,
  type FinalizeEvidence,
} from "../src/modules/digital-profile/services/arsenkin-case-agent-execution";
import { getAgent } from "../src/modules/digital-profile/agents/registry";
import { ARSENKIN_REAL_AGENT_NAMES } from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";

process.env.NETWORK_CALLS = "0";

describe("arsenkin case-agent durable outcomes", () => {
  before(() => {
    process.env.NETWORK_CALLS = "0";
  });

  it("NETWORK_CALLS=0", () => {
    assert.equal(process.env.NETWORK_CALLS, "0");
  });

  it("all five agents are DURABLE_ASYNC", () => {
    for (const name of ARSENKIN_REAL_AGENT_NAMES) {
      const a = getAgent(name);
      assert.ok(a);
      assert.equal(a!.executionMode, "DURABLE_ASYNC");
    }
  });

  it("1: enqueue-only / empty evidence is FAILED not SUCCESS", () => {
    const r = computeArsenkinCaseAgentOutcome({
      plannedSurfaceCount: 3,
      evidence: { providerTasks: [], observationCount: 0, coverageRows: [] },
    });
    assert.equal(r.outcome, "FAILED");
    assert.equal(r.errorCode, "ARSENKIN_NO_EXECUTION_EVIDENCE");
    assert.equal(r.agentDbStatus, "FAILED");
    assert.notEqual(r.outcome, "SUCCESS");
  });

  it("2: non-terminal SUBMIT_UNKNOWN stays RUNNING", () => {
    const r = computeArsenkinCaseAgentOutcome({
      plannedSurfaceCount: 2,
      evidence: {
        providerTasks: [
          { id: "t1", state: "SUBMIT_UNKNOWN", toolName: "paa", externalTaskId: null },
        ],
        observationCount: 0,
        coverageRows: [],
      },
    });
    assert.equal(r.outcome, "RUNNING");
    assert.equal(r.agentDbStatus, "RUNNING");
  });

  it("3: DONE + observations + MEASURED → SUCCESS", () => {
    const r = computeArsenkinCaseAgentOutcome({
      plannedSurfaceCount: 2,
      evidence: {
        providerTasks: [
          { id: "t1", state: "DONE", toolName: "check-top", externalTaskId: "1" },
          { id: "t2", state: "DONE", toolName: "check-top", externalTaskId: "2" },
        ],
        observationCount: 18,
        coverageRows: [
          { status: "MEASURED", surface: "organic", tool: "check-top", resultCount: 10 },
          { status: "MEASURED", surface: "organic", tool: "check-top", resultCount: 8 },
        ],
      },
    });
    assert.equal(r.outcome, "SUCCESS");
    assert.equal(r.agentDbStatus, "SUCCEEDED");
    assert.match(r.summary, /Успешно/);
  });

  it("4: DONE + 0 obs + NO_RESULTS → outcome NO_RESULTS not No new records", () => {
    const r = computeArsenkinCaseAgentOutcome({
      plannedSurfaceCount: 2,
      evidence: {
        providerTasks: [
          { id: "t1", state: "DONE", toolName: "suggest", externalTaskId: "9" },
          { id: "t2", state: "DONE", toolName: "suggest", externalTaskId: "10" },
        ],
        observationCount: 0,
        coverageRows: [
          { status: "NO_RESULTS", surface: "autocomplete", tool: "suggest", resultCount: 0 },
          { status: "NO_RESULTS", surface: "autocomplete", tool: "suggest", resultCount: 0 },
        ],
      },
    });
    assert.equal(r.outcome, "NO_RESULTS");
    assert.equal(r.agentDbStatus, "SUCCEEDED");
    assert.match(r.summary, /результатов нет/i);
    assert.doesNotMatch(r.summary, /No new records/i);
  });

  it("5: reused terminal artifacts → REUSED", () => {
    const r = computeArsenkinCaseAgentOutcome({
      plannedSurfaceCount: 2,
      reused: true,
      evidence: {
        providerTasks: [
          { id: "t1", state: "DONE", toolName: "paa", externalTaskId: "1" },
          { id: "t2", state: "DONE", toolName: "paa", externalTaskId: "2" },
        ],
        observationCount: 18,
        coverageRows: [
          { status: "MEASURED", surface: "paa", tool: "paa", resultCount: 9 },
          { status: "MEASURED", surface: "paa", tool: "paa", resultCount: 9 },
        ],
      },
    });
    assert.equal(r.outcome, "REUSED");
    assert.match(r.summary, /Переиспользованы результаты/);
    assert.match(r.summary, /tasks=2/);
    assert.match(r.summary, /observations=18/);
  });

  it("6: mixed measured + failed → PARTIAL_SUCCESS", () => {
    const r = computeArsenkinCaseAgentOutcome({
      plannedSurfaceCount: 2,
      evidence: {
        providerTasks: [
          { id: "t1", state: "DONE", toolName: "paa", externalTaskId: "1" },
          { id: "t2", state: "FAILED", toolName: "paa", externalTaskId: "2" },
        ],
        observationCount: 3,
        coverageRows: [
          { status: "MEASURED", surface: "paa", tool: "paa", resultCount: 3 },
          { status: "FAILED_FINAL", surface: "paa", tool: "paa", resultCount: 0 },
        ],
      },
    });
    assert.equal(r.outcome, "PARTIAL_SUCCESS");
  });

  it("7: durable start leaves execution RUNNING on disk (no SUCCESS)", async () => {
    const started = await startArsenkinCaseAgentDurable({
      caseId: "ace-smoke-case",
      agentRunId: "agent-run-smoke-1",
      agentId: "ARSENKIN_PAA_REAL",
      tools: ["paa"],
      resolveBaseReportRunId: async () => "orion-r10-base-smoke",
    });
    assert.equal(started.status, "RUNNING");
    assert.ok(started.plannedSurfaces.length >= 1);
    const job = loadArsenkinCaseAgentExecution("ace-smoke-case", started.executionId);
    assert.ok(job);
    assert.equal(job!.status, "RUNNING");
    assert.equal(job!.agentId, "ARSENKIN_PAA_REAL");
  });

  it("8: planned surfaces are tool-scoped and independent", () => {
    const paa = plannedSurfacesForTools(["paa"]);
    const suggest = plannedSurfacesForTools(["suggest"]);
    assert.ok(paa.every((s) => s.tool === "paa"));
    assert.ok(suggest.every((s) => s.tool === "suggest"));
    assert.ok(paa.every((s) => !suggest.some((x) => x.id === s.id)));
  });

  it("9: agent.run returns RUNNING never SUCCEEDED for Arsenkin", async () => {
    process.env.ARSENKIN_ENABLED = "true";
    process.env.ARSENKIN_API_TOKEN = "test-token";
    const agent = getAgent("ARSENKIN_SEARCH_TOP_REAL")!;
    const result = await agent.run({
      caseId: "c1",
      actorId: "t",
      mock: false,
    });
    assert.equal(result.status, "RUNNING");
    assert.notEqual(result.status, "SUCCEEDED");
  });

  it("10: coverage-less DONE tasks → FAILED ARSENKIN_NO_COVERAGE", () => {
    const evidence: FinalizeEvidence = {
      providerTasks: [{ id: "t1", state: "DONE", toolName: "suggest", externalTaskId: "1" }],
      observationCount: 0,
      coverageRows: [],
    };
    const r = computeArsenkinCaseAgentOutcome({ plannedSurfaceCount: 3, evidence });
    assert.equal(r.outcome, "FAILED");
    assert.equal(r.errorCode, "ARSENKIN_NO_COVERAGE");
  });
});
