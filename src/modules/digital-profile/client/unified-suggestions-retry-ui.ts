/**
 * Pure helpers for Suggestions targeted-retry UI wiring.
 * Kept free of React so offline smokes can prove the call contract.
 */

export const SUGGESTIONS_TARGETED_RETRY_CONFIRM =
  "Будет отправлена одна платная задача Arsenkin. Базовый поиск и остальные агенты повторно не запускаются.";

export type SuggestionsRetryJobFields = {
  jobId?: string | null;
  suggestionsRetryAllowed?: boolean;
  suggestionsMissingResult?: boolean;
  suggestionsEnrichmentRunId?: string | null;
  recoveryAllowed?: boolean;
  fullAuditBlocked?: boolean;
  paidRecollectionRequired?: boolean;
};

export function isSuggestionsTargetedRetryState(
  job: SuggestionsRetryJobFields | null | undefined
): boolean {
  return Boolean(job?.suggestionsRetryAllowed && job?.suggestionsMissingResult);
}

export function shouldShowGeneralRecoveryCta(
  job: SuggestionsRetryJobFields | null | undefined
): boolean {
  return Boolean(job?.recoveryAllowed) && !isSuggestionsTargetedRetryState(job);
}

export function shouldBlockFullAuditCta(
  job: SuggestionsRetryJobFields | null | undefined
): boolean {
  return (
    isSuggestionsTargetedRetryState(job) ||
    Boolean(job?.fullAuditBlocked) ||
    Boolean(job?.recoveryAllowed) ||
    Boolean(job?.paidRecollectionRequired)
  );
}

export function suggestionsTargetedRetryPath(caseId: string): string {
  return `/cases/${caseId}/unified-collection/retry-enrichment-task`;
}

export function buildSuggestionsTargetedRetryBody(input: {
  jobId: string;
  enrichmentRunId: string;
  confirmPaidEnrichmentRetry: boolean;
  expectedTaskFingerprint?: string;
}): {
  jobId: string;
  enrichmentRunId: string;
  agentName: "SUGGESTIONS";
  confirmPaidEnrichmentRetry: boolean;
  expectedTaskFingerprint?: string;
} {
  const body: {
    jobId: string;
    enrichmentRunId: string;
    agentName: "SUGGESTIONS";
    confirmPaidEnrichmentRetry: boolean;
    expectedTaskFingerprint?: string;
  } = {
    jobId: input.jobId,
    enrichmentRunId: input.enrichmentRunId,
    agentName: "SUGGESTIONS",
    confirmPaidEnrichmentRetry: input.confirmPaidEnrichmentRetry,
  };
  if (input.expectedTaskFingerprint != null && String(input.expectedTaskFingerprint).trim()) {
    body.expectedTaskFingerprint = String(input.expectedTaskFingerprint).trim();
  }
  return body;
}

/** Single-flight guard for double-click → one POST. */
export function createSingleFlightGuard(): {
  tryEnter: () => boolean;
  leave: () => void;
  isBusy: () => boolean;
} {
  let busy = false;
  return {
    tryEnter(): boolean {
      if (busy) return false;
      busy = true;
      return true;
    },
    leave(): void {
      busy = false;
    },
    isBusy(): boolean {
      return busy;
    },
  };
}

export function isAcceptedSuggestionsRetryResult(result: {
  accepted?: boolean;
  externalTaskId?: string | null;
}): boolean {
  return Boolean(result?.accepted) && Boolean(String(result?.externalTaskId ?? "").trim());
}
