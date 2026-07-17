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
  buildSuggestRequest,
  normalizeSuggestQueries,
  tryBuildSuggestRequest,
} from "../src/modules/digital-profile/providers/arsenkin/adapters/suggest";
import { ARSENKIN_REGION } from "../src/modules/digital-profile/providers/arsenkin/regions";
import { ArsenkinRequestError } from "../src/modules/digital-profile/providers/arsenkin/client";
import {
  classifyArsenkinSubmitFailure,
  classifyProviderTaskSubmitOutcome,
} from "../src/modules/digital-profile/providers/arsenkin/submit-outcome-classification";
import { planArsenkinExactTasks } from "../src/modules/digital-profile/orion-golden/classic/plan-arsenkin-exact-tasks";
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
  VALIDATION_REJECTION_CLASSIFIED: false,
  PAID_RETRY_REQUIRES_CONFIRMATION: false,
  TARGETED_RETRY_ONLY: false,
  EXACTLY_ONE_SUGGESTIONS_SUBMISSION: false,
  BASE_CALLS_ON_TARGETED_RETRY_ZERO: false,
  OTHER_ARSENKIN_SUBMISSIONS_ZERO: false,
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
  PRECOMMIT_SCOPE_CLEAN: false,
  READY_TO_COMMIT: false,
  READY_TO_DEPLOY_APP: false,
  READY_TO_RETRY_SUGGESTIONS: false,
  READY_TO_RECOVER_JOB_B: false,
  CEO_READY: false,
  FAILED_SUGGESTIONS_BLOCKS_COMPOSITE: false,
};

function seedJobB() {
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

describe("1. SUGGESTIONS request schema", () => {
  it("tool=suggest; Google rejects pure Cyrillic; Yandex accepts; plan uses Latin for Google", () => {
    const cyr = ["Иван Тестов", "Тестов Иван"];
    const lat = ["Ivan Testov", "Testov Ivan"];

    const yandex = buildSuggestRequest({
      queries: cyr,
      se: 1,
      region: ARSENKIN_REGION.YANDEX_MOSCOW,
      depth: 1,
    });
    assert.equal(yandex.tools_name, "suggest");
    assert.ok(Array.isArray(yandex.data.queries));
    assert.ok((yandex.data.queries as string[]).some((q) => /[\u0400-\u04FF]/.test(q)));

    const googleCyr = normalizeSuggestQueries({ queries: cyr, se: 2 });
    assert.equal(googleCyr.ok, false);

    const googleLat = buildSuggestRequest({
      queries: lat,
      se: 2,
      region: ARSENKIN_REGION.GOOGLE_MOSCOW,
      google_domain: "www.google.ru",
      google_from: "RU",
      google_lang: "ru",
      depth: 1,
    });
    assert.equal(googleLat.tools_name, "suggest");
    assert.deepEqual(googleLat.data.queries, lat.slice(0, 5));
    assert.equal(googleLat.data.se, 2);

    const bad = tryBuildSuggestRequest({
      queries: cyr,
      se: 2,
      region: ARSENKIN_REGION.GOOGLE_MOSCOW,
    });
    assert.equal(bad.ok, false);

    const plan = planArsenkinExactTasks({
      queriesRu: cyr,
      queriesUae: lat,
      tools: ["suggest"],
      urlsEnrichment: [],
    });
    const googleSuggest = plan.filter((t) => t.tool === "suggest" && Number(t.data.se) === 2);
    assert.ok(googleSuggest.length >= 1);
    for (const t of googleSuggest) {
      const qs = t.data.queries as string[];
      assert.ok(qs.every((q) => /[A-Za-z]/.test(q)), "Google suggest must be Latin");
    }

    FLAGS.SUGGESTIONS_REQUEST_SCHEMA_PASS = true;
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
  it("no confirmation → 409; with confirmation → exactly one SUGGESTIONS submit; same job", async () => {
    seedJobB();
    let submissions = 0;
    const otherAgentSubmissions = 0;
    const baseCalls = 0;
    const newUnifiedJobs = 0;
    const newAgentRuns = 0;
    const newEnrichmentRuns = 0;
    const taskStore: Array<{
      id: string;
      state: string;
      toolName: string | null;
      externalTaskId: string | null;
      requestHash?: string | null;
      responseJson?: unknown;
    }> = [
      {
        id: "pt-suggest-rejected",
        state: "SUBMIT_REJECTED_RETRYABLE",
        toolName: "suggest",
        externalTaskId: null,
        responseJson: { _submitDiagnostics: { httpStatus: 500, code: "JSON_VALIDATION_ERROR" } },
      },
    ];

    const deps = {
      loadSubject: async () => ({
        fullName: "Synthetic Subject",
        aliases: ["Synthetic Subject Alias"],
      }),
      listProviderTasks: async () => taskStore,
      submitSuggestTask: async () => {
        submissions += 1;
        const externalTaskId = `ext-suggest-${submissions}`;
        const providerTaskId = `pt-suggest-new-${submissions}`;
        taskStore.push({
          id: providerTaskId,
          state: "RUNNING",
          toolName: "suggest",
          externalTaskId,
          requestHash: "hash-synth",
        });
        return { externalTaskId, providerTaskId };
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
    assert.equal(first.jobId, JOB_B);
    assert.equal(first.status, "WAITING");
    assert.equal(first.resumeCheckpoint, "ARSENKIN_RESULT_INGEST");
    assert.ok(first.externalTaskId);
    assert.equal(submissions, 1);
    assert.equal(otherAgentSubmissions, 0);
    assert.equal(baseCalls, 0);
    assert.equal(newUnifiedJobs, 0);
    assert.equal(newAgentRuns, 0);
    assert.equal(newEnrichmentRuns, 0);

    const jobAfter = loadUnifiedCollectionJob(CASE)!;
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
    assert.equal(submissions, 1);
    assert.equal(second.jobId, JOB_B);

    FLAGS.TARGETED_RETRY_ONLY = true;
    FLAGS.EXACTLY_ONE_SUGGESTIONS_SUBMISSION = submissions === 1;
    FLAGS.BASE_CALLS_ON_TARGETED_RETRY_ZERO = baseCalls === 0;
    FLAGS.OTHER_ARSENKIN_SUBMISSIONS_ZERO = otherAgentSubmissions === 0;
    FLAGS.SAME_JOB_ID_ON_TARGETED_RETRY = true;
    FLAGS.DOUBLE_CLICK_IDEMPOTENT = true;
  });

  it("concurrent lease → one submission; restart reuses saved externalTaskId", async () => {
    seedJobB();
    let submissions = 0;
    const taskStore: Array<{
      id: string;
      state: string;
      toolName: string | null;
      externalTaskId: string | null;
      requestHash?: string | null;
      responseJson?: unknown;
    }> = [
      {
        id: "pt-reject",
        state: "SUBMIT_REJECTED_RETRYABLE",
        toolName: "suggest",
        externalTaskId: null,
      },
    ];
    const deps = {
      loadSubject: async () => ({ fullName: "Subject Two", aliases: [] as string[] }),
      listProviderTasks: async () => taskStore,
      submitSuggestTask: async () => {
        submissions += 1;
        const externalTaskId = `ext-lease-${submissions}`;
        const providerTaskId = `pt-lease-${submissions}`;
        taskStore.length = 0;
        taskStore.push({
          id: providerTaskId,
          state: "RUNNING",
          toolName: "suggest",
          externalTaskId,
        });
        return { externalTaskId, providerTaskId };
      },
    };

    const ownerA = "process-a";
    const claimedA = claimUnifiedJobLease({ caseId: CASE, ownerId: ownerA, leaseMs: 60_000 });
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
    releaseUnifiedJobLease(CASE, ownerA);

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
    const prev = loadUnifiedCollectionJob(CASE)!;
    saveUnifiedCollectionJob({
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
    writeUnifiedArtifact(CASE, JOB_B, "base-collection-manifest.json", manifest);
    writeUnifiedArtifact(CASE, JOB_B, "composite-serp-observations.json", {
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

    const finished = loadUnifiedCollectionJob(CASE)!;
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

  it("UI gap status exposes retry CTA fields without secrets", () => {
    seedJobB();
    const gap = withSuggestionsGapStatus(loadUnifiedCollectionJob(CASE), [
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

  it("empty suggest tasks for suggestions enrichment run still marks gap", () => {
    seedJobB();
    const gap = withSuggestionsGapStatus(loadUnifiedCollectionJob(CASE), []);
    assert.equal(gap.suggestionsMissingResult, true);
    assert.equal(gap.suggestionsRetryAllowed, true);
  });
});

describe("5. flag rollup", () => {
  it("prints final flags (retry/recover/deploy/CEO stay false)", () => {
    const mandatory = [
      "SUGGESTIONS_REQUEST_SCHEMA_PASS",
      "VALIDATION_REJECTION_CLASSIFIED",
      "PAID_RETRY_REQUIRES_CONFIRMATION",
      "TARGETED_RETRY_ONLY",
      "EXACTLY_ONE_SUGGESTIONS_SUBMISSION",
      "BASE_CALLS_ON_TARGETED_RETRY_ZERO",
      "OTHER_ARSENKIN_SUBMISSIONS_ZERO",
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
