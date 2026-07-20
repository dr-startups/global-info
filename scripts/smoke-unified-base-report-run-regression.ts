/**
 * Offline regression for Deripaska live E2E linkage defects:
 *   - baseReportRunId must be persisted after base collection;
 *   - Yandex provenance must not collapse to yandex:0;
 *   - missing baseReportRunId fail-closes before composite (FAILED_RETRYABLE);
 *   - five Arsenkin agents planned exactly once;
 *   - resume does not re-run base providers;
 *   - sparse subject assembles executive/risk empty-valid pages.
 *
 * NETWORK_CALLS=0 npx tsx --test scripts/smoke-unified-base-report-run-regression.ts
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import {
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  readUnifiedArtifact,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  startUnifiedOrionCollection,
  runUnifiedCollectionTick,
} from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import type { CompositeObservation } from "../src/modules/digital-profile/services/composite-serp-merge";
import { mergeCompositeSerp } from "../src/modules/digital-profile/services/composite-serp-merge";
import { normalizeSerpProviderBucket } from "../src/modules/digital-profile/services/unified-base-report-run";
import type { FullAuditResultDTO } from "../src/modules/digital-profile/services/agent-run-service";
import type { ClassifierSubjectProfile } from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { DeckRenderAdapter } from "../src/modules/digital-profile/services/render-deck-artifacts";
import {
  emptyCoverage,
  FIRST36_PLANNED_SUPPORTED_SURFACES,
  type BaseCollectionManifest,
} from "../src/modules/digital-profile/services/unified-collection-types";
import { buildRiskMatrixFragment } from "../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders";
import { ARSENKIN_REAL_AGENT_NAMES } from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";

before(async () => {
  process.env.NETWORK_CALLS = "0";
});

function subjectProfile(): ClassifierSubjectProfile {
  return {
    displayName: "Дерипаска Олег Владимирович",
    givenNames: ["Олег"],
    familyNames: ["Дерипаска"],
    patronymics: ["Владимирович"],
    aliases: ["Дерипаска"],
    transliterations: ["Deripaska Oleg"],
    contextIdentifiers: [],
    namesakeProfiles: [],
    negativeIdentitySignals: { wrongPatronymics: [], wrongNames: [], unrelatedKnownPersons: [] },
  };
}

let k = 0;
function obs(p: Partial<CompositeObservation> & Pick<CompositeObservation, "kind">): CompositeObservation {
  k += 1;
  return {
    key: `k-${k}`,
    region: "RU",
    engine: "YANDEX",
    query: "Дерипаска",
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: [`searchResult:sr-${k}`],
    baseSearchResultId: `sr-${k}`,
    ...p,
  };
}

function fixtureBaseRows(): CompositeObservation[] {
  return [
    obs({ kind: "organic", engine: "YANDEX", url: "https://example.com/a", title: "Yandex hit A" }),
    obs({ kind: "organic", engine: "YANDEX", url: "https://example.com/b", title: "Yandex hit B" }),
    obs({ kind: "organic", engine: "YANDEX", url: "https://example.com/c", title: "Yandex hit C" }),
    obs({
      kind: "organic",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      url: "https://example.com/g",
      title: "Google hit",
    }),
    obs({
      kind: "suggestion",
      engine: "yandex",
      providers: ["yandex"],
      primaryProvider: "yandex",
      suggestion: "дерипаска новости",
      title: "дерипаска новости",
      baseSearchSurfaceItemId: "surf-1",
    }),
  ];
}

function mockFullAudit(): FullAuditResultDTO {
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
        providerId: "wikipedia",
        phase: "collection",
        status: "completed",
        runtime: "real",
        agentName: "REAL_WIKIPEDIA",
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

const fakeRender: DeckRenderAdapter = async (r) => ({
  pageCount: r.deckManifest.pageCount,
  renderer: "fake",
});

async function drain(caseId: string, deps: Parameters<typeof runUnifiedCollectionTick>[1], max = 40) {
  for (let i = 0; i < max; i++) {
    const job = await runUnifiedCollectionTick(caseId, deps);
    if (!job) break;
    if (
      ["REPORT_READY", "COMPLETED_PARTIAL", "FAILED_TERMINAL", "FAILED_RETRYABLE", "CANCELLED"].includes(
        job.stage
      )
    ) {
      return job;
    }
  }
  return await loadUnifiedCollectionJob(caseId);
}

describe("unified baseReportRun + Yandex provenance regression", () => {
  it("normalizeSerpProviderBucket accepts lowercase yandex surfaces", () => {
    assert.equal(normalizeSerpProviderBucket("yandex"), "yandex");
    assert.equal(normalizeSerpProviderBucket("YANDEX"), "yandex");
    assert.equal(normalizeSerpProviderBucket("google"), "serper");
    assert.equal(normalizeSerpProviderBucket("SERPER"), "serper");
  });

  it("fixture merge counts Yandex organics (not yandex:0)", async () => {
    const rows = fixtureBaseRows();
    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: "uj-prov",
      caseId: "case-prov",
      capturedAt: new Date().toISOString(),
      baseReportRunId: "base-1",
      searchResultIds: rows.map((r) => r.baseSearchResultId!).filter(Boolean),
      searchSurfaceItemIds: rows
        .map((r) => r.baseSearchSurfaceItemId)
        .filter((x): x is string => Boolean(x)),
      baseCount: rows.length,
      actualProviders: [],
      realCollectionSufficient: true,
    };
    const merge = await mergeCompositeSerp({
      prisma: null,
      manifest,
      enrichmentRunIds: [],
      arsenkinObservations: [],
      fixtureBaseRows: rows,
    });
    assert.ok(merge.providerCounts.yandex >= 3, `yandex=${merge.providerCounts.yandex}`);
    assert.ok(merge.providerCounts.composite >= rows.length);
    assert.ok(merge.providerCounts.composite >= merge.providerCounts.yandex);
  });

  it("persists baseReportRunId and schedules five Arsenkin agents once", async () => {
    const caseId = "deripaska-base-run-fix";
    await deleteUnifiedCollectionJobForTests(caseId);
    let arsenkinCalls = 0;
    let baseCalls = 0;
    const deps = {
      autoSchedule: false as const,
      allowMockReport: false,
      fixtureBaseRows: fixtureBaseRows(),
      subjectProfile: subjectProfile(),
      renderDeck: fakeRender,
      runFullAudit: async () => {
        baseCalls += 1;
        return mockFullAudit();
      },
      runArsenkinEnrichment: async (job: { baseReportRunId: string | null }) => {
        arsenkinCalls += 1;
        assert.ok(job.baseReportRunId, "baseReportRunId required before Arsenkin");
        const enrichmentRunIds = ARSENKIN_REAL_AGENT_NAMES.map(
          (n, i) => `enr-${n}-${i + 1}`
        );
        return {
          arsenkinReportRunId: enrichmentRunIds[0]!,
          enrichmentRunIds,
          coverage: {
            ...emptyCoverage(FIRST36_PLANNED_SUPPORTED_SURFACES.length),
            measured: FIRST36_PLANNED_SUPPORTED_SURFACES.length,
            progressRatio: 1,
          },
          observations: [],
          warnings: ["arsenkin-five-agents-planned"],
          partial: false,
        };
      },
    };
    await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps });
    const job = await drain(caseId, deps);
    assert.ok(job);
    assert.ok(job!.baseReportRunId, "baseReportRunId persisted");
    assert.equal(job!.stage, "REPORT_READY", `stage=${job!.stage} err=${job!.lastError}`);
    assert.equal(arsenkinCalls, 1, "Arsenkin scheduled exactly once");
    assert.equal(baseCalls, 1, "base providers collected once");
    const enrichment = await readUnifiedArtifact<{ enrichmentRunIds?: string[] }>(
      caseId,
      job!.unifiedJobId,
      "arsenkin-enrichment-observations.json"
    );
    assert.equal(enrichment?.enrichmentRunIds?.length, 5);
    const binding = await readUnifiedArtifact<{ providerCounts: { yandex: number; composite: number } }>(
      caseId,
      job!.unifiedJobId,
      "report-data-binding.json"
    );
    assert.ok((binding?.providerCounts.yandex ?? 0) >= 3);
    assert.ok((binding?.providerCounts.composite ?? 0) >= (binding?.providerCounts.yandex ?? 0));
  });

  it("missing baseReportRunId fail-closes as FAILED_RETRYABLE (no silent Arsenkin skip)", async () => {
    const caseId = "deripaska-no-base-id";
    await deleteUnifiedCollectionJobForTests(caseId);
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows: fixtureBaseRows(),
      subjectProfile: subjectProfile(),
      renderDeck: fakeRender,
      runFullAudit: async () => mockFullAudit(),
      runArsenkinEnrichment: async () => {
        throw new Error("must not reach arsenkin enrichment when base id cleared");
      },
    };
    await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps });
    // Advance BASE_COLLECTION once…
    await runUnifiedCollectionTick(caseId, deps);
    let job = await loadUnifiedCollectionJob(caseId);
    assert.ok(job?.baseReportRunId);
    // Simulate the live defect: wipe baseReportRunId before Arsenkin.
    await patchUnifiedCollectionJob(caseId, { baseReportRunId: null });
    job = await runUnifiedCollectionTick(caseId, deps);
    assert.equal(job?.stage, "FAILED_RETRYABLE");
    assert.equal(job?.lastErrorCode, "BASE_REPORT_RUN_MISSING");
    assert.equal(job?.status, "WAITING");
  });

  it("resume from FAILED_RETRYABLE does not re-run base providers", async () => {
    const caseId = "deripaska-resume-no-recollect";
    await deleteUnifiedCollectionJobForTests(caseId);
    let baseCalls = 0;
    let arsenkinCalls = 0;
    const { recoverUnifiedOrionCollectionJob } = await import(
      "../src/modules/digital-profile/services/unified-collection-recovery"
    );
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows: fixtureBaseRows(),
      subjectProfile: subjectProfile(),
      renderDeck: fakeRender,
      runFullAudit: async () => {
        baseCalls += 1;
        return mockFullAudit();
      },
      runArsenkinEnrichment: async (job: { baseReportRunId: string | null }) => {
        arsenkinCalls += 1;
        assert.ok(job.baseReportRunId);
        const enrichmentRunIds = ARSENKIN_REAL_AGENT_NAMES.map((n, i) => `enr2-${n}-${i}`);
        return {
          arsenkinReportRunId: enrichmentRunIds[0]!,
          enrichmentRunIds,
          coverage: {
            ...emptyCoverage(FIRST36_PLANNED_SUPPORTED_SURFACES.length),
            measured: FIRST36_PLANNED_SUPPORTED_SURFACES.length,
            progressRatio: 1,
          },
          observations: [],
          warnings: [],
          partial: false,
        };
      },
    };
    await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps });
    await runUnifiedCollectionTick(caseId, deps); // BASE -> ARSENKIN
    assert.equal(baseCalls, 1);
    await patchUnifiedCollectionJob(caseId, {
      baseReportRunId: null,
      stage: "ARSENKIN_ENRICHMENT",
      status: "RUNNING",
    });
    let job = await runUnifiedCollectionTick(caseId, deps);
    assert.equal(job?.stage, "FAILED_RETRYABLE");
    // Staff recover endpoint (no base recollect).
    await recoverUnifiedOrionCollectionJob({
      caseId,
      jobId: job!.jobId,
      actorId: "smoke",
      deps: { autoSchedule: false, fixtureBaseRows: fixtureBaseRows() },
    });
    job = await drain(caseId, deps);
    assert.equal(job?.stage, "REPORT_READY", `stage=${job?.stage} err=${job?.lastError}`);
    assert.equal(baseCalls, 1, "base must not be recollected on resume");
    assert.equal(arsenkinCalls, 1, "Arsenkin runs once after resume");
  });

  it("sparse risk matrix emits READY empty-valid page (not assembly-blocking INSUFFICIENT_DATA)", () => {
    const out = buildRiskMatrixFragment("EXECUTIVE", {
      findings: [],
      surfaceUnits: [],
      metricSnapshot: {
        metricSnapshotId: "m1",
        datasetId: "d1",
        reportRunId: "r1",
        baseCount: 5,
        enrichmentCount: 0,
        compositeCount: 5,
        subjectMatchCount: 0,
        likelySubjectCount: 0,
        ambiguousCount: 0,
        otherSubjectCount: 0,
        adverseFindingCount: 0,
        perRegionCounts: { RU: 5 },
      },
      evidenceIndex: {},
      subject: {
        displayName: "Дерипаска Олег Владимирович",
        givenNames: ["Олег"],
        familyNames: ["Дерипаска"],
      },
      scope: { regions: null, surfaces: null },
    });
    assert.equal(out.status, "READY");
    assert.ok(out.slides.length >= 1);
    assert.equal(out.emptyStateReason, "no-verified-findings");
  });
});
