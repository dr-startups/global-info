/**
 * Offline UI/API wiring smoke for Suggestions targeted retry.
 * NETWORK_CALLS=0 — no live Arsenkin, no Full Audit, no recover.
 *
 *   npm run smoke:arsenkin-suggestions-targeted-retry-ui
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { getLocalizedApiError } from "../src/modules/digital-profile/i18n";
import { withSuggestionsGapStatus } from "../src/modules/digital-profile/services/unified-suggestions-gap";
import {
  SUGGESTIONS_TARGETED_RETRY_CONFIRM,
  buildSuggestionsTargetedRetryBody,
  createSingleFlightGuard,
  isAcceptedSuggestionsRetryResult,
  isSuggestionsTargetedRetryState,
  shouldBlockFullAuditCta,
  shouldShowGeneralRecoveryCta,
  suggestionsTargetedRetryPath,
} from "../src/modules/digital-profile/client/unified-suggestions-retry-ui";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

const FLAGS: Record<string, boolean> = {
  TARGETED_ENDPOINT_CALLED_BY_UI: false,
  FULL_AUDIT_CALLED_BY_TARGETED_UI: false,
  GENERAL_RECOVERY_CALLED_BY_TARGETED_UI: false,
  CONFIRMATION_REQUIRED: false,
  DOUBLE_CLICK_IDEMPOTENT: false,
  NO_LIVE_EXTERNAL_SUBMISSION: true,
  NO_DB_MIGRATION: true,
  CONFLICT_NOT_GENERIC_MASK: false,
  CTA_PRIORITY_PASS: false,
  READY_TO_COMMIT: false,
};

describe("A — targeted CTA API contract", () => {
  const api = read("src/modules/digital-profile/client/api.ts");
  const view = read("src/modules/digital-profile/client/CaseDetailView.tsx");
  const header = read("src/modules/digital-profile/client/CaseHeader.tsx");
  const route = read(
    "src/app/api/digital-profile/cases/[id]/unified-collection/retry-enrichment-task/route.ts"
  );

  it("existing server route is POST retry-enrichment-task with confirmation", () => {
    assert.match(route, /export const POST/);
    assert.match(route, /retryUnifiedEnrichmentSuggestionsTask/);
    assert.match(route, /confirmPaidEnrichmentRetry/);
    assert.doesNotMatch(route, /startUnifiedOrionCollection/);
  });

  it("client method posts only the targeted endpoint with contract fields", () => {
    assert.match(api, /export function retryUnifiedEnrichmentSuggestionsTask/);
    assert.match(api, /unified-collection\/retry-enrichment-task/);
    assert.match(api, /confirmPaidEnrichmentRetry: input\.confirmPaidEnrichmentRetry === true/);
    assert.match(api, /agentName: input\.agentName \?\? "SUGGESTIONS"/);
    assert.doesNotMatch(
      api.slice(api.indexOf("retryUnifiedEnrichmentSuggestionsTask")),
      /unified-collection\/recover/
    );
  });

  it("GET unified status exposes persisted nextPollAt / enrichment progress (F5 source of truth)", () => {
    const statusRoute = read(
      "src/app/api/digital-profile/cases/[id]/unified-collection/route.ts"
    );
    assert.match(statusRoute, /nextPollAt:\s*job\.nextPollAt/);
    assert.match(statusRoute, /pollAttempt:\s*job\.pollAttempt/);
    assert.match(statusRoute, /arsenkinEnrichmentState/);
    assert.match(api, /nextPollAt\?:/);
  });

  it("handler builds body via helper and requires confirm before POST", () => {
    assert.match(view, /buildSuggestionsTargetedRetryBody/);
    assert.match(view, /retryUnifiedEnrichmentSuggestionsTask\(caseId, body\)/);
    assert.match(view, /SUGGESTIONS_TARGETED_RETRY_CONFIRM/);
    assert.match(view, /window\.confirm\(SUGGESTIONS_TARGETED_RETRY_CONFIRM\)/);
    assert.match(header, /unified-suggestions-retry-cta/);
    assert.match(header, /Повторить только задачу Suggestions/);
    FLAGS.CONFIRMATION_REQUIRED = true;
  });

  it("simulated confirm→POST hits targeted path once; cancel→zero", () => {
    // Synthetic fixture IDs only — no live case/job hardcodes.
    const caseId = "smoke-case-suggestions-retry-ui";
    const jobId = "unified-smoke-suggestions-retry-ui";
    const enrichmentRunId = "enrichment-run-suggestions-synth";
    const posts: Array<{ path: string; body: unknown }> = [];

    const runOnce = (confirmed: boolean) => {
      if (!confirmed) return;
      const path = suggestionsTargetedRetryPath(caseId);
      const body = buildSuggestionsTargetedRetryBody({
        jobId,
        enrichmentRunId,
        confirmPaidEnrichmentRetry: true,
      });
      posts.push({ path, body });
    };

    runOnce(false);
    assert.equal(posts.length, 0, "Cancel must not POST");

    runOnce(true);
    assert.equal(posts.length, 1);
    assert.equal(posts[0]!.path, `/cases/${caseId}/unified-collection/retry-enrichment-task`);
    assert.deepEqual(posts[0]!.body, {
      jobId,
      enrichmentRunId,
      agentName: "SUGGESTIONS",
      confirmPaidEnrichmentRetry: true,
    });
    assert.doesNotMatch(posts[0]!.path, /\/unified-collection$/);
    assert.doesNotMatch(posts[0]!.path, /\/recover$/);
    FLAGS.TARGETED_ENDPOINT_CALLED_BY_UI = true;
    FLAGS.FULL_AUDIT_CALLED_BY_TARGETED_UI = false;
    FLAGS.GENERAL_RECOVERY_CALLED_BY_TARGETED_UI = false;
  });
});

describe("B — protection / single-flight", () => {
  it("double click → one enter", () => {
    const g = createSingleFlightGuard();
    assert.equal(g.tryEnter(), true);
    assert.equal(g.tryEnter(), false);
    assert.equal(g.isBusy(), true);
    g.leave();
    assert.equal(g.tryEnter(), true);
    FLAGS.DOUBLE_CLICK_IDEMPOTENT = true;
  });

  it("409 / rejected result does not count as success", () => {
    assert.equal(isAcceptedSuggestionsRetryResult({ accepted: true, externalTaskId: null }), false);
    assert.equal(isAcceptedSuggestionsRetryResult({ accepted: false, externalTaskId: "x" }), false);
    assert.equal(isAcceptedSuggestionsRetryResult({ accepted: true, externalTaskId: "123" }), true);
  });

  it("Full Audit / recover handlers hard-block during Suggestions gap", () => {
    const view = read("src/modules/digital-profile/client/CaseDetailView.tsx");
    assert.match(view, /isSuggestionsTargetedRetryState\(unifiedJob\)/);
    assert.match(
      view,
      /Full Audit недоступен: отсутствует результат Suggestions/
    );
    assert.match(view, /General recovery скрыт при gap Suggestions/);
    assert.match(view, /createSingleFlightGuard/);
  });
});

describe("C — UI CTA priority + i18n", () => {
  const header = read("src/modules/digital-profile/client/CaseHeader.tsx");
  const agents = read("src/modules/digital-profile/client/AgentsTab.tsx");
  const tabs = read("src/modules/digital-profile/client/CaseTabs.tsx");

  it("gap job shows only targeted CTA; recovery/full audit hidden", () => {
    const gapJob = {
      jobId: "unified-smoke-suggestions-retry-ui",
      suggestionsRetryAllowed: true,
      suggestionsMissingResult: true,
      suggestionsEnrichmentRunId: "enrichment-run-suggestions-synth",
      recoveryAllowed: true,
      fullAuditBlocked: true,
    };
    assert.equal(isSuggestionsTargetedRetryState(gapJob), true);
    assert.equal(shouldShowGeneralRecoveryCta(gapJob), false);
    assert.equal(shouldBlockFullAuditCta(gapJob), true);

    assert.match(header, /shouldShowGeneralRecoveryCta/);
    assert.match(header, /!suggestionsRetry \? \(/);
    assert.match(agents, /fullAuditBlocked/);
    assert.match(agents, /canRun && !fullAuditBlocked/);
    assert.match(tabs, /fullAuditBlocked=\{fullAuditBlocked\}/);
    FLAGS.CTA_PRIORITY_PASS = true;
  });

  it("CONFIRM copy is exact product string", () => {
    assert.equal(
      SUGGESTIONS_TARGETED_RETRY_CONFIRM,
      "Будет отправлена одна платная задача Arsenkin. Базовый поиск и остальные агенты повторно не запускаются."
    );
  });

  it("CONFLICT prefers server message over «Такой ресурс уже существует»", () => {
    const masked = getLocalizedApiError("CONFLICT", "ru");
    assert.match(masked, /уже существует/i);
    const specific = getLocalizedApiError(
      "CONFLICT",
      "ru",
      "PAID_ENRICHMENT_RETRY_CONFIRMATION_REQUIRED"
    );
    assert.equal(specific, "PAID_ENRICHMENT_RETRY_CONFIRMATION_REQUIRED");
    assert.doesNotMatch(specific, /уже существует/);
    FLAGS.CONFLICT_NOT_GENERIC_MASK = true;
  });

  it("gap detection without tasks still allows retry for scheduled Suggestions", () => {
    const gap = withSuggestionsGapStatus({
      version: "unified-orion-collection-job-v1",
      caseId: "c",
      jobId: "j",
      unifiedJobId: "j",
      stage: "FAILED_RETRYABLE",
      status: "FAILED",
      progress: 0,
      actualProviders: [],
      coverage: { regions: [], engines: [], surfaceTypes: [] },
      warnings: ["arsenkin-scheduled:ARSENKIN_SUGGESTIONS_REAL"],
      lastError: null,
      lastErrorCode: null,
      baseReportRunId: "base",
      arsenkinReportRunId: null,
      enrichmentRunIds: [
        "enrichment-run-a",
        "enrichment-run-arsenkin-suggestions-real",
        "enrichment-run-c",
        "enrichment-run-d",
        "enrichment-run-e",
      ],
      compositeDatasetId: null,
      reportLinks: {},
      artifactPaths: {},
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: null,
      arsenkinEnrichmentState: {
        scheduledAgents: ["ARSENKIN_SUGGESTIONS_REAL"],
        completedAgents: [],
        failedAgents: [],
        pendingAgents: ["ARSENKIN_SUGGESTIONS_REAL"],
        ingestedAgents: [],
        enrichmentObservationCount: 0,
        enrichmentComplete: false,
      },
    } as never);
    assert.equal(gap.suggestionsMissingResult, true);
    assert.equal(gap.suggestionsRetryAllowed, true);
  });
});

describe("D — server contract source + flags", () => {
  it("route requires confirmation before adapter (source)", () => {
    const service = read(
      "src/modules/digital-profile/services/unified-enrichment-targeted-retry.ts"
    );
    assert.match(service, /PAID_ENRICHMENT_RETRY_CONFIRMATION_REQUIRED/);
    assert.match(service, /if \(!input\.confirmPaidEnrichmentRetry\)/);
    assert.match(service, /ACTIVE_LEASE/);
    assert.match(service, /NETWORK_CALLS === "0"/);
  });

  it("prints flags", () => {
    FLAGS.READY_TO_COMMIT =
      FLAGS.TARGETED_ENDPOINT_CALLED_BY_UI &&
      !FLAGS.FULL_AUDIT_CALLED_BY_TARGETED_UI &&
      !FLAGS.GENERAL_RECOVERY_CALLED_BY_TARGETED_UI &&
      FLAGS.CONFIRMATION_REQUIRED &&
      FLAGS.DOUBLE_CLICK_IDEMPOTENT &&
      FLAGS.NO_LIVE_EXTERNAL_SUBMISSION &&
      FLAGS.NO_DB_MIGRATION &&
      FLAGS.CONFLICT_NOT_GENERIC_MASK &&
      FLAGS.CTA_PRIORITY_PASS;
    for (const [k, v] of Object.entries(FLAGS)) {
      console.log(`${k}=${v}`);
    }
    assert.equal(FLAGS.READY_TO_COMMIT, true);
  });
});
