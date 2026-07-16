/**
 * Arsenkin CaseAgent durable outcomes — NETWORK_CALLS=0.
 * Full lifecycle / plan / finalizer gates. No live API.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import {
  computeArsenkinCaseAgentOutcome,
  plannedSurfacesForTools,
  startArsenkinCaseAgentDurable,
  loadArsenkinCaseAgentExecution,
  finalizeArsenkinCaseAgentRun,
  tickArsenkinCaseAgentFinalizations,
  isFinalizationAllowed,
  buildArsenkinCaseAgentExecutionPlan,
  previewCaseAgentPlannedRequests,
  stageForCaseAgentTools,
  findActiveArsenkinCaseAgentExecution,
  type FinalizeEvidence,
} from "../src/modules/digital-profile/services/arsenkin-case-agent-execution";
import { getAgent } from "../src/modules/digital-profile/agents/registry";
import {
  ARSENKIN_REAL_AGENT_NAMES,
} from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import type { ArsenkinToolName } from "../src/modules/digital-profile/providers/arsenkin/flags";

process.env.NETWORK_CALLS = "0";

const SUBJECT = {
  fullName: "Иванов Иван Иванович",
  aliases: ["Ivan Ivanov", "Иванов И.И."],
};

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

  it("1: empty ProviderTask/coverage is FAILED not SUCCESS", () => {
    const r = computeArsenkinCaseAgentOutcome({
      plannedSurfaceCount: 3,
      evidence: { providerTasks: [], observationCount: 0, coverageRows: [] },
    });
    assert.equal(r.outcome, "FAILED");
    assert.equal(r.errorCode, "ARSENKIN_NO_EXECUTION_EVIDENCE");
    assert.equal(r.agentDbStatus, "FAILED");
    assert.notEqual(r.outcome, "SUCCESS");
  });

  it("2: SUBMIT_UNKNOWN stays RUNNING", () => {
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

  it("4: DONE + coverage NO_RESULTS → NO_RESULTS", () => {
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
  });

  it("5: REUSE DONE → REUSED", () => {
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
  });

  it("6: mixed → PARTIAL_SUCCESS", () => {
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

  it("7: each of five agents has independent tool-scoped plan", () => {
    const byAgent: Record<string, ArsenkinToolName[]> = {
      ARSENKIN_SEARCH_TOP_REAL: ["check-top"],
      ARSENKIN_SUGGESTIONS_REAL: ["suggest"],
      ARSENKIN_PAA_REAL: ["paa"],
      ARSENKIN_AI_SEARCH_REAL: ["ai-serp"],
      ARSENKIN_URL_AUDIT_REAL: ["check-h", "indexation"],
    };
    for (const [name, tools] of Object.entries(byAgent)) {
      const agent = getAgent(name)!;
      assert.deepEqual([...agent.tools].sort(), [...tools].sort());
      const built = buildArsenkinCaseAgentExecutionPlan({
        caseId: "c-tools",
        enrichmentReportRunId: `orion-agent-${name}`,
        tools,
        fullName: SUBJECT.fullName,
        aliases: SUBJECT.aliases,
        urlsEnrichment:
          name === "ARSENKIN_URL_AUDIT_REAL"
            ? ["https://example.com/a", "https://news.example.org/b"]
            : [],
      });
      assert.equal(built.ok, true, name);
      if (!built.ok) continue;
      assert.ok(built.plan.tools.every((t) => tools.includes(t)), name);
      assert.ok(
        built.plan.requests.every((r) => tools.includes(r.tool as ArsenkinToolName)),
        `${name} request tools`
      );
      assert.ok(built.plan.requests.length > 0, name);
    }
  });

  it("8: Suggest plan has Yandex RU, Google RU, Google UAE", () => {
    const planned = previewCaseAgentPlannedRequests({
      tools: ["suggest"],
      fullName: SUBJECT.fullName,
      aliases: SUBJECT.aliases,
    });
    const suggest = planned.filter((p) => p.tool === "suggest");
    assert.ok(suggest.length >= 3);
    const engines = new Set(suggest.map((p) => `${p.engine}:${p.region}`));
    assert.ok(engines.has("YANDEX:RU"));
    assert.ok(engines.has("GOOGLE:RU"));
    assert.ok(engines.has("GOOGLE:UAE"));
  });

  it("9: queries never use stub 'subject'", () => {
    const built = buildArsenkinCaseAgentExecutionPlan({
      caseId: "c-nostub",
      enrichmentReportRunId: "orion-nostub",
      tools: ["paa"],
      fullName: SUBJECT.fullName,
      aliases: SUBJECT.aliases,
    });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    for (const q of [...built.queriesRu, ...built.queriesUae]) {
      assert.notEqual(q.trim().toLowerCase(), "subject");
    }
    for (const r of built.plan.requests) {
      assert.notEqual(String(r.query ?? "").trim().toLowerCase(), "subject");
    }
  });

  it("10: URL Audit creates check-h/indexation only with URLs", () => {
    const noUrls = buildArsenkinCaseAgentExecutionPlan({
      caseId: "c-url",
      enrichmentReportRunId: "orion-url-empty",
      tools: ["check-h", "indexation"],
      fullName: SUBJECT.fullName,
      aliases: SUBJECT.aliases,
      urlsEnrichment: [],
    });
    assert.equal(noUrls.ok, false);
    if (!noUrls.ok) {
      assert.equal(noUrls.errorCode, "ARSENKIN_URL_AUDIT_NO_SOURCE_URLS");
    }

    const withUrls = buildArsenkinCaseAgentExecutionPlan({
      caseId: "c-url",
      enrichmentReportRunId: "orion-url-ok",
      tools: ["check-h", "indexation"],
      fullName: SUBJECT.fullName,
      aliases: SUBJECT.aliases,
      urlsEnrichment: ["https://example.com/page"],
    });
    assert.equal(withUrls.ok, true);
    if (!withUrls.ok) return;
    const tools = new Set(withUrls.plan.requests.map((r) => r.tool));
    assert.ok(tools.has("check-h"));
    assert.ok(tools.has("indexation"));
  });

  it("11: plan builder always targets parent OrionReportRun id (= enrichmentReportRunId)", () => {
    const reportRunId = "orion-arsenkin-agent-paa-testparent";
    const built = buildArsenkinCaseAgentExecutionPlan({
      caseId: "c-parent",
      enrichmentReportRunId: reportRunId,
      tools: ["paa"],
      fullName: SUBJECT.fullName,
      aliases: SUBJECT.aliases,
    });
    assert.equal(built.ok, true);
    if (!built.ok) return;
    assert.equal(built.plan.reportRunId, reportRunId);
    assert.equal(stageForCaseAgentTools(["paa"]), "FIRST36_STAGE1");
    assert.equal(stageForCaseAgentTools(["ai-serp"]), "FIRST36_STAGE2");
    assert.equal(stageForCaseAgentTools(["check-h", "indexation"]), "FIRST36_STAGE2");
  });

  it("12: finalizer does not run during PREPARING/COLLECTING", async () => {
    assert.equal(isFinalizationAllowed("PREPARING"), false);
    assert.equal(isFinalizationAllowed("COLLECTING"), false);
    assert.equal(isFinalizationAllowed("FINALIZING"), true);
    assert.equal(isFinalizationAllowed("FAILED"), true);

    const started = await startArsenkinCaseAgentDurable({
      caseId: "ace-smoke-finalize-gate",
      agentRunId: "agent-run-finalize-gate",
      agentId: "ARSENKIN_PAA_REAL",
      tools: ["paa"],
      resolveBaseReportRunId: async () => "orion-r10-base-smoke",
      scheduleWorker: false,
    });
    const job = loadArsenkinCaseAgentExecution("ace-smoke-finalize-gate", started.executionId)!;
    assert.equal(job.phase, "PREPARING");

    const blocked = await finalizeArsenkinCaseAgentRun({
      agentRunId: job.agentRunId,
      caseId: job.caseId,
      executionId: job.executionId,
      enrichmentReportRunId: job.enrichmentReportRunId,
      agentId: job.agentId,
      tools: job.tools,
      plannedSurfaceCount: job.plannedSurfaces.length,
      evidence: { providerTasks: [], observationCount: 0, coverageRows: [] },
    });
    assert.equal(blocked.agentDbStatus, "RUNNING");
    assert.equal(blocked.outcome, "RUNNING");
    assert.match(blocked.summary, /finalization запрещена/i);

    const n = await tickArsenkinCaseAgentFinalizations({
      evidenceByExecutionId: {
        [job.executionId]: { providerTasks: [], observationCount: 0, coverageRows: [] },
      },
    });
    assert.equal(n, 0);
    const still = loadArsenkinCaseAgentExecution(job.caseId, job.executionId)!;
    assert.equal(still.phase, "PREPARING");
    assert.equal(still.status, "RUNNING");
  });

  it("13: repeat start does not create duplicate active execution", async () => {
    const caseId = "ace-smoke-dedupe";
    const agentId = "ARSENKIN_SEARCH_TOP_REAL";
    const first = await startArsenkinCaseAgentDurable({
      caseId,
      agentRunId: "run-dedupe-1",
      agentId,
      tools: ["check-top"],
      resolveBaseReportRunId: async () => null,
      scheduleWorker: false,
    });
    const second = await startArsenkinCaseAgentDurable({
      caseId,
      agentRunId: "run-dedupe-2",
      agentId,
      tools: ["check-top"],
      resolveBaseReportRunId: async () => null,
      scheduleWorker: false,
    });
    assert.equal(second.executionId, first.executionId);
    assert.equal(second.enrichmentReportRunId, first.enrichmentReportRunId);
    assert.equal(second.reusedExisting, true);
    const active = findActiveArsenkinCaseAgentExecution(caseId, agentId);
    assert.ok(active);
    assert.equal(active!.executionId, first.executionId);
  });

  it("14: durable start leaves PREPARING on disk (no SUCCESS); agent.run returns RUNNING", async () => {
    const started = await startArsenkinCaseAgentDurable({
      caseId: "ace-smoke-case",
      agentRunId: "agent-run-smoke-1",
      agentId: "ARSENKIN_PAA_REAL",
      tools: ["paa"],
      resolveBaseReportRunId: async () => "orion-r10-base-smoke",
      scheduleWorker: false,
    });
    assert.equal(started.status, "RUNNING");
    assert.ok(started.plannedSurfaces.length >= 1);
    const job = loadArsenkinCaseAgentExecution("ace-smoke-case", started.executionId);
    assert.ok(job);
    assert.equal(job!.status, "RUNNING");
    assert.equal(job!.phase, "PREPARING");
    assert.equal(job!.agentId, "ARSENKIN_PAA_REAL");

    process.env.ARSENKIN_ENABLED = "true";
    process.env.ARSENKIN_API_TOKEN = "test-token";
    const agent = getAgent("ARSENKIN_SEARCH_TOP_REAL")!;
    const result = await agent.run({ caseId: "c1", actorId: "t", mock: false });
    assert.equal(result.status, "RUNNING");
    assert.notEqual(result.status, "SUCCEEDED");
  });

  it("planned surfaces are tool-scoped", () => {
    const paa = plannedSurfacesForTools(["paa"]);
    const suggest = plannedSurfacesForTools(["suggest"]);
    assert.ok(paa.every((s) => s.tool === "paa"));
    assert.ok(suggest.every((s) => s.tool === "suggest"));
  });

  it("coverage-less DONE → ARSENKIN_NO_COVERAGE", () => {
    const evidence: FinalizeEvidence = {
      providerTasks: [{ id: "t1", state: "DONE", toolName: "suggest", externalTaskId: "1" }],
      observationCount: 0,
      coverageRows: [],
    };
    const r = computeArsenkinCaseAgentOutcome({ plannedSurfaceCount: 3, evidence });
    assert.equal(r.outcome, "FAILED");
    assert.equal(r.errorCode, "ARSENKIN_NO_COVERAGE");
  });

  it("explicit terminal error preserves concrete code (not generic NO_EXECUTION_EVIDENCE)", () => {
    const r = computeArsenkinCaseAgentOutcome({
      plannedSurfaceCount: 2,
      evidence: { providerTasks: [], observationCount: 0, coverageRows: [] },
      explicitErrorCode: "ARSENKIN_URL_AUDIT_NO_SOURCE_URLS",
      explicitErrorMessage: "no urls",
    });
    assert.equal(r.errorCode, "ARSENKIN_URL_AUDIT_NO_SOURCE_URLS");
    assert.equal(r.outcome, "FAILED");
  });

  it("FINALIZING phase allows finalization (gate)", () => {
    assert.equal(isFinalizationAllowed("FINALIZING"), true);
    const r = computeArsenkinCaseAgentOutcome({
      plannedSurfaceCount: 2,
      evidence: { providerTasks: [], observationCount: 0, coverageRows: [] },
    });
    assert.equal(r.outcome, "FAILED");
    assert.equal(r.errorCode, "ARSENKIN_NO_EXECUTION_EVIDENCE");
  });
});
