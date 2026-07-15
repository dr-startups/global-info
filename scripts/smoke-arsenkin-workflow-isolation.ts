/**
 * Workflow isolation + completion gate + status projection smokes (NETWORK_CALLS=0).
 *
 *   npm run smoke:arsenkin-workflow-isolation
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import {
  createOrchestrationJob,
  evaluateFullAuditCompletionGate,
  FIRST36_FULL_EXPECTED_SURFACES,
  FIRST36_FULL_SURFACE_SLOTS,
  findOrCreateActiveOrchestrationJob,
  isFirst36FullReportRunId,
  isSuggestCanaryReportRunId,
  loadOrchestrationJob,
  startArsenkinFullAudit,
  assertWorkflowRunMatch,
  computeFullAuditPercent,
} from "../src/modules/digital-profile/providers/arsenkin";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";
import { saveArsenkinUiRunMapping } from "../src/modules/digital-profile/services/arsenkin-ui-orchestration-service";

process.env.NETWORK_CALLS = "0";

const CASE_ID = `case-wf-iso-${Date.now()}`;

describe("arsenkin workflow isolation + completion", () => {
  let tmpRoot: string;
  const prevCwd = process.cwd();

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ars-wf-iso-"));
    process.chdir(tmpRoot);
    resetArsenkinNetworkCallCount();
  });

  after(() => {
    process.chdir(prevCwd);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("A: existing transferred canary → Full start creates first36-full run", async () => {
    const caseId = `${CASE_ID}-A`;
    const canaryId = "orion-arsenkin-suggest-canary-1784052644782-08903825";
    saveArsenkinUiRunMapping({
      caseId,
      sourceReportRunId: "orion-source-1",
      arsenkinReportRunId: canaryId,
      workflow: "suggest-canary",
      stage: "SUGGEST_RU_CANARY",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Simulate canary job left around (must not be resumed by Full).
    createOrchestrationJob({
      caseId,
      workflow: "suggest-canary",
      reportRunId: canaryId,
      sourceReportRunId: "orion-source-1",
    });

    const started = await startArsenkinFullAudit(
      {
        caseId,
        reportRunId: canaryId, // UI may still pass canary binding id
        workflow: "suggest-canary", // hostile: UI tab was canary
        confirmed: true,
      },
      { sleep: async () => undefined }
    );

    assert.equal(started.requestedWorkflowType, "FIRST36_FULL");
    assert.equal(started.jobWorkflowType, "FIRST36_FULL");
    assert.equal(started.expectedSurfaceCount, 12);
    assert.ok(isFirst36FullReportRunId(started.jobReportRunId));
    assert.equal(isSuggestCanaryReportRunId(started.jobReportRunId), false);
    assert.notEqual(started.jobReportRunId, canaryId);
    assert.equal(started.currentlyBoundReportRunId, canaryId);

    const fullJob = loadOrchestrationJob(caseId, "first36-full");
    assert.ok(fullJob);
    assert.equal(fullJob!.reportRunId, started.jobReportRunId);
    assert.equal(fullJob!.expectedSurfaceCount, 12);

    const canaryJob = loadOrchestrationJob(caseId, "suggest-canary");
    assert.ok(canaryJob);
    assert.equal(canaryJob!.reportRunId, canaryId);
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("B: Full start ignores canary stage in request — always FIRST36_FULL", async () => {
    const caseId = `${CASE_ID}-B`;
    const started = await startArsenkinFullAudit(
      {
        caseId,
        reportRunId: "classic-orion-run",
        workflow: "suggest-canary",
        requestedWorkflowType: "FIRST36_FULL",
        confirmed: true,
      },
      { sleep: async () => undefined }
    );
    assert.equal(started.jobWorkflowType, "FIRST36_FULL");
    assert.ok(started.jobReportRunId.startsWith("orion-arsenkin-first36-full-"));
  });

  it("C: completion gate — 0/12 and canary 2/12 never COMPLETED", () => {
    const zero = evaluateFullAuditCompletionGate({
      workflowType: "FIRST36_FULL",
      expectedSurfaceCount: 12,
      terminalSurfaceCount: 0,
      surfaceStatuses: Array.from({ length: 12 }, () => "PLANNED"),
      stage1Done: false,
      stage2Done: false,
      bindingMatchesJob: false,
      renderDone: false,
    });
    assert.equal(zero.ok, false);
    if (!zero.ok) assert.ok(zero.code.includes("TERMINAL") || zero.code.includes("STAGE"));

    const canaryAsFull = evaluateFullAuditCompletionGate({
      workflowType: "FIRST36_FULL",
      expectedSurfaceCount: 12,
      terminalSurfaceCount: 2,
      surfaceStatuses: ["MEASURED", "MEASURED", ...Array.from({ length: 10 }, () => "PLANNED")],
      stage1Done: false,
      stage2Done: false,
      bindingMatchesJob: true,
      renderDone: true,
    });
    assert.equal(canaryAsFull.ok, false);

    const pass = evaluateFullAuditCompletionGate({
      workflowType: "FIRST36_FULL",
      expectedSurfaceCount: 12,
      terminalSurfaceCount: 12,
      surfaceStatuses: Array.from({ length: 12 }, () => "MEASURED"),
      stage1Done: true,
      stage2Done: true,
      bindingMatchesJob: true,
      renderDone: true,
      acceptancePass: true,
    });
    assert.equal(pass.ok, true);

    assert.equal(computeFullAuditPercent({ state: "STAGE1_POLLING", stage1Terminal: 0, stage2Terminal: 0 }), 10);
    assert.equal(
      computeFullAuditPercent({ state: "COMPLETED", stage1Terminal: 12, stage2Terminal: 0, completed: true }),
      100
    );
    assert.notEqual(
      computeFullAuditPercent({ state: "STAGE1_POLLING", stage1Terminal: 0, stage2Terminal: 0 }),
      100
    );
  });

  it("D: status projection — canary and full counters stay isolated in job store", () => {
    const caseId = `${CASE_ID}-D`;
    const canaryId = `orion-arsenkin-suggest-canary-${Date.now()}-d`;
    const fullId = `orion-arsenkin-first36-full-${Date.now()}-d`;
    createOrchestrationJob({
      caseId,
      workflow: "suggest-canary",
      reportRunId: canaryId,
      sourceReportRunId: "src",
    });
    createOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: fullId,
      sourceReportRunId: "src",
    });
    const canary = loadOrchestrationJob(caseId, "suggest-canary")!;
    const full = loadOrchestrationJob(caseId, "first36-full")!;
    assert.equal(canary.expectedSurfaceCount, 2);
    assert.equal(full.expectedSurfaceCount, 12);
    assert.notEqual(canary.reportRunId, full.reportRunId);
  });

  it("E: polling contract — fetch/status must be no-store (static proof)", () => {
    // Client request() hardcodes cache: "no-store"; route sets Cache-Control.
    const apiSrc = readFileSync(join(prevCwd, "src/modules/digital-profile/client/api.ts"), "utf-8");
    assert.match(apiSrc, /cache:\s*"no-store"/);
    const routeSrc = readFileSync(
      join(prevCwd, "src/app/api/digital-profile/cases/[id]/orion-golden/arsenkin/route.ts"),
      "utf-8"
    );
    assert.match(routeSrc, /Cache-Control.*no-store/);
    assert.match(routeSrc, /force-dynamic/);
    const panelSrc = readFileSync(
      join(prevCwd, "src/modules/digital-profile/client/ArsenkinToolsPanel.tsx"),
      "utf-8"
    );
    assert.match(panelSrc, /setInterval\(\(\) => \{\s*void refresh\(\);\s*\}, 3000\)/);
    assert.match(panelSrc, /Do not stop polling on transient network errors/);
  });

  it("F: repeated Full click resumes same active first36-full, never canary", async () => {
    const caseId = `${CASE_ID}-F`;
    const canaryId = `orion-arsenkin-suggest-canary-${Date.now()}-f`;
    saveArsenkinUiRunMapping({
      caseId,
      sourceReportRunId: "src",
      arsenkinReportRunId: canaryId,
      workflow: "suggest-canary",
      stage: "SUGGEST_RU_CANARY",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const a = await startArsenkinFullAudit(
      { caseId, reportRunId: canaryId, confirmed: true },
      { sleep: async () => undefined }
    );
    const b = await startArsenkinFullAudit(
      { caseId, reportRunId: canaryId, confirmed: true },
      { sleep: async () => undefined }
    );
    assert.equal(a.jobId, b.jobId);
    assert.equal(a.jobReportRunId, b.jobReportRunId);
    assert.equal(b.created, false);
    assert.ok(isFirst36FullReportRunId(a.jobReportRunId));
  });

  it("G: Full fake E2E identity — 12 surface contract + findOrCreate", () => {
    assert.equal(FIRST36_FULL_SURFACE_SLOTS.length, FIRST36_FULL_EXPECTED_SURFACES);
    assert.equal(FIRST36_FULL_SURFACE_SLOTS.filter((s) => s.stage === 1).length, 8);
    assert.equal(FIRST36_FULL_SURFACE_SLOTS.filter((s) => s.stage === 2).length, 4);
    const caseId = `${CASE_ID}-G`;
    const fullId = `orion-arsenkin-first36-full-${Date.now()}-g`;
    const a = findOrCreateActiveOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: fullId,
      sourceReportRunId: "src",
    });
    const b = findOrCreateActiveOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: fullId,
      sourceReportRunId: "src",
    });
    assert.equal(a.job.jobId, b.job.jobId);
    assert.equal(a.job.expectedSurfaceCount, 12);
    assert.throws(() =>
      findOrCreateActiveOrchestrationJob({
        caseId: `${caseId}-bad`,
        workflow: "first36-full",
        reportRunId: "orion-arsenkin-suggest-canary-should-fail",
        sourceReportRunId: "src",
      })
    );
  });

  it("H: overlay contract — workflow mismatch assert + surface slots named", () => {
    const bad = assertWorkflowRunMatch({
      requestedWorkflowType: "FIRST36_FULL",
      jobWorkflowType: "FIRST36_FULL",
      jobReportRunId: "orion-arsenkin-suggest-canary-x",
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.code, "WORKFLOW_RUN_MISMATCH");

    const labels = FIRST36_FULL_SURFACE_SLOTS.map((s) => s.id);
    assert.ok(labels.includes("ru-yandex-organic"));
    assert.ok(labels.includes("url-audit"));
    assert.ok(labels.includes("ru-google-paa"));
    // Overlay policy: search surfaces only — Wikipedia/KP not in Arsenkin slots.
    assert.equal(labels.some((l) => /wikipedia|knowledge/i.test(l)), false);
  });

  it("NETWORK_CALLS stays 0", () => {
    assert.equal(String(process.env.NETWORK_CALLS ?? ""), "0");
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });
});
