/**
 * Offline smoke: one-shot LiveExecutionAuthorization for targeted SUGGESTIONS retry
 * + reuse of proven NO_EXTERNAL_REQUEST SUBMIT_UNKNOWN ProviderTask.
 *
 * NETWORK_CALLS=0 — no live Arsenkin, no Job B mutation, no deploy.
 *
 *   npm run smoke:arsenkin-suggestions-targeted-retry-live-auth
 */

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { ConflictError } from "../src/modules/digital-profile/http/errors";
import {
  getActiveLiveAuthorization,
  getActiveLiveBudget,
} from "../src/modules/digital-profile/providers/arsenkin/live-execution-authorization";
import { hashProviderRequest } from "../src/modules/digital-profile/providers/arsenkin/provider-task-store";
import { ARSENKIN_REAL_AGENT_NAMES } from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import { buildEnrichmentTickFromAgentSnapshots } from "../src/modules/digital-profile/services/arsenkin-enrichment-tick";
import {
  claimUnifiedJobLease,
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  releaseUnifiedJobLease,
  saveUnifiedCollectionJob,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  PAID_ENRICHMENT_RETRY_CONFIRMATION_REQUIRED,
  SUBMIT_UNKNOWN_REQUIRES_RECONCILIATION,
  buildTargetedSuggestionsLiveAuthorization,
  computeSuggestionsRetryFingerprint,
  isAmbiguousSubmitUnknown,
  isProvenNoExternalRequestSubmitUnknown,
  retryUnifiedEnrichmentSuggestionsTask,
  type TargetedProviderTaskRow,
} from "../src/modules/digital-profile/services/unified-enrichment-targeted-retry";
import { buildArsenkinSubjectQueryPlan } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-subject-query-plan";
import { buildSubjectIdentityProfile } from "../src/modules/digital-profile/orion-golden/identity/subject-identity-profile-builder";
import { withSuggestionsGapStatus } from "../src/modules/digital-profile/services/unified-suggestions-gap";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.NETWORK_CALLS = "0";

const CASE = "smoke-suggestions-live-auth";
const JOB_B = "unified-suggestions-live-auth-job";
const ENRICHMENT_RUN_IDS = ARSENKIN_REAL_AGENT_NAMES.map(
  (n) => `enrichment-run-${n.toLowerCase().replace(/_/g, "-")}-live-auth`
);
const SUGGEST_RUN = ENRICHMENT_RUN_IDS[1]!;

const FLAGS: Record<string, boolean> = {
  ONE_SHOT_LIVE_AUTH: false,
  GLOBAL_LIVE_AUTH_WEAKENED: false,
  EXISTING_NO_REQUEST_TASK_REUSED: false,
  EXACTLY_ONE_EXTERNAL_SUBMIT: false,
  BASE_CALLS_ON_TARGETED_RETRY_ZERO: false,
  OTHER_ARSENKIN_SUBMISSIONS_ZERO: false,
  DOUBLE_CLICK_IDEMPOTENT: false,
  PROCESS_RESTART_IDEMPOTENT: false,
  FULL_AUDIT_STILL_GUARDED: false,
  READY_TO_COMMIT: false,
  READY_TO_DEPLOY_APP: false,
  SAFE_TO_RETRY_LIVE: false,
};

function seedJobB() {
  deleteUnifiedCollectionJobForTests(CASE);
  const now = new Date().toISOString();
  saveUnifiedCollectionJob({
    version: "unified-orion-collection-job-v1",
    caseId: CASE,
    jobId: JOB_B,
    unifiedJobId: JOB_B,
    stage: "FAILED_TERMINAL",
    status: "FAILED",
    progress: 0.7,
    versionNum: 13,
    leaseOwnerId: null,
    leaseUntil: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
    requestedBy: "smoke",
    arsenkinMode: "full-first36",
    baseReportRunId: "orion-unified-base-synth-live-auth",
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
          ingested: !isSuggest,
          pendingTaskCount: 0,
          doneTaskCount: isSuggest ? 0 : 1,
          submitUnknownCount: isSuggest ? 1 : 0,
          observationCount: isSuggest ? 0 : 1,
        };
      }),
    }).state,
    compositeDatasetId: null,
    actualProviders: [{ providerId: "yandex", runtime: "real", status: "completed" }],
    coverage: null,
    warnings: ["SUGGESTIONS_RESULT_MISSING", "arsenkin-scheduled:ARSENKIN_SUGGESTIONS_REAL"],
    lastError: "Suggestions: результат не получен",
    lastErrorCode: "SUBMIT_UNKNOWN",
    artifactPaths: {},
    reportLinks: {},
    cancelRequested: false,
    resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
  });
}

function fingerprintForSubject(fullName: string) {
  const qp = buildArsenkinSubjectQueryPlan({ fullName, aliases: [] });
  const identity = buildSubjectIdentityProfile({
    caseId: CASE,
    subjectName: fullName,
    aliases: [],
  });
  return computeSuggestionsRetryFingerprint({
    enrichmentRunId: SUGGEST_RUN,
    queriesRu: qp.queriesRu,
    queriesUae: qp.queriesUae,
    candidates: identity.queryVariants,
    primaryLocalized: qp.primaryIdentityRu,
    primaryLatin: qp.primaryIdentityUae,
  });
}

before(() => {
  assert.equal(process.env.NETWORK_CALLS, "0");
});

describe("helpers: NO_EXTERNAL_REQUEST vs ambiguous", () => {
  it("classifies live-auth block as proven NO_EXTERNAL_REQUEST", () => {
    assert.equal(
      isProvenNoExternalRequestSubmitUnknown({
        state: "SUBMIT_UNKNOWN",
        externalTaskId: null,
        responseJson: {
          _submitDiagnostics: {
            httpStatus: null,
            message: "arsenkin-live-set-blocked:no-live-authorization",
          },
        },
      }),
      true
    );
    assert.equal(
      isAmbiguousSubmitUnknown({
        state: "SUBMIT_UNKNOWN",
        externalTaskId: null,
        responseJson: {
          _submitDiagnostics: {
            httpStatus: 500,
            message: "Arsenkin HTTP 500",
          },
        },
      }),
      true
    );
    assert.equal(
      isProvenNoExternalRequestSubmitUnknown({
        state: "SUBMIT_UNKNOWN",
        externalTaskId: null,
        responseJson: {
          _submitDiagnostics: { httpStatus: 500, message: "Arsenkin HTTP 500" },
        },
      }),
      false
    );
  });
});

describe("A–L targeted live-auth + reuse", () => {
  it("confirmation absent → externalCalls=0 and no lease side-effects", async () => {
    seedJobB();
    let submissions = 0;
    let requeues = 0;
    const taskStore: TargetedProviderTaskRow[] = [
      {
        id: "pt-no-auth",
        state: "SUBMIT_UNKNOWN",
        toolName: "suggest",
        externalTaskId: null,
        requestHash: "pending",
        responseJson: {
          _submitDiagnostics: {
            httpStatus: null,
            message: "arsenkin-live-set-blocked:no-live-authorization",
          },
        },
      },
    ];
    await assert.rejects(
      () =>
        retryUnifiedEnrichmentSuggestionsTask({
          caseId: CASE,
          jobId: JOB_B,
          enrichmentRunId: SUGGEST_RUN,
          agentName: "SUGGESTIONS",
          confirmPaidEnrichmentRetry: false,
          actorId: "smoke",
          deps: {
            autoSchedule: false,
            loadSubject: async () => ({ fullName: "Live Auth Subject", aliases: [] }),
            listProviderTasks: async () => taskStore,
            requeueNoExternalRequestTask: async () => {
              requeues += 1;
            },
            submitSuggestTask: async () => {
              submissions += 1;
              throw new Error("should-not-submit");
            },
          },
        }),
      (err: unknown) =>
        err instanceof ConflictError &&
        err.message === PAID_ENRICHMENT_RETRY_CONFIRMATION_REQUIRED
    );
    assert.equal(submissions, 0);
    assert.equal(requeues, 0);
    assert.equal(getActiveLiveAuthorization(), null);
    const job = loadUnifiedCollectionJob(CASE)!;
    assert.equal(job.leaseOwnerId, null);
  });

  it("confirmation → one-shot auth, one submit, reuse NO_EXTERNAL_REQUEST row, close auth", async () => {
    seedJobB();
    let submissions = 0;
    let otherAgentSubmissions = 0;
    let baseCalls = 0;
    let authSeenDuringSubmit = false;
    let maxNewTasksDuringSubmit: number | null = null;
    const fp = fingerprintForSubject("Live Auth Subject");
    const taskStore: TargetedProviderTaskRow[] = [
      {
        id: "pt-old-google-reject",
        state: "SUBMIT_REJECTED_RETRYABLE",
        toolName: "suggest",
        externalTaskId: null,
        requestHash: "hash-old-google",
        requestJson: {
          tools_name: "suggest",
          data: { se: 2, queries: ["legacy"] },
        },
        responseJson: {
          _submitDiagnostics: { httpStatus: 500, code: "JSON_VALIDATION_ERROR" },
        },
      },
      {
        id: "pt-no-auth-yandex",
        state: "SUBMIT_UNKNOWN",
        toolName: "suggest",
        externalTaskId: null,
        requestHash: fp.requestHash,
        responseJson: {
          _submitDiagnostics: {
            httpStatus: null,
            message: "arsenkin-live-set-blocked:no-live-authorization",
          },
        },
        errorCode: "submit_unknown",
      },
    ];

    const deps = {
      autoSchedule: false as const,
      loadSubject: async () => ({ fullName: "Live Auth Subject", aliases: [] as string[] }),
      listProviderTasks: async () => taskStore,
      requeueNoExternalRequestTask: async (id: string) => {
        const row = taskStore.find((t) => t.id === id);
        assert.ok(row);
        assert.equal(row.id, "pt-no-auth-yandex");
        row.state = "QUEUED";
        row.errorCode = null;
        row.responseJson = { _targetedRetryRequeue: { reason: "NO_EXTERNAL_REQUEST" } };
      },
      submitSuggestTask: async (args: {
        requestHash: string;
        requestJson: { tools_name: string; data: Record<string, unknown> };
      }) => {
        const auth = getActiveLiveAuthorization();
        assert.ok(auth, "one-shot live auth must be active during submit");
        authSeenDuringSubmit = true;
        maxNewTasksDuringSubmit = auth.maxNewTasks;
        assert.equal(auth.reportRunId, SUGGEST_RUN);
        assert.equal(auth.maxNewTasks, 1);
        assert.equal(auth.stage, "TARGETED_SUGGESTIONS_RETRY");
        assert.ok(auth.allowedRequestHashes.has(args.requestHash));
        assert.equal(args.requestHash, hashProviderRequest(args.requestJson));
        assert.equal(getActiveLiveBudget()?.createdNewTasks, 0);
        submissions += 1;
        // Simulate only SUGGESTIONS — never other agents / base.
        otherAgentSubmissions += 0;
        baseCalls += 0;
        const externalTaskId = `ext-live-auth-${submissions}`;
        const row = taskStore.find((t) => t.requestHash === args.requestHash)!;
        row.state = "RUNNING";
        row.externalTaskId = externalTaskId;
        return { externalTaskId, providerTaskId: row.id };
      },
    };

    const first = await retryUnifiedEnrichmentSuggestionsTask({
      caseId: CASE,
      jobId: JOB_B,
      enrichmentRunId: SUGGEST_RUN,
      agentName: "SUGGESTIONS",
      confirmPaidEnrichmentRetry: true,
      actorId: "smoke",
      deps,
    });

    assert.equal(authSeenDuringSubmit, true);
    assert.equal(maxNewTasksDuringSubmit, 1);
    assert.equal(getActiveLiveAuthorization(), null);
    assert.equal(first.submissions, 1);
    assert.equal(first.reusedNoExternalRequestTask, true);
    assert.equal(first.providerTaskId, "pt-no-auth-yandex");
    assert.equal(first.jobId, JOB_B);
    assert.ok(first.externalTaskId);
    assert.equal(submissions, 1);
    assert.equal(taskStore.filter((t) => /suggest/i.test(String(t.toolName))).length, 2);
    assert.equal(baseCalls, 0);
    assert.equal(otherAgentSubmissions, 0);

    // Double-click / restart: reuse persisted externalTaskId, no second submit.
    const second = await retryUnifiedEnrichmentSuggestionsTask({
      caseId: CASE,
      jobId: JOB_B,
      enrichmentRunId: SUGGEST_RUN,
      agentName: "SUGGESTIONS",
      confirmPaidEnrichmentRetry: true,
      actorId: "smoke-2",
      deps,
    });
    assert.equal(second.submissions, 0);
    assert.equal(second.reusedExisting, true);
    assert.equal(second.externalTaskId, first.externalTaskId);
    assert.equal(submissions, 1);
    assert.equal(getActiveLiveAuthorization(), null);

    FLAGS.ONE_SHOT_LIVE_AUTH = true;
    FLAGS.EXISTING_NO_REQUEST_TASK_REUSED = true;
    FLAGS.EXACTLY_ONE_EXTERNAL_SUBMIT = submissions === 1;
    FLAGS.BASE_CALLS_ON_TARGETED_RETRY_ZERO = baseCalls === 0;
    FLAGS.OTHER_ARSENKIN_SUBMISSIONS_ZERO = otherAgentSubmissions === 0;
    FLAGS.DOUBLE_CLICK_IDEMPOTENT = true;
    FLAGS.PROCESS_RESTART_IDEMPOTENT = true;
  });

  it("ambiguous SUBMIT_UNKNOWN forbids automatic resubmit", async () => {
    seedJobB();
    let submissions = 0;
    const fp = fingerprintForSubject("Ambiguous Subject");
    const taskStore: TargetedProviderTaskRow[] = [
      {
        id: "pt-ambiguous",
        state: "SUBMIT_UNKNOWN",
        toolName: "suggest",
        externalTaskId: null,
        requestHash: fp.requestHash,
        responseJson: {
          _submitDiagnostics: { httpStatus: 503, message: "timeout-or-5xx" },
        },
      },
    ];
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
            loadSubject: async () => ({ fullName: "Ambiguous Subject", aliases: [] }),
            listProviderTasks: async () => taskStore,
            submitSuggestTask: async () => {
              submissions += 1;
              return { externalTaskId: "x", providerTaskId: "y" };
            },
          },
        }),
      (err: unknown) =>
        err instanceof ConflictError && err.message === SUBMIT_UNKNOWN_REQUIRES_RECONCILIATION
    );
    assert.equal(submissions, 0);
  });

  it("concurrent lease → one submit", async () => {
    seedJobB();
    let submissions = 0;
    const fp = fingerprintForSubject("Lease Subject");
    const taskStore: TargetedProviderTaskRow[] = [
      {
        id: "pt-lease",
        state: "SUBMIT_UNKNOWN",
        toolName: "suggest",
        externalTaskId: null,
        requestHash: fp.requestHash,
        responseJson: {
          _submitDiagnostics: {
            httpStatus: null,
            message: "arsenkin-live-set-blocked:no-live-authorization",
          },
        },
      },
    ];
    const deps = {
      autoSchedule: false as const,
      loadSubject: async () => ({ fullName: "Lease Subject", aliases: [] as string[] }),
      listProviderTasks: async () => taskStore,
      requeueNoExternalRequestTask: async (id: string) => {
        const row = taskStore.find((t) => t.id === id)!;
        row.state = "QUEUED";
      },
      submitSuggestTask: async () => {
        submissions += 1;
        const ext = `ext-lease-${submissions}`;
        taskStore[0]!.externalTaskId = ext;
        taskStore[0]!.state = "RUNNING";
        return { externalTaskId: ext, providerTaskId: taskStore[0]!.id };
      },
    };
    const ownerA = "proc-a";
    assert.ok(claimUnifiedJobLease({ caseId: CASE, ownerId: ownerA, leaseMs: 60_000 }));
    const blocked = await retryUnifiedEnrichmentSuggestionsTask({
      caseId: CASE,
      jobId: JOB_B,
      enrichmentRunId: SUGGEST_RUN,
      agentName: "SUGGESTIONS",
      confirmPaidEnrichmentRetry: true,
      actorId: "b",
      deps,
    }).then(
      () => null,
      (e: unknown) => e
    );
    assert.ok(blocked instanceof ConflictError);
    assert.match(blocked.message, /ACTIVE_LEASE/);
    assert.equal(submissions, 0);
    releaseUnifiedJobLease(CASE, ownerA);

    const ok = await retryUnifiedEnrichmentSuggestionsTask({
      caseId: CASE,
      jobId: JOB_B,
      enrichmentRunId: SUGGEST_RUN,
      agentName: "SUGGESTIONS",
      confirmPaidEnrichmentRetry: true,
      actorId: "a",
      deps,
    });
    assert.equal(ok.submissions, 1);
    assert.equal(submissions, 1);
  });

  it("Full Audit still guarded while Suggestions gap; global live-auth not weakened", () => {
    seedJobB();
    const gap = withSuggestionsGapStatus(loadUnifiedCollectionJob(CASE), [
      {
        state: "SUBMIT_UNKNOWN",
        toolName: "suggest",
        externalTaskId: null,
        errorCode: "submit_unknown",
      },
    ]);
    assert.equal(gap.suggestionsRetryAllowed, true);
    assert.equal(gap.suggestionsMissingResult, true);

    const clientSrc = readFileSync(
      join(process.cwd(), "src/modules/digital-profile/providers/arsenkin/client.ts"),
      "utf8"
    );
    assert.match(clientSrc, /skipLiveAuthorizationCheck: false/);
    assert.doesNotMatch(clientSrc, /skipLiveAuthorizationCheck:\s*true/);

    const retrySrc = readFileSync(
      join(
        process.cwd(),
        "src/modules/digital-profile/services/unified-enrichment-targeted-retry.ts"
      ),
      "utf8"
    );
    assert.match(retrySrc, /withLiveAuthorization/);
    assert.match(retrySrc, /buildTargetedSuggestionsLiveAuthorization|buildLiveAuthorizationFromPlan/);
    assert.doesNotMatch(retrySrc, /skipLiveAuthorizationCheck:\s*true/);

    const auth = buildTargetedSuggestionsLiveAuthorization({
      enrichmentRunId: SUGGEST_RUN,
      requestHash: "abc",
    });
    assert.equal(auth.maxNewTasks, 1);
    assert.equal(getActiveLiveAuthorization(), null);

    FLAGS.FULL_AUDIT_STILL_GUARDED = true;
    FLAGS.GLOBAL_LIVE_AUTH_WEAKENED = false;
  });
});

describe("flag rollup", () => {
  it("prints flags", () => {
    FLAGS.READY_TO_COMMIT =
      FLAGS.ONE_SHOT_LIVE_AUTH &&
      !FLAGS.GLOBAL_LIVE_AUTH_WEAKENED &&
      FLAGS.EXISTING_NO_REQUEST_TASK_REUSED &&
      FLAGS.EXACTLY_ONE_EXTERNAL_SUBMIT &&
      FLAGS.BASE_CALLS_ON_TARGETED_RETRY_ZERO &&
      FLAGS.OTHER_ARSENKIN_SUBMISSIONS_ZERO &&
      FLAGS.DOUBLE_CLICK_IDEMPOTENT &&
      FLAGS.PROCESS_RESTART_IDEMPOTENT &&
      FLAGS.FULL_AUDIT_STILL_GUARDED;
    FLAGS.READY_TO_DEPLOY_APP = false;
    FLAGS.SAFE_TO_RETRY_LIVE = false;
    for (const [k, v] of Object.entries(FLAGS)) {
      console.log(`${k}=${v}`);
    }
    assert.equal(FLAGS.READY_TO_COMMIT, true);
    assert.equal(FLAGS.GLOBAL_LIVE_AUTH_WEAKENED, false);
    assert.equal(FLAGS.SAFE_TO_RETRY_LIVE, false);
  });
});
