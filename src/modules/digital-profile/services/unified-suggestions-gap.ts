/**
 * Detect missing/failed SUGGESTIONS enrichment for unified job UI/status.
 */

import type { UnifiedCollectionJob } from "./unified-collection-types";

export type SuggestionsGapStatus = {
  suggestionsMissingResult: boolean;
  suggestionsFailureReason: string | null;
  suggestionsRetryAllowed: boolean;
  suggestionsEnrichmentRunId: string | null;
  suggestionsAgentName: "ARSENKIN_SUGGESTIONS_REAL";
};

function safeReason(raw: string | null | undefined): string {
  const s = String(raw ?? "")
    .replace(/Bearer\s+\S+/gi, "[redacted]")
    .replace(/token[=:]\s*\S+/gi, "[redacted]")
    .slice(0, 220)
    .trim();
  if (/JSON_VALIDATION_ERROR|SUBMIT_REJECTED_RETRYABLE|queries/i.test(s)) {
    return "Arsenkin отклонил запрос Suggestions (ошибка поля queries). Внешняя задача не создана.";
  }
  if (/SUBMIT_UNKNOWN|http_500/i.test(s)) {
    return "Результат Suggestions не получен (отправка не подтверждена).";
  }
  return s || "Suggestions: результат не получен";
}

function suggestionsAgentFailed(job: UnifiedCollectionJob): boolean {
  const st = job.arsenkinEnrichmentState;
  if (!st) return false;
  if (st.failedAgents?.some((a) => /SUGGESTIONS/i.test(a))) return true;
  if (st.enrichmentComplete) return false;
  const scheduled = st.scheduledAgents?.some((a) => /SUGGESTIONS/i.test(a));
  const completed = st.completedAgents?.some((a) => /SUGGESTIONS/i.test(a));
  const ingested = st.ingestedAgents?.some((a) => /SUGGESTIONS/i.test(a));
  return Boolean(scheduled && !completed && !ingested);
}

/**
 * @param tasks When omitted, gap is inferred only from job enrichment state / warnings
 *   (never assume missing solely because ProviderTasks were not loaded).
 */
export function withSuggestionsGapStatus(
  job: UnifiedCollectionJob | null,
  tasks?: Array<{
    state: string;
    toolName?: string | null;
    externalTaskId?: string | null;
    errorCode?: string | null;
  }>
): SuggestionsGapStatus {
  const empty: SuggestionsGapStatus = {
    suggestionsMissingResult: false,
    suggestionsFailureReason: null,
    suggestionsRetryAllowed: false,
    suggestionsEnrichmentRunId: null,
    suggestionsAgentName: "ARSENKIN_SUGGESTIONS_REAL",
  };
  if (!job) return empty;
  const enrichmentRunId =
    (job.enrichmentRunIds ?? []).find((id) => /suggestions/i.test(id)) ?? null;
  if (!enrichmentRunId) return empty;

  const tasksProvided = tasks !== undefined;
  const suggestTasks = (tasks ?? []).filter((t) => /suggest/i.test(String(t.toolName ?? "")));
  const hasDoneWithExt = suggestTasks.some(
    (t) =>
      String(t.state).toUpperCase() === "DONE" && Boolean(String(t.externalTaskId ?? "").trim())
  );
  const hasIngestibleExt = suggestTasks.some((t) =>
    Boolean(String(t.externalTaskId ?? "").trim())
  );
  const rejected = suggestTasks.find((t) =>
    /SUBMIT_REJECTED_RETRYABLE|SUBMIT_UNKNOWN/i.test(String(t.state))
  );
  const stateFailed = suggestionsAgentFailed(job);
  const warningHit = (job.warnings ?? []).some((w) =>
    /SUBMIT_REJECTED|SUBMIT_UNKNOWN|targeted-retry:|suggestions.*missing|SUGGESTIONS_RESULT/i.test(
      w
    )
  );

  if (hasDoneWithExt || (hasIngestibleExt && job.arsenkinEnrichmentState?.enrichmentComplete)) {
    return {
      ...empty,
      suggestionsEnrichmentRunId: enrichmentRunId,
    };
  }

  const missingFromTasks =
    tasksProvided &&
    !hasDoneWithExt &&
    (Boolean(rejected) ||
      (suggestTasks.length > 0 &&
        suggestTasks.every((t) => !String(t.externalTaskId ?? "").trim())));

  const missingFromJob = !tasksProvided && (stateFailed || warningHit);

  const suggestionsMissingResult = Boolean(missingFromTasks || missingFromJob);
  if (!suggestionsMissingResult) {
    return {
      ...empty,
      suggestionsEnrichmentRunId: enrichmentRunId,
    };
  }

  return {
    suggestionsMissingResult: true,
    suggestionsFailureReason: safeReason(
      rejected?.errorCode ?? job.lastErrorCode ?? job.lastError ?? "SUGGESTIONS_RESULT_MISSING"
    ),
    suggestionsRetryAllowed: true,
    suggestionsEnrichmentRunId: enrichmentRunId,
    suggestionsAgentName: "ARSENKIN_SUGGESTIONS_REAL",
  };
}
