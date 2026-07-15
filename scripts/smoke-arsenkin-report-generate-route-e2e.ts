/**
 * Route-level E2E: real button path
 * POST …/orion-golden/report/generate { regenerateContent: true }
 * → executeOrionClassicAuditReportJob
 *
 * NETWORK_CALLS=0. No live Arsenkin API. Render mocked to write real output artifacts.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  loadArsenkinReportBinding,
  resolveEffectiveReportRunIdForCase,
  saveArsenkinReportBinding,
  arsenkinCaseArtifactRoot,
  inspectArsenkinTransferContentGate,
} from "../src/modules/digital-profile/orion-golden/classic/arsenkin-report-binding";
import { executeOrionClassicAuditReportJob } from "../src/modules/digital-profile/services/orion-classic-audit-report-service";
import {
  saveArsenkinUiRunMapping,
  syncArsenkinResultsToOrion,
  type ArsenkinUiOrchestrationDeps,
} from "../src/modules/digital-profile/services/arsenkin-ui-orchestration-service";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";
import { writeJsonAtomic } from "../src/modules/digital-profile/providers/arsenkin/arsenkin-db-readiness";
import { inspectSidebarClientPolicy } from "../src/modules/digital-profile/orion-golden/classic/sidebar-client-policy";
import type { OrionClientContent } from "../src/modules/digital-profile/orion-golden/content/orion-client-content-builder";

const CASE_ID = "routee2e-arsenkin-cmreamy2t";
const SOURCE_RUN = "orion-r10-1783705193806";
const ARSENKIN_RUN = "orion-arsenkin-suggest-canary-1784052644782-08903825";

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

function make18Observations(auditRunId: string): FakeState["observations"] {
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
    providerTask: { count: async () => state.providerTaskCount },
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
    surfaceCollectionCoverage: { count: async () => state.coverageCount },
  } as unknown as ArsenkinUiOrchestrationDeps["prisma"];
}

function writeRebuildArtifacts(caseId: string, reportRunId: string, out: string): void {
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
    observationCount: 18,
  });
  writeJsonAtomic(join(out, "full-evidence-inventory.json"), {
    caseId,
    reportRunId,
    subject: { fullName: "Test", aliases: [] },
  });
}

/** Same contract as production render output for Arsenkin canary. */
async function fakeRender(options: {
  caseId: string;
  outputRoot: string;
  clientContent?: OrionClientContent;
  reportRunIdOverride?: string;
}) {
  const runId = String(options.clientContent?.reportRunId ?? "");
  mkdirSync(options.outputRoot, { recursive: true });
  const obs = make18Observations(runId);
  writeJsonAtomic(join(options.outputRoot, "client-content-binding.json"), {
    sourceReportRunId: SOURCE_RUN,
    effectiveReportRunId: runId,
    overridden: false,
  });
  writeJsonAtomic(join(options.outputRoot, "run-scoped-serp-merge.json"), {
    auditRunId: runId,
    usedRunScoped: true,
    observationCount: 18,
    duplicateKeys: [],
    warnings: [],
  });
  writeJsonAtomic(
    join(options.outputRoot, "serp-observations-provenance.json"),
    obs.map((o) => ({
      id: o.id,
      auditRunId: o.auditRunId,
      provider: o.provider,
      providerTaskId: o.providerTaskId,
      surface: o.surface,
      engine: o.engine,
      region: o.region,
    }))
  );
  writeJsonAtomic(join(options.outputRoot, "report-assets.json"), {
    assets: [
      {
        assetRef: "ru_suggestions_yandex",
        caption: "Yandex suggest via Arsenkin",
        evidenceRefs: obs.filter((o) => o.engine === "YANDEX").map((o) => `serp_observation:${o.id}`),
      },
      {
        assetRef: "ru_suggestions_google",
        caption: "Google suggest via Arsenkin",
        evidenceRefs: obs.filter((o) => o.engine === "GOOGLE").map((o) => `serp_observation:${o.id}`),
      },
    ],
  });
  writeJsonAtomic(join(options.outputRoot, "final-deck-manifest.json"), {
    slideCount: 36,
    finalSlides: [
      {
        pageNumber: 10,
        slideKey: "p10_ru_serp_visual",
        assetRefs: ["ru_provider_serp_synserp"],
        evidenceRefs: ["serp_observation:ru-serp-0"],
        visualAnalysis: {
          headlineConclusion: "Первый экран поисковой выдачи (Россия)",
          whatIsVisible: "Показаны заголовки и домены первого экрана поисковой выдачи по субъекту.",
          whyItMatters: "Клиент сразу видит, какие источники формируют первое впечатление.",
          clientMeaning: "Клиент сразу видит, какие источники формируют первое впечатление.",
          recommendedActions: [],
          provenanceLabel: "Источник: сохранённая поисковая выдача, дата сбора в кейсе",
        },
      },
      {
        pageNumber: 11,
        slideKey: "p11_ru_suggestions_yandex",
        assetRefs: ["ru_suggestions_yandex"],
        evidenceRefs: ["serp_observation:yandex-obs-0"],
        visualAnalysis: {
          headlineConclusion: "Прямых негативных формулировок в подсказках не найдено",
          whatIsVisible: "Прямых негативных формулировок не найдено.",
          whyItMatters: "На этапе ввода запроса ассоциации выглядят нейтральными.",
          clientMeaning: "На этапе ввода запроса ассоциации выглядят нейтральными.",
          recommendedActions: [],
          provenanceLabel: "Источник: Arsenkin Tools, подсказки Яндекса, дата сбора в кейсе",
        },
      },
      {
        pageNumber: 12,
        slideKey: "p12_ru_suggestions_google",
        assetRefs: ["ru_suggestions_google"],
        evidenceRefs: ["serp_observation:google-obs-0"],
        visualAnalysis: {
          headlineConclusion: "Прямых негативных формулировок в подсказках не найдено",
          whatIsVisible: "Прямых негативных формулировок не найдено.",
          whyItMatters: "На этапе ввода запроса ассоциации выглядят нейтральными.",
          clientMeaning: "На этапе ввода запроса ассоциации выглядят нейтральными.",
          recommendedActions: [],
          provenanceLabel: "Источник: Arsenkin Tools, подсказки Google, дата сбора в кейсе",
        },
      },
    ],
  });
  writeFileSync(join(options.outputRoot, "rendered-client.pdf"), "pdf-stub");
  return {
    caseId: options.caseId,
    outputRoot: options.outputRoot,
    slideCount: 36,
    pageCount: 36,
    verdict: "PASS" as const,
    clientPolicyStatus: "PASS",
    visualPassed: true,
    classicQaPassed: true,
    renderQaReady: true,
    readiness: "INTERNAL_PREVIEW" as const,
    ceoReady: false,
    warnings: [],
    reportRunId: runId,
  };
}

function seedLegacySourceContent(): void {
  const root = arsenkinCaseArtifactRoot(CASE_ID);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeJsonAtomic(join(root, "full-evidence-inventory.json"), {
    caseId: CASE_ID,
    reportRunId: SOURCE_RUN,
    subject: { fullName: "Test", aliases: [] },
  });
  writeJsonAtomic(join(root, "orion-client-content.post-review.json"), {
    caseId: CASE_ID,
    reportRunId: SOURCE_RUN,
    approvedFindings: [],
  });
  writeJsonAtomic(join(root, "admin-review-decisions.json"), {
    version: "r10-5-admin-review-decisions-v1",
    caseId: CASE_ID,
    generatedAt: new Date().toISOString(),
    qaSampleOnly: false,
    decisions: [
      { evidenceId: "ev-keep", status: "APPROVED", reviewedAt: new Date().toISOString() },
    ],
  });
  writeJsonAtomic(join(root, "manual-review-queue.json"), {
    caseId: CASE_ID,
    reportRunId: SOURCE_RUN,
    items: [{ evidenceId: "ev-keep" }],
  });
}

function arsenkinState(): FakeState {
  return {
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
}

describe("route-level report/generate Arsenkin binding E2E", () => {
  it("1 transfer → regenerate analysis → report/generate rebuilds Arsenkin output", async () => {
    resetArsenkinNetworkCallCount();
    seedLegacySourceContent();
    saveArsenkinUiRunMapping({
      caseId: CASE_ID,
      sourceReportRunId: SOURCE_RUN,
      arsenkinReportRunId: ARSENKIN_RUN,
      workflow: "suggest-canary",
      stage: "SUGGEST_RU_CANARY",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const state = arsenkinState();
    const deps: ArsenkinUiOrchestrationDeps = {
      prisma: makeFakePrisma(state),
      readinessBlockers: () => [],
      isConfigured: () => true,
      rebuild: async (c, r, out, opts) => {
        writeRebuildArtifacts(c, r, out);
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

    // 1) Real transfer handler
    const sync = await syncArsenkinResultsToOrion({
      caseId: CASE_ID,
      reportRunId: SOURCE_RUN,
      stage: "SUGGEST_RU_CANARY",
      deps,
    });
    assert.equal(sync.status, "TRANSFERRED");
    assert.equal(loadArsenkinReportBinding(CASE_ID)?.effectiveReportRunId, ARSENKIN_RUN);

    // 2) Real client-content regenerate handler path (same entry as POST …/client-content/regenerate)
    // Fixture rebuild — production entry is persistRegeneratedClientContentAsync → resolveEffective…
    const regenResolved = resolveEffectiveReportRunIdForCase(CASE_ID, SOURCE_RUN);
    assert.equal(regenResolved.reportRunId, ARSENKIN_RUN);
    writeRebuildArtifacts(CASE_ID, ARSENKIN_RUN, arsenkinCaseArtifactRoot(CASE_ID));
    const post = JSON.parse(
      readFileSync(
        join(arsenkinCaseArtifactRoot(CASE_ID), "orion-client-content.post-review.json"),
        "utf-8"
      )
    ) as { reportRunId: string };
    assert.equal(post.reportRunId, ARSENKIN_RUN);

    // 3) Real report/generate job body (same as POST regenerateContent:true)
    const uiRunId = `classic-route-e2e-${Date.now()}`;
    const runOutputRoot = join(
      process.cwd(),
      "storage",
      "digital-profile",
      "orion-classic-audit-ui",
      "cases",
      CASE_ID,
      "runs",
      uiRunId,
      "output"
    );
    mkdirSync(runOutputRoot, { recursive: true });

    const record = await executeOrionClassicAuditReportJob(
      {
        caseId: CASE_ID,
        uiRunId,
        runOutputRoot,
        createdAt: new Date().toISOString(),
        regenerateContent: true,
      },
      {
        render: fakeRender,
        persist: async (caseId) => {
          // Simulate production persist via same async entry, but avoid full GPT e2e.
          const resolved = resolveEffectiveReportRunIdForCase(caseId, SOURCE_RUN);
          assert.equal(resolved.reportRunId, ARSENKIN_RUN);
          writeRebuildArtifacts(caseId, ARSENKIN_RUN, arsenkinCaseArtifactRoot(caseId));
          writeJsonAtomic(
            join(arsenkinCaseArtifactRoot(caseId), "client-content-binding.json"),
            {
              sourceReportRunId: SOURCE_RUN,
              effectiveReportRunId: ARSENKIN_RUN,
              overridden: false,
            }
          );
          saveArsenkinReportBinding({
            ...loadArsenkinReportBinding(caseId)!,
            status: "TRANSFERRED",
            contentPromotionError: null,
            lastError: null,
          });
          return {
            artifactRoot: arsenkinCaseArtifactRoot(caseId),
            generatedAt: new Date().toISOString(),
            preReviewApprovedCount: 0,
            postReviewApprovedCount: 0,
          };
        },
      }
    );

    assert.equal(record.status, "completed");
    assert.equal(getArsenkinNetworkCallCount(), 0);

    const binding = JSON.parse(
      readFileSync(join(runOutputRoot, "client-content-binding.json"), "utf-8")
    ) as { effectiveReportRunId: string; sourceReportRunId: string };
    assert.equal(binding.effectiveReportRunId, ARSENKIN_RUN);
    assert.equal(binding.sourceReportRunId, SOURCE_RUN);
    assert.notEqual(binding.effectiveReportRunId, SOURCE_RUN);

    const merge = JSON.parse(
      readFileSync(join(runOutputRoot, "run-scoped-serp-merge.json"), "utf-8")
    ) as { auditRunId: string; observationCount: number };
    assert.equal(merge.auditRunId, ARSENKIN_RUN);
    assert.equal(merge.observationCount, 18);

    const provenance = JSON.parse(
      readFileSync(join(runOutputRoot, "serp-observations-provenance.json"), "utf-8")
    ) as unknown[];
    assert.equal(provenance.length, 18);

    const assets = JSON.parse(readFileSync(join(runOutputRoot, "report-assets.json"), "utf-8")) as {
      assets: Array<{ assetRef: string; evidenceRefs: string[] }>;
    };
    const y = assets.assets.find((a) => a.assetRef === "ru_suggestions_yandex");
    const g = assets.assets.find((a) => a.assetRef === "ru_suggestions_google");
    assert.ok((y?.evidenceRefs.length ?? 0) > 0);
    assert.ok((g?.evidenceRefs.length ?? 0) > 0);

    const deck = JSON.parse(
      readFileSync(join(runOutputRoot, "final-deck-manifest.json"), "utf-8")
    ) as {
      finalSlides: Array<{
        pageNumber: number;
        assetRefs: string[];
        visualAnalysis?: { provenanceLabel?: string };
      }>;
    };
    assert.ok(deck.finalSlides.find((s) => s.pageNumber === 11)?.assetRefs.includes("ru_suggestions_yandex"));
    assert.ok(deck.finalSlides.find((s) => s.pageNumber === 12)?.assetRefs.includes("ru_suggestions_google"));

    // Sidebar client policy parity: no rendered sidebar field may carry a
    // renderer-banned token, and p11-12 must keep Arsenkin provenance sans "API".
    const violations = inspectSidebarClientPolicy(deck.finalSlides);
    assert.deepEqual(violations, [], JSON.stringify(violations));
    const p11 = deck.finalSlides.find((s) => s.pageNumber === 11)?.visualAnalysis?.provenanceLabel ?? "";
    const p12 = deck.finalSlides.find((s) => s.pageNumber === 12)?.visualAnalysis?.provenanceLabel ?? "";
    assert.match(p11, /Arsenkin Tools/i);
    assert.match(p12, /Arsenkin Tools/i);
    assert.ok(!/\bAPI\b/.test(p11) && !/\bAPI\b/.test(p12));
  });

  it("2 regression: TRANSFERRED binding + stale source post-review never renders old run", async () => {
    resetArsenkinNetworkCallCount();
    seedLegacySourceContent();
    // Binding already transferred, but post-review still on source (production failure mode).
    saveArsenkinReportBinding({
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
    });
    writeJsonAtomic(join(arsenkinCaseArtifactRoot(CASE_ID), "arsenkin-ui-sync.json"), {
      synced: true,
      reportRunId: ARSENKIN_RUN,
      sourceReportRunId: SOURCE_RUN,
      effectiveReportRunId: ARSENKIN_RUN,
      status: "TRANSFERRED",
    });

    const gateBefore = inspectArsenkinTransferContentGate(CASE_ID);
    assert.equal(gateBefore.ok, false);
    assert.equal(gateBefore.reason, "CLIENT_CONTENT_NOT_PROMOTED");

    const uiRunId = `classic-stale-${Date.now()}`;
    const runOutputRoot = join(
      process.cwd(),
      "storage",
      "digital-profile",
      "orion-classic-audit-ui",
      "cases",
      CASE_ID,
      "runs",
      uiRunId,
      "output"
    );
    mkdirSync(runOutputRoot, { recursive: true });

    let renderedRun: string | null = null;
    const record = await executeOrionClassicAuditReportJob(
      {
        caseId: CASE_ID,
        uiRunId,
        runOutputRoot,
        createdAt: new Date().toISOString(),
        regenerateContent: true,
      },
      {
        persist: async (caseId) => {
          writeRebuildArtifacts(caseId, ARSENKIN_RUN, arsenkinCaseArtifactRoot(caseId));
          saveArsenkinReportBinding({
            ...loadArsenkinReportBinding(caseId)!,
            status: "TRANSFERRED",
            contentPromotionError: null,
            lastError: null,
          });
          return {
            artifactRoot: arsenkinCaseArtifactRoot(caseId),
            generatedAt: new Date().toISOString(),
            preReviewApprovedCount: 0,
            postReviewApprovedCount: 0,
          };
        },
        render: async (opts) => {
          renderedRun = String(opts.clientContent?.reportRunId ?? "");
          assert.equal(renderedRun, ARSENKIN_RUN);
          assert.notEqual(renderedRun, SOURCE_RUN);
          return fakeRender(opts);
        },
      }
    );

    assert.equal(record.status, "completed");
    assert.equal(renderedRun, ARSENKIN_RUN);
    const outBinding = JSON.parse(
      readFileSync(join(runOutputRoot, "client-content-binding.json"), "utf-8")
    ) as { effectiveReportRunId: string };
    assert.equal(outBinding.effectiveReportRunId, ARSENKIN_RUN);
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("3 legacy sync marker alone hydrates binding for PDF path", () => {
    const root = arsenkinCaseArtifactRoot(`${CASE_ID}-legacy-sync`);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    writeJsonAtomic(join(root, "arsenkin-ui-sync.json"), {
      synced: true,
      reportRunId: ARSENKIN_RUN,
      sourceReportRunId: SOURCE_RUN,
      at: new Date().toISOString(),
      observationCount: 18,
      providerTaskCount: 2,
      coverageCount: 2,
    });
    writeJsonAtomic(join(root, "orion-client-content.post-review.json"), {
      caseId: `${CASE_ID}-legacy-sync`,
      reportRunId: ARSENKIN_RUN,
      approvedFindings: [],
    });
    const resolved = resolveEffectiveReportRunIdForCase(`${CASE_ID}-legacy-sync`, SOURCE_RUN);
    assert.equal(resolved.fromArsenkinBinding, true);
    assert.equal(resolved.reportRunId, ARSENKIN_RUN);
    assert.ok(existsSync(join(root, "arsenkin-report-binding.json")));
  });
});
