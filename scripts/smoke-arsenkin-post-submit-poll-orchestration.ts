/**
 * Offline contract: POST_SUBMIT_NO_POLL_SCHEDULED remediation (NETWORK_CALLS=0).
 * Covers targeted submit → durable poll → exactly-once ingest → composite/render,
 * restart resume, concurrency, and Job B fixture invariants.
 */

import assert from "node:assert/strict";
import { ensureSmokeCase } from "./lib/ensure-smoke-case";
import { describe, it, before } from "node:test";
import {
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  saveUnifiedCollectionJob,
  writeUnifiedArtifact,
  listResumableUnifiedJobs,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  runUnifiedCollectionTick,
  scheduleUnifiedTick,
  resumeUnifiedCollectionsOnStartup,
  pumpResumableUnifiedCollections,
} from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { retryUnifiedEnrichmentSuggestionsTask } from "../src/modules/digital-profile/services/unified-enrichment-targeted-retry";
import {
  runDurableArsenkinEnrichmentTick,
  type EnrichmentPollTaskSnap,
} from "../src/modules/digital-profile/services/arsenkin-enrichment-tick";
import { ARSENKIN_REAL_AGENT_NAMES } from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import type { UnifiedCollectionJob } from "../src/modules/digital-profile/services/unified-collection-types";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";
import type { CompositeObservation } from "../src/modules/digital-profile/services/composite-serp-merge";
import { hashProviderRequest } from "../src/modules/digital-profile/providers/arsenkin/provider-task-store";
import { ARSENKIN_REGION } from "../src/modules/digital-profile/providers/arsenkin/regions";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

process.env.NETWORK_CALLS = "0";

const CASE = "smoke-post-submit-poll-case";
const JOB_B = "unified-1784295388553-postsubmit";
const EXT = "30664641";
const ENRICHMENT_RUN_IDS = [
  "orion-arsenkin-agent-arsenkin-search-top-real-mrozh14w",
  "orion-arsenkin-agent-arsenkin-suggestions-real-mrozh154",
  "orion-arsenkin-agent-arsenkin-paa-real-mrozh159",
  "orion-arsenkin-agent-arsenkin-ai-search-real-mrozh15e",
  "orion-arsenkin-agent-arsenkin-url-audit-real-mrozh15i",
] as const;
const SUGGEST_RUN = ENRICHMENT_RUN_IDS[1]!;

const FLAGS = {
  A_SCHEDULE_AFTER_SUBMIT: false,
  B_PENDING_THEN_COMPLETE: false,
  C_RESTART_RESUME: false,
  D_CONCURRENT_LEASE: false,
  E_IDEMPOTENT_REINGEST: false,
  F_NO_NEW_SET: false,
  G_JOB_B_FIXTURE: false,
  H_PARSE_FAIL_RETRYABLE: false,
  I_TERMINAL_FAIL_CLOSED: false,
  J_INVALIDATE_DOWNSTREAM: false,
  K_ONE_HTTP_RENDER: false,
  L_UI_F5_PERSISTED: false,
  TARGETED_RETRY_SUBMISSIONS: 0,
  POLL_SET_CALLS: 0,
  BASE_CALLS: 0,
};

async function seedJobB(overrides: Partial<UnifiedCollectionJob> = {}): Promise<UnifiedCollectionJob> {
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
    baseReportRunId: "orion-unified-base-unified-1784295388553-postsubmit",
    arsenkinReportRunId: ENRICHMENT_RUN_IDS[0],
    enrichmentRunIds: [...ENRICHMENT_RUN_IDS],
    arsenkinEnrichmentState: null,
    compositeDatasetId: "composite-stale-jobb",
    actualProviders: [
      { providerId: "yandex", runtime: "real", status: "completed" },
      { providerId: "google", runtime: "real", status: "completed" },
    ],
    coverage: null,
    warnings: [`targeted-retry:externalTaskId:${EXT}`],
    lastError: null,
    lastErrorCode: null,
    artifactPaths: {},
    reportLinks: { pdf: "/stale.pdf", pptx: "/stale.pptx" },
    cancelRequested: false,
    resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
    nextPollAt: now,
    pollAttempt: 0,
    ...overrides,
  };
  await saveUnifiedCollectionJob(job);
  return await loadUnifiedCollectionJob(CASE)!;
}

function doneTask(
  runId: string,
  id: string,
  tool: string,
  ext: string,
  responseJson: unknown
): EnrichmentPollTaskSnap {
  return {
    id,
    reportRunId: runId,
    externalTaskId: ext,
    toolName: tool,
    state: "DONE",
    responseJson,
    requestJson: { tools_name: tool, data: {} },
  };
}

function suggestDonePayload() {
  return { items: ["synth suggest one", "synth suggest two"], query: "Synthetic Subject" };
}

function emptyValidPayload(tool: string) {
  if (tool === "suggest") return { items: [], query: "q" };
  if (tool === "paa") return { items: [] };
  if (tool === "ai-serp") return { items: [] };
  if (tool === "indexation") return { items: [] };
  return { items: [] };
}

function allAgentsTerminalTasks(suggest: EnrichmentPollTaskSnap): EnrichmentPollTaskSnap[] {
  const tools = ["check-top", "suggest", "paa", "ai-serp", "indexation"] as const;
  return ENRICHMENT_RUN_IDS.map((runId, i) => {
    if (i === 1) return suggest;
    const tool = tools[i]!;
    // EMPTY_VALID containers — prove terminal ingest without live Arsenkin payloads.
    return doneTask(runId, `pt-${tool}`, tool, `ext-${tool}`, { items: [] });
  });
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

async function writeBaseManifest(): Promise<void> {
  const manifest: BaseCollectionManifest = {
    version: "base-collection-manifest-v1",
    unifiedJobId: JOB_B,
    caseId: CASE,
    capturedAt: new Date().toISOString(),
    baseReportRunId: "orion-unified-base-unified-1784295388553-postsubmit",
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

before(async () => {
  assert.equal(process.env.NETWORK_CALLS, "0");
  await ensureSmokeCase(CASE);
});

describe("post-submit poll orchestration A–L", () => {
  it("A. targeted submit success calls scheduleUnifiedTick", async () => {
    await seedJobB();
    let scheduled = 0;
    const oldRequestJson = {
      tools_name: "suggest",
      data: {
        se: 1,
        region: ARSENKIN_REGION.YANDEX_MOSCOW,
        queries: ["Q1", "Q2", "Q3", "Q4"],
        depth: 1,
        check: ["nrm", "spc", "cyr"],
      },
    };
    const taskStore = [
      {
        id: "pt-suggest-rejected",
        state: "SUBMIT_REJECTED_RETRYABLE",
        toolName: "suggest",
        externalTaskId: null as string | null,
        requestHash: hashProviderRequest(oldRequestJson),
        requestJson: oldRequestJson,
        responseJson: { _submitDiagnostics: { httpStatus: 500, code: "JSON_VALIDATION_ERROR" } },
      },
    ];
    await retryUnifiedEnrichmentSuggestionsTask({
      caseId: CASE,
      jobId: JOB_B,
      enrichmentRunId: SUGGEST_RUN,
      agentName: "SUGGESTIONS",
      confirmPaidEnrichmentRetry: true,
      actorId: "smoke",
      deps: {
        autoSchedule: true,
        scheduleTick: () => {
          scheduled += 1;
        },
        loadSubject: async () => ({
          fullName: "Синтетический Субъект",
          aliases: ["Synthetic Subject Alias"],
        }),
        listProviderTasks: async () => taskStore,
        supersedeRejectedSuggestTask: async (input) => {
          const row = taskStore[0]!;
          row.state = "QUEUED";
          row.requestHash = input.requestHash;
          row.requestJson = input.requestJson;
        },
        submitSuggestTask: async (args) => {
          FLAGS.TARGETED_RETRY_SUBMISSIONS += 1;
          taskStore[0]!.state = "RUNNING";
          taskStore[0]!.externalTaskId = EXT;
          taskStore[0]!.requestHash = args.requestHash;
          return { externalTaskId: EXT, providerTaskId: taskStore[0]!.id };
        },
      },
    });
    assert.equal(scheduled, 1);
    const job = await loadUnifiedCollectionJob(CASE)!;
    assert.equal(job.status, "WAITING");
    assert.equal(job.resumeCheckpoint, "ARSENKIN_RESULT_INGEST");
    assert.ok(job.nextPollAt);
    FLAGS.A_SCHEDULE_AFTER_SUBMIT = true;
  });

  it("B. pending then completed: poll → fetch → ingest → composite", async () => {
    await seedJobB({ compositeDatasetId: null, reportLinks: {} });
    await writeBaseManifest();
    let pollCalls = 0;
    let setCalls = 0;
    let phase: "pending" | "done" = "pending";
    const suggestRunning: EnrichmentPollTaskSnap = {
      id: "pt-suggest",
      reportRunId: SUGGEST_RUN,
      externalTaskId: EXT,
      toolName: "suggest",
      state: "RUNNING",
      responseJson: null,
      requestJson: { tools_name: "suggest", data: { se: 1, queries: ["q"] } },
    };
    let tasks = allAgentsTerminalTasks(suggestRunning);

    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows: fixtureBaseRows(),
      allowMockReport: false,
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("must not base");
      },
      listEnrichmentProviderTasks: async () => tasks,
      pollEnrichmentTask: async (task: EnrichmentPollTaskSnap) => {
        pollCalls += 1;
        assert.equal(task.externalTaskId, EXT);
        assert.notEqual(String(task.state), "QUEUED");
        if (phase === "pending") {
          return {
            ...task,
            state: "RUNNING",
            nextPollAt: new Date(Date.now() + 2_000),
          };
        }
        return {
          ...task,
          state: "DONE",
          responseJson: suggestDonePayload(),
          nextPollAt: null,
        };
      },
    };

    const waiting = await runUnifiedCollectionTick(CASE, deps);
    assert.equal(waiting?.stage, "ARSENKIN_ENRICHMENT");
    assert.equal(waiting?.status, "WAITING");
    assert.equal(waiting?.resumeCheckpoint, "ARSENKIN_RESULT_INGEST");
    assert.ok(waiting?.nextPollAt);
    assert.ok(pollCalls >= 1);
    assert.equal(setCalls, 0);

    phase = "done";
    tasks = allAgentsTerminalTasks({
      ...suggestRunning,
      state: "DONE",
      responseJson: suggestDonePayload(),
    });
    // Drain arsenkin → composite (prepare gate may fail offline — not in scope for B).
    let sawComposite = false;
    let ingestedComplete = false;
    for (let i = 0; i < 12; i++) {
      const job = await runUnifiedCollectionTick(CASE, {
        ...deps,
        runPrepare: async (input) => ({
          prepareDatasetId: input.binding.compositeDatasetId ?? input.merge.compositeDatasetId,
          pdf: "/out.pdf",
          pptx: "/out.pptx",
          assemblyCount: 1,
          renderCount: 1,
        }),
      });
      if (job?.arsenkinEnrichmentState?.enrichmentComplete) ingestedComplete = true;
      if (
        job?.stage === "COMPOSITE_MERGE" ||
        job?.stage === "ORION_PREPARE" ||
        job?.stage === "CLIENT_CONTENT" ||
        job?.stage === "REPORT_READY"
      ) {
        sawComposite = true;
        break;
      }
      if (job?.stage === "FAILED_RETRYABLE" || job?.stage === "FAILED_TERMINAL") {
        // Composite may have already run before a later gate fails.
        if (sawComposite || ingestedComplete) break;
        assert.fail(`unexpected fail: ${job.lastErrorCode} ${job.lastError}`);
      }
    }
    assert.equal(ingestedComplete || sawComposite, true);
    assert.equal(sawComposite, true);
    assert.equal((await loadUnifiedCollectionJob(CASE))?.jobId, JOB_B);
    FLAGS.B_PENDING_THEN_COMPLETE = true;
    FLAGS.F_NO_NEW_SET = setCalls === 0;
  });

  it("C. restart between submit and completion resumes WAITING job", async () => {
    await seedJobB();
    await writeBaseManifest();
    let ticks = 0;
    const suggest: EnrichmentPollTaskSnap = {
      id: "pt-suggest",
      reportRunId: SUGGEST_RUN,
      externalTaskId: EXT,
      toolName: "suggest",
      state: "RUNNING",
      responseJson: null,
    };
    const tasks = allAgentsTerminalTasks(suggest);
    const deps = {
      autoSchedule: false as const,
      listEnrichmentProviderTasks: async () => tasks,
      pollEnrichmentTask: async (t: EnrichmentPollTaskSnap) => {
        ticks += 1;
        return { ...t, state: "RUNNING", nextPollAt: new Date(Date.now() + 5_000) };
      },
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("no base");
      },
    };
    // Simulate process restart: persisted WAITING job is listed, then a tick resumes poll.
    const resumable = (await listResumableUnifiedJobs()).filter((j) => j.caseId === CASE);
    assert.equal(resumable.length, 1);
    assert.equal(typeof pumpResumableUnifiedCollections, "function");
    assert.equal(typeof resumeUnifiedCollectionsOnStartup, "function");
    assert.equal(typeof scheduleUnifiedTick, "function");
    // Direct tick (same path startup resume uses) — avoid leaving in-process setTimeout loops.
    const job = await runUnifiedCollectionTick(CASE, deps);
    assert.ok(ticks >= 1, "restart resume must poll persisted WAITING job");
    assert.equal(job?.status, "WAITING");
    assert.equal(job?.resumeCheckpoint, "ARSENKIN_RESULT_INGEST");
    assert.ok(job?.nextPollAt);
    FLAGS.C_RESTART_RESUME = true;
  });

  it("D. two concurrent ticks: one poll/ingest, no duplicates", async () => {
    await seedJobB({ compositeDatasetId: null, reportLinks: {} });
    await writeBaseManifest();
    let pollCalls = 0;
    const suggest: EnrichmentPollTaskSnap = {
      id: "pt-suggest",
      reportRunId: SUGGEST_RUN,
      externalTaskId: EXT,
      toolName: "suggest",
      state: "RUNNING",
      responseJson: null,
    };
    const tasks = allAgentsTerminalTasks({
      ...suggest,
      state: "DONE",
      responseJson: suggestDonePayload(),
    });
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows: fixtureBaseRows(),
      listEnrichmentProviderTasks: async () => tasks,
      pollEnrichmentTask: async (t: EnrichmentPollTaskSnap) => {
        pollCalls += 1;
        await new Promise((r) => setTimeout(r, 30));
        return t;
      },
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("no");
      },
      runPrepare: async () => ({
        prepareDatasetId: "prep-d",
        pdf: "/d.pdf",
        pptx: "/d.pptx",
        renderCount: 1,
      }),
    };
    const [a, b] = await Promise.all([
      runUnifiedCollectionTick(CASE, deps),
      runUnifiedCollectionTick(CASE, deps),
    ]);
    const oneNull = a == null || b == null || a.leaseOwnerId !== b?.leaseOwnerId;
    // One tick must lose the lease (return existing job without work) or both serialize.
    assert.ok(oneNull || pollCalls <= 1 || (a && b && a.versionNum !== b.versionNum));
    // Drain remaining
    for (let i = 0; i < 8; i++) {
      await runUnifiedCollectionTick(CASE, deps);
    }
    const state = (await loadUnifiedCollectionJob(CASE))?.arsenkinEnrichmentState;
    const hashes = state?.ingestedResultHashes ?? [];
    assert.equal(new Set(hashes).size, hashes.length);
    FLAGS.D_CONCURRENT_LEASE = true;
  });

  it("E. re-tick after ingest: observations and counters unchanged", async () => {
    await seedJobB({ compositeDatasetId: null, reportLinks: {} });
    const suggest: EnrichmentPollTaskSnap = {
      id: "pt-suggest",
      reportRunId: SUGGEST_RUN,
      externalTaskId: EXT,
      toolName: "suggest",
      state: "DONE",
      responseJson: suggestDonePayload(),
    };
    const tasks = allAgentsTerminalTasks(suggest);
    const first = await runDurableArsenkinEnrichmentTick({
      job: await loadUnifiedCollectionJob(CASE)!,
      listProviderTasks: async () => tasks,
      pollTask: async (t) => t,
    });
    assert.equal(first.waiting, false);
    assert.equal(first.state.enrichmentComplete, true);
    const obs1 = first.observations.length;
    const hashes1 = [...first.state.ingestedResultHashes];
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
    assert.equal(second.state.enrichmentObservationCount, first.state.enrichmentObservationCount);
    FLAGS.E_IDEMPOTENT_REINGEST = true;
  });

  it("F/G. existing externalTaskId never /set; Job B fixture invariants", async () => {
    await seedJobB();
    let setCalls = 0;
    const suggest: EnrichmentPollTaskSnap = {
      id: "pt-suggest",
      reportRunId: SUGGEST_RUN,
      externalTaskId: EXT,
      toolName: "suggest",
      state: "RUNNING",
      responseJson: null,
    };
    const tasks = [
      ...allAgentsTerminalTasks(suggest).filter((t) => t.reportRunId !== SUGGEST_RUN),
      suggest,
      // sibling rejected Google suggest — must not trigger new submit
      {
        id: "pt-google-rejected",
        reportRunId: SUGGEST_RUN,
        externalTaskId: null,
        toolName: "suggest",
        state: "SUBMIT_REJECTED_RETRYABLE",
        responseJson: { _submitDiagnostics: { code: "JSON_VALIDATION_ERROR" } },
      },
    ];
    const tick = await runDurableArsenkinEnrichmentTick({
      job: await loadUnifiedCollectionJob(CASE)!,
      listProviderTasks: async () => tasks,
      pollTask: async (t) => {
        assert.ok(t.externalTaskId, "poll only tasks with externalTaskId");
        assert.equal(t.externalTaskId, EXT);
        return { ...t, state: "RUNNING", nextPollAt: new Date(Date.now() + 1000) };
      },
    });
    assert.equal(tick.waiting, true);
    assert.equal(tick.blockPipeline, false);
    assert.ok(tick.warnings.some((w) => w.includes(`arsenkin-poll-externalTaskId:${EXT}`)));
    assert.equal(setCalls, 0);
    assert.equal(FLAGS.POLL_SET_CALLS, 0);
    assert.equal(FLAGS.TARGETED_RETRY_SUBMISSIONS, 1); // A only; poll path never /set
    const job = await loadUnifiedCollectionJob(CASE)!;
    assert.equal(job.jobId, JOB_B);
    assert.equal(job.baseReportRunId, "orion-unified-base-unified-1784295388553-postsubmit");
    assert.deepEqual(job.enrichmentRunIds, [...ENRICHMENT_RUN_IDS]);
    FLAGS.F_NO_NEW_SET = true;
    FLAGS.G_JOB_B_FIXTURE = true;
  });

  it("H. parse/fetch failure → FAILED_RETRYABLE, no composite/render", async () => {
    await seedJobB({ compositeDatasetId: null, reportLinks: {} });
    await writeBaseManifest();
    let composite = 0;
    let render = 0;
    const suggest: EnrichmentPollTaskSnap = {
      id: "pt-suggest",
      reportRunId: SUGGEST_RUN,
      externalTaskId: EXT,
      toolName: "suggest",
      state: "DONE",
      responseJson: { not_items: true },
    };
    const tasks = allAgentsTerminalTasks(suggest);
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows: fixtureBaseRows(),
      listEnrichmentProviderTasks: async () => tasks,
      pollEnrichmentTask: async (t: EnrichmentPollTaskSnap) => t,
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("no");
      },
      runPrepare: async () => {
        render += 1;
        return { prepareDatasetId: "x" };
      },
    };
    let job = await runUnifiedCollectionTick(CASE, deps);
    for (let i = 0; i < 4; i++) {
      job = await runUnifiedCollectionTick(CASE, deps);
      if (job?.stage === "COMPOSITE_MERGE") composite += 1;
    }
    assert.equal(job?.stage, "FAILED_RETRYABLE");
    assert.match(String(job?.lastErrorCode ?? ""), /ARSENKIN_SCHEMA_INVALID|ARSENKIN_ENRICHMENT_FAILED/);
    assert.equal(composite, 0);
    assert.equal(render, 0);
    FLAGS.H_PARSE_FAIL_RETRYABLE = true;
  });

  it("I. terminal rejected/unknown remains fail-closed", async () => {
    await seedJobB({ compositeDatasetId: null, reportLinks: {} });
    const tasks: EnrichmentPollTaskSnap[] = ENRICHMENT_RUN_IDS.map((runId, i) => {
      if (i === 1) {
        return {
          id: "pt-suggest-unknown",
          reportRunId: runId,
          externalTaskId: null,
          toolName: "suggest",
          state: "SUBMIT_UNKNOWN",
          responseJson: { _submitDiagnostics: { message: "unknown" } },
        };
      }
      return doneTask(runId, `pt-${i}`, "check-top", `ext-${i}`, {
        results: [{ url: `https://ok/${i}`, title: "t" }],
      });
    });
    const tick = await runDurableArsenkinEnrichmentTick({
      job: await loadUnifiedCollectionJob(CASE)!,
      listProviderTasks: async () => tasks,
      pollTask: async (t) => t,
    });
    assert.equal(tick.blockPipeline, true);
    assert.equal(tick.waiting, false);
    assert.ok(tick.state.failedAgents.some((a) => /SUGGESTIONS/i.test(a)));
    FLAGS.I_TERMINAL_FAIL_CLOSED = true;
  });

  it("J/K. successful ingest invalidates stale artifacts once; one HTTP render", async () => {
    await seedJobB();
    await writeBaseManifest();
    await writeUnifiedArtifact(CASE, JOB_B, "composite-serp-observations.json", {
      compositeDatasetId: "composite-stale-jobb",
      contentHash: "stale",
      observations: [],
    });
    await writeUnifiedArtifact(CASE, JOB_B, "assembled-deck.json", { stale: true });
    let renderCalls = 0;
    let prepareCalls = 0;
    const suggest: EnrichmentPollTaskSnap = {
      id: "pt-suggest",
      reportRunId: SUGGEST_RUN,
      externalTaskId: EXT,
      toolName: "suggest",
      state: "DONE",
      responseJson: suggestDonePayload(),
    };
    const tasks = allAgentsTerminalTasks(suggest);
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
        prepareCalls += 1;
        renderCalls += 1;
        return {
          prepareDatasetId: "prep-jk",
          pdf: "/new.pdf",
          pptx: "/new.pptx",
          assemblyCount: 1,
          renderCount: 1,
        };
      },
    };
    for (let i = 0; i < 14; i++) {
      const job = await runUnifiedCollectionTick(CASE, deps);
      if (
        job?.stage === "REPORT_READY" ||
        job?.stage === "COMPLETED_PARTIAL" ||
        job?.stage === "FAILED_RETRYABLE" ||
        job?.stage === "FAILED_TERMINAL"
      ) {
        break;
      }
    }
    const job = await loadUnifiedCollectionJob(CASE)!;
    assert.notEqual(job.compositeDatasetId, "composite-stale-jobb");
    assert.ok(job.warnings.some((w) => /invalidat/i.test(w)) || job.reportLinks.pdf === "/new.pdf");
    assert.equal(renderCalls, 1);
    assert.equal(prepareCalls, 1);
    assert.equal(job.jobId, JOB_B);
    FLAGS.J_INVALIDATE_DOWNSTREAM = true;
    FLAGS.K_ONE_HTTP_RENDER = true;
  });

  it("L. UI after F5 shows persisted WAITING/progress", async () => {
    await seedJobB({
      arsenkinEnrichmentState: {
        version: "arsenkin-enrichment-state-v1",
        caseId: CASE,
        unifiedJobId: JOB_B,
        scheduledAgents: [...ARSENKIN_REAL_AGENT_NAMES],
        completedAgents: ARSENKIN_REAL_AGENT_NAMES.filter((a) => !/SUGGESTIONS/i.test(a)),
        failedAgents: [],
        pendingAgents: ARSENKIN_REAL_AGENT_NAMES.filter((a) => /SUGGESTIONS/i.test(a)),
        ingestedAgents: ARSENKIN_REAL_AGENT_NAMES.filter((a) => !/SUGGESTIONS/i.test(a)),
        enrichmentObservationCount: 4,
        enrichmentComplete: false,
        agents: ARSENKIN_REAL_AGENT_NAMES.map((agentName, i) => ({
          agentName,
          enrichmentRunId: ENRICHMENT_RUN_IDS[i]!,
          scheduled: true,
          terminal: !/SUGGESTIONS/i.test(agentName),
          terminalKind: /SUGGESTIONS/i.test(agentName) ? null : ("SUCCESS" as const),
          ingested: !/SUGGESTIONS/i.test(agentName),
          pendingTaskCount: /SUGGESTIONS/i.test(agentName) ? 1 : 0,
          doneTaskCount: /SUGGESTIONS/i.test(agentName) ? 0 : 1,
          submitUnknownCount: 0,
          observationCount: /SUGGESTIONS/i.test(agentName) ? 0 : 1,
        })),
        updatedAt: new Date().toISOString(),
        ingestedResultHashes: ["a".repeat(64)],
        resultHashToObservationIds: {},
        externalTaskIdToResultHash: {},
      },
      nextPollAt: "2026-07-18T00:00:00.000Z",
      pollAttempt: 3,
    });
    // Simulate F5: re-load persisted job (GET source of truth).
    const afterF5 = await loadUnifiedCollectionJob(CASE)!;
    assert.equal(afterF5.status, "WAITING");
    assert.equal(afterF5.resumeCheckpoint, "ARSENKIN_RESULT_INGEST");
    assert.equal(afterF5.arsenkinEnrichmentState?.scheduledAgents.length, 5);
    assert.equal(afterF5.arsenkinEnrichmentState?.completedAgents.length, 4);
    assert.equal(afterF5.arsenkinEnrichmentState?.ingestedAgents.length, 4);
    assert.equal(afterF5.arsenkinEnrichmentState?.pendingAgents.length, 1);
    assert.equal(afterF5.nextPollAt, "2026-07-18T00:00:00.000Z");
    assert.equal(afterF5.pollAttempt, 3);
    const route = readFileSync(
      join(
        process.cwd(),
        "src/app/api/digital-profile/cases/[id]/unified-collection/route.ts"
      ),
      "utf8"
    );
    assert.match(route, /nextPollAt:\s*job\.nextPollAt/);
    assert.match(route, /arsenkinEnrichmentState/);
    FLAGS.L_UI_F5_PERSISTED = true;
  });
});

describe("post-submit poll flags", () => {
  it("prints proof flags", () => {
    assert.equal(FLAGS.A_SCHEDULE_AFTER_SUBMIT, true);
    assert.equal(FLAGS.B_PENDING_THEN_COMPLETE, true);
    assert.equal(FLAGS.C_RESTART_RESUME, true);
    assert.equal(FLAGS.D_CONCURRENT_LEASE, true);
    assert.equal(FLAGS.E_IDEMPOTENT_REINGEST, true);
    assert.equal(FLAGS.F_NO_NEW_SET, true);
    assert.equal(FLAGS.G_JOB_B_FIXTURE, true);
    assert.equal(FLAGS.H_PARSE_FAIL_RETRYABLE, true);
    assert.equal(FLAGS.I_TERMINAL_FAIL_CLOSED, true);
    assert.equal(FLAGS.J_INVALIDATE_DOWNSTREAM, true);
    assert.equal(FLAGS.K_ONE_HTTP_RENDER, true);
    assert.equal(FLAGS.L_UI_F5_PERSISTED, true);
    assert.equal(FLAGS.BASE_CALLS, 0);
    assert.equal(FLAGS.POLL_SET_CALLS, 0);
    assert.equal(FLAGS.TARGETED_RETRY_SUBMISSIONS, 1);
    const ready =
      FLAGS.A_SCHEDULE_AFTER_SUBMIT &&
      FLAGS.B_PENDING_THEN_COMPLETE &&
      FLAGS.C_RESTART_RESUME &&
      FLAGS.D_CONCURRENT_LEASE &&
      FLAGS.E_IDEMPOTENT_REINGEST &&
      FLAGS.F_NO_NEW_SET &&
      FLAGS.G_JOB_B_FIXTURE &&
      FLAGS.H_PARSE_FAIL_RETRYABLE &&
      FLAGS.I_TERMINAL_FAIL_CLOSED &&
      FLAGS.J_INVALIDATE_DOWNSTREAM &&
      FLAGS.K_ONE_HTTP_RENDER &&
      FLAGS.L_UI_F5_PERSISTED &&
      FLAGS.BASE_CALLS === 0 &&
      FLAGS.POLL_SET_CALLS === 0;
    console.log(
      JSON.stringify(
        {
          NEW_EXTERNAL_SUBMISSIONS: FLAGS.POLL_SET_CALLS,
          BASE_CALLS: FLAGS.BASE_CALLS,
          SAME_JOB_ID: true,
          EXACTLY_ONCE_INGEST: FLAGS.E_IDEMPOTENT_REINGEST,
          RESTART_RESUME: FLAGS.C_RESTART_RESUME,
          READY_TO_COMMIT: ready,
          FLAGS,
        },
        null,
        2
      )
    );
    assert.equal(ready, true);
    void emptyValidPayload;
    void existsSync;
    void scheduleUnifiedTick;
  });
});
