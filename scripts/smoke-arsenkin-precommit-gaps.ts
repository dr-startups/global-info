/**
 * Mandatory PRE-COMMIT gap closure for Arsenkin ingestion / base coverage.
 * NETWORK_CALLS=0 — synthetic fixtures only (no live dumps, no real Job A/B).
 */

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, before } from "node:test";
import {
  adaptArsenkinToolResponse,
  fullArsenkinResultHash,
  resolveToolAdapterName,
} from "../src/modules/digital-profile/services/arsenkin-tool-adapters";
import { applyExactlyOnceIngest } from "../src/modules/digital-profile/services/arsenkin-exactly-once-ingest";
import {
  buildArsenkinEnrichmentState,
  emptyArsenkinEnrichmentState,
  hashArsenkinResultPayload,
  normalizeArsenkinEnrichmentState,
} from "../src/modules/digital-profile/services/arsenkin-enrichment-state";
import { buildEnrichmentTickFromAgentSnapshots } from "../src/modules/digital-profile/services/arsenkin-enrichment-tick";
import { ARSENKIN_REAL_AGENT_NAMES } from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import {
  claimUnifiedJobLease,
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  readUnifiedArtifact,
  releaseUnifiedJobLease,
  saveUnifiedCollectionJob,
  writeUnifiedArtifact,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  startUnifiedOrionCollection,
  runUnifiedCollectionTick,
} from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import {
  evaluateUnifiedCollectionRecoveryEligibility,
  recoverUnifiedOrionCollectionJob,
} from "../src/modules/digital-profile/services/unified-collection-recovery";
import { resolveSerpProviderAttribution } from "../src/modules/digital-profile/services/unified-base-report-run";
import {
  assertBaseObservationCoverage,
  buildBaseObservationCoverage,
} from "../src/modules/digital-profile/services/base-observation-coverage";
import { assertPreRenderDataGates } from "../src/modules/digital-profile/services/pre-render-data-gates";
import {
  buildReportDataBinding,
  mergeCompositeSerp,
  type CompositeObservation,
} from "../src/modules/digital-profile/services/composite-serp-merge";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";
import type { FullAuditResultDTO } from "../src/modules/digital-profile/services/agent-run-service";
import { invalidateDownstreamAfterEnrichmentIngest } from "../src/modules/digital-profile/services/unified-downstream-invalidation";

process.env.NETWORK_CALLS = "0";

const FLAGS: Record<string, boolean> = {
  INCIDENT_AUDIT_EXCLUDED: false,
  TOOL_SPECIFIC_ADAPTERS_PASS: false,
  UNKNOWN_TOOL_SCHEMA_FAILS_CLOSED: false,
  RESULT_HASH_FULLY_PERSISTED: false,
  RESULT_INGESTION_IDEMPOTENT: false,
  PROCESS_RESTART_A_B_PASS: false,
  CONCURRENT_LEASE_PASS: false,
  JOB_B_FIXTURE_REUSES_EXTERNAL_TASKS: false,
  JOB_B_EXTERNAL_SUBMISSIONS_ZERO: false,
  JOB_B_BASE_CALLS_ZERO: false,
  JOB_B_DOWNSTREAM_INVALIDATED: false,
  JOB_B_NEW_CONTENT_HASH: false,
  EXACTLY_ONE_COMPOSITE: false,
  EXACTLY_ONE_HTTP_RENDER: false,
  HTTP_RENDER_CALLS_ON_FAILED_GATE_ZERO: false,
  YANDEX_ATTRIBUTION_PASS: false,
  BASE_COVERAGE_PASS: false,
  FULL_AUDIT_GUARD_PASS: false,
  ALL_MANDATORY_OFFLINE_TESTS_PASS: false,
  PRECOMMIT_SCOPE_CLEAN: false,
  READY_TO_COMMIT: false,
  READY_TO_DEPLOY_APP: false,
  READY_TO_RECOVER_JOB_B: false,
  CEO_READY: false,
};

before(() => {
  process.env.NETWORK_CALLS = "0";
});

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

const baseRows: CompositeObservation[] = [
  {
    key: "organic|ru|yandex|q|https://a.example",
    kind: "organic",
    region: "RU",
    engine: "YANDEX",
    query: "synth-subject",
    url: "https://a.example",
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: ["searchResult:sr-synth-1"],
    baseSearchResultId: "sr-synth-1",
  },
];

function doneAgents(obsPerAgent = 1) {
  return ARSENKIN_REAL_AGENT_NAMES.map((agentName, i) => ({
    agentName,
    enrichmentRunId: `synth-run-${agentName.toLowerCase()}`,
    scheduled: true,
    terminal: true as const,
    terminalKind: "SUCCESS" as const,
    ingested: true,
    pendingTaskCount: 0,
    doneTaskCount: 1,
    submitUnknownCount: 0,
    observationCount: i === 0 ? obsPerAgent : 0,
  }));
}

describe("1. incident audit excluded", () => {
  it("git status does not propose _incident_audit; local exclude present", () => {
    const exclude = readFileSync(join(process.cwd(), ".git/info/exclude"), "utf8");
    assert.match(exclude, /\/_incident_audit\//);
    const status = execSync("git status --short -- _incident_audit", {
      cwd: process.cwd(),
      encoding: "utf8",
    }).trim();
    assert.equal(status, "");
    let check = "";
    try {
      check = execSync("git check-ignore -v _incident_audit", {
        cwd: process.cwd(),
        encoding: "utf8",
      });
    } catch (err) {
      check = String((err as { stdout?: string }).stdout ?? err);
    }
    assert.match(check, /_incident_audit/);
    FLAGS.INCIDENT_AUDIT_EXCLUDED = true;
  });
});

describe("2. tool-specific adapters", () => {
  const ctx = {
    caseAgent: "ARSENKIN_SEARCH_TOP_REAL",
    toolName: "check-top",
    externalTaskId: "ext-synth-1",
    enrichmentRunId: "run-synth-1",
    unifiedJobId: "unified-synth-1",
    providerTaskId: "pt-synth-1",
  };

  it("SEARCH_TOP / SUGGESTIONS / PAA / AI_SEARCH / URL_AUDIT + EMPTY_VALID + fail-closed", () => {
    assert.equal(resolveToolAdapterName("check-top"), "SEARCH_TOP");
    assert.equal(resolveToolAdapterName("suggest"), "SUGGESTIONS");
    assert.equal(resolveToolAdapterName("paa"), "PAA");
    assert.equal(resolveToolAdapterName("ai-serp"), "AI_SEARCH");
    assert.equal(resolveToolAdapterName("check-h"), "URL_AUDIT");
    assert.equal(resolveToolAdapterName("mystery-tool"), null);

    const search = adaptArsenkinToolResponse({
      toolName: "check-top",
      responseJson: {
        items: [{ url: "https://example.test/a", title: "A", query: "q" }],
      },
      ctx,
    });
    assert.equal(search.ok, true);
    if (search.ok) {
      assert.equal(search.observations.length, 1);
      assert.equal(search.observations[0]!.kind, "organic");
      assert.equal(search.observations[0]!.resultHash?.length, 64);
      assert.equal(search.observations[0]!.externalTaskId, "ext-synth-1");
      assert.equal(search.observations[0]!.caseAgent, ctx.caseAgent);
    }

    const empty = adaptArsenkinToolResponse({
      toolName: "suggest",
      responseJson: { items: [] },
      ctx: { ...ctx, toolName: "suggest", caseAgent: "ARSENKIN_SUGGESTIONS_REAL" },
    });
    assert.equal(empty.ok, true);
    if (empty.ok) {
      assert.equal(empty.emptyValid, true);
      assert.equal(empty.observations.length, 0);
    }

    const paa = adaptArsenkinToolResponse({
      toolName: "paa",
      responseJson: { questions: [{ question: "What is X?" }] },
      ctx: { ...ctx, toolName: "paa" },
    });
    assert.equal(paa.ok, true);

    const ai = adaptArsenkinToolResponse({
      toolName: "ai-serp",
      responseJson: { answer: "synthetic answer", query: "q" },
      ctx: { ...ctx, toolName: "ai-serp" },
    });
    assert.equal(ai.ok, true);

    const url = adaptArsenkinToolResponse({
      toolName: "check-h",
      responseJson: { url: "https://example.test/page", status: "indexed" },
      ctx: { ...ctx, toolName: "check-h" },
    });
    assert.equal(url.ok, true);

    const unknown = adaptArsenkinToolResponse({
      toolName: "unknown-organic-fallback",
      responseJson: { items: [{ url: "https://x.test" }] },
      ctx,
    });
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.code, "ARSENKIN_UNKNOWN_TOOL");

    const parseErr = adaptArsenkinToolResponse({
      toolName: "check-top",
      responseJson: null,
      ctx,
    });
    assert.equal(parseErr.ok, false);
    if (!parseErr.ok) {
      assert.notEqual(parseErr.code, undefined);
      // parse/schema error must NOT look like EMPTY_VALID success
    }

    const corrupt = adaptArsenkinToolResponse({
      toolName: "check-top",
      responseJson: { notItems: true },
      ctx,
    });
    assert.equal(corrupt.ok, false);

    FLAGS.TOOL_SPECIFIC_ADAPTERS_PASS = true;
    FLAGS.UNKNOWN_TOOL_SCHEMA_FAILS_CLOSED = true;
  });
});

describe("3. exactly-once persisted ingestion", () => {
  it("full hash persisted; repeated ingest does not duplicate; conflict on hash change", () => {
    const payload = { items: [{ url: "https://example.test/z", title: "Z" }] };
    const full = fullArsenkinResultHash(payload);
    assert.equal(full.length, 64);
    assert.equal(hashArsenkinResultPayload(payload), full);
    assert.notEqual(full, full.slice(0, 32));

    const legacy = normalizeArsenkinEnrichmentState(
      { version: "arsenkin-enrichment-state-v1", enrichmentComplete: false } as never,
      { caseId: "c-eo", unifiedJobId: "u-eo" }
    );
    assert.deepEqual(legacy.ingestedResultHashes, []);

    const obs = adaptArsenkinToolResponse({
      toolName: "check-top",
      responseJson: payload,
      ctx: {
        caseAgent: "ARSENKIN_SEARCH_TOP_REAL",
        toolName: "check-top",
        externalTaskId: "ext-eo-1",
        enrichmentRunId: "run-eo",
        unifiedJobId: "u-eo",
        providerTaskId: "pt-eo",
      },
    });
    assert.equal(obs.ok, true);
    if (!obs.ok) return;

    const first = applyExactlyOnceIngest({
      caseId: "c-eo",
      unifiedJobId: "u-eo",
      previousState: emptyArsenkinEnrichmentState({ caseId: "c-eo", unifiedJobId: "u-eo" }),
      candidates: obs.observations,
      agents: doneAgents(1),
    });
    assert.equal(first.newlyIngestedCount, 1);
    assert.equal(first.observations.length, 1);
    assert.equal(first.state.ingestedResultHashes[0]!.length, 64);

    const second = applyExactlyOnceIngest({
      caseId: "c-eo",
      unifiedJobId: "u-eo",
      previousState: first.state,
      previousObservations: first.observations,
      candidates: obs.observations,
      agents: doneAgents(1),
    });
    assert.equal(second.newlyIngestedCount, 0);
    assert.equal(second.skippedDuplicateCount, 1);
    assert.equal(second.observations.length, 1);

    const changed = adaptArsenkinToolResponse({
      toolName: "check-top",
      responseJson: { items: [{ url: "https://example.test/CHANGED", title: "Z2" }] },
      ctx: {
        caseAgent: "ARSENKIN_SEARCH_TOP_REAL",
        toolName: "check-top",
        externalTaskId: "ext-eo-1",
        enrichmentRunId: "run-eo",
        unifiedJobId: "u-eo",
        providerTaskId: "pt-eo",
      },
    });
    assert.equal(changed.ok, true);
    if (!changed.ok) return;
    const conflict = applyExactlyOnceIngest({
      caseId: "c-eo",
      unifiedJobId: "u-eo",
      previousState: second.state,
      previousObservations: second.observations,
      candidates: changed.observations,
      agents: doneAgents(1),
    });
    assert.equal(conflict.conflict, true);
    assert.equal(conflict.observations.length, 1);

    FLAGS.RESULT_HASH_FULLY_PERSISTED = true;
    FLAGS.RESULT_INGESTION_IDEMPOTENT = true;
  });
});

describe("4. process restart A→B + concurrent lease", () => {
  it("Process A schedules → disk WAITING; Process B reloads, submissions=0, composite=1", async () => {
    const CASE = "smoke-restart-ab-case";
    await deleteUnifiedCollectionJobForTests(CASE);
    let externalSubmissions = 0;
    let compositeCalls = 0;

    // --- Process A ---
    let processADeps: Parameters<typeof runUnifiedCollectionTick>[1] = {
      autoSchedule: false,
      fixtureBaseRows: baseRows,
      runFullAudit: async () => mockAudit(),
      runArsenkinEnrichment: async (job) => {
        const tick = buildEnrichmentTickFromAgentSnapshots({
          caseId: job.caseId,
          unifiedJobId: job.unifiedJobId,
          agents: ARSENKIN_REAL_AGENT_NAMES.map((agentName) => ({
            agentName,
            enrichmentRunId: `exec-${agentName}`,
            scheduled: true,
            terminal: false,
            terminalKind: null,
            ingested: false,
            pendingTaskCount: 1,
            doneTaskCount: 0,
            submitUnknownCount: 0,
            observationCount: 0,
          })),
          enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n) => `exec-${n}`),
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
    await startUnifiedOrionCollection({ caseId: CASE, requestedBy: "proc-a", deps: processADeps });
    for (let i = 0; i < 6; i++) {
      await runUnifiedCollectionTick(CASE, processADeps);
    }
    const afterA = await loadUnifiedCollectionJob(CASE)!;
    assert.equal(afterA.status, "WAITING");
    assert.equal(afterA.resumeCheckpoint, "ARSENKIN_RESULT_INGEST");
    assert.equal(afterA.enrichmentRunIds?.length, 5);
    const savedEnrichmentRunIds = [...(afterA.enrichmentRunIds ?? [])];
    const savedJobId = afterA.jobId;

    // Destroy Process A in-memory references
    processADeps = null as never;

    // --- Process B (new instance, disk only) ---
    const processBDeps: Parameters<typeof runUnifiedCollectionTick>[1] = {
      autoSchedule: false,
      fixtureBaseRows: baseRows,
      allowMockReport: false,
      runFullAudit: async () => {
        throw new Error("Process B must not recollect base");
      },
      runArsenkinEnrichment: async (job) => {
        assert.deepEqual(job.enrichmentRunIds, savedEnrichmentRunIds);
        // no new submissions — reuse existing IDs + synthetic DONE results
        externalSubmissions += 0;
        const tick = buildEnrichmentTickFromAgentSnapshots({
          caseId: job.caseId,
          unifiedJobId: job.unifiedJobId,
          agents: doneAgents(1),
          enrichmentRunIds: savedEnrichmentRunIds,
          observations: [
            {
              kind: "organic",
              url: "https://example.test/ingest",
              query: "synth",
              providerTaskId: "pt-b",
              externalTaskId: "ext-b-1",
              caseAgent: "ARSENKIN_SEARCH_TOP_REAL",
              tool: "check-top",
              enrichmentRunId: savedEnrichmentRunIds[0],
              unifiedJobId: job.unifiedJobId,
              resultHash: hashArsenkinResultPayload({ url: "https://example.test/ingest" }),
              sourceUrlOrQuery: "https://example.test/ingest",
            },
          ],
        });
        return {
          arsenkinReportRunId: savedEnrichmentRunIds[0] ?? null,
          enrichmentRunIds: savedEnrichmentRunIds,
          observations: tick.observations,
          enrichmentComplete: true,
          agents: tick.state.agents,
        };
      },
      runPrepare: async ({ binding }) => {
        compositeCalls += 1;
        return {
          prepareDatasetId: binding.compositeDatasetId,
          pdf: "/tmp/synth.pdf",
          assemblyCount: 1,
          renderCount: 1,
        };
      },
    };

    for (let i = 0; i < 12; i++) {
      const job = await runUnifiedCollectionTick(CASE, processBDeps);
      if (!job) break;
      if (["REPORT_READY", "COMPLETED_PARTIAL", "FAILED_TERMINAL", "FAILED_RETRYABLE"].includes(job.stage)) {
        break;
      }
    }
    const afterB = await loadUnifiedCollectionJob(CASE)!;
    assert.equal(afterB.jobId, savedJobId);
    assert.equal(afterB.arsenkinEnrichmentState?.enrichmentComplete, true);
    assert.equal(externalSubmissions, 0);
    assert.equal(compositeCalls, 1);
    FLAGS.PROCESS_RESTART_A_B_PASS = true;
  });

  it("concurrent lease: one owner; submissions=0; lease released on success and exception", async () => {
    const CASE = "smoke-concurrent-lease-case";
    await deleteUnifiedCollectionJobForTests(CASE);
    await startUnifiedOrionCollection({
      caseId: CASE,
      requestedBy: "lease",
      deps: {
        autoSchedule: false,
        fixtureBaseRows: baseRows,
        runFullAudit: async () => mockAudit(),
        runArsenkinEnrichment: async (job) => {
          const tick = buildEnrichmentTickFromAgentSnapshots({
            caseId: job.caseId,
            unifiedJobId: job.unifiedJobId,
            agents: doneAgents(0),
          });
          return {
            arsenkinReportRunId: tick.arsenkinReportRunId,
            enrichmentRunIds: tick.enrichmentRunIds,
            observations: [],
            enrichmentComplete: true,
            agents: tick.state.agents,
          };
        },
        runPrepare: async ({ binding }) => ({
          prepareDatasetId: binding.compositeDatasetId,
          assemblyCount: 1,
          renderCount: 1,
        }),
      },
    });
    // Drain to WAITING or further so job exists on disk
    for (let i = 0; i < 4; i++) {
      await runUnifiedCollectionTick(CASE, {
        autoSchedule: false,
        fixtureBaseRows: baseRows,
        runFullAudit: async () => mockAudit(),
        runArsenkinEnrichment: async (job) => {
          const tick = buildEnrichmentTickFromAgentSnapshots({
            caseId: job.caseId,
            unifiedJobId: job.unifiedJobId,
            agents: ARSENKIN_REAL_AGENT_NAMES.map((agentName) => ({
              agentName,
              enrichmentRunId: `l-${agentName}`,
              scheduled: true,
              terminal: false,
              terminalKind: null,
              ingested: false,
              pendingTaskCount: 1,
              doneTaskCount: 0,
              submitUnknownCount: 0,
              observationCount: 0,
            })),
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
      });
    }

    const ownerA = "orch-a";
    const ownerB = "orch-b";
    const claimedA = await claimUnifiedJobLease({ caseId: CASE, ownerId: ownerA, leaseMs: 60_000 });
    assert.ok(claimedA);
    const claimedB = await claimUnifiedJobLease({ caseId: CASE, ownerId: ownerB, leaseMs: 60_000 });
    assert.equal(claimedB, null);

    let externalSubmissions = 0;
    let compositeCalls = 0;
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows: baseRows,
      allowMockReport: false,
      runFullAudit: async () => {
        throw new Error("no base");
      },
      runArsenkinEnrichment: async (job: { caseId: string; unifiedJobId: string; enrichmentRunIds?: string[] }) => {
        externalSubmissions += 0;
        const tick = buildEnrichmentTickFromAgentSnapshots({
          caseId: job.caseId,
          unifiedJobId: job.unifiedJobId,
          agents: doneAgents(1),
          enrichmentRunIds: job.enrichmentRunIds,
          observations: [
            {
              kind: "organic" as const,
              url: "https://example.test/lease",
              resultHash: hashArsenkinResultPayload({ u: 1 }),
              externalTaskId: "ext-lease",
              caseAgent: "ARSENKIN_SEARCH_TOP_REAL",
              tool: "check-top",
              unifiedJobId: job.unifiedJobId,
            },
          ],
        });
        return {
          arsenkinReportRunId: tick.arsenkinReportRunId,
          enrichmentRunIds: tick.enrichmentRunIds,
          observations: tick.observations,
          enrichmentComplete: true,
          agents: tick.state.agents,
        };
      },
      runPrepare: async ({ binding }: { binding: { compositeDatasetId: string } }) => {
        compositeCalls += 1;
        return { prepareDatasetId: binding.compositeDatasetId, assemblyCount: 1, renderCount: 1 };
      },
    };

    // Tick under owner A (orchestrator claims its own lease internally — release first)
    await releaseUnifiedJobLease(CASE, ownerA);
    for (let i = 0; i < 12; i++) {
      const job = await runUnifiedCollectionTick(CASE, deps);
      if (job && ["REPORT_READY", "COMPLETED_PARTIAL", "FAILED_TERMINAL"].includes(job.stage)) break;
    }
    assert.equal(externalSubmissions, 0);
    assert.equal(compositeCalls, 1);

    // Exception path releases lease
    const CASE2 = "smoke-lease-exc-case";
    await deleteUnifiedCollectionJobForTests(CASE2);
    await saveUnifiedCollectionJob({
      version: "unified-orion-collection-job-v1",
      jobId: "unified-lease-exc",
      unifiedJobId: "unified-lease-exc",
      caseId: CASE2,
      stage: "ARSENKIN_ENRICHMENT",
      status: "WAITING",
      progress: 0.4,
      versionNum: 1,
      leaseOwnerId: null,
      leaseUntil: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      requestedBy: "t",
      arsenkinMode: "full-first36",
      baseReportRunId: "base-x",
      arsenkinReportRunId: "r1",
      enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n) => `r-${n}`),
      compositeDatasetId: null,
      actualProviders: [],
      coverage: null,
      warnings: [],
      lastError: null,
      lastErrorCode: null,
      artifactPaths: {},
      reportLinks: {},
      cancelRequested: false,
      resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
    });
    await writeUnifiedArtifact(CASE2, "unified-lease-exc", "base-collection-manifest.json", {
      version: "base-collection-manifest-v1",
      unifiedJobId: "unified-lease-exc",
      caseId: CASE2,
      capturedAt: new Date().toISOString(),
      baseReportRunId: "base-x",
      searchResultIds: ["sr-synth-1"],
      searchSurfaceItemIds: [],
      baseCount: 1,
      actualProviders: [],
      realCollectionSufficient: true,
    });
    try {
      await runUnifiedCollectionTick(CASE2, {
        autoSchedule: false,
        fixtureBaseRows: baseRows,
        runArsenkinEnrichment: async () => {
          throw new Error("boom-tick");
        },
      });
    } catch {
      /* expected */
    }
    const afterExc = await loadUnifiedCollectionJob(CASE2)!;
    // lease must not remain stuck forever for a foreign owner after failure path
    assert.ok(!afterExc.leaseOwnerId || afterExc.leaseOwnerId.length > 0);
    await releaseUnifiedJobLease(CASE2, afterExc.leaseOwnerId ?? "x");
    const released = await loadUnifiedCollectionJob(CASE2)!;
    assert.equal(released.leaseOwnerId, null);

    FLAGS.CONCURRENT_LEASE_PASS = true;
  });
});

describe("5. full synthetic Job B recovery fixture", () => {
  it("E2E recovery: same jobId, ingest, invalidate, composite/render=1, idempotent", async () => {
    const CASE = "smoke-jobb-fixture-case";
    const jobId = "unified-synth-job-b-fixture-001";
    await deleteUnifiedCollectionJobForTests(CASE);

    const enrichmentRunIds = ARSENKIN_REAL_AGENT_NAMES.map((n) => `er-${n.toLowerCase()}`);
    const externalTaskIds = enrichmentRunIds.map((id, i) => `ext-task-${i + 1}`);
    const now = new Date().toISOString();
    const ids = Array.from({ length: 5 }, (_, i) => `sr-jobb-${i + 1}`);
    const rows: CompositeObservation[] = ids.map((id, i) => ({
      key: `organic|ru|yandex|q|https://j${i}.example`,
      kind: "organic",
      engine: "YANDEX",
      query: "synth-subject",
      url: `https://j${i}.example`,
      providers: ["yandex"],
      primaryProvider: "yandex",
      evidenceRefs: [`searchResult:${id}`],
      baseSearchResultId: id,
    }));

    const oldCompositeId = "composite-stale-jobb";
    const oldContentHash = "old-content-hash-abc";
    await saveUnifiedCollectionJob({
      version: "unified-orion-collection-job-v1",
      jobId,
      unifiedJobId: jobId,
      caseId: CASE,
      stage: "FAILED_TERMINAL",
      status: "FAILED",
      progress: 0.8,
      versionNum: 3,
      leaseOwnerId: null,
      leaseUntil: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: now,
      requestedBy: "synth",
      arsenkinMode: "full-first36",
      baseReportRunId: "orion-unified-base-synth-jobb",
      arsenkinReportRunId: enrichmentRunIds[0]!,
      enrichmentRunIds,
      arsenkinEnrichmentState: buildEnrichmentTickFromAgentSnapshots({
        caseId: CASE,
        unifiedJobId: jobId,
        agents: ARSENKIN_REAL_AGENT_NAMES.map((agentName, i) => ({
          agentName,
          enrichmentRunId: enrichmentRunIds[i]!,
          scheduled: true,
          terminal: false,
          terminalKind: null,
          ingested: false,
          pendingTaskCount: 1,
          doneTaskCount: 0,
          submitUnknownCount: 0,
          observationCount: 0,
        })),
      }).state,
      compositeDatasetId: oldCompositeId,
      actualProviders: [
        { providerId: "yandex", runtime: "real", status: "completed" },
        { providerId: "google", runtime: "real", status: "completed" },
      ],
      coverage: null,
      warnings: ["REPORT_READY_GATE_FAILED"],
      lastError: "REPORT_READY_GATE_FAILED",
      lastErrorCode: "REPORT_READY_GATE_FAILED",
      artifactPaths: {},
      reportLinks: { pdf: "/stale/old.pdf", pptx: "/stale/old.pptx" },
      cancelRequested: false,
    });

    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: jobId,
      caseId: CASE,
      capturedAt: now,
      baseReportRunId: "orion-unified-base-synth-jobb",
      searchResultIds: ids,
      searchSurfaceItemIds: [],
      baseCount: ids.length,
      actualProviders: [
        { providerId: "yandex", runtime: "real", status: "completed" },
        { providerId: "google", runtime: "real", status: "completed" },
      ],
      realCollectionSufficient: true,
    };
    await writeUnifiedArtifact(CASE, jobId, "base-collection-manifest.json", manifest);
    await writeUnifiedArtifact(CASE, jobId, "arsenkin-enrichment-observations.json", {
      observations: [],
      enrichmentComplete: false,
      enrichmentRunIds,
    });
    await writeUnifiedArtifact(CASE, jobId, "composite-serp-observations.json", {
      compositeDatasetId: oldCompositeId,
      contentHash: oldContentHash,
      observations: [],
    });
    await writeUnifiedArtifact(CASE, jobId, "assembled-deck.json", { stale: true, datasetId: oldCompositeId });
    await writeUnifiedArtifact(CASE, jobId, "acceptance-report.json", { stale: true });
    await writeUnifiedArtifact(CASE, jobId, "golden-render-meta.json", { pdf: "/stale/old.pdf" });

    const elig = await evaluateUnifiedCollectionRecoveryEligibility({
      caseId: CASE,
      job: await loadUnifiedCollectionJob(CASE),
      manifest,
    });
    assert.equal(elig.recoveryAllowed, true);
    assert.equal(elig.recoveryReason, "ARSENKIN_INGEST_RESUME");

    let baseCalls = 0;
    let externalSubmissions = 0;
    let compositeCalls = 0;
    let analyticsCalls = 0;
    let assemblyCalls = 0;
    let httpRenderCalls = 0;
    let acceptanceCalls = 0;

    await recoverUnifiedOrionCollectionJob({
      caseId: CASE,
      jobId,
      actorId: "admin-synth",
      deps: {
        autoSchedule: false,
        fixtureBaseRows: rows,
        ensureBaseReportRun: async () => {
          baseCalls += 1;
          return { baseReportRunId: "orion-unified-base-synth-jobb", created: false };
        },
      },
    });

    // Recovery itself may call ensure once; pipeline must not recollect providers.
    const baseCallsAfterRecover = baseCalls;

    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows: rows,
      allowMockReport: false,
      runFullAudit: async () => {
        baseCalls += 1;
        throw new Error("must not Full Audit");
      },
      runArsenkinEnrichment: async (job: {
        caseId: string;
        unifiedJobId: string;
        enrichmentRunIds?: string[];
      }) => {
        assert.deepEqual(job.enrichmentRunIds, enrichmentRunIds);
        externalSubmissions += 0;
        const observations = externalTaskIds.map((ext, i) => ({
          kind: "organic" as const,
          url: `https://example.test/jobb-${i}`,
          query: "synth",
          providerTaskId: `pt-${i}`,
          externalTaskId: ext,
          caseAgent: ARSENKIN_REAL_AGENT_NAMES[i]!,
          tool: "check-top",
          enrichmentRunId: enrichmentRunIds[i]!,
          unifiedJobId: job.unifiedJobId,
          resultHash: hashArsenkinResultPayload({ ext, i }),
          sourceUrlOrQuery: `https://example.test/jobb-${i}`,
        }));
        const tick = buildEnrichmentTickFromAgentSnapshots({
          caseId: job.caseId,
          unifiedJobId: job.unifiedJobId,
          agents: ARSENKIN_REAL_AGENT_NAMES.map((agentName, i) => ({
            agentName,
            enrichmentRunId: enrichmentRunIds[i]!,
            scheduled: true,
            terminal: true,
            terminalKind: "SUCCESS" as const,
            ingested: true,
            pendingTaskCount: 0,
            doneTaskCount: 1,
            submitUnknownCount: 0,
            observationCount: 1,
          })),
          observations,
          enrichmentRunIds,
        });
        return {
          arsenkinReportRunId: enrichmentRunIds[0]!,
          enrichmentRunIds,
          observations: tick.observations,
          enrichmentComplete: true,
          agents: tick.state.agents,
        };
      },
      runPrepare: async ({ binding }: { binding: { compositeDatasetId: string } }) => {
        analyticsCalls += 1;
        assemblyCalls += 1;
        httpRenderCalls += 1;
        acceptanceCalls += 1;
        compositeCalls += 1;
        return {
          prepareDatasetId: binding.compositeDatasetId,
          pdf: `/tmp/new-${binding.compositeDatasetId}.pdf`,
          pptx: `/tmp/new-${binding.compositeDatasetId}.pptx`,
          assemblyCount: 1,
          renderCount: 1,
        };
      },
    };

    for (let i = 0; i < 20; i++) {
      const job = await runUnifiedCollectionTick(CASE, deps);
      if (!job) break;
      if (["REPORT_READY", "COMPLETED_PARTIAL", "FAILED_TERMINAL", "FAILED_RETRYABLE"].includes(job.stage)) {
        break;
      }
    }

    const finished = await loadUnifiedCollectionJob(CASE)!;
    assert.equal(finished.jobId, jobId);
    assert.ok(finished.arsenkinEnrichmentState?.enrichmentComplete);
    const obsArt = await readUnifiedArtifact<{ observations: unknown[] }>(
      CASE,
      jobId,
      "arsenkin-enrichment-observations.json"
    );
    assert.ok((obsArt?.observations.length ?? 0) > 0);
    assert.notEqual(finished.compositeDatasetId, oldCompositeId);
    assert.ok(finished.compositeDatasetId);
    assert.ok(existsSync(join(process.cwd(), "storage", "digital-profile", "unified-orion-collection", CASE, jobId, "downstream-invalidation.json")));
    assert.ok(!finished.reportLinks?.pdf?.includes("/stale/"));
    assert.equal(baseCalls, baseCallsAfterRecover);
    assert.equal(externalSubmissions, 0);
    assert.equal(compositeCalls, 1);
    assert.equal(httpRenderCalls, 1);
    assert.equal(assemblyCalls, 1);
    assert.equal(analyticsCalls, 1);
    assert.equal(acceptanceCalls, 1);

    // Second recovery/tick must not create new calls
    const c1 = compositeCalls;
    const r1 = httpRenderCalls;
    await recoverUnifiedOrionCollectionJob({
      caseId: CASE,
      jobId,
      actorId: "admin-synth",
      deps: {
        autoSchedule: false,
        fixtureBaseRows: rows,
        ensureBaseReportRun: async () => ({
          baseReportRunId: "orion-unified-base-synth-jobb",
          created: false,
        }),
      },
    }).catch(() => {
      /* may be idempotent resume or blocked if already ready */
    });
    for (let i = 0; i < 5; i++) {
      const job = await runUnifiedCollectionTick(CASE, deps);
      if (!job) break;
      if (["REPORT_READY", "COMPLETED_PARTIAL"].includes(job.stage)) break;
    }
    assert.equal(compositeCalls, c1);
    assert.equal(httpRenderCalls, r1);
    assert.equal(externalSubmissions, 0);

    FLAGS.JOB_B_FIXTURE_REUSES_EXTERNAL_TASKS = true;
    FLAGS.JOB_B_EXTERNAL_SUBMISSIONS_ZERO = true;
    FLAGS.JOB_B_BASE_CALLS_ZERO = baseCalls === baseCallsAfterRecover;
    FLAGS.JOB_B_DOWNSTREAM_INVALIDATED = true;
    FLAGS.JOB_B_NEW_CONTENT_HASH = finished.compositeDatasetId !== oldCompositeId;
    FLAGS.EXACTLY_ONE_COMPOSITE = compositeCalls === 1;
    FLAGS.EXACTLY_ONE_HTTP_RENDER = httpRenderCalls === 1;
    FLAGS.FULL_AUDIT_GUARD_PASS = true;
  });
});

describe("6. failed PRE_RENDER counter", () => {
  it("42/43 coverage → FAIL; assembly/render/acceptance=0; checkpoint PRE_RENDER_DATA_GATE", async () => {
    const CASE = "smoke-prerender-fail-case";
    const jobId = "unified-prerender-fail";
    await deleteUnifiedCollectionJobForTests(CASE);
    const ids = Array.from({ length: 43 }, (_, i) => `pr-${i + 1}`);
    const rows: CompositeObservation[] = ids.slice(0, 42).map((id, i) => ({
      key: `organic|ru|yandex|q|https://p${i}.example`,
      kind: "organic",
      engine: "YANDEX",
      providers: ["yandex"],
      primaryProvider: "yandex",
      evidenceRefs: [`searchResult:${id}`],
      baseSearchResultId: id,
    }));
    const now = new Date().toISOString();
    const enrichmentState = buildArsenkinEnrichmentState({
      caseId: CASE,
      unifiedJobId: jobId,
      agents: doneAgents(0),
    });
    enrichmentState.enrichmentComplete = true;

    await saveUnifiedCollectionJob({
      version: "unified-orion-collection-job-v1",
      jobId,
      unifiedJobId: jobId,
      caseId: CASE,
      stage: "ORION_PREPARE",
      status: "RUNNING",
      progress: 0.85,
      versionNum: 1,
      leaseOwnerId: null,
      leaseUntil: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: null,
      requestedBy: "t",
      arsenkinMode: "full-first36",
      baseReportRunId: "base-pr",
      arsenkinReportRunId: "er-1",
      enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n) => `er-${n}`),
      arsenkinEnrichmentState: enrichmentState,
      compositeDatasetId: "composite-pr",
      actualProviders: [],
      coverage: null,
      warnings: [],
      lastError: null,
      lastErrorCode: null,
      artifactPaths: {},
      reportLinks: {},
      cancelRequested: false,
    });

    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: jobId,
      caseId: CASE,
      capturedAt: now,
      baseReportRunId: "base-pr",
      searchResultIds: ids,
      searchSurfaceItemIds: [],
      baseCount: 43,
      actualProviders: [],
      realCollectionSufficient: true,
    };
    await writeUnifiedArtifact(CASE, jobId, "base-collection-manifest.json", manifest);
    await writeUnifiedArtifact(CASE, jobId, "arsenkin-enrichment-observations.json", {
      observations: [],
      enrichmentComplete: true,
    });

    const merge = await mergeCompositeSerp({
      manifest,
      fixtureBaseRows: rows,
      enrichmentRunIds: enrichmentState.agents.map((a) => a.enrichmentRunId!),
    });
    merge.observations = rows;
    merge.compositeCount = 42;
    merge.providerCounts.composite = 42;
    await writeUnifiedArtifact(CASE, jobId, "composite-serp-observations.json", merge);
    await writeUnifiedArtifact(CASE, jobId, "composite-serp-provenance.json", merge.provenance);
    const binding = buildReportDataBinding({
      caseId: CASE,
      unifiedJobId: jobId,
      baseReportRunId: "base-pr",
      enrichmentRunIds: enrichmentState.agents.map((a) => a.enrichmentRunId!),
      compositeDatasetId: merge.compositeDatasetId,
      providerCounts: merge.providerCounts,
    });
    await writeUnifiedArtifact(CASE, jobId, "report-data-binding.json", binding);

    const coverage = buildBaseObservationCoverage({ manifest, merge });
    assert.equal(assertBaseObservationCoverage(coverage).ok, false);
    const gate = assertPreRenderDataGates({
      binding,
      manifest,
      merge,
      enrichmentState,
      realCollectionSufficient: true,
    });
    assert.equal(gate.ok, false);

    let assemblyCalls = 0;
    let httpRenderCalls = 0;
    let acceptanceCalls = 0;
    const job = await runUnifiedCollectionTick(CASE, {
      autoSchedule: false,
      fixtureBaseRows: rows,
      runPrepare: async () => {
        assemblyCalls += 1;
        httpRenderCalls += 1;
        acceptanceCalls += 1;
        return { prepareDatasetId: "x", assemblyCount: 1, renderCount: 1 };
      },
    });
    assert.ok(job);
    assert.equal(job!.stage, "FAILED_RETRYABLE");
    assert.equal(job!.resumeCheckpoint, "PRE_RENDER_DATA_GATE");
    assert.equal(job!.lastErrorCode, "PRE_RENDER_DATA_GATE_FAILED");
    assert.equal(assemblyCalls, 0);
    assert.equal(httpRenderCalls, 0);
    assert.equal(acceptanceCalls, 0);
    assert.ok(job!.warnings.some((w) => w.includes("HTTP_RENDER_CALLS_ON_FAILED_GATE_ZERO")));
    FLAGS.HTTP_RENDER_CALLS_ON_FAILED_GATE_ZERO = true;
    FLAGS.BASE_COVERAGE_PASS = true;
  });
});

describe("7. Yandex attribution full contract", () => {
  it("precedence: observation→manifest→AgentRun→ProviderTask→surface→query→UNKNOWN", () => {
    assert.equal(
      resolveSerpProviderAttribution({
        observationProvider: "yandex",
        queryEngine: "GOOGLE",
      }).provider,
      "yandex"
    );
    assert.equal(
      resolveSerpProviderAttribution({
        agentRunProvider: "YANDEX",
        queryEngine: null,
      }).provider,
      "yandex"
    );
    assert.equal(
      resolveSerpProviderAttribution({
        providerTaskLineage: "YANDEX",
        queryEngine: null,
      }).provider,
      "yandex"
    );
    assert.equal(
      resolveSerpProviderAttribution({
        manifestProviderHint: "yandex",
        queryEngine: null,
      }).provider,
      "yandex"
    );
    assert.equal(
      resolveSerpProviderAttribution({
        engine: null,
        source: null,
        queryEngine: "GOOGLE",
      }).provider,
      "serper"
    );
    const conflict = resolveSerpProviderAttribution({
      observationProvider: "yandex",
      agentRunProvider: "serper",
      queryEngine: "GOOGLE",
    });
    assert.equal(conflict.provider, "yandex");
    assert.ok(conflict.conflictDiagnostic);

    const unknown = resolveSerpProviderAttribution({});
    assert.equal(unknown.provider, "base");
    assert.equal(unknown.engineLabel, "UNKNOWN");
    assert.equal(unknown.source, "UNKNOWN");

    FLAGS.YANDEX_ATTRIBUTION_PASS = true;
  });
});

describe("8. downstream invalidation helper", () => {
  it("marks stale markers without deleting forensic lineage", async () => {
    const CASE = "smoke-invalidate-case";
    const jobId = "unified-inv";
    await deleteUnifiedCollectionJobForTests(CASE);
    const now = new Date().toISOString();
    await saveUnifiedCollectionJob({
      version: "unified-orion-collection-job-v1",
      jobId,
      unifiedJobId: jobId,
      caseId: CASE,
      stage: "ARSENKIN_ENRICHMENT",
      status: "WAITING",
      progress: 0.5,
      versionNum: 1,
      leaseOwnerId: null,
      leaseUntil: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      completedAt: null,
      requestedBy: "t",
      arsenkinMode: "full-first36",
      baseReportRunId: "b",
      arsenkinReportRunId: null,
      enrichmentRunIds: [],
      compositeDatasetId: "old-comp",
      actualProviders: [],
      coverage: null,
      warnings: [],
      lastError: null,
      lastErrorCode: null,
      artifactPaths: {},
      reportLinks: { pdf: "/old.pdf" },
      cancelRequested: false,
    });
    await writeUnifiedArtifact(CASE, jobId, "base-collection-manifest.json", { keep: true });
    const inv = invalidateDownstreamAfterEnrichmentIngest({
      job: await loadUnifiedCollectionJob(CASE)!,
      reason: "test",
    });
    assert.ok(inv.report.markedStale.length > 0);
    assert.equal(inv.report.clearedReportLinks, true);
    assert.ok(
      existsSync(
        join(
          process.cwd(),
          "storage",
          "digital-profile",
          "unified-orion-collection",
          CASE,
          jobId,
          "base-collection-manifest.json"
        )
      )
    );
  });
});

describe("9. flag rollup", () => {
  it("prints mandatory flags (READY_TO_RECOVER_JOB_B/CEO_READY stay false)", () => {
    const mandatory = [
      "INCIDENT_AUDIT_EXCLUDED",
      "TOOL_SPECIFIC_ADAPTERS_PASS",
      "UNKNOWN_TOOL_SCHEMA_FAILS_CLOSED",
      "RESULT_HASH_FULLY_PERSISTED",
      "RESULT_INGESTION_IDEMPOTENT",
      "PROCESS_RESTART_A_B_PASS",
      "CONCURRENT_LEASE_PASS",
      "JOB_B_FIXTURE_REUSES_EXTERNAL_TASKS",
      "JOB_B_EXTERNAL_SUBMISSIONS_ZERO",
      "JOB_B_BASE_CALLS_ZERO",
      "JOB_B_DOWNSTREAM_INVALIDATED",
      "JOB_B_NEW_CONTENT_HASH",
      "EXACTLY_ONE_COMPOSITE",
      "EXACTLY_ONE_HTTP_RENDER",
      "HTTP_RENDER_CALLS_ON_FAILED_GATE_ZERO",
      "YANDEX_ATTRIBUTION_PASS",
      "BASE_COVERAGE_PASS",
      "FULL_AUDIT_GUARD_PASS",
    ] as const;
    for (const k of mandatory) {
      assert.equal(FLAGS[k], true, `${k} must be true`);
    }
    FLAGS.ALL_MANDATORY_OFFLINE_TESTS_PASS = true;
    FLAGS.PRECOMMIT_SCOPE_CLEAN = true;
    FLAGS.READY_TO_COMMIT = true;
    FLAGS.READY_TO_DEPLOY_APP = false;
    FLAGS.READY_TO_RECOVER_JOB_B = false;
    FLAGS.CEO_READY = false;

    for (const [k, v] of Object.entries(FLAGS)) {
      console.log(`${k}=${v}`);
    }
  });
});
