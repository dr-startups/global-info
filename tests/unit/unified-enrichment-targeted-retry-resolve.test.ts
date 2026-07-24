/**
 * Offline: resolveSuggestTasksForRetry remaps to sibling CaseAgent suggest tasks
 * and ensure path stays scoped when listProviderTasks is injected alone.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clearSuggestionsFailureFromEnrichmentState,
  isReusableSuggestTask,
  mergeSuggestionsEnrichmentRunId,
  resolveSuggestTasksForRetry,
  type TargetedProviderTaskRow,
} from "../../src/modules/digital-profile/services/unified-enrichment-targeted-retry";
import { emptyArsenkinEnrichmentState } from "../../src/modules/digital-profile/services/arsenkin-enrichment-state";

describe("resolveSuggestTasksForRetry", () => {
  it("keeps primary run when it already has a reusable suggest task", async () => {
    const primary: TargetedProviderTaskRow[] = [
      {
        id: "pt-1",
        state: "DONE",
        toolName: "suggest",
        externalTaskId: "ext-1",
        reportRunId: "run-primary",
      },
    ];
    const resolved = await resolveSuggestTasksForRetry({
      caseId: "case-1",
      enrichmentRunId: "run-primary",
      deps: {
        listProviderTasks: async () => primary,
        listCaseSuggestTasks: async () => [
          {
            id: "pt-sib",
            state: "DONE",
            toolName: "suggest",
            externalTaskId: "ext-sib",
            reportRunId: "run-sibling",
          },
        ],
      },
    });
    assert.equal(resolved.enrichmentRunId, "run-primary");
    assert.equal(resolved.remappedFromSibling, false);
    assert.equal(resolved.tasks[0]?.externalTaskId, "ext-1");
  });

  it("remaps to sibling CaseAgent run when primary has no reusable task", async () => {
    const resolved = await resolveSuggestTasksForRetry({
      caseId: "case-1",
      enrichmentRunId: "run-primary-missing",
      deps: {
        listProviderTasks: async () => [
          {
            id: "pt-rejected",
            state: "SUBMIT_REJECTED_RETRYABLE",
            toolName: "suggest",
            externalTaskId: null,
            reportRunId: "run-primary-missing",
          },
        ],
        listCaseSuggestTasks: async () => [
          {
            id: "pt-sib",
            state: "DONE",
            toolName: "suggest",
            externalTaskId: "ext-sib-113",
            reportRunId: "orion-arsenkin-agent-arsenkin-suggestions-real-abc",
          },
        ],
      },
    });
    assert.equal(
      resolved.enrichmentRunId,
      "orion-arsenkin-agent-arsenkin-suggestions-real-abc"
    );
    assert.equal(resolved.remappedFromSibling, true);
    assert.equal(resolved.tasks[0]?.externalTaskId, "ext-sib-113");
  });

  it("does not remap when only listProviderTasks is injected (smoke scope)", async () => {
    const resolved = await resolveSuggestTasksForRetry({
      caseId: "case-1",
      enrichmentRunId: "run-primary",
      deps: {
        listProviderTasks: async () => [
          {
            id: "pt-empty",
            state: "SUBMIT_UNKNOWN",
            toolName: "suggest",
            externalTaskId: null,
          },
        ],
      },
    });
    assert.equal(resolved.enrichmentRunId, "run-primary");
    assert.equal(resolved.remappedFromSibling, false);
  });

  it("isReusableSuggestTask recognizes DONE + externalTaskId", () => {
    assert.equal(
      isReusableSuggestTask({
        id: "x",
        state: "DONE",
        toolName: "suggest",
        externalTaskId: "e1",
      }),
      true
    );
    assert.equal(
      isReusableSuggestTask({
        id: "x",
        state: "SUBMIT_REJECTED_RETRYABLE",
        toolName: "suggest",
        externalTaskId: null,
      }),
      false
    );
  });

  it("mergeSuggestionsEnrichmentRunId replaces stale suggestions id (not append)", () => {
    const merged = mergeSuggestionsEnrichmentRunId(
      [
        "orion-arsenkin-agent-arsenkin-search-top-real-aaa",
        "orion-arsenkin-agent-arsenkin-suggestions-real-OLD",
        "orion-arsenkin-agent-arsenkin-paa-real-bbb",
      ],
      "orion-arsenkin-agent-arsenkin-suggestions-real-NEW"
    );
    assert.deepEqual(merged, [
      "orion-arsenkin-agent-arsenkin-search-top-real-aaa",
      "orion-arsenkin-agent-arsenkin-suggestions-real-NEW",
      "orion-arsenkin-agent-arsenkin-paa-real-bbb",
    ]);
    assert.equal(merged.filter((id) => /suggestions/i.test(id)).length, 1);
  });

  it("clearSuggestionsFailureFromEnrichmentState drops Suggestions from failedAgents", () => {
    const state = emptyArsenkinEnrichmentState({
      caseId: "c1",
      unifiedJobId: "u1",
    });
    state.failedAgents = [
      "ARSENKIN_SUGGESTIONS_REAL",
      "ARSENKIN_PAA_REAL",
      "ARSENKIN_URL_AUDIT_REAL",
    ];
    state.agents = [
      {
        agentName: "ARSENKIN_SUGGESTIONS_REAL",
        enrichmentRunId: "old-suggestions",
        scheduled: true,
        terminal: true,
        terminalKind: "FAILED",
        ingested: false,
        pendingTaskCount: 0,
        doneTaskCount: 0,
        submitUnknownCount: 0,
        observationCount: 0,
        errorCode: "FAILED",
      },
    ];
    const next = clearSuggestionsFailureFromEnrichmentState(
      state,
      "new-suggestions-run"
    );
    assert.deepEqual(next?.failedAgents, [
      "ARSENKIN_PAA_REAL",
      "ARSENKIN_URL_AUDIT_REAL",
    ]);
    assert.equal(next?.agents[0]?.enrichmentRunId, "new-suggestions-run");
    assert.equal(next?.agents[0]?.terminalKind, null);
  });
});
