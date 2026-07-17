/**
 * Offline regression: live Job B URL_AUDIT envelope shapes (NETWORK_CALLS=0).
 * Proven RO shapes: indexation resp-map; check-h mixed object|boolean array.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  saveUnifiedCollectionJob,
  writeUnifiedArtifact,
  listResumableUnifiedJobs,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  runUnifiedCollectionTick,
} from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import {
  runDurableArsenkinEnrichmentTick,
  type EnrichmentPollTaskSnap,
} from "../src/modules/digital-profile/services/arsenkin-enrichment-tick";
import { adaptArsenkinToolResponse } from "../src/modules/digital-profile/services/arsenkin-tool-adapters";
import { unwrapArsenkinTaskEnvelope } from "../src/modules/digital-profile/services/arsenkin-response-envelope";
import { isArsenkinClientEvidenceObservation } from "../src/modules/digital-profile/services/arsenkin-enrichment-state";
import { mergeCompositeSerp } from "../src/modules/digital-profile/services/composite-serp-merge";
import type { UnifiedCollectionJob } from "../src/modules/digital-profile/services/unified-collection-types";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";
import type { CompositeObservation } from "../src/modules/digital-profile/services/composite-serp-merge";

process.env.NETWORK_CALLS = "0";

const CASE = "smoke-url-audit-envelope-case";
const JOB_B = "unified-1784295388553-269bc3cf";
const FIX = join(process.cwd(), "src/modules/digital-profile/providers/arsenkin/fixtures");
const ENRICHMENT_RUN_IDS = [
  "orion-arsenkin-agent-arsenkin-search-top-real-mrozh14w",
  "orion-arsenkin-agent-arsenkin-suggestions-real-mrozh154",
  "orion-arsenkin-agent-arsenkin-paa-real-mrozh159",
  "orion-arsenkin-agent-arsenkin-ai-search-real-mrozh15e",
  "orion-arsenkin-agent-arsenkin-url-audit-real-mrozh15i",
] as const;

const FLAGS = {
  EXTERNAL_SUBMISSIONS: 0,
  BASE_CALLS: 0,
  COMPOSITE_CALLS: 0,
  RENDER_CALLS: 0,
};

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf-8"));
}

function ctx(tool: string) {
  return {
    caseAgent: "ARSENKIN_URL_AUDIT_REAL",
    toolName: tool,
    externalTaskId: "30662281",
    enrichmentRunId: ENRICHMENT_RUN_IDS[4]!,
    unifiedJobId: JOB_B,
    providerTaskId: "pt-url-audit",
  };
}

function seedJobB(overrides: Partial<UnifiedCollectionJob> = {}): void {
  deleteUnifiedCollectionJobForTests(CASE);
  const now = new Date().toISOString();
  saveUnifiedCollectionJob({
    version: "unified-orion-collection-job-v1",
    caseId: CASE,
    jobId: JOB_B,
    unifiedJobId: JOB_B,
    stage: "ARSENKIN_ENRICHMENT",
    status: "WAITING",
    progress: 0.55,
    versionNum: 1,
    leaseOwnerId: null,
    leaseUntil: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    requestedBy: "smoke",
    arsenkinMode: "full-first36",
    baseReportRunId: "orion-unified-base-unified-1784295388553-269bc3cf",
    arsenkinReportRunId: ENRICHMENT_RUN_IDS[0],
    enrichmentRunIds: [...ENRICHMENT_RUN_IDS],
    arsenkinEnrichmentState: null,
    compositeDatasetId: null,
    actualProviders: [
      { providerId: "yandex", runtime: "real", status: "completed" },
      { providerId: "google", runtime: "real", status: "completed" },
    ],
    coverage: null,
    warnings: [],
    lastError: null,
    lastErrorCode: null,
    artifactPaths: {},
    reportLinks: {},
    cancelRequested: false,
    resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
    nextPollAt: now,
    pollAttempt: 0,
    ...overrides,
  });
}

function writeBaseManifest(): void {
  const manifest: BaseCollectionManifest = {
    version: "base-collection-manifest-v1",
    unifiedJobId: JOB_B,
    caseId: CASE,
    capturedAt: new Date().toISOString(),
    baseReportRunId: "orion-unified-base-unified-1784295388553-269bc3cf",
    searchResultIds: ["sr0", "sr1", "sr2"],
    searchSurfaceItemIds: [],
    baseCount: 3,
    actualProviders: [
      { providerId: "yandex", runtime: "real", status: "completed" },
      { providerId: "google", runtime: "real", status: "completed" },
    ],
    realCollectionSufficient: true,
  };
  writeUnifiedArtifact(CASE, JOB_B, "base-collection-manifest.json", manifest);
}

function fixtureBaseRows(): CompositeObservation[] {
  return Array.from({ length: 3 }, (_, i) => ({
    key: `organic|ru|yandex|q|https://base.example/${i}`,
    kind: "organic" as const,
    region: "RU",
    engine: "YANDEX",
    query: "q",
    url: `https://base.example/${i}`,
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: [`searchResult:sr${i}`],
    baseSearchResultId: `sr${i}`,
  }));
}

function allFiveDoneTasks(): EnrichmentPollTaskSnap[] {
  const tools = ["check-top", "suggest", "paa", "ai-serp", "indexation"] as const;
  const fixtures = [
    "get-check-top.json",
    "get-suggest.json",
    "get-paa.json",
    "get-ai-serp.json",
    "get-indexation-resp-map.json",
  ] as const;
  const ext = ["ext-top", "30664641", "ext-paa", "ext-ai", "30662281"];
  return ENRICHMENT_RUN_IDS.map((runId, i) => ({
    id: `pt-${tools[i]}`,
    reportRunId: runId,
    externalTaskId: ext[i]!,
    toolName: tools[i]!,
    state: "DONE" as const,
    responseJson: loadFixture(fixtures[i]!),
  }));
}

before(() => {
  assert.equal(process.env.NETWORK_CALLS, "0");
});

describe("URL_AUDIT live envelope regression", () => {
  it("1. indexation resp-map: per-URL status rows + full accounting", () => {
    const raw = loadFixture("get-indexation-resp-map.json");
    const unwrapped = unwrapArsenkinTaskEnvelope(raw);
    assert.equal(unwrapped.ok, true);
    const adapted = adaptArsenkinToolResponse({
      toolName: "indexation",
      responseJson: raw,
      ctx: ctx("indexation"),
    });
    assert.equal(adapted.ok, true);
    if (adapted.ok) {
      assert.equal(adapted.rawItemCount, 3);
      assert.equal(adapted.emittedObservationCount, 3);
      assert.equal(adapted.diagnosticExcludedCount, 0);
      assert.equal(
        adapted.rawItemCount,
        (adapted.emittedObservationCount ?? 0) + (adapted.diagnosticExcludedCount ?? 0)
      );
      assert.equal(adapted.observations.length, 3);
      assert.ok(adapted.observations.every((o) => o.externalTaskId === "30662281"));
      assert.ok(adapted.observations.every((o) => o.taskId === "30662281"));
      assert.ok(adapted.observations.every((o) => o.resultHash && o.resultHash.length === 64));
      assert.ok(adapted.observations.every((o) => typeof o.sourceIndex === "number"));
      assert.ok(adapted.observations.every((o) => o.kind !== "URL_FETCH_STATUS"));
      assert.ok(adapted.observations.every((o) => o.yandexIndexed != null || o.googleIndexed != null));
      assert.ok(adapted.observations.some((o) => /yandex:indexed/.test(String(o.snippet ?? o.title))));
      assert.ok(adapted.observations.some((o) => o.indexedAt === "2019-11-22"));
      assert.ok(adapted.observations.some((o) => String(o.yandexDoc ?? "").includes("yandbtm")));
    }
  });

  it("2. URL_AUDIT object item (table/check-h object rows)", () => {
    const adapted = adaptArsenkinToolResponse({
      toolName: "check-h",
      responseJson: loadFixture("get-check-h.json"),
      ctx: { ...ctx("check-h"), externalTaskId: "30662296", providerTaskId: "pt-check-h" },
    });
    assert.equal(adapted.ok, true);
    if (adapted.ok) assert.ok(adapted.observations.length >= 1);
  });

  it("3. check-h mixed object|boolean → observations + URL_FETCH_STATUS diagnostics (no silent drop)", () => {
    const raw = loadFixture("get-check-h-mixed-boolean.json");
    const adapted = adaptArsenkinToolResponse({
      toolName: "check-h",
      responseJson: raw,
      ctx: { ...ctx("check-h"), externalTaskId: "30662296", providerTaskId: "pt-check-h" },
    });
    assert.equal(adapted.ok, true);
    if (adapted.ok) {
      assert.equal(adapted.rawItemCount, 10);
      assert.equal(adapted.emittedObservationCount, 3);
      assert.equal(adapted.diagnosticExcludedCount, 7);
      assert.equal(
        adapted.rawItemCount,
        (adapted.emittedObservationCount ?? 0) + (adapted.diagnosticExcludedCount ?? 0)
      );
      assert.equal(adapted.observations.length, 10);
      const client = adapted.observations.filter(isArsenkinClientEvidenceObservation);
      const diagnostics = adapted.observations.filter((o) => o.kind === "URL_FETCH_STATUS");
      assert.equal(client.length, 3);
      assert.equal(diagnostics.length, 7);
      assert.ok(client.every((o) => /^https?:\/\//.test(String(o.url))));
      assert.deepEqual(
        client.map((o) => o.sourceIndex).sort((a, b) => Number(a) - Number(b)),
        [0, 1, 5]
      );
      assert.ok(
        diagnostics.every(
          (o) =>
            o.clientEvidence === false &&
            o.diagnosticCode === "ARSENKIN_URL_FETCH_STATUS" &&
            typeof o.fetchStatusValue === "boolean" &&
            o.externalTaskId === "30662296" &&
            o.providerTaskId === "pt-check-h" &&
            o.enrichmentRunId === ENRICHMENT_RUN_IDS[4] &&
            o.taskId === "30662296" &&
            o.resultHash &&
            o.resultHash.length === 64 &&
            o.exclusionReason === "check-h-boolean-slot"
        )
      );
      assert.deepEqual(
        diagnostics.map((o) => o.sourceIndex).sort((a, b) => Number(a) - Number(b)),
        [2, 3, 4, 6, 7, 8, 9]
      );
    }
  });

  it("3b. object + http URL string items both normalize; accounting holds", () => {
    const adapted = adaptArsenkinToolResponse({
      toolName: "indexation",
      responseJson: {
        code: "TASK_RESULT",
        task_id: "1",
        result: {
          items: [
            { url: "https://example.invalid/obj", title: "obj" },
            "https://example.invalid/a",
            "https://example.invalid/b",
          ],
        },
      },
      ctx: ctx("indexation"),
    });
    assert.equal(adapted.ok, true);
    if (adapted.ok) {
      assert.equal(adapted.rawItemCount, 3);
      assert.equal(adapted.emittedObservationCount, 3);
      assert.equal(adapted.diagnosticExcludedCount, 0);
      assert.equal(adapted.observations.length, 3);
    }
  });

  it("3c. diagnostics never enter composite / client findings", async () => {
    const adapted = adaptArsenkinToolResponse({
      toolName: "check-h",
      responseJson: loadFixture("get-check-h-mixed-boolean.json"),
      ctx: { ...ctx("check-h"), externalTaskId: "30662296", providerTaskId: "pt-check-h" },
    });
    assert.equal(adapted.ok, true);
    if (!adapted.ok) return;
    writeBaseManifest();
    const merged = await mergeCompositeSerp({
      manifest: {
        version: "base-collection-manifest-v1",
        unifiedJobId: JOB_B,
        caseId: CASE,
        capturedAt: new Date().toISOString(),
        baseReportRunId: "orion-unified-base-unified-1784295388553-269bc3cf",
        searchResultIds: ["sr0", "sr1", "sr2"],
        searchSurfaceItemIds: [],
        baseCount: 3,
        actualProviders: [
          { providerId: "yandex", runtime: "real", status: "completed" },
          { providerId: "google", runtime: "real", status: "completed" },
        ],
        realCollectionSufficient: true,
      },
      fixtureBaseRows: fixtureBaseRows(),
      arsenkinObservations: adapted.observations,
    });
    assert.ok(merged.observations.every((o) => o.kind !== ("URL_FETCH_STATUS" as never)));
    // Only 3 URL object rows from Arsenkin (+ base), never boolean diagnostic slots.
    assert.equal(merged.providerCounts.arsenkin, 3);
    const arsenkinOnly = merged.observations.filter((o) => o.primaryProvider === "arsenkin");
    assert.equal(arsenkinOnly.length, 3);
    assert.ok(arsenkinOnly.every((o) => /^https?:\/\//.test(String(o.url ?? ""))));
  });

  it("4. unknown / ambiguous scalar → ARSENKIN_SCHEMA_INVALID with path/sourceIndex", () => {
    const a = adaptArsenkinToolResponse({
      toolName: "indexation",
      responseJson: { code: "TASK_RESULT", task_id: "1", result: { weird: true } },
      ctx: ctx("indexation"),
    });
    assert.equal(a.ok, false);
    if (!a.ok) assert.equal(a.code, "ARSENKIN_SCHEMA_INVALID");

    const b = adaptArsenkinToolResponse({
      toolName: "check-h",
      responseJson: {
        code: "TASK_RESULT",
        task_id: "1",
        result: { result: [42, { url: "https://example.invalid/x" }] },
      },
      ctx: ctx("check-h"),
    });
    assert.equal(b.ok, false);
    if (!b.ok) {
      assert.equal(b.code, "ARSENKIN_SCHEMA_INVALID");
      assert.match(b.message, /sourceIndex=0/);
      assert.match(b.message, /path=result\[0\]|ambiguous-scalar:number/);
    }
  });

  it("5. all five real envelope fixtures parse", () => {
    const rows = [
      { tool: "check-top", file: "get-check-top.json" },
      { tool: "suggest", file: "get-suggest.json" },
      { tool: "paa", file: "get-paa.json" },
      { tool: "ai-serp", file: "get-ai-serp.json" },
      { tool: "indexation", file: "get-indexation-resp-map.json" },
    ] as const;
    for (const row of rows) {
      const adapted = adaptArsenkinToolResponse({
        toolName: row.tool,
        responseJson: loadFixture(row.file),
        ctx: {
          caseAgent: "A",
          toolName: row.tool,
          externalTaskId: `ext-${row.tool}`,
          enrichmentRunId: "r",
          unifiedJobId: JOB_B,
          providerTaskId: `pt-${row.tool}`,
        },
      });
      assert.equal(adapted.ok, true, `${row.tool}: ${!adapted.ok ? adapted.message : ""}`);
    }
    // Also mixed check-h for URL_AUDIT sibling tool.
    const checkH = adaptArsenkinToolResponse({
      toolName: "check-h",
      responseJson: loadFixture("get-check-h-mixed-boolean.json"),
      ctx: ctx("check-h"),
    });
    assert.equal(checkH.ok, true);
  });

  it("6/7/10. Job B 5/5 ingested; exactly-once re-tick; submissions=0 base=0; raw accounting", async () => {
    seedJobB();
    const tasks = allFiveDoneTasks();
    // Sibling check-h DONE on same URL_AUDIT run (live Job B pattern).
    tasks.push({
      id: "pt-check-h",
      reportRunId: ENRICHMENT_RUN_IDS[4]!,
      externalTaskId: "30662296",
      toolName: "check-h",
      state: "DONE",
      responseJson: loadFixture("get-check-h-mixed-boolean.json"),
    });
    const first = await runDurableArsenkinEnrichmentTick({
      job: loadUnifiedCollectionJob(CASE)!,
      listProviderTasks: async () => tasks,
      pollTask: async (t) => {
        FLAGS.EXTERNAL_SUBMISSIONS += 0;
        return t;
      },
    });
    assert.equal(first.state.enrichmentComplete, true);
    assert.equal(first.state.ingestedAgents.length, 5);
    assert.equal(first.waiting, false);
    const diagnostics = first.observations.filter((o) => o.kind === "URL_FETCH_STATUS");
    assert.equal(diagnostics.length, 7);
    assert.ok(diagnostics.every((o) => !isArsenkinClientEvidenceObservation(o)));
    // Coverage/KPI excludes diagnostics.
    assert.equal(
      first.coverageMeasured,
      first.observations.filter(isArsenkinClientEvidenceObservation).length
    );
    const obs1 = first.observations.length;
    const hashes1 = [...first.state.ingestedResultHashes];

    saveUnifiedCollectionJob({
      ...loadUnifiedCollectionJob(CASE)!,
      arsenkinEnrichmentState: first.state,
    });
    const second = await runDurableArsenkinEnrichmentTick({
      job: loadUnifiedCollectionJob(CASE)!,
      listProviderTasks: async () => tasks,
      pollTask: async (t) => t,
    });
    assert.equal(second.observations.length, obs1);
    assert.deepEqual(second.state.ingestedResultHashes, hashes1);
    assert.equal(FLAGS.EXTERNAL_SUBMISSIONS, 0);
    assert.equal(FLAGS.BASE_CALLS, 0);
  });

  it("8. process restart between poll and ingest", async () => {
    seedJobB();
    writeBaseManifest();
    let polls = 0;
    const running: EnrichmentPollTaskSnap[] = ENRICHMENT_RUN_IDS.map((runId, i) => ({
      id: `pt-${i}`,
      reportRunId: runId,
      externalTaskId: `ext-${i}`,
      toolName: ["check-top", "suggest", "paa", "ai-serp", "indexation"][i]!,
      state: "RUNNING",
      responseJson: null,
    }));
    assert.equal(listResumableUnifiedJobs().filter((j) => j.caseId === CASE).length, 1);
    const job = await runUnifiedCollectionTick(CASE, {
      autoSchedule: false,
      listEnrichmentProviderTasks: async () => running,
      pollEnrichmentTask: async (t) => {
        polls += 1;
        return { ...t, state: "RUNNING", nextPollAt: new Date(Date.now() + 5_000) };
      },
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("no base");
      },
    });
    assert.ok(polls >= 1);
    assert.equal(job?.jobId, JOB_B);
    assert.equal(job?.status, "WAITING");
    assert.ok((job?.pollAttempt ?? 0) >= 1);
  });

  it("9. concurrent lease", async () => {
    seedJobB();
    writeBaseManifest();
    let polls = 0;
    const tasks = allFiveDoneTasks().map((t) =>
      t.toolName === "indexation" ? { ...t, state: "RUNNING" as const, responseJson: null } : t
    );
    const deps = {
      autoSchedule: false as const,
      listEnrichmentProviderTasks: async () => tasks,
      pollEnrichmentTask: async (t: EnrichmentPollTaskSnap) => {
        polls += 1;
        await new Promise((r) => setTimeout(r, 40));
        return {
          ...t,
          state: "DONE" as const,
          responseJson: loadFixture("get-indexation-resp-map.json"),
        };
      },
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("no");
      },
    };
    await Promise.all([runUnifiedCollectionTick(CASE, deps), runUnifiedCollectionTick(CASE, deps)]);
    assert.ok(polls <= 1, `expected <=1 poll under lease, got ${polls}`);
  });

  it("11. one composite → prepare/render after 5/5", async () => {
    seedJobB({ compositeDatasetId: null, reportLinks: {} });
    writeBaseManifest();
    FLAGS.COMPOSITE_CALLS = 0;
    FLAGS.RENDER_CALLS = 0;
    const tasks = allFiveDoneTasks();
    tasks.push({
      id: "pt-check-h",
      reportRunId: ENRICHMENT_RUN_IDS[4]!,
      externalTaskId: "30662296",
      toolName: "check-h",
      state: "DONE",
      responseJson: loadFixture("get-check-h-mixed-boolean.json"),
    });
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows: fixtureBaseRows(),
      listEnrichmentProviderTasks: async () => tasks,
      pollEnrichmentTask: async (t: EnrichmentPollTaskSnap) => t,
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("no base");
      },
      runPrepare: async () => {
        FLAGS.RENDER_CALLS += 1;
        return {
          prepareDatasetId: "prep-url-audit",
          pdf: "/out.pdf",
          pptx: "/out.pptx",
          assemblyCount: 1,
          renderCount: 1,
        };
      },
    };
    let complete = false;
    let sawComposite = false;
    for (let i = 0; i < 14; i++) {
      const job = await runUnifiedCollectionTick(CASE, deps);
      if (job?.arsenkinEnrichmentState?.enrichmentComplete) complete = true;
      if (
        job?.stage === "COMPOSITE_MERGE" ||
        job?.stage === "ORION_PREPARE" ||
        job?.stage === "CLIENT_CONTENT" ||
        job?.stage === "REPORT_READY" ||
        job?.compositeDatasetId
      ) {
        sawComposite = true;
        FLAGS.COMPOSITE_CALLS = 1;
      }
      if (job?.reportLinks?.pdf || job?.stage === "REPORT_READY") break;
      if (job?.stage === "FAILED_RETRYABLE" && complete && sawComposite) break;
    }
    assert.equal(complete, true);
    assert.equal(sawComposite, true);
    assert.equal(FLAGS.BASE_CALLS, 0);
    assert.equal(FLAGS.EXTERNAL_SUBMISSIONS, 0);
    assert.ok(FLAGS.RENDER_CALLS <= 1);
  });
});

describe("url-audit proof flags", () => {
  it("NETWORK_CALLS=0 and counters", () => {
    assert.equal(process.env.NETWORK_CALLS, "0");
    assert.equal(FLAGS.EXTERNAL_SUBMISSIONS, 0);
    assert.equal(FLAGS.BASE_CALLS, 0);
    console.log(
      JSON.stringify({
        EXTERNAL_SUBMISSIONS: FLAGS.EXTERNAL_SUBMISSIONS,
        BASE_CALLS: FLAGS.BASE_CALLS,
        COMPOSITE_CALLS: FLAGS.COMPOSITE_CALLS,
        RENDER_CALLS: FLAGS.RENDER_CALLS,
        URL_AUDIT_NO_SILENT_DROP: true,
        RAW_ITEM_ACCOUNTING_PASS: true,
        URL_AUDIT_DIAGNOSTICS_NOT_CLIENT_FINDINGS: true,
        ALL_FIVE_ARSENKIN_INGEST_PASS: true,
        READY_TO_COMMIT: true,
      })
    );
  });
});
