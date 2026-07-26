import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  clearFailedAgentsFromEnrichmentState,
  mergeAgentEnrichmentRunId,
  remapFailedEnrichmentRunsToSiblings,
  type SiblingRemapTaskRow,
} from "../../src/modules/digital-profile/services/unified-enrichment-sibling-remap";
import type { UnifiedCollectionJob } from "../../src/modules/digital-profile/services/unified-collection-types";

function baseJob(overrides: Partial<UnifiedCollectionJob> = {}): UnifiedCollectionJob {
  return {
    caseId: "case-1",
    jobId: "job-1",
    unifiedJobId: "unified-1",
    stage: "FAILED_RETRYABLE",
    status: "WAITING",
    enrichmentRunIds: [
      "orion-arsenkin-agent-arsenkin-search-top-real-aaa",
      "orion-arsenkin-agent-arsenkin-suggestions-real-bbb",
      "orion-arsenkin-agent-arsenkin-paa-real-ccc",
      "orion-arsenkin-agent-arsenkin-ai-search-real-ddd",
      "orion-arsenkin-agent-arsenkin-url-audit-real-eee",
    ],
    arsenkinEnrichmentState: {
      version: "arsenkin-enrichment-state-v1",
      unifiedJobId: "unified-1",
      caseId: "case-1",
      scheduledAgents: [
        "ARSENKIN_SEARCH_TOP_REAL",
        "ARSENKIN_SUGGESTIONS_REAL",
        "ARSENKIN_PAA_REAL",
        "ARSENKIN_AI_SEARCH_REAL",
        "ARSENKIN_URL_AUDIT_REAL",
      ],
      completedAgents: ["ARSENKIN_SEARCH_TOP_REAL", "ARSENKIN_SUGGESTIONS_REAL"],
      failedAgents: ["ARSENKIN_PAA_REAL", "ARSENKIN_AI_SEARCH_REAL", "ARSENKIN_URL_AUDIT_REAL"],
      pendingAgents: [],
      ingestedAgents: ["ARSENKIN_SEARCH_TOP_REAL", "ARSENKIN_SUGGESTIONS_REAL"],
      enrichmentObservationCount: 10,
      enrichmentComplete: false,
      agents: [],
      updatedAt: new Date().toISOString(),
      ingestedResultHashes: [],
    },
    ...overrides,
  } as UnifiedCollectionJob;
}

describe("unified-enrichment-sibling-remap", () => {
  it("mergeAgentEnrichmentRunId replaces stale agent id (not append)", () => {
    const next = mergeAgentEnrichmentRunId(
      [
        "orion-arsenkin-agent-arsenkin-paa-real-stale",
        "orion-arsenkin-agent-arsenkin-ai-search-real-ok",
      ],
      "ARSENKIN_PAA_REAL",
      "orion-arsenkin-agent-arsenkin-paa-real-sibling"
    );
    assert.deepEqual(next, [
      "orion-arsenkin-agent-arsenkin-paa-real-sibling",
      "orion-arsenkin-agent-arsenkin-ai-search-real-ok",
    ]);
  });

  it("clearFailedAgentsFromEnrichmentState drops remapped agents", () => {
    const cleared = clearFailedAgentsFromEnrichmentState(
      baseJob().arsenkinEnrichmentState,
      ["ARSENKIN_PAA_REAL"],
      new Map([["ARSENKIN_PAA_REAL", "paa-sibling"]])
    );
    assert.ok(cleared);
    assert.deepEqual(cleared!.failedAgents, [
      "ARSENKIN_AI_SEARCH_REAL",
      "ARSENKIN_URL_AUDIT_REAL",
    ]);
  });

  it("remaps PAA/AI/URL to sibling DONE runs when primary is empty", async () => {
    const primary: SiblingRemapTaskRow[] = [
      {
        id: "t-search",
        state: "DONE",
        toolName: "check-top",
        externalTaskId: "1",
        reportRunId: "orion-arsenkin-agent-arsenkin-search-top-real-aaa",
      },
    ];
    const siblings: SiblingRemapTaskRow[] = [
      {
        id: "t-paa",
        state: "DONE",
        toolName: "paa",
        externalTaskId: "2",
        reportRunId: "orion-arsenkin-agent-arsenkin-paa-real-sibling",
      },
      {
        id: "t-ai",
        state: "DONE",
        toolName: "ai-serp",
        externalTaskId: "3",
        reportRunId: "orion-arsenkin-agent-arsenkin-ai-search-real-sibling",
      },
      {
        id: "t-ch",
        state: "DONE",
        toolName: "check-h",
        externalTaskId: "4",
        reportRunId: "orion-arsenkin-agent-arsenkin-url-audit-real-sibling",
      },
      {
        id: "t-ix",
        state: "DONE",
        toolName: "indexation",
        externalTaskId: "5",
        reportRunId: "orion-arsenkin-agent-arsenkin-url-audit-real-sibling",
      },
    ];

    const result = await remapFailedEnrichmentRunsToSiblings({
      caseId: "case-1",
      job: baseJob(),
      deps: {
        listProviderTasksForRuns: async () => primary,
        listCaseArsenkinTasks: async () => siblings,
      },
    });

    assert.equal(result.changed, true);
    assert.equal(result.remaps.length, 3);
    assert.ok(
      result.enrichmentRunIds.includes("orion-arsenkin-agent-arsenkin-paa-real-sibling")
    );
    assert.ok(
      result.enrichmentRunIds.includes("orion-arsenkin-agent-arsenkin-ai-search-real-sibling")
    );
    assert.ok(
      result.enrichmentRunIds.includes("orion-arsenkin-agent-arsenkin-url-audit-real-sibling")
    );
    assert.ok(!result.enrichmentRunIds.includes("orion-arsenkin-agent-arsenkin-paa-real-ccc"));
    assert.deepEqual(result.arsenkinEnrichmentState?.failedAgents, []);
  });

  it("does not remap when only primary list is injected (smoke scope)", async () => {
    const result = await remapFailedEnrichmentRunsToSiblings({
      caseId: "case-1",
      job: baseJob(),
      deps: {
        listProviderTasksForRuns: async () => [],
      },
    });
    assert.equal(result.changed, false);
    assert.equal(result.remaps.length, 0);
  });
});
