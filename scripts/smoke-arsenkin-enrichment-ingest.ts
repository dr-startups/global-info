/**
 * Offline Arsenkin completion/ingestion contract (NETWORK_CALLS=0).
 * Fixtures A–F, J from incident remediation.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import {
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  saveUnifiedCollectionJob,
  writeUnifiedArtifact,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  startUnifiedOrionCollection,
  runUnifiedCollectionTick,
} from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { evaluateUnifiedCollectionRecoveryEligibility } from "../src/modules/digital-profile/services/unified-collection-recovery";
import { ARSENKIN_REAL_AGENT_NAMES } from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import {
  buildEnrichmentTickFromAgentSnapshots,
  legacyEnrichmentResultToTick,
} from "../src/modules/digital-profile/services/arsenkin-enrichment-tick";
import type { ArsenkinAgentProgress } from "../src/modules/digital-profile/services/arsenkin-enrichment-state";
import type { FullAuditResultDTO } from "../src/modules/digital-profile/services/agent-run-service";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";

process.env.NETWORK_CALLS = "0";

const CASE = "smoke-arsenkin-ingest-case";

function mockAudit(): FullAuditResultDTO {
  return {
    outcome: "SUCCESS",
    runs: [],
    runSummary: [
      {
        providerId: "yandex",
        phase: "collection",
        status: "completed",
        runtime: "real",
        agentName: "REAL_YANDEX_SEARCH",
      },
      {
        providerId: "google",
        phase: "collection",
        status: "completed",
        runtime: "real",
        agentName: "REAL_GOOGLE_SEARCH",
      },
    ],
    runtimeStrategy: {
      mode: "real_first_with_fallback",
      selectedOrder: [],
      fallbackPolicy: "allow_mock_fallback",
      realProvidersAvailable: 2,
      mockProvidersAvailable: 0,
      fallbackEvents: [],
      warnings: [],
      decisions: [],
    },
  };
}

const fixtureBaseRows = [
  {
    key: "organic|ru|yandex|q|https://a.example",
    kind: "organic" as const,
    region: "RU",
    engine: "YANDEX",
    query: "q",
    url: "https://a.example",
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: ["searchResult:sr1"],
    baseSearchResultId: "sr1",
  },
];

function agentsSnapshot(kind: "scheduled" | "4done1run" | "doneNotIngested" | "doneIngested" | "submitUnknown"): ArsenkinAgentProgress[] {
  return ARSENKIN_REAL_AGENT_NAMES.map((agentName, i) => {
    const runId = `run-${agentName.toLowerCase()}`;
    if (kind === "scheduled") {
      return {
        agentName,
        enrichmentRunId: runId,
        scheduled: true,
        terminal: false,
        terminalKind: null,
        ingested: false,
        pendingTaskCount: 1,
        doneTaskCount: 0,
        submitUnknownCount: 0,
        observationCount: 0,
      };
    }
    if (kind === "4done1run") {
      const running = i === 4;
      return {
        agentName,
        enrichmentRunId: runId,
        scheduled: true,
        terminal: !running,
        terminalKind: running ? null : "SUCCESS",
        ingested: !running,
        pendingTaskCount: running ? 1 : 0,
        doneTaskCount: running ? 0 : 1,
        submitUnknownCount: 0,
        observationCount: running ? 0 : 1,
      };
    }
    if (kind === "doneNotIngested") {
      return {
        agentName,
        enrichmentRunId: runId,
        scheduled: true,
        terminal: true,
        terminalKind: "SUCCESS",
        ingested: false,
        pendingTaskCount: 0,
        doneTaskCount: 1,
        submitUnknownCount: 0,
        observationCount: 0,
      };
    }
    if (kind === "submitUnknown") {
      return {
        agentName,
        enrichmentRunId: runId,
        scheduled: true,
        terminal: i === 1,
        terminalKind: i === 1 ? "SUBMIT_UNKNOWN_UNRECONCILED" : null,
        ingested: false,
        pendingTaskCount: i === 1 ? 0 : 1,
        doneTaskCount: 0,
        submitUnknownCount: i === 1 ? 1 : 0,
        observationCount: 0,
        errorCode: i === 1 ? "ARSENKIN_SUBMIT_UNKNOWN" : null,
      };
    }
    // doneIngested
    return {
      agentName,
      enrichmentRunId: runId,
      scheduled: true,
      terminal: true,
      terminalKind: "EMPTY_VALID",
      ingested: true,
      pendingTaskCount: 0,
      doneTaskCount: 1,
      submitUnknownCount: 0,
      observationCount: 0,
    };
  });
}

describe("arsenkin enrichment ingest contract", () => {
  before(() => {
    process.env.NETWORK_CALLS = "0";
    deleteUnifiedCollectionJobForTests(CASE);
  });

  it("A: 5 scheduled, 0 completed → compositeCalls=0", async () => {
    deleteUnifiedCollectionJobForTests(CASE);
    let compositeCalls = 0;
    let ticks = 0;
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows,
      runFullAudit: async () => mockAudit(),
      runArsenkinEnrichment: async (job: { caseId: string; unifiedJobId: string }) => {
        ticks += 1;
        const tick = buildEnrichmentTickFromAgentSnapshots({
          caseId: job.caseId,
          unifiedJobId: job.unifiedJobId,
          agents: agentsSnapshot("scheduled"),
        });
        return {
          arsenkinReportRunId: tick.arsenkinReportRunId,
          enrichmentRunIds: tick.enrichmentRunIds,
          observations: [],
          enrichmentComplete: false,
          agents: tick.state.agents,
          warnings: tick.warnings,
          partial: true,
        };
      },
      runPrepare: async () => {
        throw new Error("prepare should not run");
      },
    };
    // Intercept composite by never leaving arsenkin — verify stage
    await startUnifiedOrionCollection({ caseId: CASE, requestedBy: "t", deps });
    for (let i = 0; i < 4; i++) {
      const job = await runUnifiedCollectionTick(CASE, deps);
      if (job?.stage === "COMPOSITE_MERGE") compositeCalls += 1;
    }
    const job = loadUnifiedCollectionJob(CASE);
    assert.equal(compositeCalls, 0);
    assert.equal(job?.stage, "ARSENKIN_ENRICHMENT");
    assert.equal(job?.status, "WAITING");
    assert.equal(job?.resumeCheckpoint, "ARSENKIN_RESULT_INGEST");
    assert.equal(job?.arsenkinEnrichmentState?.enrichmentComplete, false);
    assert.ok(ticks >= 1);
  });

  it("B: 4 completed, 1 running → compositeCalls=0", async () => {
    deleteUnifiedCollectionJobForTests(CASE);
    let compositeCalls = 0;
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows,
      runFullAudit: async () => mockAudit(),
      runArsenkinEnrichment: async (job: { caseId: string; unifiedJobId: string }) => {
        const tick = buildEnrichmentTickFromAgentSnapshots({
          caseId: job.caseId,
          unifiedJobId: job.unifiedJobId,
          agents: agentsSnapshot("4done1run"),
        });
        return {
          arsenkinReportRunId: tick.arsenkinReportRunId,
          enrichmentRunIds: tick.enrichmentRunIds,
          observations: [],
          enrichmentComplete: false,
          agents: tick.state.agents,
          partial: true,
        };
      },
      runPrepare: async () => ({ prepareDatasetId: "x" }),
    };
    await startUnifiedOrionCollection({ caseId: CASE, requestedBy: "t", deps });
    for (let i = 0; i < 5; i++) {
      const job = await runUnifiedCollectionTick(CASE, deps);
      if (job?.stage === "COMPOSITE_MERGE" || job?.stage === "ORION_PREPARE") compositeCalls += 1;
    }
    assert.equal(compositeCalls, 0);
    assert.equal(loadUnifiedCollectionJob(CASE)?.stage, "ARSENKIN_ENRICHMENT");
  });

  it("C: 5 completed, not ingested → compositeCalls=0", async () => {
    deleteUnifiedCollectionJobForTests(CASE);
    let compositeCalls = 0;
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows,
      runFullAudit: async () => mockAudit(),
      runArsenkinEnrichment: async (job: { caseId: string; unifiedJobId: string }) => {
        const tick = buildEnrichmentTickFromAgentSnapshots({
          caseId: job.caseId,
          unifiedJobId: job.unifiedJobId,
          agents: agentsSnapshot("doneNotIngested"),
        });
        return {
          arsenkinReportRunId: tick.arsenkinReportRunId,
          enrichmentRunIds: tick.enrichmentRunIds,
          observations: [],
          enrichmentComplete: false,
          agents: tick.state.agents,
          partial: true,
        };
      },
    };
    await startUnifiedOrionCollection({ caseId: CASE, requestedBy: "t", deps });
    for (let i = 0; i < 5; i++) {
      const job = await runUnifiedCollectionTick(CASE, deps);
      if (job?.stage === "COMPOSITE_MERGE") compositeCalls += 1;
    }
    assert.equal(compositeCalls, 0);
  });

  it("D: 5 completed + ingested → compositeCalls=1", async () => {
    deleteUnifiedCollectionJobForTests(CASE);
    let compositeCalls = 0;
    const deps = {
      autoSchedule: false as const,
      allowMockReport: false,
      fixtureBaseRows,
      runFullAudit: async () => mockAudit(),
      runArsenkinEnrichment: async (job: { caseId: string; unifiedJobId: string }) => {
        const tick = buildEnrichmentTickFromAgentSnapshots({
          caseId: job.caseId,
          unifiedJobId: job.unifiedJobId,
          agents: agentsSnapshot("doneIngested"),
          observations: [
            {
              kind: "organic" as const,
              url: "https://ars.example",
              query: "q",
              providerTaskId: "pt1",
              externalTaskId: "ext1",
              caseAgent: "ARSENKIN_SEARCH_TOP_REAL",
              tool: "check-top",
              enrichmentRunId: "run-1",
              unifiedJobId: job.unifiedJobId,
              resultHash: "abc",
            },
          ],
        });
        return {
          arsenkinReportRunId: tick.arsenkinReportRunId,
          enrichmentRunIds: tick.enrichmentRunIds,
          observations: tick.observations,
          enrichmentComplete: true,
          agents: tick.state.agents,
          partial: false,
        };
      },
      runPrepare: async ({ binding }: { binding: { compositeDatasetId: string } }) => {
        compositeCalls += 1;
        return { prepareDatasetId: binding.compositeDatasetId, pdf: "/tmp/x.pdf", assemblyCount: 1, renderCount: 1 };
      },
    };
    await startUnifiedOrionCollection({ caseId: CASE, requestedBy: "t", deps });
    for (let i = 0; i < 12; i++) {
      const job = await runUnifiedCollectionTick(CASE, deps);
      if (
        job?.stage === "REPORT_READY" ||
        job?.stage === "COMPLETED_PARTIAL" ||
        job?.stage === "FAILED_TERMINAL"
      ) {
        break;
      }
    }
    // prepare called once; composite stage visited once en route
    assert.equal(compositeCalls, 1);
    const job = loadUnifiedCollectionJob(CASE);
    assert.ok(job?.arsenkinEnrichmentState?.enrichmentComplete);
  });

  it("E: SUBMIT_UNKNOWN → fail-closed, no new submit", () => {
    const tick = buildEnrichmentTickFromAgentSnapshots({
      caseId: CASE,
      unifiedJobId: "u1",
      agents: agentsSnapshot("submitUnknown"),
    });
    assert.equal(tick.blockPipeline, true);
    assert.equal(tick.state.enrichmentComplete, false);
    assert.ok(tick.state.failedAgents.length >= 1);
  });

  it("F: Job B recovery fixture — ingest checkpoint, no new base/arsenkin schedule", () => {
    deleteUnifiedCollectionJobForTests(CASE);
    const unifiedJobId = "unified-1784295388553-269bc3cf-fixture";
    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId,
      caseId: CASE,
      capturedAt: new Date().toISOString(),
      baseReportRunId: "orion-unified-base-jobb",
      searchResultIds: ["sr1"],
      searchSurfaceItemIds: [],
      baseCount: 1,
      actualProviders: [
        {
          providerId: "yandex",
          agentName: "REAL_YANDEX_SEARCH",
          runtime: "real",
          status: "completed",
        },
      ],
      realCollectionSufficient: true,
    };
    // Seed a terminal job with scheduled-but-not-complete enrichment (Job B pattern).
    writeUnifiedArtifact(CASE, unifiedJobId, "base-collection-manifest.json", manifest);
    const now = new Date().toISOString();
    saveUnifiedCollectionJob({
      version: "unified-orion-collection-job-v1",
      jobId: unifiedJobId,
      unifiedJobId,
      caseId: CASE,
      stage: "FAILED_TERMINAL",
      status: "FAILED",
      progress: 0.7,
      versionNum: 1,
      leaseOwnerId: null,
      leaseUntil: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
      requestedBy: "t",
      arsenkinMode: "full-first36",
      baseReportRunId: "orion-unified-base-jobb",
      arsenkinReportRunId: "run-a",
      enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n) => `run-${n}`),
      arsenkinEnrichmentState: buildEnrichmentTickFromAgentSnapshots({
        caseId: CASE,
        unifiedJobId,
        agents: agentsSnapshot("scheduled"),
      }).state,
      compositeDatasetId: "composite-x",
      actualProviders: manifest.actualProviders,
      coverage: null,
      warnings: ["REPORT_READY_GATE_FAILED"],
      lastError: "compositeCount 41 < baseCount 43",
      lastErrorCode: "REPORT_READY_GATE_FAILED",
      artifactPaths: { baseCollectionManifest: "base-collection-manifest.json" },
      reportLinks: {},
      cancelRequested: false,
    });

    const job = loadUnifiedCollectionJob(CASE)!;
    const elig = evaluateUnifiedCollectionRecoveryEligibility({
      caseId: CASE,
      job,
      manifest,
    });
    assert.equal(elig.recoveryAllowed, true);
    assert.equal(elig.recoveryReason, "ARSENKIN_INGEST_RESUME");

    // Full audit without paid confirm must conflict.
    assert.rejects(
      async () =>
        startUnifiedOrionCollection({
          caseId: CASE,
          requestedBy: "t",
          deps: { autoSchedule: false },
        }),
      /confirmPaidRecollection|preserved|recoverable/i
    );
  });

  it("J: double tick does not duplicate enrichmentComplete transition", async () => {
    deleteUnifiedCollectionJobForTests(CASE);
    let scheduleCount = 0;
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows,
      allowMockReport: false,
      runFullAudit: async () => mockAudit(),
      runArsenkinEnrichment: async (job: { caseId: string; unifiedJobId: string; enrichmentRunIds?: string[] }) => {
        scheduleCount += 1;
        const tick = buildEnrichmentTickFromAgentSnapshots({
          caseId: job.caseId,
          unifiedJobId: job.unifiedJobId,
          agents: agentsSnapshot("doneIngested"),
        });
        return {
          arsenkinReportRunId: tick.arsenkinReportRunId,
          enrichmentRunIds: job.enrichmentRunIds?.length
            ? job.enrichmentRunIds
            : tick.enrichmentRunIds,
          observations: [],
          enrichmentComplete: true,
          agents: tick.state.agents,
        };
      },
      runPrepare: async ({ binding }: { binding: { compositeDatasetId: string } }) => ({
        prepareDatasetId: binding.compositeDatasetId,
        assemblyCount: 1,
        renderCount: 1,
      }),
    };
    await startUnifiedOrionCollection({ caseId: CASE, requestedBy: "t", deps });
    for (let i = 0; i < 10; i++) await runUnifiedCollectionTick(CASE, deps);
    const job = loadUnifiedCollectionJob(CASE);
    assert.ok(job?.stage === "REPORT_READY" || job?.stage === "COMPLETED_PARTIAL");
    // Enrichment handler may be called once per arsenkin tick; must not explode.
    assert.ok(scheduleCount >= 1 && scheduleCount <= 3);
  });

  it("legacy schedule-only is not treated as complete", () => {
    const job = {
      caseId: CASE,
      unifiedJobId: "u",
      enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n) => `id-${n}`),
    } as Parameters<typeof legacyEnrichmentResultToTick>[0];
    const tick = legacyEnrichmentResultToTick(job, {
      arsenkinReportRunId: "id-1",
      enrichmentRunIds: job.enrichmentRunIds,
      observations: [],
      enrichmentComplete: false,
      partial: true,
    });
    assert.equal(tick.state.enrichmentComplete, false);
    assert.equal(tick.waiting, true);
  });
});
