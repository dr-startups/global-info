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

/**
 * Terminal failure of the Suggestions agent.
 *
 * "Scheduled but not finished yet" is NOT a failure: the five Arsenkin agents
 * start sequentially, so Suggestions is legitimately unstarted for the first
 * minutes of every run. Treating that as a gap made the UI demand a paid retry
 * of a task that was about to run on its own — observed on every run, clearing
 * itself a few minutes later, which is what "errors keep popping up" meant.
 */
function suggestionsAgentFailed(job: UnifiedCollectionJob): boolean {
  const st = job.arsenkinEnrichmentState;
  if (!st) return false;
  if (st.failedAgents?.some((a) => /SUGGESTIONS/i.test(a))) return true;
  // Enrichment finished without a Suggestions result — that is a real gap.
  if (st.enrichmentComplete) {
    return !st.ingestedAgents?.some((a) => /SUGGESTIONS/i.test(a));
  }
  return false;
}

/**
 * The agent has not had its turn yet: enrichment is still in flight and
 * Suggestions is neither failed nor finished. Nothing to report and nothing
 * to retry.
 */
function suggestionsStillInFlight(job: UnifiedCollectionJob): boolean {
  const st = job.arsenkinEnrichmentState;
  if (!st) return false;
  if (st.enrichmentComplete) return false;
  if (st.failedAgents?.some((a) => /SUGGESTIONS/i.test(a))) return false;
  const stageActive =
    job.stage === "ARSENKIN_ENRICHMENT" &&
    (job.status === "WAITING" || job.status === "RUNNING");
  const pending = st.pendingAgents?.some((a) => /SUGGESTIONS/i.test(a)) ?? false;
  const scheduled = st.scheduledAgents?.some((a) => /SUGGESTIONS/i.test(a)) ?? false;
  return stageActive && (pending || scheduled);
}

function suggestionsIngested(job: UnifiedCollectionJob): boolean {
  return Boolean(
    job.arsenkinEnrichmentState?.ingestedAgents?.some((a) => /SUGGESTIONS/i.test(a))
  );
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

  // Successful ingest closes the gap even when a sibling SUBMIT_UNKNOWN row remains.
  if (suggestionsIngested(job)) {
    return {
      ...empty,
      suggestionsEnrichmentRunId: enrichmentRunId,
    };
  }

  const tasksProvided = tasks !== undefined;
  const suggestTasks = (tasks ?? []).filter((t) => /suggest/i.test(String(t.toolName ?? "")));
  const hasDoneWithExt = suggestTasks.some(
    (t) =>
      String(t.state).toUpperCase() === "DONE" && Boolean(String(t.externalTaskId ?? "").trim())
  );
  const hasIngestibleExt = suggestTasks.some((t) =>
    Boolean(String(t.externalTaskId ?? "").trim())
  );
  const pollableWithExt = suggestTasks.some((t) => {
    const st = String(t.state).toUpperCase();
    return (
      Boolean(String(t.externalTaskId ?? "").trim()) &&
      /^(RUNNING|SUBMITTED|RATE_LIMITED|WAITING|POLLING|DONE)$/.test(st)
    );
  });
  const rejected = suggestTasks.find((t) =>
    /SUBMIT_REJECTED_RETRYABLE|SUBMIT_UNKNOWN/i.test(String(t.state))
  );
  const stateFailed = suggestionsAgentFailed(job);
  const warningHit = (job.warnings ?? []).some((w) =>
    /SUBMIT_REJECTED|SUBMIT_UNKNOWN|JSON_VALIDATION_ERROR|targeted-retry:|suggestions.*missing|SUGGESTIONS_RESULT/i.test(
      w
    )
  );
  const scheduledSuggest =
    (job.warnings ?? []).some((w) => /arsenkin-scheduled:.*SUGGESTIONS/i.test(w)) ||
    Boolean(job.arsenkinEnrichmentState?.scheduledAgents?.some((a) => /SUGGESTIONS/i.test(a)));
  const enrichmentIncomplete = job.arsenkinEnrichmentState?.enrichmentComplete !== true;
  const durableIngestActive =
    job.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" &&
    (job.status === "WAITING" || job.status === "RUNNING") &&
    job.stage === "ARSENKIN_ENRICHMENT";

  if (hasDoneWithExt || (hasIngestibleExt && job.arsenkinEnrichmentState?.enrichmentComplete)) {
    return {
      ...empty,
      suggestionsEnrichmentRunId: enrichmentRunId,
    };
  }

  // Durable poll/ingest in progress for an accepted externalTaskId — show progress, hide retry CTA.
  if (durableIngestActive && pollableWithExt) {
    return {
      suggestionsMissingResult: false,
      suggestionsFailureReason: null,
      suggestionsRetryAllowed: false,
      suggestionsEnrichmentRunId: enrichmentRunId,
      suggestionsAgentName: "ARSENKIN_SUGGESTIONS_REAL",
    };
  }

  // Empty ProviderTask rows for a suggestions enrichment run still mean a gap
  // (failed load path returns undefined, not []).
  const missingFromTasks =
    tasksProvided &&
    !hasDoneWithExt &&
    !pollableWithExt &&
    (Boolean(rejected) ||
      suggestTasks.length === 0 ||
      suggestTasks.every((t) => !String(t.externalTaskId ?? "").trim()));

  // When tasks could not be loaded, infer gap from job signals — including a
  // scheduled Suggestions agent that never completed (Job B incident pattern).
  // Do not treat durable ingest progress as a gap when pollAttempt/nextPollAt exist.
  const ingestProgressVisible =
    durableIngestActive &&
    (Number(job.pollAttempt ?? 0) > 0 || Boolean(job.nextPollAt));
  const missingFromJob =
    !tasksProvided &&
    !ingestProgressVisible &&
    (stateFailed ||
      warningHit ||
      (scheduledSuggest && enrichmentIncomplete && Boolean(enrichmentRunId)));

  // An explicit rejection is a real failure at any moment; everything else must
  // wait until the agent has actually had its turn.
  const explicitFailure = Boolean(rejected) || stateFailed || warningHit;
  const suggestionsMissingResult =
    Boolean(missingFromTasks || missingFromJob) &&
    (explicitFailure || !suggestionsStillInFlight(job));
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
    suggestionsRetryAllowed: !durableIngestActive || !pollableWithExt,
    suggestionsEnrichmentRunId: enrichmentRunId,
    suggestionsAgentName: "ARSENKIN_SUGGESTIONS_REAL",
  };
}
