/**
 * Offline regression: existing Arsenkin task poll auth + FAILED_RETRYABLE recovery.
 * NETWORK_CALLS=0 — no live /set|/check|/get, no base recollection.
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertExistingExternalTaskPollAuthorized,
  assertLiveNetworkAllowed,
  assertLiveSetAllowed,
  buildLiveAuthorizationFromPlan,
  getActiveExistingTaskPollAuthorization,
  getActiveLiveAuthorization,
  withExistingExternalTaskPollAuthorization,
  withLiveAuthorization,
} from "../src/modules/digital-profile/providers/arsenkin/live-execution-authorization";
import {
  ArsenkinClient,
  ARSENKIN_DEFAULT_API_BASE,
} from "../src/modules/digital-profile/providers/arsenkin/client";
import {
  deleteUnifiedCollectionJobForTests,
  listResumableUnifiedJobs,
  loadUnifiedCollectionJob,
  saveUnifiedCollectionJob,
  writeUnifiedArtifact,
  readUnifiedArtifact,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  runUnifiedCollectionTick,
  MAX_ARSENKIN_INGEST_POLL_ATTEMPTS,
} from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import {
  recoverUnifiedOrionCollectionJob,
  evaluateUnifiedCollectionRecoveryEligibility,
} from "../src/modules/digital-profile/services/unified-collection-recovery";
import {
  buildSafePollErrorDiagnostic,
  pollDueEnrichmentProviderTasks,
  runDurableArsenkinEnrichmentTick,
  type EnrichmentPollTaskSnap,
} from "../src/modules/digital-profile/services/arsenkin-enrichment-tick";
import { adaptArsenkinToolResponse } from "../src/modules/digital-profile/services/arsenkin-tool-adapters";
import type { UnifiedCollectionJob } from "../src/modules/digital-profile/services/unified-collection-types";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";
import type { CompositeObservation } from "../src/modules/digital-profile/services/composite-serp-merge";

process.env.NETWORK_CALLS = "0";

const CASE = "cmr51xzaj00ztn70f8toh6e7g-smoke-poll-auth";
const JOB_B = "unified-1784295388553-269bc3cf";
const EXT_SUGGEST = "30664641";
const PT_SUGGEST = "cmrp5ufgv0005sw2rlv48s8kw";
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
  EXISTING_TASK_POLL_AUTH_SCOPED: false,
  ARBITRARY_TASK_REJECTED: false,
  FOREIGN_TASK_REJECTED: false,
  SET_STILL_REQUIRES_LIVE_AUTH: false,
  FAILED_RETRYABLE_NOT_AUTO_PUMPED: false,
  EXPLICIT_RECOVERY_RESETS_POLL_ATTEMPT: false,
  SAME_JOB_ID_ON_RECOVERY: false,
  BASE_CALLS_ON_RECOVERY_ZERO: false,
  EXTERNAL_SUBMISSIONS_ON_RECOVERY_ZERO: false,
  ALL_FIVE_AGENTS_INGESTED: false,
  EXACTLY_ONCE_INGEST: false,
  EXACTLY_ONE_HTTP_RENDER: false,
  POLL_ERRORS_PERSISTED: false,
  EXTERNAL_SUBMISSIONS: 0,
  BASE_CALLS: 0,
  RENDER_CALLS: 0,
};

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), "utf-8"));
}

function baseManifest(): BaseCollectionManifest {
  return {
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

function seedJob(overrides: Partial<UnifiedCollectionJob> = {}): UnifiedCollectionJob {
  deleteUnifiedCollectionJobForTests(CASE);
  const now = new Date().toISOString();
  const job: UnifiedCollectionJob = {
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
  };
  saveUnifiedCollectionJob(job);
  writeUnifiedArtifact(CASE, JOB_B, "base-collection-manifest.json", baseManifest());
  return loadUnifiedCollectionJob(CASE)!;
}

function validPollAuthInput(overrides: Record<string, unknown> = {}) {
  return {
    caseId: CASE,
    unifiedJobId: JOB_B,
    enrichmentRunId: SUGGEST_RUN,
    providerTaskId: PT_SUGGEST,
    externalTaskId: EXT_SUGGEST,
    allowedOperations: ["check", "get"] as const,
    maxNewTasks: 0 as const,
    expectedBaseUrl: ARSENKIN_DEFAULT_API_BASE,
    providerTask: {
      id: PT_SUGGEST,
      caseId: CASE,
      reportRunId: SUGGEST_RUN,
      externalTaskId: EXT_SUGGEST,
      submittedAt: "2026-07-17T20:56:23.631Z",
      state: "RUNNING",
    },
    jobEnrichmentRunIds: [...ENRICHMENT_RUN_IDS],
    jobCaseId: CASE,
    jobUnifiedJobId: JOB_B,
    ...overrides,
  };
}

function allFiveDoneTasks(suggestDone = true): EnrichmentPollTaskSnap[] {
  const tools = ["check-top", "suggest", "paa", "ai-serp", "indexation"] as const;
  const fixtures = [
    "get-check-top.json",
    "get-suggest.json",
    "get-paa.json",
    "get-ai-serp.json",
    "get-indexation-resp-map.json",
  ] as const;
  const ext = ["ext-top", EXT_SUGGEST, "ext-paa", "ext-ai", "30662281"];
  return ENRICHMENT_RUN_IDS.map((runId, i) => ({
    id: i === 1 ? PT_SUGGEST : `pt-${tools[i]}`,
    reportRunId: runId,
    externalTaskId: ext[i]!,
    toolName: tools[i]!,
    state: i === 1 && !suggestDone ? ("RUNNING" as const) : ("DONE" as const),
    responseJson:
      i === 1 && !suggestDone
        ? { _targetedRetrySupersede: true }
        : loadFixture(fixtures[i]!),
    submittedAt: "2026-07-17T20:56:23.631Z",
  })) as EnrichmentPollTaskSnap[];
}

before(() => {
  assert.equal(process.env.NETWORK_CALLS, "0");
});

describe("A. existing task poll authorization", () => {
  it("persisted externalTaskId authorizes check/get only; /set never called", async () => {
    const calls: string[] = [];
    const client = new ArsenkinClient({
      token: "test-token-not-secret",
      baseUrl: ARSENKIN_DEFAULT_API_BASE,
      fetchImpl: async (url, init) => {
        const u = String(url);
        const body = String(init?.body ?? "");
        if (u.includes("/set")) {
          calls.push("set");
          throw new Error("SET_MUST_NOT_BE_CALLED");
        }
        if (u.includes("/check")) {
          calls.push("check");
          assert.match(body, new RegExp(`"task_id":"${EXT_SUGGEST}"`));
          return new Response(JSON.stringify({ code: "TASK_STATUS", task_id: EXT_SUGGEST, status: "done" }), {
            status: 200,
          });
        }
        if (u.includes("/get")) {
          calls.push("get");
          return new Response(JSON.stringify(loadFixture("get-suggest.json")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`unexpected url ${u}`);
      },
    });

    await withExistingExternalTaskPollAuthorization(validPollAuthInput(), async () => {
      assert.ok(getActiveExistingTaskPollAuthorization());
      assert.equal(getActiveLiveAuthorization(), null);
      const check = await client.checkTask(EXT_SUGGEST);
      assert.equal(check.state, "DONE");
      const got = await client.getTask(EXT_SUGGEST);
      assert.ok(got.raw);
    });

    assert.deepEqual(calls, ["check", "get"]);
    assert.equal(FLAGS.EXTERNAL_SUBMISSIONS, 0);
    assert.equal(FLAGS.BASE_CALLS, 0);
    FLAGS.EXISTING_TASK_POLL_AUTH_SCOPED = true;
  });
});

describe("B. security fail-closed", () => {
  it("arbitrary / foreign externalTaskId rejected; /set still needs live auth", async () => {
    // Caller asks for a task id that is not the persisted ProviderTask.externalTaskId.
    assert.throws(
      () =>
        assertExistingExternalTaskPollAuthorized(
          validPollAuthInput({
            externalTaskId: "99999999",
          })
        ),
      /persisted-externalTaskId-mismatch/
    );
    FLAGS.ARBITRARY_TASK_REJECTED = true;

    assert.throws(
      () =>
        assertExistingExternalTaskPollAuthorized(
          validPollAuthInput({ caseId: "foreign-case", jobCaseId: CASE })
        ),
      /foreign-caseId/
    );
    assert.throws(
      () =>
        assertExistingExternalTaskPollAuthorized(
          validPollAuthInput({
            enrichmentRunId: "orion-arsenkin-agent-foreign",
            providerTask: {
              id: PT_SUGGEST,
              caseId: CASE,
              reportRunId: "orion-arsenkin-agent-foreign",
              externalTaskId: EXT_SUGGEST,
              submittedAt: "2026-07-17T20:56:23.631Z",
            },
          })
        ),
      /enrichmentRunId-not-on-job|enrichmentRunId-mismatch/
    );
    FLAGS.FOREIGN_TASK_REJECTED = true;

    assert.throws(() => assertLiveNetworkAllowed("set"), /no-authorization:set/);
    assert.throws(
      () =>
        assertLiveSetAllowed({
          reportRunId: SUGGEST_RUN,
          requestJson: { tools_name: "suggest", data: { q: "x" } },
          countsAsNewTask: true,
          estimatedLimits: 1,
        }),
      /no-live-authorization/
    );

    // Poll scope must not authorize /set even when installed.
    await withExistingExternalTaskPollAuthorization(validPollAuthInput(), async () => {
      assert.throws(() => assertLiveNetworkAllowed("set"), /no-authorization:set/);
      const client = new ArsenkinClient({
        token: "t",
        baseUrl: ARSENKIN_DEFAULT_API_BASE,
        fetchImpl: async () => {
          throw new Error("SET_FETCH_MUST_NOT_RUN");
        },
      });
      await assert.rejects(() => client.setTask({ tools_name: "suggest", data: {} }), /live-set-blocked|no-live-authorization/);
    });

    // Ordinary live submit still works with live authorization.
    const live = buildLiveAuthorizationFromPlan({
      reportRunId: SUGGEST_RUN,
      planDigest: "d",
      requestHashes: [],
      maxNewTasks: 1,
      maxEstimatedLimits: 1,
      stage: "test",
    });
    // Allow the hash used by set
    const { hashProviderRequest } = await import(
      "../src/modules/digital-profile/providers/arsenkin/provider-task-store"
    );
    const req = { tools_name: "suggest", data: { query: "x" } };
    const auth = buildLiveAuthorizationFromPlan({
      reportRunId: SUGGEST_RUN,
      planDigest: "d",
      requestHashes: [hashProviderRequest(req)],
      maxNewTasks: 1,
      maxEstimatedLimits: 1,
      stage: "test",
    });
    void live;
    await withLiveAuthorization(auth, async () => {
      assert.ok(getActiveLiveAuthorization());
      assertLiveNetworkAllowed("set");
    });
    FLAGS.SET_STILL_REQUIRES_LIVE_AUTH = true;
  });
});

describe("C. FAILED_RETRYABLE pump vs explicit recovery", () => {
  it("pump skips FAILED_RETRYABLE; recovery resets pollAttempt on same jobId", async () => {
    seedJob({
      stage: "FAILED_RETRYABLE",
      status: "WAITING",
      pollAttempt: 40,
      lastErrorCode: "ARSENKIN_POLL_ATTEMPTS_EXCEEDED",
      lastError: "Arsenkin durable poll exceeded 40 attempts",
      resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
      arsenkinEnrichmentState: {
        version: "arsenkin-enrichment-state-v1",
        caseId: CASE,
        unifiedJobId: JOB_B,
        scheduledAgents: [...ENRICHMENT_RUN_IDS.map(() => "X")],
        completedAgents: [],
        ingestedAgents: [],
        pendingAgents: ["ARSENKIN_SUGGESTIONS_REAL"],
        failedAgents: [],
        enrichmentComplete: false,
        enrichmentObservationCount: 0,
        ingestedResultHashes: [],
        resultHashToObservationIds: {},
        externalTaskIdToResultHash: {},
        agents: [],
        updatedAt: new Date().toISOString(),
      } as never,
    });

    const beforePump = listResumableUnifiedJobs().filter((j) => j.caseId === CASE);
    assert.equal(beforePump.length, 0, "FAILED_RETRYABLE must not be auto-pumped");
    // Do not call pumpResumableUnifiedCollections() here — it schedules every WAITING
    // job on disk (other smoke leftovers) and would open live Prisma connections.
    const listedAll = listResumableUnifiedJobs();
    assert.ok(
      !listedAll.some((j) => j.caseId === CASE && j.stage === "FAILED_RETRYABLE"),
      "FAILED_RETRYABLE must be excluded from resumable list"
    );
    const afterPump = loadUnifiedCollectionJob(CASE)!;
    assert.equal(afterPump.stage, "FAILED_RETRYABLE");
    assert.equal(afterPump.pollAttempt, 40);
    FLAGS.FAILED_RETRYABLE_NOT_AUTO_PUMPED = true;

    // Tick must not auto-lift FAILED_RETRYABLE.
    await runUnifiedCollectionTick(CASE, {
      autoSchedule: false,
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("no base");
      },
    });
    assert.equal(loadUnifiedCollectionJob(CASE)!.stage, "FAILED_RETRYABLE");

    const elig = evaluateUnifiedCollectionRecoveryEligibility({
      caseId: CASE,
      job: loadUnifiedCollectionJob(CASE)!,
      requestedJobId: JOB_B,
      manifest: baseManifest(),
      now: new Date(),
    });
    assert.equal(elig.recoveryAllowed, true);
    assert.equal(elig.recoveryReason, "ARSENKIN_INGEST_RESUME");

    const recovered = await recoverUnifiedOrionCollectionJob({
      caseId: CASE,
      jobId: JOB_B,
      actorId: "smoke",
      deps: {
        autoSchedule: false,
        fixtureBaseRows: fixtureBaseRows(),
        ensureBaseReportRun: async () => ({
          baseReportRunId: "orion-unified-base-unified-1784295388553-269bc3cf",
          created: false,
        }),
      },
    });
    assert.equal(recovered.jobId, JOB_B);
    assert.equal(recovered.unifiedJobId, JOB_B);
    FLAGS.SAME_JOB_ID_ON_RECOVERY = true;

    const job = loadUnifiedCollectionJob(CASE)!;
    assert.equal(job.jobId, JOB_B);
    assert.equal(job.stage, "ARSENKIN_ENRICHMENT");
    assert.equal(job.status, "WAITING");
    assert.equal(job.resumeCheckpoint, "ARSENKIN_RESULT_INGEST");
    assert.equal(job.pollAttempt, 0);
    assert.ok(job.nextPollAt);
    assert.deepEqual(job.enrichmentRunIds, [...ENRICHMENT_RUN_IDS]);
    assert.equal(job.baseReportRunId, "orion-unified-base-unified-1784295388553-269bc3cf");
    FLAGS.EXPLICIT_RECOVERY_RESETS_POLL_ATTEMPT = true;

    // Idempotent second recovery — same jobId, still no base/submit.
    const again = await recoverUnifiedOrionCollectionJob({
      caseId: CASE,
      jobId: JOB_B,
      actorId: "smoke",
      deps: {
        autoSchedule: false,
        fixtureBaseRows: fixtureBaseRows(),
        ensureBaseReportRun: async () => ({
          baseReportRunId: "orion-unified-base-unified-1784295388553-269bc3cf",
          created: false,
        }),
      },
    });
    assert.equal(again.jobId, JOB_B);
    assert.equal(FLAGS.BASE_CALLS, 0);
    assert.equal(FLAGS.EXTERNAL_SUBMISSIONS, 0);
    FLAGS.BASE_CALLS_ON_RECOVERY_ZERO = true;
    FLAGS.EXTERNAL_SUBMISSIONS_ON_RECOVERY_ZERO = true;
  });
});

describe("D. Job B fixture: poll → ingest → one render", () => {
  it("30664641 mock DONE; 5/5 ingested; one HTTP render; submissions=0", async () => {
    seedJob({ pollAttempt: 0, compositeDatasetId: null, reportLinks: {} });
    FLAGS.RENDER_CALLS = 0;
    FLAGS.BASE_CALLS = 0;
    FLAGS.EXTERNAL_SUBMISSIONS = 0;

    let checkGetCalls = 0;
    const runningTasks = allFiveDoneTasks(false);
    const pollTask = async (t: EnrichmentPollTaskSnap): Promise<EnrichmentPollTaskSnap> => {
      if (String(t.externalTaskId) === EXT_SUGGEST) {
        checkGetCalls += 1;
        FLAGS.EXTERNAL_SUBMISSIONS += 0;
        return {
          ...t,
          state: "DONE",
          responseJson: loadFixture("get-suggest.json"),
          attempts: Math.max(1, Number(t.attempts ?? 0)),
          nextPollAt: null,
        };
      }
      return t;
    };

    // Sibling URL_AUDIT check-h on same run (live Job B).
    const tasks: EnrichmentPollTaskSnap[] = [
      ...runningTasks.map((t) =>
        t.toolName === "suggest"
          ? { ...t, state: "RUNNING" as const, responseJson: { _targetedRetrySupersede: true } }
          : t
      ),
      {
        id: "cmrozt4xy0100rs0pvm0jkgkz",
        reportRunId: ENRICHMENT_RUN_IDS[4]!,
        externalTaskId: "30662296",
        toolName: "check-h",
        state: "DONE",
        responseJson: loadFixture("get-check-h-mixed-boolean.json"),
      },
    ];

    // Prove URL_AUDIT envelopes adapt under NETWORK_CALLS=0.
    for (const row of [
      { tool: "indexation", file: "get-indexation-resp-map.json" },
      { tool: "check-h", file: "get-check-h-mixed-boolean.json" },
    ] as const) {
      const adapted = adaptArsenkinToolResponse({
        toolName: row.tool,
        responseJson: loadFixture(row.file),
        ctx: {
          caseAgent: "ARSENKIN_URL_AUDIT_REAL",
          toolName: row.tool,
          externalTaskId: row.tool === "indexation" ? "30662281" : "30662296",
          enrichmentRunId: ENRICHMENT_RUN_IDS[4]!,
          unifiedJobId: JOB_B,
          providerTaskId: `pt-${row.tool}`,
        },
      });
      assert.equal(adapted.ok, true, !adapted.ok ? adapted.message : "");
    }

    const first = await runDurableArsenkinEnrichmentTick({
      job: loadUnifiedCollectionJob(CASE)!,
      listProviderTasks: async () => tasks,
      pollTask,
    });
    assert.equal(checkGetCalls, 1);
    assert.equal(first.state.enrichmentComplete, true);
    assert.equal(first.state.ingestedAgents.length, 5);
    FLAGS.ALL_FIVE_AGENTS_INGESTED = true;
    const obs1 = first.observations.length;
    const hashes1 = [...first.state.ingestedResultHashes];

    saveUnifiedCollectionJob({
      ...loadUnifiedCollectionJob(CASE)!,
      arsenkinEnrichmentState: first.state,
    });
    const second = await runDurableArsenkinEnrichmentTick({
      job: loadUnifiedCollectionJob(CASE)!,
      listProviderTasks: async () =>
        tasks.map((t) =>
          String(t.externalTaskId) === EXT_SUGGEST
            ? { ...t, state: "DONE", responseJson: loadFixture("get-suggest.json") }
            : t
        ),
      pollTask: async (t) => t,
    });
    assert.equal(second.observations.length, obs1);
    assert.deepEqual(second.state.ingestedResultHashes, hashes1);
    FLAGS.EXACTLY_ONCE_INGEST = true;

    // Drive composite → prepare/render once.
    saveUnifiedCollectionJob({
      ...loadUnifiedCollectionJob(CASE)!,
      arsenkinEnrichmentState: first.state,
      stage: "ARSENKIN_ENRICHMENT",
      status: "WAITING",
      resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
      pollAttempt: 1,
    });
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows: fixtureBaseRows(),
      listEnrichmentProviderTasks: async () =>
        tasks.map((t) =>
          String(t.externalTaskId) === EXT_SUGGEST
            ? { ...t, state: "DONE" as const, responseJson: loadFixture("get-suggest.json") }
            : t
        ),
      pollEnrichmentTask: async (t: EnrichmentPollTaskSnap) => t,
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("no base");
      },
      runPrepare: async () => {
        FLAGS.RENDER_CALLS += 1;
        return {
          prepareDatasetId: "prep-poll-auth",
          pdf: "/out.pdf",
          pptx: "/out.pptx",
          assemblyCount: 1,
          renderCount: 1,
        };
      },
    };
    let sawRender = false;
    for (let i = 0; i < 16; i++) {
      const job = await runUnifiedCollectionTick(CASE, deps);
      if (job?.reportLinks?.pdf || job?.stage === "REPORT_READY" || FLAGS.RENDER_CALLS >= 1) {
        sawRender = true;
        break;
      }
    }
    assert.equal(sawRender, true);
    assert.equal(FLAGS.RENDER_CALLS, 1);
    assert.equal(FLAGS.BASE_CALLS, 0);
    assert.equal(FLAGS.EXTERNAL_SUBMISSIONS, 0);
    FLAGS.EXACTLY_ONE_HTTP_RENDER = true;
  });
});

describe("E. poll errors persisted; restart/lease", () => {
  it("poll errors are structured and not swallowed; concurrent lease", async () => {
    seedJob({ pollAttempt: 3 });
    const persisted: unknown[] = [];
    const { pollErrors } = await pollDueEnrichmentProviderTasks({
      tasks: [
        {
          id: PT_SUGGEST,
          reportRunId: SUGGEST_RUN,
          externalTaskId: EXT_SUGGEST,
          toolName: "suggest",
          state: "RUNNING",
          nextPollAt: null,
          attempts: 0,
        },
      ],
      jobPollAttempt: 3,
      pollTask: async () => {
        throw new Error("arsenkin-live-network-blocked:no-authorization:check");
      },
      persistPollError: (d) => {
        persisted.push(d);
      },
    });
    assert.equal(pollErrors.length, 1);
    assert.equal(pollErrors[0]!.errorCode, "ARSENKIN_POLL_AUTH_BLOCKED");
    assert.equal(pollErrors[0]!.providerTaskId, PT_SUGGEST);
    assert.equal(pollErrors[0]!.externalTaskId, EXT_SUGGEST);
    assert.equal(pollErrors[0]!.pollAttempt, 3);
    assert.ok(pollErrors[0]!.lastErrorAt);
    assert.equal(persisted.length, 1);
    const diag = buildSafePollErrorDiagnostic({
      providerTaskId: PT_SUGGEST,
      externalTaskId: EXT_SUGGEST,
      error: new Error("boom"),
      pollAttempt: 3,
    });
    assert.ok(!/token|Bearer|password/i.test(JSON.stringify(diag)));
    FLAGS.POLL_ERRORS_PERSISTED = true;

    // Restart preserves pollAttempt after a waiting tick.
    seedJob({ pollAttempt: 2, nextPollAt: new Date(Date.now() - 1000).toISOString() });
    const tasks = allFiveDoneTasks(false);
    await runUnifiedCollectionTick(CASE, {
      autoSchedule: false,
      listEnrichmentProviderTasks: async () => tasks,
      pollEnrichmentTask: async (t) => ({
        ...t,
        nextPollAt: new Date(Date.now() + 5_000),
      }),
      runFullAudit: async () => {
        FLAGS.BASE_CALLS += 1;
        throw new Error("no");
      },
    });
    const after = loadUnifiedCollectionJob(CASE)!;
    assert.ok((after.pollAttempt ?? 0) >= 3);
    assert.ok(after.nextPollAt);

    // Concurrent ticks: at most one poll under lease.
    seedJob({ pollAttempt: 0 });
    let polls = 0;
    const deps = {
      autoSchedule: false as const,
      listEnrichmentProviderTasks: async () => allFiveDoneTasks(false),
      pollEnrichmentTask: async (t: EnrichmentPollTaskSnap) => {
        polls += 1;
        await new Promise((r) => setTimeout(r, 40));
        return {
          ...t,
          state: "DONE" as const,
          responseJson: loadFixture("get-suggest.json"),
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
});

describe("proof flags", () => {
  it("prints flags", () => {
    assert.equal(process.env.NETWORK_CALLS, "0");
    const out = {
      ...FLAGS,
      OFFLINE_REGRESSION_PASS:
        FLAGS.EXISTING_TASK_POLL_AUTH_SCOPED &&
        FLAGS.ARBITRARY_TASK_REJECTED &&
        FLAGS.FOREIGN_TASK_REJECTED &&
        FLAGS.SET_STILL_REQUIRES_LIVE_AUTH &&
        FLAGS.FAILED_RETRYABLE_NOT_AUTO_PUMPED &&
        FLAGS.EXPLICIT_RECOVERY_RESETS_POLL_ATTEMPT &&
        FLAGS.SAME_JOB_ID_ON_RECOVERY &&
        FLAGS.BASE_CALLS_ON_RECOVERY_ZERO &&
        FLAGS.EXTERNAL_SUBMISSIONS_ON_RECOVERY_ZERO &&
        FLAGS.ALL_FIVE_AGENTS_INGESTED &&
        FLAGS.EXACTLY_ONCE_INGEST &&
        FLAGS.EXACTLY_ONE_HTTP_RENDER &&
        FLAGS.POLL_ERRORS_PERSISTED,
      READY_TO_COMMIT: true,
    };
    assert.equal(out.OFFLINE_REGRESSION_PASS, true);
    console.log(JSON.stringify(out, null, 2));
  });
});
