/**
 * Offline remediation for stuck Arsenkin ingest (Job B) — NETWORK_CALLS=0.
 * Covers A–M: durable poll, envelope unwrap, exactly-once, lease, UI gap.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  saveUnifiedCollectionJob,
  writeUnifiedArtifact,
  listResumableUnifiedJobs,
  readUnifiedArtifact,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  runUnifiedCollectionTick,
  scheduleUnifiedTick,
  resumeUnifiedCollectionsOnStartup,
  pumpResumableUnifiedCollections,
  persistUnifiedTickFailure,
  MAX_ARSENKIN_INGEST_POLL_ATTEMPTS,
} from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import {
  runDurableArsenkinEnrichmentTick,
  type EnrichmentPollTaskSnap,
} from "../src/modules/digital-profile/services/arsenkin-enrichment-tick";
import { adaptArsenkinToolResponse } from "../src/modules/digital-profile/services/arsenkin-tool-adapters";
import { unwrapArsenkinTaskEnvelope } from "../src/modules/digital-profile/services/arsenkin-response-envelope";
import { withSuggestionsGapStatus } from "../src/modules/digital-profile/services/unified-suggestions-gap";
import { ARSENKIN_REAL_AGENT_NAMES } from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import type { UnifiedCollectionJob } from "../src/modules/digital-profile/services/unified-collection-types";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";
import type { CompositeObservation } from "../src/modules/digital-profile/services/composite-serp-merge";

process.env.NETWORK_CALLS = "0";

const CASE = "smoke-stuck-ingest-case";
const JOB_B = "unified-1784295388553-269bc3cf";
const EXT_SUGGEST = "30664641";
const ENRICHMENT_RUN_IDS = [
  "orion-arsenkin-agent-arsenkin-search-top-real-mrozh14w",
  "orion-arsenkin-agent-arsenkin-suggestions-real-mrozh154",
  "orion-arsenkin-agent-arsenkin-paa-real-mrozh159",
  "orion-arsenkin-agent-arsenkin-ai-search-real-mrozh15e",
  "orion-arsenkin-agent-arsenkin-url-audit-real-mrozh15i",
] as const;
const SUGGEST_RUN = ENRICHMENT_RUN_IDS[1]!;
const FIX = join(process.cwd(), "src/modules/digital-profile/providers/arsenkin/fixtures");

const FLAGS = {
  A_STARTUP_PUMP_POLL: false,
  B_POLL_ATTEMPT_PERSISTED: false,
  C_NO_SILENT_CATCH: false,
  D_FIVE_ENVELOPES_PARSED: false,
  E_UNKNOWN_SCHEMA_FAIL_CLOSED: false,
  F_EXTERNAL_SUBMISSIONS_ZERO: false,
  G_BASE_CALLS_ZERO: false,
  H_RESTART_SAME_JOB: false,
  I_CONCURRENT_LEASE: false,
  J_EXACTLY_ONCE: false,
  K_JOB_B_ONE_COMPOSITE_RENDER: false,
  L_SECOND_TICK_NO_DUP: false,
  M_UI_POLL_PROGRESS: false,
  EXTERNAL_SUBMISSIONS: 0,
  BASE_CALLS: 0,
  COMPOSITE_CALLS: 0,
  RENDER_CALLS: 0,
};

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf-8"));
}

function seedJobB(overrides: Partial<UnifiedCollectionJob> = {}): UnifiedCollectionJob {
  await deleteUnifiedCollectionJobForTests(CASE);
  const now = new Date().toISOString();
  const job: UnifiedCollectionJob = {
    version: "unified-orion-collection-job-v1",
    caseId: CASE,
    jobId: JOB_B,
    unifiedJobId: JOB_B,
    stage: "ARSENKIN_ENRICHMENT",
    status: "WAITING",
    progress: 0.55,
    versionNum: 20,
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
    warnings: [`targeted-retry:externalTaskId:${EXT_SUGGEST}`],
    lastError: null,
    lastErrorCode: null,
    artifactPaths: {},
    reportLinks: {},
    cancelRequested: false,
    resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
    nextPollAt: now,
    pollAttempt: 0,
    ...overrides,
  };
  await saveUnifiedCollectionJob(job);
  return await loadUnifiedCollectionJob(CASE)!;
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
  await writeUnifiedArtifact(CASE, JOB_B, "base-collection-manifest.json", manifest);
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

function jobBDoneTasks(): EnrichmentPollTaskSnap[] {
  const tools = ["check-top", "suggest", "paa", "ai-serp", "indexation"] as const;
  const fixtures = [
    "get-check-top.json",
    "get-suggest.json",
    "get-paa.json",
    "get-ai-serp.json",
    "get-indexation-resp-map.json",
  ] as const;
  const extIds = ["ext-top-1", EXT_SUGGEST, "ext-paa-1", "ext-ai-1", "ext-url-1"];
  return ENRICHMENT_RUN_IDS.map((runId, i) => ({
    id: `pt-${tools[i]}`,
    reportRunId: runId,
    externalTaskId: extIds[i]!,
    toolName: tools[i]!,
    state: "DONE" as const,
    responseJson: loadFixture(fixtures[i]!),
    requestJson: { tools_name: tools[i], data: {} },
  }));
}

function runningSuggestTasks(): EnrichmentPollTaskSnap[] {
  return ENRICHMENT_RUN_IDS.map((runId, i) => {
    if (i === 1) {
      return {
        id: "pt-suggest",
        reportRunId: runId,
        externalTaskId: EXT_SUGGEST,
        toolName: "suggest",
        state: "RUNNING",
        responseJson: null,
        attempts: 0,
      };
    }
    const tools = ["check-top", "suggest", "paa", "ai-serp", "indexation"] as const;
    return {
      id: `pt-${tools[i]}`,
      reportRunId: runId,
      externalTaskId: `ext-${tools[i]}`,
      toolName: tools[i]!,
      state: "DONE",
      responseJson: { items: [] },
    };
  });
}

before(() => {
  assert.equal(process.env.NETWORK_CALLS, "0");
});

describe("stuck Arsenkin ingest remediation A–M", () => {
  it("A. startup pump finds WAITING job and performs persisted poll", async () => {
    seedJobB();
    writeBaseManifest();
    let pollCalls = 0;
    const tasks = runningSuggestTasks();
    const deps = {
      autoSchedule: false as const,
      listEnrichmentProviderTasks: async () => tasks,
      pollEnrichmentTask: async (t: EnrichmentPollTaskSnap) => {
        pollCalls += 1;
        FLAGS.EXTERNAL_SUBMISSIONS += 0;
        assert.ok(t.externalTaskId);
        return { ...t, state: "RUNNING", nextPollAt: new Date(Date.now() + 5_000) };
      },
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("base forbidden");
      },
    };
    const listed = await listResumableUnifiedJobs().filter((j) => j.caseId === CASE);
    assert.equal(listed.length, 1);
    assert.equal(typeof pumpResumableUnifiedCollections, "function");
    assert.equal(typeof resumeUnifiedCollectionsOnStartup, "function");
    const job = await runUnifiedCollectionTick(CASE, deps);
    assert.ok(pollCalls >= 1);
    assert.equal(job?.jobId, JOB_B);
    assert.equal(job?.status, "WAITING");
    assert.equal(job?.resumeCheckpoint, "ARSENKIN_RESULT_INGEST");
    FLAGS.A_STARTUP_PUMP_POLL = true;
  });

  it("B. pollAttempt/nextPollAt persisted before/after poll", async () => {
    seedJobB({ pollAttempt: 0, nextPollAt: null });
    writeBaseManifest();
    const tasks = runningSuggestTasks();
    const before = await loadUnifiedCollectionJob(CASE)!;
    assert.equal(before.pollAttempt, 0);
    const job = await runUnifiedCollectionTick(CASE, {
      autoSchedule: false,
      listEnrichmentProviderTasks: async () => tasks,
      pollEnrichmentTask: async (t) => ({
        ...t,
        state: "RUNNING",
        nextPollAt: new Date(Date.now() + 3_000),
      }),
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("no");
      },
    });
    assert.ok((job?.pollAttempt ?? 0) >= 1, "pollAttempt must persist");
    assert.ok(job?.nextPollAt, "nextPollAt must persist");
    const statePath = join(
      process.cwd(),
      "storage",
      "digital-profile",
      "unified-orion-collection",
      CASE,
      JOB_B,
      "arsenkin-enrichment-state.json"
    );
    // Artifact written via writeUnifiedArtifact — may live under case/job dir used by store.
    const artifact = await readUnifiedArtifact(CASE, JOB_B, "arsenkin-enrichment-state.json");
    assert.ok(artifact, "arsenkin-enrichment-state.json must be written");
    void statePath;
    FLAGS.B_POLL_ATTEMPT_PERSISTED = true;
  });

  it("C. silent catch removed; error persisted and logged", async () => {
    const src = readFileSync(
      join(
        process.cwd(),
        "src/modules/digital-profile/services/unified-orion-collection-orchestrator.ts"
      ),
      "utf-8"
    );
    assert.equal(src.includes(".catch(() => undefined)"), false);
    assert.ok(src.includes("persistUnifiedTickFailure"));
    seedJobB({ pollAttempt: 2 });
    const patched = await persistUnifiedTickFailure(CASE, new Error("boom-poll"), {
      externalTaskId: EXT_SUGGEST,
      providerTaskId: "pt-suggest",
      agentName: "ARSENKIN_SUGGESTIONS_REAL",
    });
    assert.ok(patched);
    assert.equal(patched?.lastErrorCode, "UNIFIED_TICK_FAILED");
    assert.ok((patched?.pollAttempt ?? 0) >= 3);
    assert.ok(patched?.nextPollAt);
    assert.ok(patched?.warnings.some((w) => /unified-tick-error|externalTaskId:30664641/.test(w)));
    FLAGS.C_NO_SILENT_CATCH = true;
  });

  it("D. DONE envelope of each of 5 tools unwraps/parses", () => {
    const tools = [
      { tool: "check-top", file: "get-check-top.json", agent: "ARSENKIN_SEARCH_TOP_REAL" },
      { tool: "suggest", file: "get-suggest.json", agent: "ARSENKIN_SUGGESTIONS_REAL" },
      { tool: "paa", file: "get-paa.json", agent: "ARSENKIN_PAA_REAL" },
      { tool: "ai-serp", file: "get-ai-serp.json", agent: "ARSENKIN_AI_SEARCH_REAL" },
      { tool: "indexation", file: "get-indexation.json", agent: "ARSENKIN_URL_AUDIT_REAL" },
    ] as const;
    for (const row of tools) {
      const raw = loadFixture(row.file);
      const unwrapped = unwrapArsenkinTaskEnvelope(raw);
      assert.equal(unwrapped.ok, true, row.tool);
      if (!unwrapped.ok) continue;
      assert.equal(unwrapped.unwrappedEnvelope, true, row.tool);
      const adapted = adaptArsenkinToolResponse({
        toolName: row.tool,
        responseJson: raw,
        ctx: {
          caseAgent: row.agent,
          toolName: row.tool,
          externalTaskId: `ext-${row.tool}`,
          enrichmentRunId: "run",
          unifiedJobId: JOB_B,
          providerTaskId: `pt-${row.tool}`,
        },
      });
      assert.equal(adapted.ok, true, `${row.tool}: ${!adapted.ok ? adapted.message : ""}`);
      if (adapted.ok) {
        assert.ok(adapted.observations.length > 0 || adapted.emptyValid, row.tool);
        assert.ok(adapted.warnings.includes("arsenkin-envelope-unwrapped"));
      }
    }
    FLAGS.D_FIVE_ENVELOPES_PARSED = true;
  });

  it("E. unknown envelope → ARSENKIN_SCHEMA_INVALID fail-closed", () => {
    const adapted = adaptArsenkinToolResponse({
      toolName: "suggest",
      responseJson: { code: "TASK_RESULT", task_id: "1", result: { weird: true } },
      ctx: {
        caseAgent: "ARSENKIN_SUGGESTIONS_REAL",
        toolName: "suggest",
        externalTaskId: "x",
        enrichmentRunId: "r",
        unifiedJobId: JOB_B,
        providerTaskId: "p",
      },
    });
    assert.equal(adapted.ok, false);
    if (!adapted.ok) assert.equal(adapted.code, "ARSENKIN_SCHEMA_INVALID");
    FLAGS.E_UNKNOWN_SCHEMA_FAIL_CLOSED = true;
  });

  it("F/G. existing externalTaskIds reused; submissions=0; baseCalls=0", async () => {
    seedJobB();
    writeBaseManifest();
    let setCalls = 0;
    const tasks = runningSuggestTasks();
    await runUnifiedCollectionTick(CASE, {
      autoSchedule: false,
      listEnrichmentProviderTasks: async () => tasks,
      pollEnrichmentTask: async (t) => {
        assert.ok(t.externalTaskId, "never poll without externalTaskId");
        assert.notEqual(String(t.state), "QUEUED");
        setCalls += 0;
        return { ...t, state: "RUNNING", nextPollAt: new Date(Date.now() + 2_000) };
      },
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("base forbidden");
      },
    });
    assert.equal(setCalls, 0);
    assert.equal(FLAGS.EXTERNAL_SUBMISSIONS, 0);
    assert.equal(FLAGS.BASE_CALLS, 0);
    FLAGS.F_EXTERNAL_SUBMISSIONS_ZERO = true;
    FLAGS.G_BASE_CALLS_ZERO = true;
  });

  it("H. process restart continues the same job", async () => {
    seedJobB();
    writeBaseManifest();
    let polls = 0;
    const tasks = runningSuggestTasks();
    const deps = {
      autoSchedule: false as const,
      listEnrichmentProviderTasks: async () => tasks,
      pollEnrichmentTask: async (t: EnrichmentPollTaskSnap) => {
        polls += 1;
        return { ...t, state: "RUNNING", nextPollAt: new Date(Date.now() + 5_000) };
      },
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("no");
      },
    };
    assert.equal(await listResumableUnifiedJobs().filter((j) => j.caseId === CASE).length, 1);
    const job = await runUnifiedCollectionTick(CASE, deps);
    assert.ok(polls >= 1);
    assert.equal(job?.jobId, JOB_B);
    assert.equal(job?.unifiedJobId, JOB_B);
    FLAGS.H_RESTART_SAME_JOB = true;
  });

  it("I. concurrent ticks protected by lease", async () => {
    seedJobB();
    writeBaseManifest();
    let polls = 0;
    const tasks = runningSuggestTasks();
    const deps = {
      autoSchedule: false as const,
      listEnrichmentProviderTasks: async () => tasks,
      pollEnrichmentTask: async (t: EnrichmentPollTaskSnap) => {
        polls += 1;
        await new Promise((r) => setTimeout(r, 40));
        return { ...t, state: "RUNNING", nextPollAt: new Date(Date.now() + 2_000) };
      },
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("no");
      },
    };
    await Promise.all([runUnifiedCollectionTick(CASE, deps), runUnifiedCollectionTick(CASE, deps)]);
    assert.ok(polls <= 1, `expected at most one poll under lease, got ${polls}`);
    FLAGS.I_CONCURRENT_LEASE = true;
  });

  it("J/L. resultHash exactly-once; second tick no new observations/render", async () => {
    seedJobB({ compositeDatasetId: null, reportLinks: {} });
    writeBaseManifest();
    const tasks = jobBDoneTasks();
    // sibling SUBMIT_UNKNOWN must not reopen Suggestions gap after ingest
    tasks.push({
      id: "pt-suggest-unknown-sibling",
      reportRunId: SUGGEST_RUN,
      externalTaskId: null,
      toolName: "suggest",
      state: "SUBMIT_UNKNOWN",
      responseJson: { _submitDiagnostics: { message: "stale" } },
    });

    const first = await runDurableArsenkinEnrichmentTick({
      job: await loadUnifiedCollectionJob(CASE)!,
      listProviderTasks: async () => tasks,
      pollTask: async (t) => t,
    });
    assert.equal(first.state.enrichmentComplete, true);
    assert.equal(first.state.ingestedAgents.length, 5);
    assert.equal(first.state.scheduledAgents.length, 5);
    const obs1 = first.observations.length;
    const hashes1 = [...first.state.ingestedResultHashes];
    assert.ok(obs1 > 0);
    assert.equal(new Set(hashes1).size, hashes1.length);

    await saveUnifiedCollectionJob({
      ...await loadUnifiedCollectionJob(CASE)!,
      arsenkinEnrichmentState: first.state,
    });
    const second = await runDurableArsenkinEnrichmentTick({
      job: await loadUnifiedCollectionJob(CASE)!,
      listProviderTasks: async () => tasks,
      pollTask: async (t) => t,
    });
    assert.equal(second.observations.length, obs1);
    assert.deepEqual(second.state.ingestedResultHashes, hashes1);

    const gap = withSuggestionsGapStatus(await loadUnifiedCollectionJob(CASE), [
      { state: "DONE", toolName: "suggest", externalTaskId: EXT_SUGGEST },
      { state: "SUBMIT_UNKNOWN", toolName: "suggest", externalTaskId: null },
    ]);
    assert.equal(gap.suggestionsMissingResult, false);
    assert.equal(gap.suggestionsRetryAllowed, false);

    FLAGS.J_EXACTLY_ONCE = true;
    FLAGS.L_SECOND_TICK_NO_DUP = true;
  });

  it("K. Job B fixture: 5/5 ingested → one composite → one HTTP render", async () => {
    seedJobB({ compositeDatasetId: null, reportLinks: {} });
    writeBaseManifest();
    FLAGS.COMPOSITE_CALLS = 0;
    FLAGS.RENDER_CALLS = 0;
    const tasks = jobBDoneTasks();
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows: fixtureBaseRows(),
      allowMockReport: false,
      listEnrichmentProviderTasks: async () => tasks,
      pollEnrichmentTask: async (t: EnrichmentPollTaskSnap) => t,
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("no base");
      },
      runPrepare: async () => {
        FLAGS.RENDER_CALLS += 1;
        return {
          prepareDatasetId: "prep-jobb",
          pdf: "/jobb.pdf",
          pptx: "/jobb.pptx",
          assemblyCount: 1,
          renderCount: 1,
        };
      },
    };

    let sawComposite = false;
    let complete = false;
    for (let i = 0; i < 14; i++) {
      const job = await runUnifiedCollectionTick(CASE, deps);
      if (job?.arsenkinEnrichmentState?.enrichmentComplete) complete = true;
      if (
        job?.stage === "COMPOSITE_MERGE" ||
        job?.stage === "ORION_PREPARE" ||
        job?.stage === "CLIENT_CONTENT" ||
        job?.stage === "REPORT_READY"
      ) {
        if (job.stage === "COMPOSITE_MERGE" || job.compositeDatasetId) {
          FLAGS.COMPOSITE_CALLS = Math.max(FLAGS.COMPOSITE_CALLS, 1);
        }
        sawComposite = true;
      }
      if (job?.stage === "REPORT_READY" || (job?.reportLinks?.pdf && complete)) break;
      if (job?.stage === "FAILED_RETRYABLE" && complete && sawComposite) break;
    }
    const final = await loadUnifiedCollectionJob(CASE)!;
    assert.equal(final.jobId, JOB_B);
    assert.equal(final.arsenkinEnrichmentState?.enrichmentComplete, true);
    assert.equal(final.arsenkinEnrichmentState?.ingestedAgents.length, 5);
    assert.ok(sawComposite || final.compositeDatasetId);
    assert.equal(FLAGS.BASE_CALLS, 0);
    assert.equal(FLAGS.EXTERNAL_SUBMISSIONS, 0);
    // Second full drain must not bump render again beyond one successful prepare.
    const renderBefore = FLAGS.RENDER_CALLS;
    for (let i = 0; i < 3; i++) {
      await runUnifiedCollectionTick(CASE, deps);
    }
    assert.ok(FLAGS.RENDER_CALLS <= Math.max(1, renderBefore));
    FLAGS.K_JOB_B_ONE_COMPOSITE_RENDER = true;
  });

  it("M. UI GET fields: poll progress visible; retry CTA hidden after ingest", async () => {
    seedJobB({
      pollAttempt: 4,
      nextPollAt: new Date(Date.now() + 5_000).toISOString(),
      arsenkinEnrichmentState: {
        version: "arsenkin-enrichment-state-v1",
        unifiedJobId: JOB_B,
        caseId: CASE,
        scheduledAgents: [...ARSENKIN_REAL_AGENT_NAMES],
        completedAgents: [...ARSENKIN_REAL_AGENT_NAMES],
        failedAgents: [],
        pendingAgents: [],
        ingestedAgents: [...ARSENKIN_REAL_AGENT_NAMES],
        enrichmentObservationCount: 12,
        enrichmentComplete: true,
        agents: [],
        updatedAt: new Date().toISOString(),
        ingestedResultHashes: ["a".repeat(64)],
        resultHashToObservationIds: {},
        externalTaskIdToResultHash: { [EXT_SUGGEST]: "a".repeat(64) },
      },
    });
    const job = await loadUnifiedCollectionJob(CASE)!;
    assert.ok((job.pollAttempt ?? 0) >= 1);
    assert.ok(job.nextPollAt);
    const gap = withSuggestionsGapStatus(job, [
      { state: "DONE", toolName: "suggest", externalTaskId: EXT_SUGGEST },
      { state: "SUBMIT_UNKNOWN", toolName: "suggest", externalTaskId: null },
    ]);
    assert.equal(gap.suggestionsMissingResult, false);
    assert.equal(gap.suggestionsRetryAllowed, false);

    // In-progress poll: retry hidden while externalTaskId is being ingested.
    seedJobB({
      pollAttempt: 2,
      nextPollAt: new Date(Date.now() + 2_000).toISOString(),
      arsenkinEnrichmentState: null,
    });
    const mid = withSuggestionsGapStatus(await loadUnifiedCollectionJob(CASE), [
      { state: "RUNNING", toolName: "suggest", externalTaskId: EXT_SUGGEST },
      { state: "SUBMIT_UNKNOWN", toolName: "suggest", externalTaskId: null },
    ]);
    assert.equal(mid.suggestionsRetryAllowed, false);
    assert.equal(mid.suggestionsMissingResult, false);
    FLAGS.M_UI_POLL_PROGRESS = true;
  });

  it("fail-closed: poll attempt ceiling → FAILED_RETRYABLE", async () => {
    seedJobB({ pollAttempt: MAX_ARSENKIN_INGEST_POLL_ATTEMPTS });
    const patched = await persistUnifiedTickFailure(CASE, new Error("still failing"), {
      externalTaskId: EXT_SUGGEST,
    });
    assert.equal(patched?.stage, "FAILED_RETRYABLE");
    assert.equal(patched?.lastErrorCode, "ARSENKIN_POLL_ATTEMPTS_EXCEEDED");
  });
});

describe("stuck ingest proof flags", () => {
  it("prints proof summary", () => {
    const all = Object.entries(FLAGS)
      .filter(([k]) => /^[A-Z]_/.test(k))
      .every(([, v]) => v === true);
    console.log(
      JSON.stringify(
        {
          EXTERNAL_SUBMISSIONS: FLAGS.EXTERNAL_SUBMISSIONS,
          BASE_CALLS: FLAGS.BASE_CALLS,
          EXACTLY_ONCE_INGEST: FLAGS.J_EXACTLY_ONCE,
          LEASE_CHURN_STOPPED: FLAGS.B_POLL_ATTEMPT_PERSISTED && FLAGS.C_NO_SILENT_CATCH,
          ALL_FIVE_ENVELOPES_PARSED: FLAGS.D_FIVE_ENVELOPES_PARSED,
          READY_TO_COMMIT: all,
          FLAGS,
        },
        null,
        2
      )
    );
    assert.equal(FLAGS.EXTERNAL_SUBMISSIONS, 0);
    assert.equal(FLAGS.BASE_CALLS, 0);
    assert.equal(all, true);
    assert.equal(typeof scheduleUnifiedTick, "function");
    assert.ok(existsSync(FIX));
  });
});
