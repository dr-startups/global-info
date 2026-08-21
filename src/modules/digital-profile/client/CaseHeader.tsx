"use client";

import Link from "next/link";
import {
  getCanonicalArtifactDownloadUrl,
  type CaseDetail,
  type UnifiedCollectionJobStatus,
} from "./api";
import { Notice, StatusBadge } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";
import {
  isSuggestionsTargetedRetryState,
  shouldShowGeneralRecoveryCta,
} from "./unified-suggestions-retry-ui";
import { arsenkinProgressLine } from "./arsenkin-progress-line";

function arsenkinProgress(job: UnifiedCollectionJobStatus | null): string {
  const plannedAgents = job?.arsenkinPlannedAgents;
  if (!job) return arsenkinProgressLine({ plannedAgents });
  const st = job.arsenkinEnrichmentState;
  if (st) {
    return arsenkinProgressLine({
      plannedAgents,
      scheduledAgents: st.scheduledAgents,
      completedAgents: st.completedAgents,
      ingestedAgents: st.ingestedAgents,
      pendingAgents: st.pendingAgents,
      enrichmentComplete: st.enrichmentComplete,
    });
  }
  // Состояния обогащения ещё нет: о постановке известно только по прогонам.
  const scheduledAgents = job.enrichmentRunIds ?? [];
  if (scheduledAgents.length > 0) {
    return arsenkinProgressLine({ plannedAgents, scheduledAgents, enrichmentComplete: false });
  }
  return arsenkinProgressLine({ plannedAgents });
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

function isAssemblyRecovery(job: UnifiedCollectionJobStatus | null): boolean {
  if (!job) return false;
  return (
    job.recoveryReason === "ASSEMBLY_RESUME" ||
    job.lastErrorCode === "ASSEMBLY_FAILED" ||
    job.lastErrorCode === "REQUIRED_SECTION_FAILED"
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

/** Prefer stage for in-flight jobs so the badge matches the pipeline step. */
function unifiedStageForDisplay(job: UnifiedCollectionJobStatus | null): string | null {
  if (!job) return null;
  return job.stage || job.status || null;
}

/** Job-scoped Unified downloads only — never ORION v2/Storyboard artifact IDs. */
export function UnifiedCanonicalDownloadButtons({
  caseId,
  job,
}: {
  caseId: string;
  job: UnifiedCollectionJobStatus;
}) {
  const { t } = useDigitalProfileI18n();
  // Prefer server availability; fall back to reportLinks so COMPLETED_PARTIAL
  // with a rendered PDF is never stuck behind a stale downloadArtifacts=false.
  const downloads = {
    pdf: Boolean(job.downloadArtifacts?.pdf || job.reportLinks?.pdf),
    pptx: Boolean(job.downloadArtifacts?.pptx || job.reportLinks?.pptx),
    contactSheet: Boolean(
      job.downloadArtifacts?.contactSheet || job.reportLinks?.contactSheet
    ),
  };
  const jobId = job.unifiedJobId || job.jobId;
  return (
    <div
      className="dp-inline"
      style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}
      data-testid="unified-canonical-downloads"
    >
      {downloads.pdf ? (
        <a
          className="dp-btn"
          href={getCanonicalArtifactDownloadUrl(caseId, jobId, "pdf")}
          data-testid="unified-download-pdf"
        >
          {t("unified.downloadPdf")}
        </a>
      ) : (
        <button type="button" className="dp-btn" disabled data-testid="unified-download-pdf">
          {t("unified.downloadPdf")}
        </button>
      )}
      {downloads.pptx ? (
        <a
          className="dp-btn"
          href={getCanonicalArtifactDownloadUrl(caseId, jobId, "pptx")}
          data-testid="unified-download-pptx"
        >
          {t("unified.downloadPptx")}
        </a>
      ) : (
        <button type="button" className="dp-btn" disabled data-testid="unified-download-pptx">
          {t("unified.downloadPptx")}
        </button>
      )}
      {downloads.contactSheet ? (
        <a
          className="dp-btn"
          href={getCanonicalArtifactDownloadUrl(caseId, jobId, "contactSheet")}
          data-testid="unified-download-contact-sheet"
        >
          {t("unified.downloadContactSheet")}
        </a>
      ) : null}
    </div>
  );
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
  onRunUnifiedCollection,
  onRecoverUnifiedCollection,
  onRetrySuggestions,
  onPaidRecollection,
  onRebuildReport,
  onPauseRun,
  auditing,
  recovering,
  rebuilding,
  pausing,
  unifiedJob,
}: {
  caseDetail: CaseDetail;
  onRunUnifiedCollection: () => void;
  onRecoverUnifiedCollection: () => void;
  onRetrySuggestions?: () => void;
  onPaidRecollection?: () => void;
  /** Re-run analytics/assembly/render from the persisted composite (no paid collection). */
  onRebuildReport?: () => void;
  /** Пауза идущего прогона: собранное сохраняется (шаг 0027). */
  onPauseRun?: () => void;
  auditing: boolean;
  recovering: boolean;
  rebuilding?: boolean;
  pausing?: boolean;
  /** Current unified job (not legacy AgentRun). */
  unifiedJob: UnifiedCollectionJobStatus | null;
}) {
  const { t, tStatus, fmtDate } = useDigitalProfileI18n();
  const { can } = useDpAuth();
  const subjectName = caseDetail.subject?.fullName ?? caseDetail.title;
  const unifiedLabel = unifiedStatusLabel(unifiedJob);
  const stageLabel = unifiedStageForDisplay(unifiedJob);
  const serverRecoveryAllowed = Boolean(unifiedJob?.recoveryAllowed);
  const autoResumePending = Boolean(unifiedJob?.autoResumePending);
  const suggestionsRetry = isSuggestionsTargetedRetryState(unifiedJob);
  const showGeneralRecovery = shouldShowGeneralRecoveryCta(unifiedJob);
  const renderRecovery = isRenderRecovery(unifiedJob);
  const assemblyRecovery = isAssemblyRecovery(unifiedJob);
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
  const blockNewRun = fullAuditBlocked;
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
            {/*
              Один бейдж на кейс. Статус кейса следует за стадией прогона
              (шаг 11.3), поэтому пока прогон идёт — показываем его состояние,
              а без прогона остаётся статус кейса. Два бейджа рядом отвечали на
              один вопрос по-разному и заставляли гадать, какой из них верный.
            */}
            <StatusBadge status={unifiedLabel ?? caseDetail.status} />
            <span className="dp-muted">
              {t("cases.created")} {fmtDate(caseDetail.createdAt)}
            </span>
            <span className="dp-muted">
              · {t("cases.updated")} {fmtDate(caseDetail.updatedAt)}
            </span>
            {stageLabel ? (
              <span className="dp-muted">
                · {t("agents.unifiedStage")}: {tStatus(stageLabel)}
              </span>
            ) : null}
          </div>
          {autoResumePending ? (
            /*
             * Прогон, который продолжится сам, — это ожидание, а не отказ.
             * Раньше здесь стоял код ошибки и кнопка, и пользователь нажимал её
             * по нескольку раз, выполняя работу оркестратора (шаг 14).
             */
            <div style={{ marginTop: 8 }} data-testid="unified-auto-resume">
              <Notice>
                {t("unified.autoResumeWaiting")}
                {unifiedJob?.autoResumeAt
                  ? ` ${t("unified.autoResumeAt", { time: fmtDate(unifiedJob.autoResumeAt) })}`
                  : ""}
              </Notice>
            </div>
          ) : null}
          {unifiedJob ? (
            <div className="dp-muted" style={{ marginTop: 8, fontSize: 13, lineHeight: 1.45 }}>
              <div>
                jobId: <span className="dp-mono">{unifiedJob.jobId}</span>
                {unifiedJob.lastErrorCode && !autoResumePending ? (
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
                  {t("unified.suggestionsGap")}
                  {unifiedJob.suggestionsFailureReason
                    ? ` — ${unifiedJob.suggestionsFailureReason}`
                    : ""}
                </div>
              ) : null}
              {unifiedJob.stage === "REPORT_READY" ||
              unifiedJob.stage === "COMPLETED_PARTIAL" ? (
                <UnifiedCanonicalDownloadButtons caseId={caseDetail.id} job={unifiedJob} />
              ) : null}
              {/*
                * Пауза стоит рядом с остальными действиями прогона, но не
                * ждёт их: её нажимают именно на идущем сборе, когда все
                * прочие кнопки заблокированы работой (шаг 0027).
                */}
              {can("agents.run") && unifiedJob.pauseAllowed && onPauseRun ? (
                <div className="dp-inline" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="dp-btn"
                    onClick={onPauseRun}
                    disabled={Boolean(pausing)}
                    title={t("unified.pauseHint")}
                    data-testid="unified-pause-cta"
                  >
                    {pausing ? <span className="dp-spinner" /> : null}
                    {pausing ? t("unified.pausing") : t("unified.pause")}
                  </button>
                </div>
              ) : null}
              {can("agents.run") && unifiedJob.rebuildAllowed && onRebuildReport ? (
                <div className="dp-inline" style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="dp-btn"
                    onClick={onRebuildReport}
                    disabled={Boolean(rebuilding) || recovering || auditing}
                    title={t("unified.rebuildHint")}
                    data-testid="unified-rebuild-report-cta"
                  >
                    {rebuilding ? <span className="dp-spinner" /> : null}
                    {rebuilding ? t("unified.rebuilding") : t("unified.rebuild")}
                  </button>
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
              disabled={recovering || auditing}
              title={t("unified.retrySuggestionsConfirm")}
              data-testid="unified-suggestions-retry-cta"
            >
              {recovering ? <span className="dp-spinner" /> : null}
              {t("unified.retrySuggestions")}
            </button>
          ) : null}
          {can("agents.run") && showGeneralRecovery ? (
            <button
              className="dp-btn dp-btn-primary"
              onClick={onRecoverUnifiedCollection}
              disabled={recovering || suggestionsRetry}
              title={
                renderRecovery
                  ? t("unified.resumeRenderHint")
                  : assemblyRecovery
                    ? t("unified.resumeAssemblyHint")
                    : ingestRecovery
                      ? t("unified.resumeIngestHint")
                      : t("unified.resumeArsenkinHint")
              }
              data-testid="unified-orion-recovery-cta"
            >
              {recovering ? <span className="dp-spinner" /> : null}
              {renderRecovery
                ? t("unified.resumeRender")
                : assemblyRecovery
                  ? t("unified.resumeAssembly")
                  : ingestRecovery
                    ? t("unified.resumeIngest")
                    : t("unified.resumeArsenkin")}
            </button>
          ) : null}
          {can("agents.run") &&
          paidRecollectionRequired &&
          !serverRecoveryAllowed &&
          !suggestionsRetry ? (
            <button
              className="dp-btn"
              onClick={onPaidRecollection}
              disabled={recovering || !onPaidRecollection}
              title={t("unified.paidRecollectionHint")}
              data-testid="unified-orion-paid-recollection-cta"
            >
              {t("unified.paidRecollection")}
            </button>
          ) : null}
          {can("agents.run") && !suggestionsRetry ? (
            <button
              className="dp-btn dp-btn-primary"
              onClick={onRunUnifiedCollection}
              disabled={blockNewRun}
              title={
                fullAuditBlocked
                  ? unifiedJob?.fullAuditBlockReason ?? t("unified.blockedFallback")
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
        </div>
      </div>
    </div>
  );
}
