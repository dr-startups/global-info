"use client";

import { useEffect, useState } from "react";
import {
  DigitalProfileApiError,
  generateReport,
  getSerpSnapshot,
  renderReport,
  type ReportVersion,
  type UnifiedCollectionJobStatus,
} from "./api";
import { UnifiedCanonicalDownloadButtons } from "./CaseHeader";
import { unifiedArtifactsReady } from "./report-preview-state";
import {
  EmptyState,
  ErrorBox,
  Notice,
  StatusBadge,
  SuccessBox,
} from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";

/**
 * Report Preview: shows the latest report version and drives generation.
 *
 * "Generate report" = build report_json (POST /report/generate) then render
 * PPTX/PDF (POST /report/render). Download links use the signed-URL download
 * routes returned by the API. Renderer 502s surface as a clear, non-fatal error.
 */
export function ReportPreviewPanel({
  caseId,
  report,
  unifiedJob = null,
  onReportChange,
  legacyReportUi = false,
}: {
  caseId: string;
  report: ReportVersion | null;
  /** Прогон, чьи артефакты и есть текущий отчёт кейса. */
  unifiedJob?: UnifiedCollectionJobStatus | null;
  onReportChange: (r: ReportVersion) => void;
  /** REMEDIATION §8.1 — legacy POST /report/generate controls. */
  legacyReportUi?: boolean;
}) {
  const { t, tError, tTemplate, fmtDate } = useDigitalProfileI18n();
  const { can } = useDpAuth();
  const canGenerateInternal = can("report.generateInternal");
  const canGenerateClient = can("report.generateClient");
  const canGenerate = legacyReportUi && (canGenerateInternal || canGenerateClient);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [templateVersion, setTemplateVersion] = useState("report-template-v3");
  const [audience, setAudience] = useState<"internal" | "client">("internal");
  // Reviewers can only produce client reports — coerce the default once auth loads.
  useEffect(() => {
    if (audience === "internal" && !canGenerateInternal && canGenerateClient) {
      setAudience("client");
    }
  }, [audience, canGenerateInternal, canGenerateClient]);
  const [watermarkMode, setWatermarkMode] = useState<"draft" | "none">("draft");
  // Отчёт собирается по-русски независимо от языка интерфейса, поэтому
  // подставлять сюда локаль UI значит предлагать по умолчанию язык, которого
  // дека не даёт. Выбор остаётся за оператором, но начинается с правды.
  const [reportLanguage, setReportLanguage] = useState<"ru" | "en">("ru");
  const [warnings, setWarnings] = useState<string[]>([]);
  // Stage S1.5 — whether a SERP snapshot exists for this case (drives the hint
  // about the ORION-style page being included in the rendered report).
  const [hasSnapshot, setHasSnapshot] = useState<boolean | null>(null);
  const [renderInfo, setRenderInfo] = useState<{
    template: string;
    slides: number;
    audience: string;
    watermarkMode: string;
    reportLanguage: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSerpSnapshot(caseId)
      .then((res) => {
        if (!cancelled) setHasSnapshot(!!res.snapshot);
      })
      .catch(() => {
        if (!cancelled) setHasSnapshot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  async function handleGenerate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    setWarnings([]);
    setRenderInfo(null);
    try {
      // 1) Build the report_json (a new DRAFT version).
      const generated = await generateReport(caseId);
      onReportChange(generated);
      // 2) Render PPTX + PDF for that version using the chosen template.
      const rendered = await renderReport(caseId, {
        templateVersion,
        audience,
        watermarkMode,
        reportLanguage,
      });
      onReportChange({ ...generated, ...rendered });
      setWarnings(rendered.warnings ?? []);
      setRenderInfo({
        template: rendered.templateVersion ?? templateVersion,
        slides: rendered.slideCount ?? 0,
        audience: rendered.audience ?? audience,
        watermarkMode: rendered.watermarkMode ?? watermarkMode,
        reportLanguage: rendered.reportLanguage ?? reportLanguage,
      });
      setSuccess(
        t("report.successMessage", {
          version: rendered.version,
          template: tTemplate(rendered.templateVersion ?? templateVersion),
          slides: rendered.slideCount ?? 0,
        })
      );
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
    } finally {
      setBusy(false);
    }
  }

  const unifiedReady = unifiedArtifactsReady(unifiedJob);

  const aiStatus =
    report &&
    report.reportJson &&
    typeof report.reportJson === "object" &&
    (report.reportJson as { meta?: { aiAnalystStatus?: Record<string, unknown> } }).meta?.aiAnalystStatus
      ? ((report.reportJson as { meta?: { aiAnalystStatus?: Record<string, unknown> } }).meta?.aiAnalystStatus ??
        null)
      : null;

  return (
    <div>
      <div className="dp-row" style={{ marginBottom: 16 }}>
        <h2 className="dp-h2" style={{ margin: 0 }}>
          {t("report.title")}
        </h2>
        {canGenerate ? (
        <div className="dp-inline">
          <select
            className="dp-select"
            style={{ maxWidth: 220 }}
            value={templateVersion}
            onChange={(e) => setTemplateVersion(e.target.value)}
            disabled={busy}
            aria-label={t("report.templateVersion")}
          >
            <option value="report-template-v3">{tTemplate("report-template-v3")}</option>
            <option value="report-template-v2">{tTemplate("report-template-v2")}</option>
            <option value="report-template-v1">{tTemplate("report-template-v1")}</option>
            <option value="simple">{tTemplate("simple")}</option>
          </select>
          <select
            className="dp-select"
            style={{ maxWidth: 150 }}
            value={audience}
            onChange={(e) => setAudience(e.target.value as "internal" | "client")}
            disabled={busy}
            aria-label={t("report.audience")}
          >
            {canGenerateInternal ? (
              <option value="internal">{t("report.internal")}</option>
            ) : null}
            {canGenerateClient ? (
              <option value="client">{t("report.client")}</option>
            ) : null}
          </select>
          <select
            className="dp-select"
            style={{ maxWidth: 170 }}
            value={watermarkMode}
            onChange={(e) => setWatermarkMode(e.target.value as "draft" | "none")}
            disabled={busy}
            aria-label={t("report.watermark")}
          >
            <option value="draft">{t("report.watermark")}: {t("report.draft")}</option>
            <option value="none">{t("report.watermark")}: {t("report.none")}</option>
          </select>
          <select
            className="dp-select"
            style={{ maxWidth: 150 }}
            value={reportLanguage}
            onChange={(e) => setReportLanguage(e.target.value as "ru" | "en")}
            disabled={busy}
            aria-label={t("report.reportLanguage")}
          >
            <option value="ru">{t("report.reportLanguage")}: {t("report.langRu")}</option>
            <option value="en">{t("report.reportLanguage")}: {t("report.langEn")}</option>
          </select>
          <button
            className="dp-btn dp-btn-primary"
            onClick={handleGenerate}
            disabled={
              busy ||
              (audience === "client" ? !canGenerateClient : !canGenerateInternal)
            }
          >
            {busy ? <span className="dp-spinner" /> : null}
            {busy ? t("common.working") : report ? t("report.regenerateReport") : t("report.generateReport")}
          </button>
        </div>
        ) : null}
      </div>

      {hasSnapshot !== null ? (
        <div style={{ marginBottom: 14 }}>
          <Notice>
            {hasSnapshot
              ? t("report.serpSnapshotIncluded")
              : t("report.serpSnapshotMissing")}
          </Notice>
        </div>
      ) : null}

      {error ? (
        <div style={{ marginBottom: 14 }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}
      {success ? (
        <div style={{ marginBottom: 14 }}>
          <SuccessBox>{success}</SuccessBox>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div style={{ marginBottom: 14 }}>
          <Notice>
            <strong>{t("report.warnings")} ({warnings.length}):</strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {warnings.slice(0, 6).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}

      {unifiedReady ? (
        <div style={{ marginBottom: 18 }} data-testid="report-preview-unified">
          <h3 className="dp-h3" style={{ marginTop: 0 }}>
            {t("report.unifiedTitle")}
          </h3>
          <dl className="dp-kv">
            <dt>{t("cases.status")}</dt>
            <dd>
              <StatusBadge status={unifiedJob!.stage} />
            </dd>
            <dt>{t("report.unifiedSource")}</dt>
            <dd className="dp-mono">{unifiedJob!.unifiedJobId || unifiedJob!.jobId}</dd>
          </dl>
          <UnifiedCanonicalDownloadButtons caseId={caseId} job={unifiedJob!} />
        </div>
      ) : null}

      {report && unifiedReady ? (
        <h3 className="dp-h3">{t("report.legacyTitle")}</h3>
      ) : null}

      {!report ? (
        unifiedReady ? null : (
          <EmptyState title={t("report.emptyTitle")} hint={t("report.emptyHint")} />
        )
      ) : (
        <>
          <dl className="dp-kv">
            <dt>{t("report.version")}</dt>
            <dd>v{report.version}</dd>
            <dt>{t("cases.status")}</dt>
            <dd>
              <StatusBadge status={report.status} />
            </dd>
            <dt>{t("report.watermark")}</dt>
            <dd>{report.watermark ?? "—"}</dd>
            <dt>{t("report.renderedAt")}</dt>
            <dd>{report.renderedAt ? fmtDate(report.renderedAt) : t("report.notRendered")}</dd>
            {renderInfo ? (
              <>
                <dt>{t("report.template")}</dt>
                <dd>{tTemplate(renderInfo.template)}</dd>
                <dt>{t("report.slideCount")}</dt>
                <dd>{renderInfo.slides}</dd>
                <dt>{t("report.audience")}</dt>
                <dd>
                  {renderInfo.audience === "client" ? t("report.client") : t("report.internal")}
                </dd>
                <dt>{t("report.watermarkMode")}</dt>
                <dd>
                  {renderInfo.watermarkMode === "none" ? t("report.none") : t("report.draft")}
                </dd>
                <dt>{t("report.reportLanguage")}</dt>
                <dd>
                  {renderInfo.reportLanguage === "en" ? t("report.langEn") : t("report.langRu")}
                </dd>
              </>
            ) : null}
            <dt>{t("cases.created")}</dt>
            <dd>{fmtDate(report.createdAt)}</dd>
            {aiStatus ? (
              <>
                <dt>{t("report.aiAnalytics")}</dt>
                <dd>{String(aiStatus.model ?? "GPT-5.5")}</dd>
                <dt>{t("cases.status")}</dt>
                <dd>
                  {String(aiStatus.status ?? "fallback") === "ready"
                    ? t("report.aiReady")
                    : String(aiStatus.status ?? "fallback") === "fallback"
                      ? t("report.aiFallback")
                      : t("report.aiUnavailable")}
                </dd>
                {aiStatus.reason ? (
                  <>
                    <dt>{t("report.aiFallbackReason")}</dt>
                    <dd>{String(aiStatus.reason)}</dd>
                  </>
                ) : null}
                <dt>{t("report.aiNarrative")}</dt>
                <dd>{t("report.aiNarrativeValue")}</dd>
              </>
            ) : null}
          </dl>

          <div className="dp-inline" style={{ marginTop: 18 }}>
            {report.pdfDownloadUrl ? (
              <a
                className="dp-btn dp-btn-primary"
                href={report.pdfDownloadUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("report.downloadPdf")}
              </a>
            ) : (
              <button className="dp-btn" disabled title={t("report.renderFirst")}>
                {t("report.downloadPdf")}
              </button>
            )}
            {report.pptxDownloadUrl ? (
              <a
                className="dp-btn"
                href={report.pptxDownloadUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("report.downloadPptx")}
              </a>
            ) : (
              <button className="dp-btn" disabled title={t("report.renderFirst")}>
                {t("report.downloadPptx")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
