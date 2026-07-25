import { describe, it, expect } from "vitest";
import { withSuggestionsGapStatus } from "../../src/modules/digital-profile/services/unified-suggestions-gap";
import type { UnifiedCollectionJob } from "../../src/modules/digital-profile/services/unified-collection-types";

/**
 * Шаг 11.1 плана (docs/rework/11-workflow-ux-and-false-failures.md).
 *
 * Пять агентов Arsenkin стартуют последовательно, поэтому Suggestions первые
 * минуты любого прогона законно не начат. Раньше это состояние объявлялось
 * отказом: UI требовал платный ретрай задачи, которая и так вот-вот выполнится,
 * и блокировал главную кнопку. Через несколько минут флаг гас сам.
 */

function job(over: Partial<UnifiedCollectionJob> = {}): UnifiedCollectionJob {
  return {
    jobId: "unified-1",
    unifiedJobId: "unified-1",
    caseId: "case-1",
    stage: "ARSENKIN_ENRICHMENT",
    status: "WAITING",
    progress: 0.35,
    warnings: [],
    enrichmentRunIds: ["orion-arsenkin-agent-arsenkin-suggestions-real-x1"],
    arsenkinEnrichmentState: {
      scheduledAgents: [
        "ARSENKIN_SEARCH_TOP_REAL",
        "ARSENKIN_SUGGESTIONS_REAL",
        "ARSENKIN_PAA_REAL",
      ],
      pendingAgents: ["ARSENKIN_SUGGESTIONS_REAL", "ARSENKIN_PAA_REAL"],
      completedAgents: ["ARSENKIN_SEARCH_TOP_REAL"],
      ingestedAgents: ["ARSENKIN_SEARCH_TOP_REAL"],
      failedAgents: [],
      enrichmentComplete: false,
    },
    ...over,
  } as unknown as UnifiedCollectionJob;
}

describe("разрыв по Suggestions", () => {
  it("молчит, пока агент просто ещё не дошёл до очереди", () => {
    // Ровно состояние живого прогона: задача suggest ещё не отправлена.
    const status = withSuggestionsGapStatus(job(), []);
    expect(status.suggestionsMissingResult).toBe(false);
    expect(status.suggestionsRetryAllowed).toBe(false);
  });

  it("молчит и когда список задач не удалось загрузить", () => {
    const status = withSuggestionsGapStatus(job(), undefined);
    expect(status.suggestionsMissingResult).toBe(false);
  });

  it("сообщает об отказе, когда агент помечен упавшим", () => {
    const failed = job({
      arsenkinEnrichmentState: {
        scheduledAgents: ["ARSENKIN_SUGGESTIONS_REAL"],
        pendingAgents: [],
        completedAgents: [],
        ingestedAgents: [],
        failedAgents: ["ARSENKIN_SUGGESTIONS_REAL"],
        enrichmentComplete: false,
      },
    } as never);
    const status = withSuggestionsGapStatus(failed, []);
    expect(status.suggestionsMissingResult).toBe(true);
    expect(status.suggestionsRetryAllowed).toBe(true);
  });

  it("сообщает об отказе при явном отклонении задачи провайдером", () => {
    const status = withSuggestionsGapStatus(job(), [
      { state: "SUBMIT_REJECTED_RETRYABLE", toolName: "suggest", errorCode: "JSON_VALIDATION_ERROR" },
    ]);
    expect(status.suggestionsMissingResult).toBe(true);
    expect(status.suggestionsFailureReason).toContain("Suggestions");
  });

  it("сообщает о разрыве, если обогащение завершилось без результата Suggestions", () => {
    const done = job({
      status: "RUNNING",
      arsenkinEnrichmentState: {
        scheduledAgents: ["ARSENKIN_SUGGESTIONS_REAL"],
        pendingAgents: [],
        completedAgents: ["ARSENKIN_SUGGESTIONS_REAL"],
        ingestedAgents: [],
        failedAgents: [],
        enrichmentComplete: true,
      },
    } as never);
    const status = withSuggestionsGapStatus(done, []);
    expect(status.suggestionsMissingResult).toBe(true);
  });

  it("молчит после успешного импорта результата", () => {
    const ok = job({
      arsenkinEnrichmentState: {
        scheduledAgents: ["ARSENKIN_SUGGESTIONS_REAL"],
        pendingAgents: [],
        completedAgents: ["ARSENKIN_SUGGESTIONS_REAL"],
        ingestedAgents: ["ARSENKIN_SUGGESTIONS_REAL"],
        failedAgents: [],
        enrichmentComplete: true,
      },
    } as never);
    expect(withSuggestionsGapStatus(ok, []).suggestionsMissingResult).toBe(false);
  });
});
