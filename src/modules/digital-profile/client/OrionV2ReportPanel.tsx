"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DigitalProfileApiError,
  generateOrionV2Report,
  getOrionV2ReportStatus,
  type OrionV2ReportStatus,
} from "./api";
import { Badge, EmptyState, ErrorBox, Notice, SuccessBox } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";

function isAdminRole(role: string | null | undefined): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

function toneByStatus(
  status: OrionV2ReportStatus["status"]
): "neutral" | "ok" | "warn" | "danger" | "info" {
  if (status === "completed") return "ok";
  if (status === "failed") return "danger";
  if (status === "running") return "info";
  return "neutral";
}

export function OrionV2ReportPanel({ caseId }: { caseId: string }) {
  const { t, tError, fmtDate } = useDigitalProfileI18n();
  const { user, can } = useDpAuth();
  const isAdmin = isAdminRole(user?.role);
  const canGenerateInternal = can("report.generateInternal");
  const canRenderClient = can("report.generateClient");
  const canUseOrion = canGenerateInternal || canRenderClient;

  const [status, setStatus] = useState<OrionV2ReportStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyGenerate, setBusyGenerate] = useState(false);
  const [busyGpt55, setBusyGpt55] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getOrionV2ReportStatus(caseId);
      setStatus(next);
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
    } finally {
      setLoading(false);
    }
  }, [caseId, tError]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const disabledByFlag = status?.uiEnabled === false;
  const isRunning = status?.status === "running";

  async function pollUntilSettled(): Promise<OrionV2ReportStatus | null> {
    for (let i = 0; i < 150; i += 1) {
      await new Promise((r) => setTimeout(r, 4000));
      const next = await getOrionV2ReportStatus(caseId);
      setStatus(next);
      if (next.status === "completed" || next.status === "failed") {
        return next;
      }
    }
    setError(t("report.orionV2RunningNotice"));
    return null;
  }

  useEffect(() => {
    if (!isRunning) return;
    let cancelled = false;
    void (async () => {
      const final = await pollUntilSettled();
      if (cancelled || !final) return;
      if (final.status === "completed" && final.gpt55Status !== "required_missing") {
        setSuccess(t("report.orionV2Generated"));
      } else if (final.gpt55Status === "required_missing") {
        setError(t("report.orionV2AiRequiredMissing"));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll only while running
  }, [isRunning, caseId]);

  async function runGenerate(gpt55Validate: boolean): Promise<void> {
    if (!canUseOrion || disabledByFlag || isRunning) return;
    setError(null);
    setSuccess(null);
    if (gpt55Validate) setBusyGpt55(true);
    else setBusyGenerate(true);
    try {
      const next = await generateOrionV2Report(
        caseId,
        gpt55Validate ? { gpt55Validate: true } : undefined
      );
      setStatus(next);
      if (next.status === "running") {
        setSuccess(t("report.orionV2RunningNotice"));
        return;
      }
      if (next.status === "completed" && next.gpt55Status !== "required_missing") {
        setSuccess(t("report.orionV2Generated"));
      } else if (next.gpt55Status === "required_missing") {
        setError(t("report.orionV2AiRequiredMissing"));
      }
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
    } finally {
      setBusyGenerate(false);
      setBusyGpt55(false);
    }
  }

  const aiRequiredMissing = Boolean(status?.aiRequired && !status?.aiReady);

  const gptLabel = useMemo(() => {
    if (!status) return "—";
    if (status.gpt55Status === "used") return t("report.orionV2Gpt55Done");
    if (status.gpt55Status === "required_missing") {
      return t("report.orionV2AiRequiredMissing");
    }
    if (status.gpt55Status === "deterministic_fallback") {
      return t("report.orionV2DevDeterministicNotice");
    }
    return t("report.orionV2Gpt55Skipped");
  }, [status, t]);

  const lexisLabel = useMemo(() => {
    if (!status) return "—";
    if (status.lexisStatus === "visual_pages_ready") return t("report.orionV2LexisVisualReady");
    if (status.lexisStatus === "uploaded_parsed") return t("report.orionV2LexisUploadedParsed");
    if (status.lexisStatus === "requires_manual_review") return t("report.orionV2LexisManualReview");
    return t("report.orionV2LexisNotUploaded");
  }, [status, t]);

  if (!isAdmin) return null;

  return (
    <div className="dp-stack">
      <div className="dp-row" style={{ alignItems: "center" }}>
        <h2 className="dp-h2" style={{ margin: 0 }}>{t("report.orionV2Title")}</h2>
        <div className="dp-inline">
          <button
            className="dp-btn dp-btn-primary"
            disabled={!canUseOrion || disabledByFlag || busyGenerate || busyGpt55 || isRunning}
            onClick={() => void runGenerate(false)}
          >
            {busyGenerate ? <span className="dp-spinner" /> : null}
            {t("report.orionV2Generate")}
          </button>
          <button
            className="dp-btn"
            disabled={loading || busyGenerate || busyGpt55}
            onClick={() => void refreshStatus()}
          >
            {loading ? <span className="dp-spinner" /> : null}
            {t("report.orionV2Refresh")}
          </button>
          {isAdmin ? (
            <button
              className="dp-btn"
              disabled={!status?.uiEnabled || busyGenerate || busyGpt55 || isRunning}
              onClick={() => void runGenerate(true)}
            >
              {busyGpt55 ? <span className="dp-spinner" /> : null}
              {t("report.orionV2GenerateWithGpt55")}
            </button>
          ) : null}
        </div>
      </div>

      <Notice>{t("report.orionV2ExperimentalNotice")}</Notice>
      {disabledByFlag && isAdmin ? (
        <Notice>{t("report.orionV2FeatureDisabled")}</Notice>
      ) : null}
      {isRunning ? (
        <Notice>{t("report.orionV2RunningNotice")}</Notice>
      ) : null}
      {aiRequiredMissing || status?.gpt55Status === "required_missing" ? (
        <ErrorBox>{t("report.orionV2AiRequiredNotice")}</ErrorBox>
      ) : null}
      {status?.gpt55Status === "deterministic_fallback" ? (
        <Notice>{t("report.orionV2DevDeterministicNotice")}</Notice>
      ) : status?.gpt55Status === "skipped" ? (
        <Notice>{t("report.orionV2Gpt55SkipNotice")}</Notice>
      ) : null}
      {status?.lexisStatus === "visual_pages_ready" ? (
        <Notice>{t("report.orionV2LexisVisualNote")}</Notice>
      ) : null}
      {status?.lexisStatus === "not_uploaded" || status?.lexisStatus === "requires_manual_review" ? (
        <Notice>{t("report.orionV2LexisUnavailableNote")}</Notice>
      ) : null}

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {success ? <SuccessBox>{success}</SuccessBox> : null}

      {!status || status.status === "empty" ? (
        <EmptyState
          title={t("report.orionV2EmptyTitle")}
          hint={t("report.orionV2EmptyHint")}
        />
      ) : status.status === "running" ? (
        <div className="dp-card" style={{ padding: 16 }}>
          <div className="dp-muted">{t("report.orionV2GenerationStatus")}</div>
          <div style={{ marginTop: 8 }}>
            <Badge tone="info">{t("report.orionV2Status_running")}</Badge>
          </div>
          <p className="dp-muted" style={{ marginTop: 12, marginBottom: 0 }}>
            {t("report.orionV2RunningNotice")}
          </p>
        </div>
      ) : (
        <>
          <div className="dp-grid-cards">
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("report.orionV2GenerationStatus")}</div>
              <div style={{ marginTop: 4 }}>
                <Badge tone={toneByStatus(status.status)}>{t(`report.orionV2Status_${status.status}`)}</Badge>
              </div>
              <div className="dp-muted" style={{ marginTop: 6, fontSize: 12 }}>
                {status.createdAt ? fmtDate(status.createdAt) : "—"}
              </div>
            </div>
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("report.orionV2ClientPages")}</div>
              <div style={{ fontSize: 22 }}>{status.clientPageCount}</div>
              <div className="dp-muted" style={{ fontSize: 12 }}>
                {t("report.orionV2StoreMode")}: {status.storeMode ?? "—"}
              </div>
            </div>
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("report.orionV2LexisVisualPages")}</div>
              <div style={{ fontSize: 22 }}>{status.lexisVisualPageCount}</div>
              <div className="dp-muted" style={{ fontSize: 12 }}>{lexisLabel}</div>
            </div>
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("report.orionV2Gpt55Status")}</div>
              <div style={{ marginTop: 4 }}>{gptLabel}</div>
              {status.deterministicFallbackUsed ? (
                <div className="dp-muted" style={{ fontSize: 12 }}>
                  {t("report.orionV2DeterministicUsed")}
                </div>
              ) : null}
            </div>
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("report.orionV2ClientPolicy")}</div>
              <div style={{ marginTop: 4 }}>
                <Badge tone={status.clientPolicyStatus === "PASS" ? "ok" : "warn"}>
                  {status.clientPolicyStatus ?? "—"}
                </Badge>
              </div>
            </div>
          </div>

          <div className="dp-inline" style={{ marginTop: 8 }}>
            {status.artifacts.clientPdf.available && status.artifacts.clientPdf.downloadUrl ? (
              <a className="dp-btn dp-btn-primary" href={status.artifacts.clientPdf.downloadUrl} target="_blank" rel="noopener noreferrer">
                {t("report.orionV2DownloadPdf")}
              </a>
            ) : (
              <button className="dp-btn dp-btn-primary" disabled>
                {t("report.orionV2DownloadPdf")}
              </button>
            )}
            {status.artifacts.clientPptx.available && status.artifacts.clientPptx.downloadUrl ? (
              <a className="dp-btn" href={status.artifacts.clientPptx.downloadUrl} target="_blank" rel="noopener noreferrer">
                {t("report.orionV2DownloadPptx")}
              </a>
            ) : (
              <button className="dp-btn" disabled>
                {t("report.orionV2DownloadPptx")}
              </button>
            )}
            {isAdmin ? (
              status.artifacts.internalDraftPdf?.available &&
              status.artifacts.internalDraftPdf.downloadUrl ? (
                <a className="dp-btn" href={status.artifacts.internalDraftPdf.downloadUrl} target="_blank" rel="noopener noreferrer">
                  {t("report.orionV2DownloadInternalDraft")}
                </a>
              ) : (
                <button className="dp-btn" disabled>
                  {t("report.orionV2DownloadInternalDraft")}
                </button>
              )
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

