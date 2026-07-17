/**
 * Arsenkin transfer → canonical binding → regenerate/render reportRunId regression.
 * NETWORK_CALLS must stay 0. No live Arsenkin API.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  assertArsenkinTransferredClientContent,
  loadArsenkinReportBinding,
  resolveEffectiveReportRunIdForCase,
  saveArsenkinReportBinding,
  type ArsenkinReportBinding,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-report-binding";
import {
  caseScopedArtifactRoot,
  ORION_GOLDEN_QA_STORAGE_ROOT,
} from "../src/modules/digital-profile/orion-golden/evidence/admin-review-decision-store";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";
import { writeJsonAtomic } from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import {
  saveArsenkinUiRunMapping,
  syncArsenkinResultsToOrion,
  type ArsenkinUiOrchestrationDeps,
} from "../src/modules/digital-profile/services/arsenkin-ui-orchestration-service";
import {
  findOrCreateUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  loadUnifiedCollectionJob,
  deleteUnifiedCollectionJobForTests,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import { ConflictError } from "../src/modules/digital-profile/http/errors";

const CASE_ID = "cmreamy2t0002o30f29urzcog-xfer-test";
const SOURCE_RUN = "orion-r10-1783705193806";
const ARSENKIN_RUN = "orion-arsenkin-suggest-canary-1784052644782-08903825";
const FOREIGN_CASE = "foreign-case-other";
const ART = join(process.cwd(), "storage", "digital-profile", "qa-arsenkin-transfer-binding");

type FakeState = {
  run: { id: string; caseId: string; status: string; metadataJson: unknown } | null;
  stages: Array<{
    reportRunId: string;
    stage: string;
    status: string;
    planDigest: string | null;
    errorJson: unknown;
    updatedAt: Date;
  }>;
  observations: Array<{
    id: string;
    auditRunId: string;
    provider: string;
    providerTaskId: string | null;
    surface: string;
    engine: string;
    region: string;
  }>;
  providerTaskCount: number;
  coverageCount: number;
};

function makeFakePrisma(state: FakeState) {
  return {
    orionReportRun: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.run && state.run.id === where.id ? state.run : null,
      findFirst: async ({ where }: { where: { caseId: string } }) =>
        state.run && state.run.caseId === where.caseId ? state.run : null,
    },
    orionArsenkinStageRun: {
      findMany: async ({ where }: { where: { reportRunId: string } }) =>
        state.stages.filter((s) => s.reportRunId === where.reportRunId),
      findFirst: async ({
        where,
      }: {
        where: { reportRunId: string; stage?: string };
      }) =>
        state.stages.find(
          (s) =>
            s.reportRunId === where.reportRunId &&
            (!where.stage || s.stage === where.stage)
        ) ?? null,
    },
    providerTask: {
      count: async () => state.providerTaskCount,
    },
    serpObservation: {
      count: async () => state.observations.length,
      findMany: async ({
        where,
      }: {
        where: { auditRunId: string; provider: string };
      }) =>
        state.observations.filter(
          (o) => o.auditRunId === where.auditRunId && o.provider === where.provider
        ),
    },
    surfaceCollectionCoverage: {
      count: async () => state.coverageCount,
    },
  } as unknown as ArsenkinUiOrchestrationDeps["prisma"];
}

function make18Observations(auditRunId: string) {
  const out: FakeState["observations"] = [];
  for (let i = 0; i < 9; i++) {
    out.push({
      id: `yandex-obs-${i}`,
      auditRunId,
      provider: "arsenkin",
      providerTaskId: "task-yandex",
      surface: "autocomplete",
      engine: "YANDEX",
      region: "RU",
    });
  }
  for (let i = 0; i < 9; i++) {
    out.push({
      id: `google-obs-${i}`,
      auditRunId,
      provider: "arsenkin",
      providerTaskId: "task-google",
      surface: "autocomplete",
      engine: "GOOGLE",
      region: "RU",
    });
  }
  return out;
}

function writeRebuildArtifacts(
  caseId: string,
  reportRunId: string,
  out: string,
  observationCount: number
): void {
  mkdirSync(out, { recursive: true });
  writeJsonAtomic(join(out, "orion-client-content.post-review.json"), {
    caseId,
    reportRunId,
    approvedFindings: [],
  });
  writeJsonAtomic(join(out, "orion-client-content.pre-review.json"), {
    caseId,
    reportRunId,
    approvedFindings: [],
  });
  writeJsonAtomic(join(out, "client-content-binding.json"), {
    sourceReportRunId: SOURCE_RUN,
    effectiveReportRunId: reportRunId,
    overridden: false,
  });
  writeJsonAtomic(join(out, "manual-review-queue.json"), {
    caseId,
    reportRunId,
    items: [{ evidenceId: "ev-keep" }],
  });
  writeJsonAtomic(join(out, "run-scoped-serp-merge.json"), {
    auditRunId: reportRunId,
    usedRunScoped: true,
    observationCount,
  });
  writeJsonAtomic(join(out, "full-evidence-inventory.json"), {
    caseId,
    reportRunId,
    subject: { fullName: "Test", aliases: [] },
  });
  writeJsonAtomic(join(out, "report-assets.json"), {
    assets: [
      {
        assetRef: "ru_suggestions_yandex",
        caption: "Yandex suggest via Arsenkin",
        evidenceRefs: ["serp_observation:yandex-obs-0"],
      },
      {
        assetRef: "ru_suggestions_google",
        caption: "Google suggest via Arsenkin",
        evidenceRefs: ["serp_observation:google-obs-0"],
      },
    ],
  });
  writeJsonAtomic(join(out, "final-deck-manifest.json"), {
    slides: [
      {
        pageNumber: 11,
        assetRefs: ["ru_suggestions_yandex"],
        evidenceRefs: ["serp_observation:yandex-obs-0"],
      },
      {
        pageNumber: 12,
        assetRefs: ["ru_suggestions_google"],
        evidenceRefs: ["serp_observation:google-obs-0"],
      },
    ],
  });
}

function depsFor(state: FakeState): ArsenkinUiOrchestrationDeps {
  return {
    prisma: makeFakePrisma(state),
    readinessBlockers: () => [],
    isConfigured: () => true,
    rebuild: async (c, r, out, opts) => {
      writeRebuildArtifacts(c, r, out, state.observations.length);
      if (opts?.sourceReportRunId) {
        writeJsonAtomic(join(out, "client-content-binding.json"), {
          sourceReportRunId: opts.sourceReportRunId,
          effectiveReportRunId: r,
          overridden: false,
          rebuilt: true,
        });
      }
      return { caseId: c, reportRunId: r, outputRoot: out };
    },
  };
}

function seedMapping(caseId = CASE_ID): void {
  saveArsenkinUiRunMapping({
    caseId,
    sourceReportRunId: SOURCE_RUN,
    arsenkinReportRunId: ARSENKIN_RUN,
    workflow: "suggest-canary",
    stage: "SUGGEST_RU_CANARY",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

function seedCaseRootLegacy(): void {
  const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, CASE_ID);
  mkdirSync(caseRoot, { recursive: true });
  writeJsonAtomic(join(caseRoot, "full-evidence-inventory.json"), {
    caseId: CASE_ID,
    reportRunId: SOURCE_RUN,
    subject: { fullName: "Test", aliases: [] },
  });
  writeJsonAtomic(join(caseRoot, "orion-client-content.post-review.json"), {
    caseId: CASE_ID,
    reportRunId: SOURCE_RUN,
    approvedFindings: [],
  });
  writeJsonAtomic(join(caseRoot, "admin-review-decisions.json"), {
    version: "r10-5-admin-review-decisions-v1",
    caseId: CASE_ID,
    generatedAt: new Date().toISOString(),
    qaSampleOnly: false,
    decisions: [
      {
        evidenceId: "ev-keep",
        status: "APPROVED",
        reviewedAt: new Date().toISOString(),
      },
    ],
  });
}

describe("arsenkin-transfer-binding", () => {
  mkdirSync(ART, { recursive: true });

  it("1 successful transfer writes canonical binding + arsenkin client content", async () => {
    resetArsenkinNetworkCallCount();
    rmSync(caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, CASE_ID), {
      recursive: true,
      force: true,
    });
    seedCaseRootLegacy();
    seedMapping();
    const state: FakeState = {
      run: {
        id: ARSENKIN_RUN,
        caseId: CASE_ID,
        status: "DONE",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [
        {
          reportRunId: ARSENKIN_RUN,
          stage: "SUGGEST_RU_CANARY",
          status: "DONE",
          planDigest: "d1",
          errorJson: null,
          updatedAt: new Date(),
        },
      ],
      observations: make18Observations(ARSENKIN_RUN),
      providerTaskCount: 2,
      coverageCount: 2,
    };

    const result = await syncArsenkinResultsToOrion({
      caseId: CASE_ID,
      reportRunId: SOURCE_RUN,
      stage: "SUGGEST_RU_CANARY",
      deps: depsFor(state),
    });

    assert.equal(result.status, "TRANSFERRED");
    assert.equal(result.synced, true);
    assert.equal(getArsenkinNetworkCallCount(), 0);

    const binding = loadArsenkinReportBinding(CASE_ID);
    assert.ok(binding);
    assert.equal(binding!.sourceReportRunId, SOURCE_RUN);
    assert.equal(binding!.effectiveReportRunId, ARSENKIN_RUN);
    assert.equal(binding!.status, "TRANSFERRED");
    assert.equal(binding!.provider, "arsenkin");
    assert.equal(binding!.observationCount, 18);
    assert.equal(binding!.providerTaskCount, 2);
    assert.equal(binding!.coverageCount, 2);

    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, CASE_ID);
    const post = JSON.parse(
      readFileSync(join(caseRoot, "orion-client-content.post-review.json"), "utf-8")
    ) as { reportRunId: string };
    assert.equal(post.reportRunId, ARSENKIN_RUN);

    const clientBinding = JSON.parse(
      readFileSync(join(caseRoot, "client-content-binding.json"), "utf-8")
    ) as { sourceReportRunId: string; effectiveReportRunId: string; overridden: boolean };
    assert.equal(clientBinding.sourceReportRunId, SOURCE_RUN);
    assert.equal(clientBinding.effectiveReportRunId, ARSENKIN_RUN);
    assert.equal(clientBinding.overridden, false);

    const inventory = JSON.parse(
      readFileSync(join(caseRoot, "full-evidence-inventory.json"), "utf-8")
    ) as { reportRunId: string };
    assert.equal(inventory.reportRunId, ARSENKIN_RUN);

    const resolved = resolveEffectiveReportRunIdForCase(CASE_ID, SOURCE_RUN);
    assert.equal(resolved.fromArsenkinBinding, true);
    assert.equal(resolved.reportRunId, ARSENKIN_RUN);
  });

  it("2 no silent fallback when TRANSFERRED but observations missing", () => {
    resetArsenkinNetworkCallCount();
    const binding: ArsenkinReportBinding = {
      caseId: CASE_ID,
      sourceReportRunId: SOURCE_RUN,
      effectiveReportRunId: ARSENKIN_RUN,
      provider: "arsenkin",
      workflow: "suggest-canary",
      stage: "SUGGEST_RU_CANARY",
      status: "TRANSFERRED",
      transferredAt: new Date().toISOString(),
      providerTaskCount: 2,
      observationCount: 18,
      coverageCount: 2,
    };
    const gate = assertArsenkinTransferredClientContent({
      caseId: CASE_ID,
      clientContentReportRunId: SOURCE_RUN,
      binding,
      observationCount: 0,
      providerTaskCount: 2,
      coverageCount: 2,
    });
    assert.equal(gate.ok, false);
    if (!gate.ok) {
      assert.ok(gate.issues.some((i) => i.code === "ARSENKIN_CLIENT_CONTENT_RUN_MISMATCH"));
      assert.ok(gate.issues.some((i) => i.code === "ARSENKIN_OBSERVATIONS_MISSING"));
    }
    assert.equal(getArsenkinNetworkCallCount(), 0);
    const resolved = resolveEffectiveReportRunIdForCase(CASE_ID, SOURCE_RUN);
    assert.equal(resolved.reportRunId, ARSENKIN_RUN);
    assert.notEqual(resolved.reportRunId, SOURCE_RUN);
  });

  it("3 foreign Arsenkin run is blocked and client content unchanged", async () => {
    resetArsenkinNetworkCallCount();
    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, CASE_ID);
    const before = readFileSync(join(caseRoot, "orion-client-content.post-review.json"), "utf-8");
    const state: FakeState = {
      run: {
        id: ARSENKIN_RUN,
        caseId: FOREIGN_CASE,
        status: "DONE",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [
        {
          reportRunId: ARSENKIN_RUN,
          stage: "SUGGEST_RU_CANARY",
          status: "DONE",
          planDigest: "d1",
          errorJson: null,
          updatedAt: new Date(),
        },
      ],
      observations: make18Observations(ARSENKIN_RUN),
      providerTaskCount: 2,
      coverageCount: 2,
    };
    await assert.rejects(
      () =>
        syncArsenkinResultsToOrion({
          caseId: CASE_ID,
          reportRunId: SOURCE_RUN,
          stage: "SUGGEST_RU_CANARY",
          deps: depsFor(state),
        }),
      (e: unknown) => e instanceof ConflictError && /не принадлежит/i.test(String(e.message))
    );
    assert.equal(
      readFileSync(join(caseRoot, "orion-client-content.post-review.json"), "utf-8"),
      before
    );
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("4 idempotent replay of same arsenkin run", async () => {
    resetArsenkinNetworkCallCount();
    seedMapping();
    // Force a fresh transfer path once, then replay.
    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, CASE_ID);
    rmSync(join(caseRoot, "arsenkin-report-binding.json"), { force: true });
    writeJsonAtomic(join(caseRoot, "orion-client-content.post-review.json"), {
      caseId: CASE_ID,
      reportRunId: SOURCE_RUN,
      approvedFindings: [],
    });
    const state: FakeState = {
      run: {
        id: ARSENKIN_RUN,
        caseId: CASE_ID,
        status: "DONE",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [
        {
          reportRunId: ARSENKIN_RUN,
          stage: "SUGGEST_RU_CANARY",
          status: "DONE",
          planDigest: "d1",
          errorJson: null,
          updatedAt: new Date(),
        },
      ],
      observations: make18Observations(ARSENKIN_RUN),
      providerTaskCount: 2,
      coverageCount: 2,
    };
    let rebuildCalls = 0;
    const deps: ArsenkinUiOrchestrationDeps = {
      ...depsFor(state),
      rebuild: async (c, r, out, opts) => {
        rebuildCalls += 1;
        writeRebuildArtifacts(c, r, out, 18);
        if (opts?.sourceReportRunId) {
          writeJsonAtomic(join(out, "client-content-binding.json"), {
            sourceReportRunId: opts.sourceReportRunId,
            effectiveReportRunId: r,
            overridden: false,
          });
        }
        return { caseId: c, reportRunId: r, outputRoot: out };
      },
    };
    const first = await syncArsenkinResultsToOrion({
      caseId: CASE_ID,
      reportRunId: SOURCE_RUN,
      stage: "SUGGEST_RU_CANARY",
      deps,
    });
    const bindingBefore = loadArsenkinReportBinding(CASE_ID)!;
    const digestBefore = JSON.stringify(bindingBefore);
    const second = await syncArsenkinResultsToOrion({
      caseId: CASE_ID,
      reportRunId: SOURCE_RUN,
      stage: "SUGGEST_RU_CANARY",
      deps,
    });
    assert.equal(first.status, "TRANSFERRED");
    assert.equal(second.status, "TRANSFERRED");
    assert.equal(rebuildCalls, 1, "second sync must be idempotent (no rebuild)");
    assert.equal(JSON.stringify(loadArsenkinReportBinding(CASE_ID)), digestBefore);
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("5 assets provenance fixtures for 18 observations", () => {
    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, CASE_ID);
    const assets = JSON.parse(readFileSync(join(caseRoot, "report-assets.json"), "utf-8")) as {
      assets: Array<{ assetRef: string; caption: string; evidenceRefs: string[] }>;
    };
    const yandex = assets.assets.find((a) => a.assetRef === "ru_suggestions_yandex");
    const google = assets.assets.find((a) => a.assetRef === "ru_suggestions_google");
    assert.ok(yandex);
    assert.ok(google);
    assert.match(yandex!.caption, /Arsenkin/i);
    assert.match(google!.caption, /Arsenkin/i);
    assert.ok(yandex!.evidenceRefs.some((r) => r.startsWith("serp_observation:")));
    assert.ok(google!.evidenceRefs.some((r) => r.startsWith("serp_observation:")));
    const deck = JSON.parse(readFileSync(join(caseRoot, "final-deck-manifest.json"), "utf-8")) as {
      slides: Array<{ pageNumber: number; assetRefs: string[]; evidenceRefs: string[] }>;
    };
    const p11 = deck.slides.find((s) => s.pageNumber === 11);
    const p12 = deck.slides.find((s) => s.pageNumber === 12);
    assert.ok(p11?.assetRefs.includes("ru_suggestions_yandex"));
    assert.ok(p12?.assetRefs.includes("ru_suggestions_google"));
    assert.ok(p11?.evidenceRefs.some((r) => r.startsWith("serp_observation:")));
    assert.ok(p12?.evidenceRefs.some((r) => r.startsWith("serp_observation:")));
  });

  it("6 generic rebuild resolution keeps arsenkin effective run", () => {
    const resolved = resolveEffectiveReportRunIdForCase(CASE_ID, SOURCE_RUN);
    assert.equal(resolved.reportRunId, ARSENKIN_RUN);
    assert.equal(resolved.fromArsenkinBinding, true);
    assert.notEqual(resolved.reportRunId, SOURCE_RUN);
  });

  it("7 legacy case without transfer keeps inventory run", () => {
    const legacyCase = `${CASE_ID}-legacy`;
    const legacyRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, legacyCase);
    mkdirSync(legacyRoot, { recursive: true });
    rmSync(join(legacyRoot, "arsenkin-report-binding.json"), { force: true });
    const resolved = resolveEffectiveReportRunIdForCase(legacyCase, SOURCE_RUN);
    assert.equal(resolved.fromArsenkinBinding, false);
    assert.equal(resolved.reportRunId, SOURCE_RUN);
  });

  it("8 UI status TRANSFERRED only after binding + client content", async () => {
    const binding = loadArsenkinReportBinding(CASE_ID);
    assert.ok(binding);
    assert.equal(binding!.status, "TRANSFERRED");
    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, CASE_ID);
    assert.ok(existsSync(join(caseRoot, "arsenkin-report-binding.json")));
    assert.ok(existsSync(join(caseRoot, "orion-client-content.post-review.json")));
    const post = JSON.parse(
      readFileSync(join(caseRoot, "orion-client-content.post-review.json"), "utf-8")
    ) as { reportRunId: string };
    assert.equal(post.reportRunId, binding!.effectiveReportRunId);

    // Simulate partial failure marker — status must not look transferred.
    saveArsenkinReportBinding({
      ...binding!,
      status: "TRANSFER_FAILED",
      lastError: "simulated",
    });
    const failed = loadArsenkinReportBinding(CASE_ID)!;
    assert.equal(failed.status, "TRANSFER_FAILED");
    const resolvedWhileFailed = resolveEffectiveReportRunIdForCase(CASE_ID, SOURCE_RUN);
    assert.equal(resolvedWhileFailed.fromArsenkinBinding, false);
    assert.equal(resolvedWhileFailed.reportRunId, SOURCE_RUN);

    // Restore TRANSFERRED for leftover artifacts.
    saveArsenkinReportBinding({ ...binding!, status: "TRANSFERRED", lastError: null });
  });

  it("9 canary suggestion gate requires Yandex+Google RU autocomplete", () => {
    const binding = loadArsenkinReportBinding(CASE_ID)!;
    const ok = assertArsenkinTransferredClientContent({
      caseId: CASE_ID,
      clientContentReportRunId: ARSENKIN_RUN,
      binding,
      observationCount: 18,
      providerTaskCount: 2,
      coverageCount: 2,
      requireCanarySuggestions: true,
      hasYandexRuAutocomplete: true,
      hasGoogleRuAutocomplete: true,
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.skipped, false);

    const bad = assertArsenkinTransferredClientContent({
      caseId: CASE_ID,
      clientContentReportRunId: ARSENKIN_RUN,
      binding,
      observationCount: 18,
      providerTaskCount: 2,
      coverageCount: 2,
      requireCanarySuggestions: true,
      hasYandexRuAutocomplete: true,
      hasGoogleRuAutocomplete: false,
    });
    assert.equal(bad.ok, false);
    if (!bad.ok) {
      assert.ok(bad.issues.some((i) => i.code === "ARSENKIN_SUGGESTION_ASSETS_MISSING"));
    }
  });

  it("standalone diagnostic sync (no rebuild) updates binding, marks report stale, renders nothing", async () => {
    resetArsenkinNetworkCallCount();
    const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, CASE_ID);
    rmSync(caseRoot, { recursive: true, force: true });
    mkdirSync(caseRoot, { recursive: true });
    seedMapping();

    // Seed an accepted canonical unified job so staleness has a target.
    deleteUnifiedCollectionJobForTests(CASE_ID);
    findOrCreateUnifiedCollectionJob({ caseId: CASE_ID, requestedBy: "tester" });
    patchUnifiedCollectionJob(CASE_ID, { stage: "REPORT_READY", status: "COMPLETED" });

    const state: FakeState = {
      run: {
        id: ARSENKIN_RUN,
        caseId: CASE_ID,
        status: "DONE",
        metadataJson: { workflow: "suggest-canary" },
      },
      stages: [
        {
          reportRunId: ARSENKIN_RUN,
          stage: "SUGGEST_RU_CANARY",
          status: "DONE",
          planDigest: "d1",
          errorJson: null,
          updatedAt: new Date(),
        },
      ],
      observations: make18Observations(ARSENKIN_RUN),
      providerTaskCount: 2,
      coverageCount: 2,
    };

    // NOTE: no `rebuild` in deps → production diagnostic-only path.
    const result = await syncArsenkinResultsToOrion({
      caseId: CASE_ID,
      reportRunId: SOURCE_RUN,
      stage: "SUGGEST_RU_CANARY",
      deps: {
        prisma: makeFakePrisma(state),
        readinessBlockers: () => [],
        isConfigured: () => true,
      },
    });

    // Diagnostic-only: enrichment collected/appended but NOT promoted to a report.
    // Honest state is READY_TO_TRANSFER (not render-ready) — never TRANSFERRED.
    assert.equal(result.status, "READY_TO_TRANSFER");
    assert.equal(result.synced, false);
    assert.equal(getArsenkinNetworkCallCount(), 0);

    // Binding + provenance persisted, not render-ready (no legacy render happened).
    const binding = loadArsenkinReportBinding(CASE_ID);
    assert.ok(binding);
    assert.equal(binding!.status, "READY_TO_TRANSFER");
    assert.equal(binding!.effectiveReportRunId, ARSENKIN_RUN);

    // Diagnostic sync marker: no report generated.
    const sync = JSON.parse(readFileSync(join(caseRoot, "arsenkin-ui-sync.json"), "utf-8")) as {
      diagnosticOnly?: boolean;
      reportGenerated?: boolean;
      status?: string;
    };
    assert.equal(sync.diagnosticOnly, true);
    assert.equal(sync.reportGenerated, false);
    assert.equal(sync.status, "READY_TO_TRANSFER");

    // No client-content report was rebuilt/promoted.
    assert.equal(
      existsSync(join(caseRoot, "orion-client-content.post-review.json")),
      false,
      "diagnostic sync must not produce client content"
    );

    // Accepted canonical report is now marked stale (REBUILD_REQUIRED).
    const job = loadUnifiedCollectionJob(CASE_ID);
    assert.ok(job);
    assert.ok(
      job!.warnings.some((w) => w.startsWith("CANONICAL_ARTIFACTS_STALE")),
      `expected stale warning, got ${JSON.stringify(job!.warnings)}`
    );

    deleteUnifiedCollectionJobForTests(CASE_ID);
  });

  it("NETWORK_CALLS remains 0", () => {
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });
});
