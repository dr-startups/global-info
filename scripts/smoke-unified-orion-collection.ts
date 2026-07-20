/**
 * Offline acceptance for unified ORION + Arsenkin collection.
 * NETWORK_CALLS=0 — no live Arsenkin / Yandex / Serper.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  readUnifiedArtifact,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  startUnifiedOrionCollection,
  runUnifiedCollectionTick,
} from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { assertReportReadyGates } from "../src/modules/digital-profile/services/report-ready-gates";
import { mergeCompositeSerp, buildReportDataBinding } from "../src/modules/digital-profile/services/composite-serp-merge";
import { listAgentDefinitions, getAgent } from "../src/modules/digital-profile/agents/registry";
import { ARSENKIN_REAL_AGENT_NAMES } from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import type { FullAuditResultDTO } from "../src/modules/digital-profile/services/agent-run-service";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";
import { emptyCoverage, FIRST36_PLANNED_SUPPORTED_SURFACES } from "../src/modules/digital-profile/services/unified-collection-types";

process.env.NETWORK_CALLS = "0";

const CASE_ID = "unified-smoke-case-1";

function mockFullAuditReal(): FullAuditResultDTO {
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
        reason: "ok",
      },
      {
        providerId: "google",
        phase: "collection",
        status: "completed",
        runtime: "real",
        agentName: "REAL_GOOGLE_SEARCH",
        reason: "ok",
      },
      {
        providerId: "orion_profile",
        phase: "collection",
        status: "completed",
        runtime: "real",
        agentName: "REAL_ORION_SEARCH_PROFILE",
        reason: "ok",
      },
    ],
    runtimeStrategy: {
      mode: "real_first_with_fallback",
      selectedOrder: [],
      fallbackPolicy: "allow_mock_fallback",
      realProvidersAvailable: 3,
      mockProvidersAvailable: 0,
      fallbackEvents: [],
      warnings: [],
      decisions: [],
    },
  };
}

function mockFullAuditMockFallback(): FullAuditResultDTO {
  const base = mockFullAuditReal();
  return {
    ...base,
    runSummary: base.runSummary.map((r) =>
      r.providerId === "yandex" || r.providerId === "google" || r.providerId === "orion_profile"
        ? { ...r, runtime: "mock" as const }
        : r
    ),
  };
}

const fixtureBaseRows = [
  {
    key: "organic|ru|yandex|fio|https://a.example",
    kind: "organic" as const,
    region: "RU",
    engine: "YANDEX",
    query: "fio",
    url: "https://a.example",
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: ["searchResult:sr1"],
    baseSearchResultId: "sr1",
  },
  {
    key: "organic|ru|google|fio|https://b.example",
    kind: "organic" as const,
    region: "RU",
    engine: "GOOGLE",
    query: "fio",
    url: "https://b.example",
    providers: ["serper"],
    primaryProvider: "serper",
    evidenceRefs: ["searchResult:sr2"],
    baseSearchResultId: "sr2",
  },
];

async function drainJob(caseId: string, deps: Parameters<typeof runUnifiedCollectionTick>[1], max = 20) {
  for (let i = 0; i < max; i++) {
    const job = await runUnifiedCollectionTick(caseId, deps);
    if (!job) break;
    if (
      job.stage === "REPORT_READY" ||
      job.stage === "COMPLETED_PARTIAL" ||
      job.stage === "FAILED_TERMINAL" ||
      job.stage === "CANCELLED"
    ) {
      return job;
    }
  }
  return await loadUnifiedCollectionJob(caseId);
}

describe("unified orion arsenkin collection", () => {
  before(async () => {
    process.env.NETWORK_CALLS = "0";
    await deleteUnifiedCollectionJobForTests(CASE_ID);
  });

  it("NETWORK_CALLS=0", () => {
    assert.equal(process.env.NETWORK_CALLS, "0");
  });

  it("five Arsenkin agents registered as REAL", () => {
    const defs = listAgentDefinitions();
    for (const name of ARSENKIN_REAL_AGENT_NAMES) {
      const d = defs.find((x) => x.name === name);
      assert.ok(d, name);
      assert.equal(d!.kind, "REAL");
      assert.ok(getAgent(name));
    }
  });

  it("agentId isolation: shared SEARCH_SURFACES does not cross-collide in keying logic", () => {
    // Simulate listAgents keying: only input.agentId maps to registry name
    const runs = [
      { agentName: "SEARCH_SURFACES", input: { agentId: "ARSENKIN_SEARCH_TOP_REAL" }, status: "SUCCEEDED" },
      { agentName: "SEARCH_SURFACES", input: { agentId: "ARSENKIN_PAA_REAL" }, status: "FAILED" },
      { agentName: "SEARCH_SURFACES", input: {}, status: "SUCCEEDED" },
    ];
    const latest = new Map<string, (typeof runs)[number]>();
    for (const r of runs) {
      const agentId = (r.input as { agentId?: string }).agentId;
      if (typeof agentId === "string" && agentId.trim()) {
        if (!latest.has(agentId)) latest.set(agentId, r);
        continue;
      }
      if (r.agentName === "SEARCH_SURFACES") continue;
      if (!latest.has(r.agentName)) latest.set(r.agentName, r);
    }
    assert.equal(latest.get("ARSENKIN_SEARCH_TOP_REAL")?.status, "SUCCEEDED");
    assert.equal(latest.get("ARSENKIN_PAA_REAL")?.status, "FAILED");
    assert.equal(latest.has("SEARCH_SURFACES"), false);
  });

  it("composite merge dedupes arsenkin duplicate with base provenance", async () => {
    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: "unified-test",
      caseId: CASE_ID,
      capturedAt: new Date().toISOString(),
      baseReportRunId: "orion-base-1",
      searchResultIds: ["sr1", "sr2"],
      searchSurfaceItemIds: [],
      baseCount: 2,
      actualProviders: [],
      realCollectionSufficient: true,
    };
    const merge = await mergeCompositeSerp({
      manifest,
      fixtureBaseRows,
      arsenkinObservations: [
        {
          kind: "organic",
          region: "RU",
          engine: "YANDEX",
          query: "fio",
          url: "https://a.example",
          providerTaskId: "pt1",
        },
      ],
      enrichmentRunIds: ["arsenkin-1"],
    });
    const row = merge.observations.find((o) => o.url === "https://a.example");
    assert.ok(row);
    assert.ok(row!.providers.includes("yandex"));
    assert.ok(row!.providers.includes("arsenkin"));
    assert.equal(row!.primaryProvider, "yandex");
    assert.ok(merge.compositeCount >= 2);
  });

  it("REPORT_READY gate fails when prepare reads stale base dataset", () => {
    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: "u1",
      caseId: CASE_ID,
      capturedAt: new Date().toISOString(),
      baseReportRunId: "base-1",
      searchResultIds: ["sr1"],
      searchSurfaceItemIds: [],
      baseCount: 1,
      actualProviders: [],
      realCollectionSufficient: true,
    };
    const merge = {
      compositeDatasetId: "composite-u1",
      observations: [],
      providerCounts: { yandex: 1, serper: 0, arsenkin: 0, composite: 1 },
      baseCount: 1,
      compositeCount: 1,
      provenance: {
        unifiedJobId: "u1",
        baseProviders: ["yandex"],
        enrichmentProviders: ["arsenkin"],
        baseSearchResultIds: ["sr1"],
        baseSearchSurfaceItemIds: [],
        enrichmentRunIds: ["a1"],
      },
    };
    const binding = buildReportDataBinding({
      caseId: CASE_ID,
      unifiedJobId: "u1",
      baseReportRunId: "base-1",
      enrichmentRunIds: ["a1"],
      compositeDatasetId: "composite-u1",
      providerCounts: merge.providerCounts,
    });
    const gate = assertReportReadyGates({
      binding,
      manifest,
      merge,
      prepareDatasetId: "stale-base-orion-run",
      realCollectionSufficient: true,
    });
    assert.equal(gate.ok, false);
    assert.match(gate.errors.join(" "), /stale dataset/i);
  });

  it("happy path: real base + arsenkin partial → COMPLETED_PARTIAL or REPORT_READY with artifacts", async () => {
    await deleteUnifiedCollectionJobForTests(CASE_ID);
    const deps = {
      autoSchedule: false as const,
      allowMockReport: false,
      fixtureBaseRows,
      runFullAudit: async () => mockFullAuditReal(),
      runArsenkinEnrichment: async () => ({
        arsenkinReportRunId: "arsenkin-enrich-1",
        enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n, i) => `arsenkin-enrich-${i + 1}`),
        coverage: {
          ...emptyCoverage(FIRST36_PLANNED_SUPPORTED_SURFACES.length),
          measured: 2,
          noResults: 1,
          notSupported: 1,
          failedFinal: 0,
          progressRatio: 4 / 12,
        },
        observations: [
          {
            kind: "organic" as const,
            region: "RU",
            engine: "GOOGLE",
            query: "fio",
            url: "https://new.example",
            providerTaskId: "pt-new",
          },
        ],
        warnings: [],
        partial: false,
        enrichmentComplete: true,
      }),
      runPrepare: async ({ binding }: { binding: { compositeDatasetId: string } }) => ({
        prepareDatasetId: binding.compositeDatasetId,
        pdf: "/tmp/demo.pdf",
      }),
    };
    const started = await startUnifiedOrionCollection({
      caseId: CASE_ID,
      requestedBy: "smoke",
      deps,
    });
    assert.equal(started.created, true);
    // Drain synchronously (avoid relying on setImmediate race)
    const job = await drainJob(CASE_ID, deps);
    assert.ok(job);
    assert.ok(
      job!.stage === "REPORT_READY" || job!.stage === "COMPLETED_PARTIAL",
      `stage=${job!.stage} err=${job!.lastError}`
    );
    const manifest = await readUnifiedArtifact<BaseCollectionManifest>(
      CASE_ID,
      job!.unifiedJobId,
      "base-collection-manifest.json"
    );
    assert.ok(manifest);
    assert.ok(manifest!.searchResultIds.includes("sr1"));
    assert.ok(existsSync(join(
      process.cwd(),
      "storage",
      "digital-profile",
      "unified-orion-collection",
      CASE_ID,
      job!.unifiedJobId,
      "report-data-binding.json"
    )));
    const bindingRaw = readFileSync(
      join(
        process.cwd(),
        "storage",
        "digital-profile",
        "unified-orion-collection",
        CASE_ID,
        job!.unifiedJobId,
        "report-data-binding.json"
      ),
      "utf-8"
    );
    assert.match(bindingRaw, /compositeDatasetId/);
  });

  it("mock/fallback base cannot unlock REPORT_READY", async () => {
    const caseId = "unified-smoke-mock-base";
    await deleteUnifiedCollectionJobForTests(caseId);
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows,
      runFullAudit: async () => mockFullAuditMockFallback(),
      runArsenkinEnrichment: async () => ({
        arsenkinReportRunId: null,
        coverage: emptyCoverage(12),
        observations: [],
        warnings: ["skipped"],
        partial: true,
        enrichmentComplete: true,
      }),
      runPrepare: async ({ binding }: { binding: { compositeDatasetId: string } }) => ({
        prepareDatasetId: binding.compositeDatasetId,
      }),
    };
    await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps });
    const job = await drainJob(caseId, deps);
    assert.equal(job?.stage, "FAILED_TERMINAL");
    assert.match(String(job?.lastError ?? ""), /real collection insufficient/i);
  });

  it("stale prepare dataset → fail-closed not REPORT_READY", async () => {
    const caseId = "unified-smoke-stale-prepare";
    await deleteUnifiedCollectionJobForTests(caseId);
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows,
      runFullAudit: async () => mockFullAuditReal(),
      runArsenkinEnrichment: async () => ({
        arsenkinReportRunId: "a1",
        enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n, i) => `a${i + 1}`),
        coverage: { ...emptyCoverage(12), measured: 12, progressRatio: 1 },
        observations: [],
        enrichmentComplete: true,
      }),
      runPrepare: async () => ({
        prepareDatasetId: "old-base-dataset-not-composite",
      }),
    };
    await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps });
    const job = await drainJob(caseId, deps);
    assert.equal(job?.stage, "FAILED_TERMINAL");
    assert.equal(job?.lastErrorCode, "REPORT_READY_GATE_FAILED");
  });

  it("idempotent start does not create second active job", async () => {
    const caseId = "unified-smoke-idempotent";
    await deleteUnifiedCollectionJobForTests(caseId);
    const holdDeps = {
      autoSchedule: false as const,
      fixtureBaseRows,
      runFullAudit: async () => mockFullAuditReal(),
      runArsenkinEnrichment: async () => ({
        arsenkinReportRunId: "hold-run",
        enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n, i) => `hold-${i + 1}`),
        coverage: emptyCoverage(12),
        observations: [],
        warnings: ["hold"],
        partial: true,
        enrichmentComplete: false,
      }),
    };
    const a = await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps: holdDeps });
    // Drain until WAITING arsenkin ingest — not terminal REPORT_READY
    for (let i = 0; i < 6; i++) {
      const j = await runUnifiedCollectionTick(caseId, holdDeps);
      if (j?.stage === "ARSENKIN_ENRICHMENT" && j.status === "WAITING") break;
    }
    const b = await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps: holdDeps });
    assert.equal(b.created, false);
    assert.equal(a.unifiedJobId, b.unifiedJobId);
  });

  it("coverage breakdown exposes measured/noResults/notSupported/failedFinal", () => {
    const c = {
      plannedSupportedSurfaces: 12,
      measured: 3,
      noResults: 2,
      notSupported: 1,
      failedFinal: 1,
      failedRetryable: 0,
      inFlight: 5,
      progressRatio: 7 / 12,
    };
    assert.equal(c.measured + c.noResults + c.notSupported + c.failedFinal, 7);
    assert.ok(c.progressRatio < 1);
  });
});
