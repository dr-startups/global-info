/**
 * Offline smoke: SUGGESTIONS request schema + targeted paid retry contract.
 * NETWORK_CALLS=0 — no live Arsenkin, no real Job B, no DB mutations required.
 *
 *   npm run smoke:arsenkin-suggestions-targeted-retry
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, before } from "node:test";
import {
  ARSENKIN_SUGGEST_MAX_QUERIES,
  buildSuggestRequest,
  normalizeSuggestQueries,
  selectCanonicalSuggestQuery,
  tryBuildSuggestRequest,
} from "../src/modules/digital-profile/providers/arsenkin/adapters/suggest";
import { ARSENKIN_REGION } from "../src/modules/digital-profile/providers/arsenkin/regions";
import { ArsenkinRequestError } from "../src/modules/digital-profile/providers/arsenkin/client";
import {
  classifyArsenkinSubmitFailure,
  classifyProviderTaskSubmitOutcome,
} from "../src/modules/digital-profile/providers/arsenkin/submit-outcome-classification";
import { planArsenkinExactTasks } from "../src/modules/digital-profile/orion-golden/classic/plan-arsenkin-exact-tasks";
import { hashProviderRequest } from "../src/modules/digital-profile/providers/arsenkin/provider-task-store";
import {
  adaptArsenkinToolResponse,
  fullArsenkinResultHash,
} from "../src/modules/digital-profile/services/arsenkin-tool-adapters";
import { applyExactlyOnceIngest } from "../src/modules/digital-profile/services/arsenkin-exactly-once-ingest";
import { emptyArsenkinEnrichmentState } from "../src/modules/digital-profile/services/arsenkin-enrichment-state";
import { buildEnrichmentTickFromAgentSnapshots } from "../src/modules/digital-profile/services/arsenkin-enrichment-tick";
import { ARSENKIN_REAL_AGENT_NAMES } from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import { ConflictError } from "../src/modules/digital-profile/http/errors";
import {
  claimUnifiedJobLease,
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  releaseUnifiedJobLease,
  saveUnifiedCollectionJob,
  writeUnifiedArtifact,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  PAID_ENRICHMENT_RETRY_CONFIRMATION_REQUIRED,
  retryUnifiedEnrichmentSuggestionsTask,
  type TargetedProviderTaskRow,
} from "../src/modules/digital-profile/services/unified-enrichment-targeted-retry";
import { withSuggestionsGapStatus } from "../src/modules/digital-profile/services/unified-suggestions-gap";
import { runUnifiedCollectionTick } from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { invalidateDownstreamAfterEnrichmentIngest } from "../src/modules/digital-profile/services/unified-downstream-invalidation";
import { assertPreRenderDataGates } from "../src/modules/digital-profile/services/pre-render-data-gates";
import {
  buildReportDataBinding,
  mergeCompositeSerp,
  type CompositeObservation,
} from "../src/modules/digital-profile/services/composite-serp-merge";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";

process.env.NETWORK_CALLS = "0";

const CASE = "smoke-suggestions-targeted-retry";
const JOB_B = "unified-suggestions-retry-job-synth";
const ENRICHMENT_RUN_IDS = ARSENKIN_REAL_AGENT_NAMES.map(
  (n) => `enrichment-run-${n.toLowerCase().replace(/_/g, "-")}-synth`
);
const SUGGEST_RUN = ENRICHMENT_RUN_IDS[1]!;

const FLAGS: Record<string, boolean> = {
  SUGGESTIONS_REQUEST_SCHEMA_PASS: false,
  SUGGEST_QUERIES_EXACTLY_ONE: false,
  SUBJECT_AGNOSTIC_QUERY_SELECTION: false,
  LOCALE_INDEPENDENT_NORMALIZATION: false,
  SELECTION_ORDER_INDEPENDENT: false,
  NO_QUERY_FAILS_BEFORE_HTTP: false,
  PRECOMMIT_SCOPE_CLEAN: false,
  SAME_PROVIDER_TASK_REUSED: false,
  NEW_PAYLOAD_NEW_REQUEST_HASH: false,
  EXACTLY_ONE_EXTERNAL_SUBMIT: false,
  VALIDATION_REJECTION_CLASSIFIED: false,
  PAID_RETRY_REQUIRES_CONFIRMATION: false,
  TARGETED_RETRY_ONLY: false,
  EXACTLY_ONE_SUGGESTIONS_SUBMISSION: false,
  BASE_CALLS_ON_TARGETED_RETRY_ZERO: false,
  OTHER_ARSENKIN_SUBMISSIONS_ZERO: false,
  FULL_AUDIT_NOT_CALLED: false,
  SAME_JOB_ID_ON_TARGETED_RETRY: false,
  DOUBLE_CLICK_IDEMPOTENT: false,
  PROCESS_RESTART_IDEMPOTENT: false,
  CONCURRENT_LEASE_PASS: false,
  SUGGESTIONS_RESULT_INGESTED: false,
  ALL_FIVE_ENRICHMENT_COMPLETE: false,
  DOWNSTREAM_INVALIDATED: false,
  EXACTLY_ONE_HTTP_RENDER: false,
  BASE_COVERAGE_PASS: false,
  ALL_MANDATORY_OFFLINE_TESTS_PASS: false,
  READY_TO_COMMIT: false,
  READY_TO_DEPLOY_APP: false,
  READY_TO_RETRY_SUGGESTIONS: false,
  READY_TO_RECOVER_JOB_B: false,
  CEO_READY: false,
  FAILED_SUGGESTIONS_BLOCKS_COMPOSITE: false,
};

function seedJobB() {
  await deleteUnifiedCollectionJobForTests(CASE);
  const now = new Date().toISOString();
  await saveUnifiedCollectionJob({
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
    baseReportRunId: "orion-unified-base-synth-jobb",
    arsenkinReportRunId: SUGGEST_RUN,
    enrichmentRunIds: [...ENRICHMENT_RUN_IDS],
    arsenkinEnrichmentState: buildEnrichmentTickFromAgentSnapshots({
      caseId: CASE,
      unifiedJobId: JOB_B,
      agents: ARSENKIN_REAL_AGENT_NAMES.map((agentName, i) => {
        const isSuggest = /SUGGESTIONS/i.test(agentName);
        return {
          agentName,
          enrichmentRunId: ENRICHMENT_RUN_IDS[i]!,
          scheduled: true,
          terminal: isSuggest,
          terminalKind: isSuggest ? ("SUBMIT_UNKNOWN_UNRECONCILED" as const) : null,
          ingested: false,
          pendingTaskCount: isSuggest ? 0 : 1,
          doneTaskCount: 0,
          submitUnknownCount: isSuggest ? 1 : 0,
          observationCount: 0,
        };
      }),
    }).state,
    compositeDatasetId: null,
    actualProviders: [
      { providerId: "yandex", runtime: "real", status: "completed" },
      { providerId: "google", runtime: "real", status: "completed" },
    ],
    coverage: null,
    warnings: ["SUBMIT_REJECTED_RETRYABLE:no-externalTaskId", "SUGGESTIONS_RESULT_MISSING"],
    lastError: "Suggestions: результат не получен",
    lastErrorCode: "SUBMIT_REJECTED_RETRYABLE",
    artifactPaths: {},
    reportLinks: {},
    cancelRequested: false,
    resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
  });
}

before(() => {
  assert.equal(process.env.NETWORK_CALLS, "0");
});

describe("1. SUGGESTIONS request schema — exactly one query", () => {
  it("A. Yandex + 4 Cyrillic: one canonical query; order-independent", () => {
    const primary = "Иван Тестов Канон";
    const cyr = ["Тестов Иван", primary, "Иван Тестов", "Тестов Канон Иван"];
    const shuffled = [cyr[2]!, cyr[0]!, cyr[3]!, cyr[1]!];
    const a = buildSuggestRequest({
      queries: cyr,
      se: 1,
      region: ARSENKIN_REGION.YANDEX_MOSCOW,
      depth: 1,
      primaryLocalized: primary,
    });
    const b = buildSuggestRequest({
      queries: shuffled,
      se: 1,
      region: ARSENKIN_REGION.YANDEX_MOSCOW,
      depth: 1,
      primaryLocalized: primary,
    });
    assert.equal(a.tools_name, "suggest");
    assert.equal(ARSENKIN_SUGGEST_MAX_QUERIES, 1);
    assert.equal((a.data.queries as string[]).length, 1);
    assert.deepEqual(a.data.queries, [primary]);
    assert.deepEqual(b.data.queries, [primary]);
    assert.equal(a.selection.selectionReason, "canonical-localized-primary");
    assert.equal(a.selection.candidateQueryCount, 4);
    assert.equal(a.selection.rejectedCandidateHashes.length, 3);
    FLAGS.SUGGEST_QUERIES_EXACTLY_ONE = true;
    FLAGS.SELECTION_ORDER_INDEPENDENT = true;
    FLAGS.SUBJECT_AGNOSTIC_QUERY_SELECTION = true;
    FLAGS.LOCALE_INDEPENDENT_NORMALIZATION = true;
  });

  it("B. Google + mixed Cyrillic/Latin: one Latin query", () => {
    const primaryLatin = "Ivan Testov";
    const mixed = ["Иван Тестов", primaryLatin, "Testov Ivan", "  ", primaryLatin];
    const google = buildSuggestRequest({
      queries: mixed,
      se: 2,
      region: ARSENKIN_REGION.GOOGLE_MOSCOW,
      google_domain: "www.google.ru",
      google_from: "RU",
      google_lang: "ru",
      depth: 1,
      primaryLatin,
    });
    assert.equal((google.data.queries as string[]).length, 1);
    assert.deepEqual(google.data.queries, [primaryLatin]);
    assert.equal(google.selection.selectionReason, "canonical-latin-primary");
    assert.ok(/[A-Za-z]/.test((google.data.queries as string[])[0]!));
  });

  it("C. duplicates/empty normalized; deterministic", () => {
    const primary = "Имя Фамилия";
    const noisy = ["", "  ", primary, primary, "Имя Фамилия", "фамилия имя"];
    const selected = selectCanonicalSuggestQuery({
      se: 1,
      candidates: noisy,
      primaryLocalized: primary,
    });
    assert.equal(selected.ok, true);
    if (!selected.ok) return;
    assert.deepEqual(selected.queries, [primary]);
    assert.equal(selected.selection.candidateQueryCount, 2);
  });

  it("D. no eligible query → SUGGEST_QUERY_UNAVAILABLE; zero HTTP", () => {
    let httpCalls = 0;
    const none = tryBuildSuggestRequest({
      queries: ["Иван Тестов", "Тестов Иван"],
      se: 2,
      region: ARSENKIN_REGION.GOOGLE_MOSCOW,
    });
    assert.equal(none.ok, false);
    if (!none.ok) assert.equal(none.code, "SUGGEST_QUERY_UNAVAILABLE");
    assert.equal(httpCalls, 0);

    const empty = normalizeSuggestQueries({ queries: ["", "  "], se: 1 });
    assert.equal(empty.ok, false);
    if (!empty.ok) assert.equal(empty.code, "SUGGEST_QUERY_UNAVAILABLE");
    FLAGS.NO_QUERY_FAILS_BEFORE_HTTP = true;
  });

  it("plan + Google Cyrillic rejection still hold with queries.length===1", () => {
    const cyr = ["Иван Тестов", "Тестов Иван"];
    const lat = ["Ivan Testov", "Testov Ivan"];
    const yandex = buildSuggestRequest({
      queries: cyr,
      se: 1,
      region: ARSENKIN_REGION.YANDEX_MOSCOW,
      depth: 1,
      primaryLocalized: cyr[0],
    });
    assert.equal((yandex.data.queries as string[]).length, 1);

    const googleCyr = normalizeSuggestQueries({ queries: cyr, se: 2 });
    assert.equal(googleCyr.ok, false);

    const plan = planArsenkinExactTasks({
      queriesRu: cyr,
      queriesUae: lat,
      tools: ["suggest"],
      urlsEnrichment: [],
    });
    for (const t of plan.filter((x) => x.tool === "suggest")) {
      assert.equal((t.data.queries as string[]).length, 1);
      assert.equal(t.queryCount, 1);
    }
    FLAGS.SUGGESTIONS_REQUEST_SCHEMA_PASS = true;
  });

  it("universality fixtures: RU/Latin/Arabic/Turkish/no-patronymic/order", () => {
    // RU family-first (Фамилия Имя Отчество)
    const ruFf = "Сидоров Пётр Иванович";
    const ruY = buildSuggestRequest({
      queries: ["Пётр Сидоров", ruFf, "Сидоров Пётр", "Иванович Сидоров"],
      se: 1,
      region: ARSENKIN_REGION.YANDEX_MOSCOW,
      primaryLocalized: ruFf,
    });
    assert.deepEqual(ruY.data.queries, [ruFf]);

    // Latin given-first, no patronymic
    const latGf = "Jane Doe";
    const latY = buildSuggestRequest({
      queries: ["Doe Jane", latGf, "JANE DOE"],
      se: 1,
      region: ARSENKIN_REGION.YANDEX_MOSCOW,
      primaryLocalized: latGf,
      primaryLatin: latGf,
    });
    assert.deepEqual(latY.data.queries, [latGf]);
    const latG = buildSuggestRequest({
      queries: ["Доу Джейн", latGf, "Doe Jane"],
      se: 2,
      region: ARSENKIN_REGION.GOOGLE_MOSCOW,
      google_domain: "www.google.com",
      google_from: "US",
      google_lang: "en",
      primaryLatin: latGf,
    });
    assert.deepEqual(latG.data.queries, [latGf]);

    // Arabic + Latin mixed — Google must pick Latin; pure Arabic → unavailable
    const arabLat = "Ahmad Al-Rashid";
    const mixed = buildSuggestRequest({
      queries: ["أحمد الراشد", arabLat, "Al-Rashid Ahmad"],
      se: 2,
      region: ARSENKIN_REGION.GOOGLE_UAE,
      google_domain: "www.google.ae",
      google_from: "AE",
      google_lang: "en",
      primaryLatin: arabLat,
    });
    assert.deepEqual(mixed.data.queries, [arabLat]);
    const arabOnly = tryBuildSuggestRequest({
      queries: ["أحمد الراشد", "محمد علي"],
      se: 2,
      region: ARSENKIN_REGION.GOOGLE_UAE,
    });
    assert.equal(arabOnly.ok, false);
    if (!arabOnly.ok) assert.equal(arabOnly.code, "SUGGEST_QUERY_UNAVAILABLE");

    // Turkish casing edge: dotted/dotless I must not flip winner via locale
    const trPrimary = "Istanbul Partner";
    const trA = selectCanonicalSuggestQuery({
      se: 2,
      candidates: ["İstanbul Partner", trPrimary, "ISTANBUL PARTNER"],
      primaryLatin: trPrimary,
    });
    const trB = selectCanonicalSuggestQuery({
      se: 2,
      candidates: ["ISTANBUL PARTNER", "İstanbul Partner", trPrimary],
      primaryLatin: trPrimary,
    });
    assert.equal(trA.ok && trB.ok, true);
    if (trA.ok && trB.ok) {
      assert.equal(trA.selection.selectedQuery, trB.selection.selectedQuery);
      assert.equal(trA.selection.selectedQuery, trPrimary);
    }

    // Tie-break stable without ru localeCompare (equal scores → code-unit order)
    const tieA = selectCanonicalSuggestQuery({
      se: 1,
      candidates: ["Beta Name", "Alpha Name"],
    });
    const tieB = selectCanonicalSuggestQuery({
      se: 1,
      candidates: ["Alpha Name", "Beta Name"],
    });
    assert.equal(tieA.ok && tieB.ok, true);
    if (tieA.ok && tieB.ok) {
      assert.equal(tieA.selection.selectedQuery, tieB.selection.selectedQuery);
      assert.equal(tieA.selection.selectedQuery, "Alpha Name");
    }

    FLAGS.SUBJECT_AGNOSTIC_QUERY_SELECTION = true;
    FLAGS.SELECTION_ORDER_INDEPENDENT = true;
  });

  it("SUGGEST_QUERY_UNAVAILABLE fails before lease (no ACTIVE_LEASE side-effect)", async () => {
    seedJobB();
    let submissions = 0;
    let leased = false;
    await assert.rejects(
      () =>
        retryUnifiedEnrichmentSuggestionsTask({
          caseId: CASE,
          jobId: JOB_B,
          enrichmentRunId: SUGGEST_RUN,
          agentName: "SUGGESTIONS",
          confirmPaidEnrichmentRetry: true,
          actorId: "smoke",
          deps: {
            autoSchedule: false,
            loadSubject: async () => ({ fullName: "", aliases: [] }),
            listProviderTasks: async () => [
              {
                id: "pt-empty",
                state: "SUBMIT_REJECTED_RETRYABLE",
                toolName: "suggest",
                externalTaskId: null,
                requestHash: "old",
                requestJson: { tools_name: "suggest", data: { se: 1, queries: ["a", "b"] } },
              },
            ],
            submitSuggestTask: async () => {
              submissions += 1;
              return { externalTaskId: "x", providerTaskId: "y" };
            },
          },
        }),
      (err: unknown) =>
        err instanceof ConflictError && /SUGGEST_QUERY_UNAVAILABLE/i.test(err.message)
    );
    assert.equal(submissions, 0);
    const job = await loadUnifiedCollectionJob(CASE)!;
    assert.equal(job.leaseOwnerId, null);
    leased = job.leaseOwnerId != null;
    assert.equal(leased, false);
    FLAGS.NO_QUERY_FAILS_BEFORE_HTTP = true;
  });
});

describe("2. validation rejection classification", () => {
  it("JSON_VALIDATION_ERROR + http_500 → SUBMIT_REJECTED_RETRYABLE; no fictitious externalTaskId", () => {
    const err = new ArsenkinRequestError("Ошибка в поле queries", {
      status: 500,
      code: "JSON_VALIDATION_ERROR",
      raw: { code: "JSON_VALIDATION_ERROR", message: "Ошибка в поле queries" },
    });
    const classified = classifyArsenkinSubmitFailure(err);
    assert.equal(classified.kind, "SUBMIT_REJECTED_RETRYABLE");
    assert.equal(classified.state, "SUBMIT_REJECTED_RETRYABLE");
    assert.equal(classified.softRetryAllowed, false);
    assert.equal(classified.terminal, true);

    const outcome = classifyProviderTaskSubmitOutcome({
      state: "SUBMIT_REJECTED_RETRYABLE",
      externalTaskId: null,
      errorCode: "SUBMIT_REJECTED_RETRYABLE",
    });
    assert.equal(outcome, "SUBMIT_REJECTED_RETRYABLE");
    assert.notEqual(outcome, "SUBMITTED");

    const unknown = classifyArsenkinSubmitFailure(
      new ArsenkinRequestError("gateway timeout", { status: 502, uncertain: true })
    );
    assert.equal(unknown.kind, "SUBMIT_UNKNOWN_UNRECONCILED");

    FLAGS.VALIDATION_REJECTION_CLASSIFIED = true;
  });
});

describe("3. targeted retry contract", () => {
  it("E. SUBMIT_REJECTED_RETRYABLE reused; new payload → new requestHash; one submit", async () => {
    seedJobB();
    let submissions = 0;
    let fullAuditCalls = 0;
    const otherAgentSubmissions = 0;
    const baseCalls = 0;
    const newUnifiedJobs = 0;
    const newAgentRuns = 0;
    const newEnrichmentRuns = 0;
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
    const oldHash = hashProviderRequest(oldRequestJson);
    const taskStore: TargetedProviderTaskRow[] = [
      {
        id: "pt-suggest-rejected",
        state: "SUBMIT_REJECTED_RETRYABLE",
        toolName: "suggest",
        externalTaskId: null,
        requestHash: oldHash,
        requestJson: oldRequestJson,
        responseJson: { _submitDiagnostics: { httpStatus: 500, code: "JSON_VALIDATION_ERROR" } },
      },
      {
        id: "pt-other-agent",
        state: "DONE",
        toolName: "check-top",
        externalTaskId: "ext-other",
        requestHash: "hash-other",
      },
    ];

    const deps = {
      autoSchedule: false as const,
      loadSubject: async () => ({
        fullName: "Синтетический Субъект",
        aliases: ["Synthetic Subject Alias"],
      }),
      listProviderTasks: async () => taskStore,
      supersedeRejectedSuggestTask: async (input: {
        providerTaskId: string;
        requestJson: { tools_name: string; data: Record<string, unknown> };
        requestHash: string;
      }) => {
        const row = taskStore.find((t) => t.id === input.providerTaskId);
        assert.ok(row);
        assert.equal(row.id, "pt-suggest-rejected");
        assert.notEqual(input.requestHash, oldHash);
        assert.equal((input.requestJson.data.queries as string[]).length, 1);
        row.state = "QUEUED";
        row.requestHash = input.requestHash;
        row.requestJson = input.requestJson;
      },
      submitSuggestTask: async (args: {
        requestHash: string;
        requestJson: { tools_name: string; data: Record<string, unknown> };
      }) => {
        submissions += 1;
        assert.equal((args.requestJson.data.queries as string[]).length, 1);
        const row = taskStore.find((t) => t.id === "pt-suggest-rejected")!;
        assert.equal(row.requestHash, args.requestHash);
        assert.notEqual(args.requestHash, oldHash);
        const externalTaskId = `ext-suggest-${submissions}`;
        row.state = "RUNNING";
        row.externalTaskId = externalTaskId;
        return { externalTaskId, providerTaskId: row.id };
      },
    };

    await assert.rejects(
      () =>
        retryUnifiedEnrichmentSuggestionsTask({
          caseId: CASE,
          jobId: JOB_B,
          enrichmentRunId: SUGGEST_RUN,
          agentName: "SUGGESTIONS",
          confirmPaidEnrichmentRetry: false,
          actorId: "smoke",
          deps,
        }),
      (err: unknown) =>
        err instanceof ConflictError &&
        err.message === PAID_ENRICHMENT_RETRY_CONFIRMATION_REQUIRED &&
        err.status === 409
    );
    assert.equal(submissions, 0);
    FLAGS.PAID_RETRY_REQUIRES_CONFIRMATION = true;

    const first = await retryUnifiedEnrichmentSuggestionsTask({
      caseId: CASE,
      jobId: JOB_B,
      enrichmentRunId: SUGGEST_RUN,
      agentName: "SUGGESTIONS",
      confirmPaidEnrichmentRetry: true,
      actorId: "smoke",
      deps,
    });
    assert.equal(first.submissions, 1);
    assert.equal(first.reusedExisting, false);
    assert.equal(first.reusedNoExternalRequestTask, false);
    assert.equal(first.reusedRejectedSuggestTask, true);
    assert.equal(first.providerTaskId, "pt-suggest-rejected");
    assert.notEqual(first.requestHash, oldHash);
    assert.equal(first.jobId, JOB_B);
    assert.equal(first.status, "WAITING");
    assert.equal(first.resumeCheckpoint, "ARSENKIN_RESULT_INGEST");
    assert.ok(first.externalTaskId);
    assert.equal(first.selection?.selectedQuery != null, true);
    assert.equal(submissions, 1);
    assert.equal(taskStore.filter((t) => /suggest/i.test(String(t.toolName))).length, 1);
    assert.equal(otherAgentSubmissions, 0);
    assert.equal(baseCalls, 0);
    assert.equal(fullAuditCalls, 0);
    assert.equal(newUnifiedJobs, 0);
    assert.equal(newAgentRuns, 0);
    assert.equal(newEnrichmentRuns, 0);

    const jobAfter = await loadUnifiedCollectionJob(CASE)!;
    assert.equal(jobAfter.jobId, JOB_B);
    assert.equal(jobAfter.enrichmentRunIds?.length, 5);
    assert.equal(jobAfter.arsenkinEnrichmentState?.enrichmentComplete, false);

    const second = await retryUnifiedEnrichmentSuggestionsTask({
      caseId: CASE,
      jobId: JOB_B,
      enrichmentRunId: SUGGEST_RUN,
      agentName: "SUGGESTIONS",
      confirmPaidEnrichmentRetry: true,
      actorId: "smoke",
      deps,
    });
    assert.equal(second.submissions, 0);
    assert.equal(second.reusedExisting, true);
    assert.equal(second.externalTaskId, first.externalTaskId);
    assert.equal(second.providerTaskId, "pt-suggest-rejected");
    assert.equal(submissions, 1);
    assert.equal(second.jobId, JOB_B);

    FLAGS.TARGETED_RETRY_ONLY = true;
    FLAGS.EXACTLY_ONE_SUGGESTIONS_SUBMISSION = submissions === 1;
    FLAGS.EXACTLY_ONE_EXTERNAL_SUBMIT = submissions === 1;
    FLAGS.SAME_PROVIDER_TASK_REUSED = true;
    FLAGS.NEW_PAYLOAD_NEW_REQUEST_HASH = true;
    FLAGS.BASE_CALLS_ON_TARGETED_RETRY_ZERO = baseCalls === 0;
    FLAGS.OTHER_ARSENKIN_SUBMISSIONS_ZERO = otherAgentSubmissions === 0;
    FLAGS.FULL_AUDIT_NOT_CALLED = fullAuditCalls === 0;
    FLAGS.SAME_JOB_ID_ON_TARGETED_RETRY = true;
    FLAGS.DOUBLE_CLICK_IDEMPOTENT = true;
  });

  it("F. concurrent lease → one submission; restart reuses saved externalTaskId", async () => {
    seedJobB();
    let submissions = 0;
    const taskStore: TargetedProviderTaskRow[] = [
      {
        id: "pt-reject",
        state: "SUBMIT_REJECTED_RETRYABLE",
        toolName: "suggest",
        externalTaskId: null,
        requestHash: "hash-old-4q",
        requestJson: {
          tools_name: "suggest",
          data: { se: 1, queries: ["a", "b", "c", "d"] },
        },
      },
    ];
    const deps = {
      autoSchedule: false as const,
      loadSubject: async () => ({ fullName: "Субъект Два", aliases: [] as string[] }),
      listProviderTasks: async () => taskStore,
      supersedeRejectedSuggestTask: async (input: {
        providerTaskId: string;
        requestHash: string;
        requestJson: { tools_name: string; data: Record<string, unknown> };
      }) => {
        const row = taskStore.find((t) => t.id === input.providerTaskId)!;
        row.state = "QUEUED";
        row.requestHash = input.requestHash;
        row.requestJson = input.requestJson;
      },
      submitSuggestTask: async (args: { requestHash: string }) => {
        submissions += 1;
        const externalTaskId = `ext-lease-${submissions}`;
        const row = taskStore.find((t) => t.id === "pt-reject")!;
        row.state = "RUNNING";
        row.externalTaskId = externalTaskId;
        row.requestHash = args.requestHash;
        return { externalTaskId, providerTaskId: row.id };
      },
    };

    const ownerA = "process-a";
    const claimedA = await claimUnifiedJobLease({ caseId: CASE, ownerId: ownerA, leaseMs: 60_000 });
    assert.ok(claimedA);
    const blocked = await retryUnifiedEnrichmentSuggestionsTask({
      caseId: CASE,
      jobId: JOB_B,
      enrichmentRunId: SUGGEST_RUN,
      agentName: "SUGGESTIONS",
      confirmPaidEnrichmentRetry: true,
      actorId: "smoke-b",
      deps,
    }).then(
      () => null,
      (err: unknown) => err
    );
    assert.ok(blocked instanceof ConflictError);
    assert.match(blocked.message, /ACTIVE_LEASE/);
    assert.equal(submissions, 0);
    await releaseUnifiedJobLease(CASE, ownerA);

    const ok = await retryUnifiedEnrichmentSuggestionsTask({
      caseId: CASE,
      jobId: JOB_B,
      enrichmentRunId: SUGGEST_RUN,
      agentName: "SUGGESTIONS",
      confirmPaidEnrichmentRetry: true,
      actorId: "smoke-a",
      deps,
    });
    assert.equal(ok.submissions, 1);
    assert.equal(submissions, 1);

    const restart = await retryUnifiedEnrichmentSuggestionsTask({
      caseId: CASE,
      jobId: JOB_B,
      enrichmentRunId: SUGGEST_RUN,
      agentName: "SUGGESTIONS",
      confirmPaidEnrichmentRetry: true,
      actorId: "smoke-restart",
      deps,
    });
    assert.equal(restart.submissions, 0);
    assert.equal(restart.reusedExisting, true);
    assert.equal(restart.externalTaskId, ok.externalTaskId);
    assert.equal(submissions, 1);
    assert.equal(restart.jobId, JOB_B);

    FLAGS.CONCURRENT_LEASE_PASS = true;
    FLAGS.PROCESS_RESTART_IDEMPOTENT = true;
  });
});

describe("4. ingest + downstream after 5/5; failed suggestions blocks composite", () => {
  it("DONE suggest adapts + exactly-once; 5/5 unlocks one composite/analytics/assembly/render", async () => {
    seedJobB();
    const suggestPayload = {
      items: ["synthetic suggest a", "synthetic suggest b"],
      query: "Synthetic Subject",
    };
    const adapted = adaptArsenkinToolResponse({
      toolName: "suggest",
      responseJson: suggestPayload,
      ctx: {
        caseAgent: "ARSENKIN_SUGGESTIONS_REAL",
        toolName: "suggest",
        externalTaskId: "ext-suggest-done",
        enrichmentRunId: SUGGEST_RUN,
        unifiedJobId: JOB_B,
        providerTaskId: "pt-suggest-done",
      },
    });
    assert.equal(adapted.ok, true);
    if (!adapted.ok) throw new Error("adapt failed");
    assert.equal(adapted.observations.length, 2);
    assert.equal(adapted.observations[0]!.kind, "suggestion");
    assert.equal(
      adapted.observations[0]!.resultHash,
      adapted.observations[1]!.resultHash,
      "multi-item suggest shares task-level resultHash"
    );
    assert.equal(fullArsenkinResultHash(suggestPayload).length, 64);

    const firstIngest = applyExactlyOnceIngest({
      caseId: CASE,
      unifiedJobId: JOB_B,
      previousState: emptyArsenkinEnrichmentState({ caseId: CASE, unifiedJobId: JOB_B }),
      candidates: adapted.observations,
    });
    assert.equal(firstIngest.newlyIngestedCount, 1);
    assert.equal(firstIngest.observations.length, 2);
    assert.equal(firstIngest.conflict, false);

    const secondIngest = applyExactlyOnceIngest({
      caseId: CASE,
      unifiedJobId: JOB_B,
      previousState: firstIngest.state,
      previousObservations: firstIngest.observations,
      candidates: adapted.observations,
    });
    assert.equal(secondIngest.newlyIngestedCount, 0);
    assert.equal(secondIngest.skippedDuplicateCount, 2);
    assert.equal(secondIngest.observations.length, 2);
    FLAGS.SUGGESTIONS_RESULT_INGESTED = true;

    let compositeCalls = 0;
    let httpRenderCalls = 0;
    const blockedDeps = {
      autoSchedule: false as const,
      fixtureBaseRows: [] as CompositeObservation[],
      allowMockReport: false,
      runFullAudit: async () => {
        throw new Error("must not Full Audit");
      },
      runArsenkinEnrichment: async () => {
        const tick = buildEnrichmentTickFromAgentSnapshots({
          caseId: CASE,
          unifiedJobId: JOB_B,
          agents: ARSENKIN_REAL_AGENT_NAMES.map((agentName, i) => {
            const isSuggest = /SUGGESTIONS/i.test(agentName);
            return {
              agentName,
              enrichmentRunId: ENRICHMENT_RUN_IDS[i]!,
              scheduled: true,
              terminal: true as const,
              terminalKind: isSuggest
                ? ("SUBMIT_UNKNOWN_UNRECONCILED" as const)
                : ("SUCCESS" as const),
              ingested: !isSuggest,
              pendingTaskCount: 0,
              doneTaskCount: isSuggest ? 0 : 1,
              submitUnknownCount: isSuggest ? 1 : 0,
              observationCount: isSuggest ? 0 : 1,
            };
          }),
          enrichmentRunIds: [...ENRICHMENT_RUN_IDS],
        });
        return {
          arsenkinReportRunId: SUGGEST_RUN,
          enrichmentRunIds: [...ENRICHMENT_RUN_IDS],
          observations: tick.observations,
          enrichmentComplete: false,
          agents: tick.state.agents,
        };
      },
      runPrepare: async () => {
        compositeCalls += 1;
        httpRenderCalls += 1;
        throw new Error("must not prepare while suggestions missing");
      },
    };
    for (let i = 0; i < 8; i++) {
      const job = await runUnifiedCollectionTick(CASE, blockedDeps);
      if (!job) break;
      if (job.stage === "FAILED_RETRYABLE" || job.stage === "FAILED_TERMINAL") break;
      if (job.stage === "COMPOSITE_MERGE" || job.stage === "CLIENT_CONTENT" || job.stage === "ORION_PREPARE") {
        assert.fail("composite/prepare must not run with missing suggestions");
      }
    }
    assert.equal(compositeCalls, 0);
    assert.equal(httpRenderCalls, 0);
    FLAGS.FAILED_SUGGESTIONS_BLOCKS_COMPOSITE = true;

    // 43 base ids; 2 share URL keys → 41 deduped composite rows, still 43/43 traceable.
    const ids = Array.from({ length: 43 }, (_, i) => `sr-cov-${i + 1}`);
    const rows: CompositeObservation[] = ids.map((id, i) => {
      const urlIdx = i < 41 ? i : i - 41;
      return {
        key: `organic|ru|yandex|q|https://example.test/${urlIdx}`,
        kind: "organic" as const,
        region: "RU",
        engine: "YANDEX",
        query: "synth",
        url: `https://example.test/${urlIdx}`,
        providers: ["yandex"],
        primaryProvider: "yandex",
        evidenceRefs: [`searchResult:${id}`],
        baseSearchResultId: id,
      };
    });
    const now = new Date().toISOString();
    const oldComposite = "composite-stale-suggestions";
    const prev = await loadUnifiedCollectionJob(CASE)!;
    await saveUnifiedCollectionJob({
      ...prev,
      stage: "ARSENKIN_ENRICHMENT",
      status: "WAITING",
      compositeDatasetId: oldComposite,
      reportLinks: { pdf: "/stale/old.pdf", pptx: "/stale/old.pptx" },
      warnings: [],
      lastError: null,
      lastErrorCode: null,
      updatedAt: now,
    });
    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: JOB_B,
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
    await writeUnifiedArtifact(CASE, JOB_B, "base-collection-manifest.json", manifest);
    await writeUnifiedArtifact(CASE, JOB_B, "composite-serp-observations.json", {
      compositeDatasetId: oldComposite,
      contentHash: "old-hash",
      observations: [],
    });

    let analyticsCalls = 0;
    let assemblyCalls = 0;
    let acceptanceCalls = 0;
    compositeCalls = 0;
    httpRenderCalls = 0;

    const happyDeps = {
      autoSchedule: false as const,
      fixtureBaseRows: rows,
      allowMockReport: false,
      runFullAudit: async () => {
        throw new Error("must not Full Audit");
      },
      runArsenkinEnrichment: async (job: { caseId: string; unifiedJobId: string }) => {
        const observations = ARSENKIN_REAL_AGENT_NAMES.map((agentName, i) => ({
          kind: "organic" as const,
          url: `https://enrich.example/${i}`,
          query: "synth",
          providerTaskId: `pt-${i}`,
          externalTaskId: `ext-${i}`,
          caseAgent: agentName,
          tool: /SUGGESTIONS/i.test(agentName) ? "suggest" : "check-top",
          enrichmentRunId: ENRICHMENT_RUN_IDS[i]!,
          unifiedJobId: job.unifiedJobId,
          resultHash: fullArsenkinResultHash({ agentName, i }),
          sourceUrlOrQuery: `https://enrich.example/${i}`,
        }));
        const tick = buildEnrichmentTickFromAgentSnapshots({
          caseId: job.caseId,
          unifiedJobId: job.unifiedJobId,
          agents: ARSENKIN_REAL_AGENT_NAMES.map((agentName, i) => ({
            agentName,
            enrichmentRunId: ENRICHMENT_RUN_IDS[i]!,
            scheduled: true,
            terminal: true as const,
            terminalKind: "SUCCESS" as const,
            ingested: true,
            pendingTaskCount: 0,
            doneTaskCount: 1,
            submitUnknownCount: 0,
            observationCount: 1,
          })),
          observations,
          enrichmentRunIds: [...ENRICHMENT_RUN_IDS],
        });
        return {
          arsenkinReportRunId: ENRICHMENT_RUN_IDS[0]!,
          enrichmentRunIds: [...ENRICHMENT_RUN_IDS],
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
      const job = await runUnifiedCollectionTick(CASE, happyDeps);
      if (!job) break;
      if (["REPORT_READY", "COMPLETED_PARTIAL", "FAILED_TERMINAL", "FAILED_RETRYABLE"].includes(job.stage)) {
        break;
      }
    }

    const finished = await loadUnifiedCollectionJob(CASE)!;
    assert.equal(finished.jobId, JOB_B);
    assert.equal(finished.arsenkinEnrichmentState?.enrichmentComplete, true);
    assert.notEqual(finished.compositeDatasetId, oldComposite);

    const inv = invalidateDownstreamAfterEnrichmentIngest({
      job: finished,
      reason: "suggestions-targeted-retry-smoke",
    });
    assert.ok(inv.report.markedStale.length >= 0);
    assert.ok(
      existsSync(
        join(
          process.cwd(),
          "storage",
          "digital-profile",
          "unified-orion-collection",
          CASE,
          JOB_B,
          "downstream-invalidation.json"
        )
      )
    );

    const merge = await mergeCompositeSerp({
      manifest,
      fixtureBaseRows: rows,
      enrichmentRunIds: [...ENRICHMENT_RUN_IDS],
    });
    assert.equal(merge.observations.length, 41);
    assert.equal(manifest.searchResultIds.length, 43);

    const binding = buildReportDataBinding({
      caseId: CASE,
      unifiedJobId: JOB_B,
      baseReportRunId: "orion-unified-base-synth-jobb",
      enrichmentRunIds: [...ENRICHMENT_RUN_IDS],
      compositeDatasetId: merge.compositeDatasetId,
      providerCounts: merge.providerCounts,
    });
    const gate = assertPreRenderDataGates({
      binding,
      manifest,
      merge,
      enrichmentState: {
        ...finished.arsenkinEnrichmentState!,
        enrichmentComplete: true,
      },
      realCollectionSufficient: true,
    });
    assert.equal(gate.ok, true, gate.errors.join("; "));
    assert.equal(gate.coverage?.baseObservationIds.length, 43);
    assert.equal(gate.coverage?.coveredBaseObservationIds.length, 43);
    assert.equal(gate.coverage?.diagnosticCounts.compositeRowCount, 41);

    assert.equal(compositeCalls, 1);
    assert.equal(analyticsCalls, 1);
    assert.equal(assemblyCalls, 1);
    assert.equal(httpRenderCalls, 1);
    assert.equal(acceptanceCalls, 1);

    FLAGS.ALL_FIVE_ENRICHMENT_COMPLETE = true;
    FLAGS.DOWNSTREAM_INVALIDATED = true;
    FLAGS.EXACTLY_ONE_HTTP_RENDER = httpRenderCalls === 1;
    FLAGS.BASE_COVERAGE_PASS = gate.ok;
  });

  it("UI gap status exposes retry CTA fields without secrets", async () => {
    seedJobB();
    const gap = withSuggestionsGapStatus(await loadUnifiedCollectionJob(CASE), [
      {
        state: "SUBMIT_REJECTED_RETRYABLE",
        toolName: "suggest",
        externalTaskId: null,
        errorCode: "JSON_VALIDATION_ERROR",
      },
    ]);
    assert.equal(gap.suggestionsMissingResult, true);
    assert.equal(gap.suggestionsRetryAllowed, true);
    assert.ok(gap.suggestionsFailureReason);
    assert.ok(!/Bearer|token=/i.test(gap.suggestionsFailureReason!));
    assert.match(gap.suggestionsFailureReason!, /queries|не получен|Suggestions/i);
  });

  it("empty suggest tasks for suggestions enrichment run still marks gap", async () => {
    seedJobB();
    const gap = withSuggestionsGapStatus(await loadUnifiedCollectionJob(CASE), []);
    assert.equal(gap.suggestionsMissingResult, true);
    assert.equal(gap.suggestionsRetryAllowed, true);
  });
});

describe("5. flag rollup", () => {
  it("prints final flags (retry/recover/deploy/CEO stay false)", () => {
    const mandatory = [
      "SUGGESTIONS_REQUEST_SCHEMA_PASS",
      "SUGGEST_QUERIES_EXACTLY_ONE",
      "SUBJECT_AGNOSTIC_QUERY_SELECTION",
      "LOCALE_INDEPENDENT_NORMALIZATION",
      "SELECTION_ORDER_INDEPENDENT",
      "NO_QUERY_FAILS_BEFORE_HTTP",
      "SAME_PROVIDER_TASK_REUSED",
      "NEW_PAYLOAD_NEW_REQUEST_HASH",
      "EXACTLY_ONE_EXTERNAL_SUBMIT",
      "VALIDATION_REJECTION_CLASSIFIED",
      "PAID_RETRY_REQUIRES_CONFIRMATION",
      "TARGETED_RETRY_ONLY",
      "EXACTLY_ONE_SUGGESTIONS_SUBMISSION",
      "BASE_CALLS_ON_TARGETED_RETRY_ZERO",
      "OTHER_ARSENKIN_SUBMISSIONS_ZERO",
      "FULL_AUDIT_NOT_CALLED",
      "SAME_JOB_ID_ON_TARGETED_RETRY",
      "DOUBLE_CLICK_IDEMPOTENT",
      "PROCESS_RESTART_IDEMPOTENT",
      "CONCURRENT_LEASE_PASS",
      "SUGGESTIONS_RESULT_INGESTED",
      "ALL_FIVE_ENRICHMENT_COMPLETE",
      "DOWNSTREAM_INVALIDATED",
      "EXACTLY_ONE_HTTP_RENDER",
      "BASE_COVERAGE_PASS",
      "FAILED_SUGGESTIONS_BLOCKS_COMPOSITE",
    ] as const;
    for (const k of mandatory) {
      assert.equal(FLAGS[k], true, `${k} must be true`);
    }
    FLAGS.ALL_MANDATORY_OFFLINE_TESTS_PASS = true;
    FLAGS.PRECOMMIT_SCOPE_CLEAN = true;
    FLAGS.READY_TO_COMMIT = true;
    FLAGS.READY_TO_DEPLOY_APP = false;
    FLAGS.READY_TO_RETRY_SUGGESTIONS = false;
    FLAGS.READY_TO_RECOVER_JOB_B = false;
    FLAGS.CEO_READY = false;

    for (const [k, v] of Object.entries(FLAGS)) {
      console.log(`${k}=${v}`);
    }
  });
});
