"use client";

import Link from "next/link";
import type { CaseDetail, UnifiedCollectionJobStatus } from "./api";
import { StatusBadge } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";
import {
  SUGGESTIONS_TARGETED_RETRY_CONFIRM,
  isSuggestionsTargetedRetryState,
  shouldShowGeneralRecoveryCta,
} from "./unified-suggestions-retry-ui";

function arsenkinProgress(job: UnifiedCollectionJobStatus | null): string {
  if (!job) return "scheduled 0/5 · completed 0/5 · ingested 0/5";
  const st = job.arsenkinEnrichmentState;
  if (st) {
    const s = st.scheduledAgents?.length ?? 0;
    const c = st.completedAgents?.length ?? 0;
    const i = st.ingestedAgents?.length ?? 0;
    const suffix = st.enrichmentComplete
      ? "complete"
      : st.pendingAgents?.length
        ? "pending"
        : "incomplete";
    return `scheduled ${Math.min(5, s)}/5 · completed ${Math.min(5, c)}/5 · ingested ${Math.min(5, i)}/5 (${suffix})`;
  }
  const n = job.enrichmentRunIds?.length ?? 0;
  if (n > 0) return `scheduled ${Math.min(5, n)}/5 · completed 0/5 · ingested 0/5 (incomplete)`;
  return "scheduled 0/5 · completed 0/5 · ingested 0/5";
}

function isRenderRecovery(job: UnifiedCollectionJobStatus | null): boolean {
  if (!job) return false;
  return (
    job.resumeCheckpoint === "RENDER" ||
    job.recoveryReason === "RENDER_RESUME" ||
    job.recoveryReason === "IDEMPOTENT_RENDER_RESUME" ||
    job.lastErrorCode === "RENDER_FAILED"
  );
}

function unifiedStatusLabel(job: UnifiedCollectionJobStatus | null): string | null {
  if (!job) return null;
  if (job.stage === "FAILED_TERMINAL" || job.status === "FAILED") return "FAILED";
  if (job.stage === "FAILED_RETRYABLE") return "FAILED_RETRYABLE";
  if (job.stage === "REPORT_READY") return "REPORT_READY";
  if (job.stage === "COMPLETED_PARTIAL") return "COMPLETED_PARTIAL";
  if (job.status === "RUNNING" || job.status === "WAITING") return job.status;
  return job.stage;
}

function prepareRenderLabel(job: UnifiedCollectionJobStatus): string {
  if (job.stage === "REPORT_READY" || job.stage === "COMPLETED_PARTIAL") return "ok";
  if (job.lastErrorCode === "RENDER_FAILED" || job.resumeCheckpoint === "RENDER") {
    return job.stage === "FAILED_RETRYABLE" ? "failed" : "…";
  }
  if (job.stage === "ORION_PREPARE" || job.stage === "CLIENT_CONTENT") return "…";
  if (
    job.compositeDatasetId &&
    Boolean(job.arsenkinEnrichmentState?.enrichmentComplete) &&
    (job.enrichmentRunIds?.length ?? 0) >= 5
  ) {
    return "ok";
  }
  if ((job.enrichmentRunIds?.length ?? 0) >= 5 && !job.arsenkinEnrichmentState?.enrichmentComplete) {
    return "awaiting Arsenkin ingest";
  }
  return "—";
}

export function CaseHeader({
  caseDetail,
  onGenerate,
  generating,
  onRunUnifiedCollection,
  onRecoverUnifiedCollection,
  onRetrySuggestions,
  onPaidRecollection,
  auditing,
  recovering,
  unifiedJob,
}: {
  caseDetail: CaseDetail;
  onGenerate: () => void;
  generating: boolean;
  onRunUnifiedCollection: () => void;
  onRecoverUnifiedCollection: () => void;
  onRetrySuggestions?: () => void;
  onPaidRecollection?: () => void;
  auditing: boolean;
  recovering: boolean;
  /** Current unified job (not legacy AgentRun). */
  unifiedJob: UnifiedCollectionJobStatus | null;
}) {
  const { t, fmtDate } = useDigitalProfileI18n();
  const { can } = useDpAuth();
  const subjectName = caseDetail.subject?.fullName ?? caseDetail.title;
  const unifiedLabel = unifiedStatusLabel(unifiedJob);
  const serverRecoveryAllowed = Boolean(unifiedJob?.recoveryAllowed);
  const suggestionsRetry = isSuggestionsTargetedRetryState(unifiedJob);
  const showGeneralRecovery = shouldShowGeneralRecoveryCta(unifiedJob);
  const renderRecovery = isRenderRecovery(unifiedJob);
  const ingestRecovery =
    unifiedJob?.resumeCheckpoint === "ARSENKIN_RESULT_INGEST" ||
    unifiedJob?.recoveryReason === "ARSENKIN_INGEST_RESUME";
  const runningUnified =
    auditing ||
    recovering ||
    unifiedJob?.status === "RUNNING" ||
    unifiedJob?.status === "WAITING" ||
    unifiedJob?.stage === "BASE_COLLECTION" ||
    unifiedJob?.stage === "ARSENKIN_ENRICHMENT" ||
    unifiedJob?.stage === "COMPOSITE_MERGE" ||
    unifiedJob?.stage === "ORION_PREPARE" ||
    unifiedJob?.stage === "CLIENT_CONTENT";
  const fullAuditBlocked =
    Boolean(unifiedJob?.fullAuditBlocked) ||
    serverRecoveryAllowed ||
    suggestionsRetry ||
    runningUnified;
  const paidRecollectionRequired = Boolean(unifiedJob?.paidRecollectionRequired);
  const blockNewRun = fullAuditBlocked || generating;
  return (
    <div>
      <Link className="dp-back" href="/admin/digital-profile">
        ← {t("common.back")}
      </Link>
      <div className="dp-row">
        <div>
          <h1 className="dp-h1">{subjectName}</h1>
          <div className="dp-inline" style={{ marginTop: 6 }}>
            <span className="dp-mono">{caseDetail.caseNumber}</span>
            <StatusBadge status={caseDetail.status} />
            <span className="dp-muted">
              {t("cases.created")} {fmtDate(caseDetail.createdAt)}
            </span>
            <span className="dp-muted">
              · {t("cases.updated")} {fmtDate(caseDetail.updatedAt)}
            </span>
            {unifiedLabel ? (
              <span className="dp-inline">
                <span className="dp-muted">· Unified:</span>
                <StatusBadge status={unifiedLabel} />
              </span>
            ) : null}
            {unifiedJob ? (
              <span className="dp-muted">
                · {t("agents.unifiedStage")}: {unifiedJob.stage}
              </span>
            ) : null}
          </div>
          {unifiedJob ? (
            <div className="dp-muted" style={{ marginTop: 8, fontSize: 13, lineHeight: 1.45 }}>
              <div>
                jobId: <span className="dp-mono">{unifiedJob.jobId}</span>
                {unifiedJob.lastErrorCode ? (
                  <>
                    {" "}
                    · error: <span className="dp-mono">{unifiedJob.lastErrorCode}</span>
                  </>
                ) : null}
              </div>
              <div>
                base: {unifiedJob.baseReportRunId ? "ok" : "—"} · Arsenkin{" "}
                {arsenkinProgress(unifiedJob)} · composite/analytics/assembly:{" "}
                {unifiedJob.compositeDatasetId ? "ok" : "—"} · render:{" "}
                {prepareRenderLabel(unifiedJob)}
              </div>
              <div>
                recovery:{" "}
                {serverRecoveryAllowed
                  ? `allowed (${unifiedJob.recoveryReason ?? "ok"})`
                  : unifiedJob.recoveryBlockerReason
                    ? `blocked (${unifiedJob.recoveryBlockerReason})`
                    : "—"}
                {unifiedJob.resumeCheckpoint
                  ? ` · checkpoint: ${unifiedJob.resumeCheckpoint}`
                  : ""}
              </div>
              {unifiedJob.lastError ? (
                <div style={{ color: "#b42318" }}>{unifiedJob.lastError}</div>
              ) : null}
              {unifiedJob.suggestionsMissingResult ? (
                <div style={{ color: "#b42318" }} data-testid="unified-suggestions-gap">
                  Suggestions: результат не получен
                  {unifiedJob.suggestionsFailureReason
                    ? ` — ${unifiedJob.suggestionsFailureReason}`
                    : ""}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="dp-inline">
          {can("agents.run") && suggestionsRetry && onRetrySuggestions ? (
            <button
              className="dp-btn dp-btn-primary"
              onClick={onRetrySuggestions}
              disabled={recovering || generating || auditing}
              title={SUGGESTIONS_TARGETED_RETRY_CONFIRM}
              data-testid="unified-suggestions-retry-cta"
            >
              {recovering ? <span className="dp-spinner" /> : null}
              Повторить только задачу Suggestions
            </button>
          ) : null}
          {can("agents.run") && showGeneralRecovery ? (
            <button
              className="dp-btn dp-btn-primary"
              onClick={onRecoverUnifiedCollection}
              disabled={recovering || generating || suggestionsRetry}
              title={
                renderRecovery
                  ? "Продолжить с этапа рендера без повторного сбора"
                  : ingestRecovery
                    ? "Импортировать уже выполненные Arsenkin задачи без новых submit"
                    : "Продолжить с этапа Arsenkin без повторного базового поиска"
              }
              data-testid="unified-orion-recovery-cta"
            >
              {recovering ? <span className="dp-spinner" /> : null}
              {renderRecovery
                ? "Продолжить с этапа рендера"
                : ingestRecovery
                  ? "Продолжить импорт Arsenkin"
                  : "Продолжить аудит с этапа Arsenkin"}
            </button>
          ) : null}
          {can("agents.run") &&
          paidRecollectionRequired &&
          !serverRecoveryAllowed &&
          !suggestionsRetry ? (
            <button
              className="dp-btn"
              onClick={onPaidRecollection}
              disabled={generating || recovering || !onPaidRecollection}
              title="Явно подтверждает повторные платные вызовы провайдеров"
              data-testid="unified-orion-paid-recollection-cta"
            >
              Начать новый аудит с повторным сбором данных
            </button>
          ) : null}
          {can("agents.run") && !suggestionsRetry ? (
            <button
              className="dp-btn dp-btn-primary"
              onClick={onRunUnifiedCollection}
              disabled={blockNewRun}
              title={
                fullAuditBlocked
                  ? unifiedJob?.fullAuditBlockReason ?? "Full Audit недоступен для текущего job"
                  : t("agents.unifiedCollectionHint")
              }
              data-testid="unified-orion-collection-cta"
            >
              {runningUnified && !serverRecoveryAllowed ? <span className="dp-spinner" /> : null}
              {runningUnified && !serverRecoveryAllowed
                ? t("agents.runningUnifiedCollection")
                : t("agents.runUnifiedCollection")}
            </button>
          ) : null}
          {can("report.generateInternal") ? (
            <button
              className="dp-btn"
              onClick={onGenerate}
              disabled={generating || runningUnified}
            >
              {generating ? <span className="dp-spinner" /> : null}
              {generating ? t("report.generating") : t("report.generateReport")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
