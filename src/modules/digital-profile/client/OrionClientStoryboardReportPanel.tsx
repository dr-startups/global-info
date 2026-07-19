"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DigitalProfileApiError,
  generateOrionClientStoryboardReport,
  getOrionClientStoryboardReportStatus,
  type OrionClientStoryboardReportStatus,
} from "./api";
import { Badge, EmptyState, ErrorBox, Notice, SuccessBox } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";

function isAdminRole(role: string | null | undefined): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

function toneByStatus(
  status: OrionClientStoryboardReportStatus["status"]
): "neutral" | "ok" | "warn" | "danger" | "info" {
  if (status === "completed") return "ok";
  if (status === "failed") return "danger";
  if (status === "running") return "info";
  return "neutral";
}

export function OrionClientStoryboardReportPanel({ caseId }: { caseId: string }) {
  const { t, tError, fmtDate } = useDigitalProfileI18n();
  const { user, can } = useDpAuth();
  const isAdmin = isAdminRole(user?.role);
  const canGenerate = can("report.generateInternal") || can("report.generateClient");

  const [status, setStatus] = useState<OrionClientStoryboardReportStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyGenerate, setBusyGenerate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getOrionClientStoryboardReportStatus(caseId);
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

  async function pollUntilSettled(): Promise<OrionClientStoryboardReportStatus | null> {
    for (let i = 0; i < 150; i += 1) {
      await new Promise((r) => setTimeout(r, 4000));
      const next = await getOrionClientStoryboardReportStatus(caseId);
      setStatus(next);
      if (next.status === "completed" || next.status === "failed") {
        return next;
      }
    }
    setError(t("report.orionClientStoryboardRunningNotice"));
    return null;
  }

  useEffect(() => {
    if (!isRunning) return;
    let cancelled = false;
    void (async () => {
      const final = await pollUntilSettled();
      if (cancelled || !final) return;
      if (final.status === "completed") {
        setSuccess(t("report.orionClientStoryboardGenerated"));
      } else if (final.clientQualityVerdict?.includes("RATE_LIMIT")) {
        setError(t("report.orionClientStoryboardRateLimit"));
      } else if (final.status === "failed") {
        setError(t("report.orionClientStoryboardRunFailedNotice"));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll only while running
  }, [isRunning, caseId]);

  async function runGenerate(): Promise<void> {
    if (!canGenerate || disabledByFlag || isRunning || busyGenerate) return;
    setError(null);
    setSuccess(null);
    setBusyGenerate(true);
    try {
      const next = await generateOrionClientStoryboardReport(caseId);
      setStatus(next);
      if (next.status === "running") {
        setSuccess(t("report.orionClientStoryboardRunningNotice"));
        return;
      }
      if (next.status === "completed") {
        setSuccess(t("report.orionClientStoryboardGenerated"));
      }
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
    } finally {
      setBusyGenerate(false);
    }
  }

  if (!isAdmin) return null;

  const aiRequiredMissing = Boolean(status?.aiRequired && !status?.aiReady);

  return (
    <div className="dp-stack">
      <div className="dp-row" style={{ alignItems: "center" }}>
        <h2 className="dp-h2" style={{ margin: 0 }}>
          {t("report.orionClientStoryboardTitle")}
        </h2>
        <div className="dp-inline">
          <button
            className="dp-btn dp-btn-primary"
            disabled={!canGenerate || disabledByFlag || busyGenerate || isRunning}
            onClick={() => void runGenerate()}
          >
            {busyGenerate ? <span className="dp-spinner" /> : null}
            {t("report.orionClientStoryboardGenerate")}
          </button>
          <button
            className="dp-btn"
            disabled={loading || busyGenerate}
            onClick={() => void refreshStatus()}
          >
            {loading ? <span className="dp-spinner" /> : null}
            {t("report.orionClientStoryboardRefresh")}
          </button>
        </div>
      </div>

      <Notice>{t("report.orionClientStoryboardNotice")}</Notice>
      {disabledByFlag ? (
        <Notice>{t("report.orionClientStoryboardFeatureDisabled")}</Notice>
      ) : null}
      {isRunning ? <Notice>{t("report.orionClientStoryboardRunningNotice")}</Notice> : null}
      {aiRequiredMissing ? (
        <ErrorBox>{t("report.orionClientStoryboardAiRequiredNotice")}</ErrorBox>
      ) : null}

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {success ? <SuccessBox>{success}</SuccessBox> : null}

      {!status || status.status === "empty" ? (
        <EmptyState
          title={t("report.orionClientStoryboardEmptyTitle")}
          hint={t("report.orionClientStoryboardEmptyHint")}
        />
      ) : status.status === "running" ? (
        <div className="dp-card" style={{ padding: 16 }}>
          <div className="dp-muted">{t("report.orionClientStoryboardGenerationStatus")}</div>
          <div style={{ marginTop: 8 }}>
            <Badge tone="info">{t("report.orionClientStoryboardStatus_running")}</Badge>
          </div>
        </div>
      ) : (
        <>
          <div className="dp-grid-cards">
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("report.orionClientStoryboardGenerationStatus")}</div>
              <div style={{ marginTop: 4 }}>
                <Badge tone={toneByStatus(status.status)}>
                  {t(`report.orionClientStoryboardStatus_${status.status}`)}
                </Badge>
              </div>
              <div className="dp-muted" style={{ marginTop: 6, fontSize: 12 }}>
                {status.createdAt ? fmtDate(status.createdAt) : "—"}
              </div>
            </div>
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("report.orionClientStoryboardSlideCount")}</div>
              <div style={{ fontSize: 22 }}>{status.slideCount}</div>
            </div>
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("report.orionClientStoryboardQuality")}</div>
              <div style={{ marginTop: 4 }}>
                <Badge tone={status.clientQualityVerdict === "PASS" ? "ok" : "warn"}>
                  {status.clientQualityVerdict ?? "—"}
                </Badge>
              </div>
            </div>
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("report.orionClientStoryboardClientPolicy")}</div>
              <div style={{ marginTop: 4 }}>
                <Badge tone={status.clientPolicyStatus === "PASS" ? "ok" : "warn"}>
                  {status.clientPolicyStatus ?? "—"}
                </Badge>
              </div>
            </div>
          </div>

          {(status.warnings?.length ?? 0) > 0 ? (
            <ErrorBox>
              <ul style={{ margin: "8px 0 0", paddingLeft: "18px" }}>
                {(status.warnings ?? []).map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </ErrorBox>
          ) : null}

          <div className="dp-inline" style={{ marginTop: 8 }}>
            {status.artifacts.clientPdf.available && status.artifacts.clientPdf.downloadUrl ? (
              <a
                className="dp-btn dp-btn-primary"
                href={status.artifacts.clientPdf.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("report.orionClientStoryboardDownloadPdf")}
              </a>
            ) : (
              <button className="dp-btn dp-btn-primary" disabled>
                {t("report.orionClientStoryboardDownloadPdf")}
              </button>
            )}
            {status.artifacts.clientPptx.available && status.artifacts.clientPptx.downloadUrl ? (
              <a
                className="dp-btn"
                href={status.artifacts.clientPptx.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("report.orionClientStoryboardDownloadPptx")}
              </a>
            ) : (
              <button className="dp-btn" disabled>
                {t("report.orionClientStoryboardDownloadPptx")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
