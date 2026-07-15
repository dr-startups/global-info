/**
 * Source-binding repair smokes (NETWORK_CALLS=0).
 *
 *   npm run smoke:arsenkin-source-binding-repair
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import {
  createOrchestrationJob,
  ensureFirst36FullCanonicalSource,
  evaluateFullAuditCompletionGate,
  isArsenkinProviderRunId,
  isValidBaseOrionReportRunId,
  loadOrchestrationJob,
  repairFirst36FullSourceBinding,
  resolveCanonicalBaseOrionReportRunId,
  runOrchestrationTick,
  sourceBindingRepairArtifactPath,
  startArsenkinFullAudit,
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin";
import { saveArsenkinReportBinding } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-report-binding";
import {
  caseScopedArtifactRoot,
  ORION_GOLDEN_QA_STORAGE_ROOT,
} from "../src/modules/digital-profile/orion-golden/evidence/admin-review-decision-store";

process.env.NETWORK_CALLS = "0";

const BASE = "orion-r10-1783705193806";
const CANARY = "orion-arsenkin-suggest-canary-1784052644782-08903825";
const FULL = "orion-arsenkin-first36-full-1784142276718-5d3c206e";

function writeMapping(
  caseId: string,
  workflow: "suggest-canary" | "first36-full",
  payload: Record<string, unknown>
): void {
  const root = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, `arsenkin-ui-run-mapping-${workflow}.json`),
    JSON.stringify(payload, null, 2),
    "utf-8"
  );
}

function readMapping(caseId: string, workflow: string): Record<string, unknown> {
  const root = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
  return JSON.parse(
    readFileSync(join(root, `arsenkin-ui-run-mapping-${workflow}.json`), "utf-8")
  ) as Record<string, unknown>;
}

describe("arsenkin source-binding repair", () => {
  let tmpRoot: string;
  const prevCwd = process.cwd();

  before(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "ars-src-bind-"));
    process.chdir(tmpRoot);
    resetArsenkinNetworkCallCount();
  });

  after(() => {
    process.chdir(prevCwd);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("A: binding.source=base + effective=canary → Full uses base, not canary", async () => {
    const caseId = `case-A-${Date.now()}`;
    saveArsenkinReportBinding({
      caseId,
      sourceReportRunId: BASE,
      effectiveReportRunId: CANARY,
      provider: "arsenkin",
      workflow: "suggest-canary",
      stage: "SUGGEST_RU_CANARY",
      status: "TRANSFERRED",
      transferredAt: new Date().toISOString(),
      providerTaskCount: 2,
      observationCount: 18,
      coverageCount: 2,
    });
    writeMapping(caseId, "suggest-canary", {
      caseId,
      sourceReportRunId: BASE,
      arsenkinReportRunId: CANARY,
      workflow: "suggest-canary",
      stage: "SUGGEST_RU_CANARY",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const resolved = await resolveCanonicalBaseOrionReportRunId(caseId, {
      listOrionRunIds: async () => [CANARY, FULL, BASE],
    });
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.baseOrionReportRunId, BASE);
      assert.equal(resolved.via, "binding.sourceReportRunId");
    }

    const started = await startArsenkinFullAudit(
      {
        caseId,
        reportRunId: CANARY, // hostile UI input
        confirmed: true,
      },
      { sleep: async () => undefined }
    );
    assert.equal(started.sourceOrionReportRunId, BASE);
    assert.ok(started.jobReportRunId.startsWith("orion-arsenkin-first36-full-"));
    assert.notEqual(started.jobReportRunId, CANARY);
    assert.equal(isArsenkinProviderRunId(started.sourceOrionReportRunId), false);
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("B: corrupted Full source=canary → auto-repair keeps same Full run id", async () => {
    const caseId = `case-B-${Date.now()}`;
    saveArsenkinReportBinding({
      caseId,
      sourceReportRunId: BASE,
      effectiveReportRunId: CANARY,
      provider: "arsenkin",
      workflow: "suggest-canary",
      stage: "SUGGEST_RU_CANARY",
      status: "TRANSFERRED",
      transferredAt: new Date().toISOString(),
      providerTaskCount: 2,
      observationCount: 18,
      coverageCount: 2,
    });
    writeMapping(caseId, "suggest-canary", {
      caseId,
      sourceReportRunId: BASE,
      arsenkinReportRunId: CANARY,
      workflow: "suggest-canary",
      stage: "SUGGEST_RU_CANARY",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    writeMapping(caseId, "first36-full", {
      caseId,
      sourceReportRunId: CANARY, // corrupted
      arsenkinReportRunId: FULL,
      workflow: "first36-full",
      stage: "FIRST36_STAGE1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    createOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: FULL,
      sourceReportRunId: CANARY,
    });
    const jobBefore = loadOrchestrationJob(caseId, "first36-full")!;
    // Simulate production FAILED_RETRYABLE
    const { patchOrchestrationJob } = await import(
      "../src/modules/digital-profile/providers/arsenkin/full-audit-job-store"
    );
    patchOrchestrationJob(caseId, "first36-full", {
      state: "FAILED_RETRYABLE",
      lastError: `Workflow first36-full уже привязан к source ${CANARY}`,
      lastErrorCode: "planning_failed",
      nextStep: "user-continue",
    });

    const repair = await repairFirst36FullSourceBinding({
      caseId,
      enrichmentReportRunId: FULL,
      listOrionRunIds: async () => [BASE, CANARY, FULL],
    });
    assert.equal(repair.ok, true);
    if (!repair.ok) return;
    assert.equal(repair.repaired, true);
    assert.equal(repair.baseOrionReportRunId, BASE);
    assert.equal(repair.enrichmentReportRunId, FULL);
    assert.equal(repair.artifact.previousSourceReportRunId, CANARY);
    assert.equal(repair.artifact.canonicalSourceReportRunId, BASE);
    assert.equal(repair.artifact.reason, "EFFECTIVE_PROVIDER_RUN_USED_AS_BASE_SOURCE");

    const mapping = readMapping(caseId, "first36-full");
    assert.equal(mapping.sourceReportRunId, BASE);
    assert.equal(mapping.arsenkinReportRunId, FULL);
    assert.equal(mapping.baseOrionReportRunId, BASE);

    const jobAfter = loadOrchestrationJob(caseId, "first36-full")!;
    assert.equal(jobAfter.reportRunId, FULL);
    assert.equal(jobAfter.jobId, jobBefore.jobId);
    assert.equal(jobAfter.sourceReportRunId, BASE);
    assert.ok(existsSync(sourceBindingRepairArtifactPath(caseId, FULL)));
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("C: offline repair never issues /set (ProviderTask reuse path intact)", async () => {
    resetArsenkinNetworkCallCount();
    const caseId = `case-C-${Date.now()}`;
    saveArsenkinReportBinding({
      caseId,
      sourceReportRunId: BASE,
      effectiveReportRunId: CANARY,
      provider: "arsenkin",
      workflow: "suggest-canary",
      stage: "SUGGEST_RU_CANARY",
      status: "TRANSFERRED",
      transferredAt: new Date().toISOString(),
      providerTaskCount: 0,
      observationCount: 0,
      coverageCount: 0,
    });
    writeMapping(caseId, "first36-full", {
      caseId,
      sourceReportRunId: CANARY,
      arsenkinReportRunId: FULL,
      workflow: "first36-full",
      stage: "FIRST36_STAGE1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await ensureFirst36FullCanonicalSource({
      caseId,
      enrichmentReportRunId: FULL,
      listOrionRunIds: async () => [BASE],
    });
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("D: idempotent repair — second call is no-op, no duplicate reason churn", async () => {
    const caseId = `case-D-${Date.now()}`;
    saveArsenkinReportBinding({
      caseId,
      sourceReportRunId: BASE,
      effectiveReportRunId: CANARY,
      provider: "arsenkin",
      workflow: "suggest-canary",
      stage: "SUGGEST_RU_CANARY",
      status: "TRANSFERRED",
      transferredAt: new Date().toISOString(),
      providerTaskCount: 0,
      observationCount: 0,
      coverageCount: 0,
    });
    writeMapping(caseId, "first36-full", {
      caseId,
      sourceReportRunId: CANARY,
      arsenkinReportRunId: FULL,
      workflow: "first36-full",
      stage: "FIRST36_STAGE1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const a = await repairFirst36FullSourceBinding({
      caseId,
      enrichmentReportRunId: FULL,
      listOrionRunIds: async () => [BASE],
    });
    const b = await repairFirst36FullSourceBinding({
      caseId,
      enrichmentReportRunId: FULL,
      listOrionRunIds: async () => [BASE],
    });
    assert.equal(a.ok && a.repaired, true);
    assert.equal(b.ok && b.repaired, false);
    if (b.ok) assert.equal(b.artifact.idempotentNoOp, true);
  });

  it("E: FAILED_RETRYABLE repairable → tick auto-resumes without user-continue", async () => {
    const caseId = `case-E-${Date.now()}`;
    saveArsenkinReportBinding({
      caseId,
      sourceReportRunId: BASE,
      effectiveReportRunId: CANARY,
      provider: "arsenkin",
      workflow: "suggest-canary",
      stage: "SUGGEST_RU_CANARY",
      status: "TRANSFERRED",
      transferredAt: new Date().toISOString(),
      providerTaskCount: 0,
      observationCount: 0,
      coverageCount: 0,
    });
    writeMapping(caseId, "first36-full", {
      caseId,
      sourceReportRunId: CANARY,
      arsenkinReportRunId: FULL,
      workflow: "first36-full",
      stage: "FIRST36_STAGE1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    createOrchestrationJob({
      caseId,
      workflow: "first36-full",
      reportRunId: FULL,
      sourceReportRunId: CANARY,
    });
    const { patchOrchestrationJob } = await import(
      "../src/modules/digital-profile/providers/arsenkin/full-audit-job-store"
    );
    patchOrchestrationJob(caseId, "first36-full", {
      state: "FAILED_RETRYABLE",
      lastError: `Workflow first36-full уже привязан к source ${CANARY}`,
      lastErrorCode: "SOURCE_BINDING_REPAIRABLE",
      nextStep: "user-continue",
    });

    await runOrchestrationTick(caseId, "first36-full", {
      sleep: async () => undefined,
      readiness: async () => ({
        ok: true,
        code: "READY",
        blockers: [],
        cached: true,
        checkedAt: new Date().toISOString(),
        buildCommit: "t",
        schemaFingerprint: "s",
      }),
      prepare: async () => ({ status: "PREPARED" }) as never,
      plan: async () =>
        ({
          digest: "d1",
          planDigest: "d1",
          estimatedLimitsTotal: 4,
        }) as never,
      client: null,
      refetchResults: false,
    });

    const job = loadOrchestrationJob(caseId, "first36-full")!;
    assert.notEqual(job.nextStep, "user-continue");
    assert.equal(job.sourceReportRunId, BASE);
    assert.ok(
      job.state === "PLANNING" ||
        job.state === "STAGE1_SUBMITTING" ||
        job.state === "PREFLIGHT" ||
        job.state === "WAITING_INFRASTRUCTURE"
    );
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("F: ambiguous bases without binding.source → NEEDS_ADMIN", async () => {
    const caseId = `case-F-${Date.now()}`;
    const resolved = await resolveCanonicalBaseOrionReportRunId(caseId, {
      listOrionRunIds: async () => ["orion-r10-aaa", "orion-r10-bbb", CANARY],
    });
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.code, "NEEDS_ADMIN");
  });

  it("G: UI contract labels — base vs enrichment vs previous (static)", () => {
    const panel = readFileSync(
      join(prevCwd, "src/modules/digital-profile/client/ArsenkinToolsPanel.tsx"),
      "utf-8"
    );
    assert.match(panel, /Базовый отчёт ORION/);
    assert.match(panel, /Текущий Full Arsenkin run/);
    assert.match(panel, /Предыдущее обогащение/);
    assert.match(panel, /showContinueButton/);
    assert.match(panel, /orchAutoRepairable/);
    assert.equal(isValidBaseOrionReportRunId(BASE), true);
    assert.equal(isValidBaseOrionReportRunId(CANARY), false);
  });

  it("H: completion — arsenkin base blocked; 0/12 not COMPLETED; 12/12 ok", () => {
    assert.equal(isArsenkinProviderRunId(CANARY), true);
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
  });

  it("NETWORK_CALLS=0", () => {
    assert.equal(String(process.env.NETWORK_CALLS ?? ""), "0");
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });
});
