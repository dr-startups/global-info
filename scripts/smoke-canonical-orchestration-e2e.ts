/**
 * B-1 — unified orchestration through the REAL canonical prepare (NETWORK_CALLS=0).
 *
 * Drives the whole unified job (BASE -> ARSENKIN -> COMPOSITE -> ORION_PREPARE
 * -> REPORT_READY) with the default canonical prepare wired in — only the
 * renderer is stubbed. Proves:
 *   - REPORT_READY with report links + job-scoped canonical artifacts;
 *   - exactly one assembly + one render;
 *   - idempotent re-tick after completion;
 *   - restart resume of an in-flight job;
 *   - partial arsenkin -> COMPLETED_PARTIAL (base preserved, still one render);
 *   - disabled canonical prepare -> fail-closed, never legacy;
 *   - missing subject profile -> fail-closed blocker.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-canonical-orchestration-e2e.ts
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import {
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  unifiedArtifactsDir,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  startUnifiedOrionCollection,
  runUnifiedCollectionTick,
} from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import type { CompositeObservation } from "../src/modules/digital-profile/services/composite-serp-merge";
import type { FullAuditResultDTO } from "../src/modules/digital-profile/services/agent-run-service";
import type { ClassifierSubjectProfile } from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { DeckRenderAdapter } from "../src/modules/digital-profile/services/render-deck-artifacts";
import { emptyCoverage, FIRST36_PLANNED_SUPPORTED_SURFACES } from "../src/modules/digital-profile/services/unified-collection-types";

before(async () => {
  process.env.NETWORK_CALLS = "0";
});

function subjectProfile(): ClassifierSubjectProfile {
  return {
    displayName: "Anders Holmström",
    givenNames: ["Anders"],
    familyNames: ["Holmström", "Holmstrom"],
    patronymics: [],
    aliases: ["A. Holmström"],
    transliterations: ["Anders Holmstrom"],
    contextIdentifiers: ["Nordkap Capital", "fintech"],
    namesakeProfiles: [
      { label: "Anders Holmström (goaltender)", noiseTerms: ["hockey", "nhl", "goaltender"] },
    ],
    negativeIdentitySignals: { wrongPatronymics: [], wrongNames: [], unrelatedKnownPersons: [] },
  };
}

let k = 0;
function obs(p: Partial<CompositeObservation> & Pick<CompositeObservation, "kind">): CompositeObservation {
  k += 1;
  return {
    key: `k-${k}-${p.url ?? p.suggestion ?? p.question ?? k}`,
    region: "RU",
    engine: "YANDEX",
    query: "Anders Holmström",
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: [],
    ...p,
  };
}

function fixtureBaseRows(): CompositeObservation[] {
  return [
    obs({ kind: "organic", region: "RU", engine: "YANDEX", url: "https://di.se/probe", title: "Anders Holmström, founder of Nordkap Capital, faces tax-fraud probe", snippet: "Prosecutors opened a tax fraud investigation into Anders Holmström (Nordkap Capital).", riskLabel: "adverse" }),
    obs({ kind: "organic", region: "RU", engine: "YANDEX", url: "https://svd.se/watch", title: "Anders Holmström flagged during sanctions screening watchlist review", snippet: "Watchlist review referenced Anders Holmström, Nordkap Capital." }),
    obs({ kind: "organic", region: "RU", engine: "GOOGLE", providers: ["serper"], primaryProvider: "serper", url: "https://dn.se/malta", title: "Anders Holmström linked to Malta holding and offshore beneficial ownership", snippet: "Filings connect Anders Holmström (Nordkap Capital) to a Malta holding." }),
    obs({ kind: "organic", region: "RU", engine: "YANDEX", url: "https://forbes.com/holmstrom", title: "Anders Holmström, CEO of Nordkap Capital AB — investor profile", snippet: "Profile of Anders Holmström, founder of Nordkap Capital." }),
    obs({ kind: "organic", region: "RU", engine: "GOOGLE", providers: ["serper"], primaryProvider: "serper", url: "https://nhl.com/goalie", title: "Holmström, ice-hockey goaltender, signs with NHL club", snippet: "Goaltender Holmström joins the NHL." }),
    obs({ kind: "suggestion", region: "RU", engine: "YANDEX", suggestion: "Anders Holmström Nordkap fraud", title: "Anders Holmström Nordkap fraud" }),
    obs({ kind: "paa", region: "RU", engine: "GOOGLE", providers: ["serper"], primaryProvider: "serper", question: "Who is Anders Holmström of Nordkap Capital?", title: "Who is Anders Holmström of Nordkap Capital?" }),
    obs({ kind: "organic", region: "UAE", engine: "GOOGLE", providers: ["serper"], primaryProvider: "serper", url: "https://thenationalnews.com/dubai", title: "Anders Holmström expands Nordkap Capital into Dubai real-estate", snippet: "Anders Holmström announced a Dubai real-estate vehicle under Nordkap Capital." }),
    obs({ kind: "organic", region: "UAE", engine: "GOOGLE", providers: ["serper"], primaryProvider: "serper", url: "https://gulfnews.com/pep", title: "Anders Holmström referenced in UAE PEP/RCA compliance screening", snippet: "A UAE compliance database returned a potential PEP/RCA reference to Anders Holmström.", riskLabel: "adverse" }),
    obs({ kind: "suggestion", region: "UAE", engine: "GOOGLE", providers: ["serper"], primaryProvider: "serper", suggestion: "Anders Holmström Dubai Nordkap", title: "Anders Holmström Dubai Nordkap" }),
  ];
}

function mockFullAuditReal(): FullAuditResultDTO {
  return {
    outcome: "SUCCESS",
    runs: [],
    runSummary: [
      { providerId: "yandex", phase: "collection", status: "completed", runtime: "real", agentName: "REAL_YANDEX_SEARCH", reason: "ok" },
      { providerId: "google", phase: "collection", status: "completed", runtime: "real", agentName: "REAL_GOOGLE_SEARCH", reason: "ok" },
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

let renderCount = 0;
const fakeRender: DeckRenderAdapter = async (r) => {
  renderCount += 1;
  return { pageCount: r.deckManifest.pageCount, renderer: "fake" };
};

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    autoSchedule: false as const,
    allowMockReport: false,
    fixtureBaseRows: fixtureBaseRows(),
    runFullAudit: async () => mockFullAuditReal(),
    subjectProfile: subjectProfile(),
    renderDeck: fakeRender,
    runArsenkinEnrichment: async () => ({
      arsenkinReportRunId: "arsenkin-canon-1",
      coverage: {
        ...emptyCoverage(FIRST36_PLANNED_SUPPORTED_SURFACES.length),
        measured: FIRST36_PLANNED_SUPPORTED_SURFACES.length,
        progressRatio: 1,
      },
      observations: [],
      warnings: [],
      partial: false,
    }),
    ...overrides,
  };
}

async function drain(caseId: string, deps: Parameters<typeof runUnifiedCollectionTick>[1], max = 30) {
  for (let i = 0; i < max; i++) {
    const job = await runUnifiedCollectionTick(caseId, deps);
    if (!job) break;
    if (["REPORT_READY", "COMPLETED_PARTIAL", "FAILED_TERMINAL", "CANCELLED"].includes(job.stage)) {
      return job;
    }
  }
  return await loadUnifiedCollectionJob(caseId);
}

describe("B-1 — unified orchestration via canonical prepare", () => {
  it("reaches REPORT_READY with job-scoped canonical artifacts + one render", async () => {
    const caseId = "canon-orch-ready";
    await deleteUnifiedCollectionJobForTests(caseId);
    renderCount = 0;
    const deps = baseDeps();
    await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps });
    const job = await drain(caseId, deps);
    assert.ok(job, "job must exist");
    assert.equal(job!.stage, "REPORT_READY", `stage=${job!.stage} err=${job!.lastError}`);
    assert.equal(renderCount, 1, "exactly one render per completed job");
    const dir = unifiedArtifactsDir(caseId, job!.unifiedJobId);
    assert.ok(existsSync(join(dir, "analytics", "verified-finding-bundle.json")), "analytics artifacts");
    assert.ok(existsSync(join(dir, "deck", "assembled-deck.json")), "deck artifacts");
    assert.ok(existsSync(join(dir, "canonical-prepare-summary.json")), "prepare summary");
    assert.ok(existsSync(join(dir, "subject-identity-profile.json")), "job-scoped subject profile");
  });

  it("idempotent re-tick on a terminal REPORT_READY job is a no-op (no second render)", async () => {
    const caseId = "canon-orch-idem";
    await deleteUnifiedCollectionJobForTests(caseId);
    renderCount = 0;
    const deps = baseDeps();
    await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps });
    const job = await drain(caseId, deps);
    assert.equal(job!.stage, "REPORT_READY");
    assert.equal(renderCount, 1);
    const uid = job!.unifiedJobId;
    // Re-tick the completed job: no stage change, no re-render.
    await runUnifiedCollectionTick(caseId, deps);
    await runUnifiedCollectionTick(caseId, deps);
    const after = await loadUnifiedCollectionJob(caseId);
    assert.equal(after!.stage, "REPORT_READY", "terminal job stays REPORT_READY");
    assert.equal(after!.unifiedJobId, uid, "re-tick does not create a new job");
    assert.equal(renderCount, 1, "no second render on re-tick");
  });

  it("restart resume: a mid-flow job continues to REPORT_READY on the next tick", async () => {
    const caseId = "canon-orch-restart";
    await deleteUnifiedCollectionJobForTests(caseId);
    renderCount = 0;
    const deps = baseDeps();
    await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps });
    // One tick = advance one stage (BASE_COLLECTION -> ARSENKIN_ENRICHMENT).
    await runUnifiedCollectionTick(caseId, deps);
    const mid = await loadUnifiedCollectionJob(caseId);
    assert.ok(mid && mid.stage !== "REPORT_READY", `mid stage=${mid?.stage}`);
    // Simulate restart: brand-new drain loop resumes the persisted job.
    const job = await drain(caseId, deps);
    assert.equal(job!.stage, "REPORT_READY", `stage=${job!.stage} err=${job!.lastError}`);
    assert.equal(renderCount, 1);
  });

  it("partial arsenkin -> COMPLETED_PARTIAL, base preserved, still one render", async () => {
    const caseId = "canon-orch-partial";
    await deleteUnifiedCollectionJobForTests(caseId);
    renderCount = 0;
    const deps = baseDeps({
      runArsenkinEnrichment: async () => ({
        arsenkinReportRunId: null,
        coverage: { ...emptyCoverage(FIRST36_PLANNED_SUPPORTED_SURFACES.length), failedFinal: 3, measured: 5, progressRatio: 1 },
        observations: [],
        warnings: ["arsenkin-failed:offline"],
        partial: true,
      }),
    });
    await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps });
    const job = await drain(caseId, deps);
    assert.equal(job!.stage, "COMPLETED_PARTIAL", `stage=${job!.stage} err=${job!.lastError}`);
    assert.equal(renderCount, 1);
  });
});

describe("B-1 — orchestration fail-closed (never legacy)", () => {
  it("ORION_CANONICAL_PREPARE=0 -> FAILED_TERMINAL CANONICAL_PREPARE_DISABLED", async () => {
    const caseId = "canon-orch-disabled";
    await deleteUnifiedCollectionJobForTests(caseId);
    const prev = process.env.ORION_CANONICAL_PREPARE;
    process.env.ORION_CANONICAL_PREPARE = "0";
    try {
      const deps = baseDeps();
      await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps });
      const job = await drain(caseId, deps);
      assert.equal(job!.stage, "FAILED_TERMINAL");
      assert.equal(job!.lastErrorCode, "CANONICAL_PREPARE_DISABLED");
    } finally {
      if (prev === undefined) delete process.env.ORION_CANONICAL_PREPARE;
      else process.env.ORION_CANONICAL_PREPARE = prev;
    }
  });

  it("missing subject profile -> FAILED_TERMINAL SUBJECT_PROFILE_MISSING", async () => {
    const caseId = "canon-orch-noprofile";
    await deleteUnifiedCollectionJobForTests(caseId);
    const deps = baseDeps({ subjectProfile: null });
    await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps });
    const job = await drain(caseId, deps);
    assert.equal(job!.stage, "FAILED_TERMINAL");
    assert.equal(job!.lastErrorCode, "SUBJECT_PROFILE_MISSING");
  });
});
