"use client";

import { useState } from "react";
import {
  DigitalProfileApiError,
  generateReport,
  renderReport,
  type ReportVersion,
} from "./api";
import {
  EmptyState,
  ErrorBox,
  Notice,
  StatusBadge,
  SuccessBox,
} from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";

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
  onReportChange,
}: {
  caseId: string;
  report: ReportVersion | null;
  onReportChange: (r: ReportVersion) => void;
}) {
  const { t, tError, tTemplate, fmtDate, locale } = useDigitalProfileI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [templateVersion, setTemplateVersion] = useState("report-template-v3");
  const [audience, setAudience] = useState<"internal" | "client">("internal");
  const [watermarkMode, setWatermarkMode] = useState<"draft" | "none">("draft");
  // Report language defaults to the current UI locale but can be chosen separately.
  const [reportLanguage, setReportLanguage] = useState<"ru" | "en">(
    locale === "en" ? "en" : "ru"
  );
  const [warnings, setWarnings] = useState<string[]>([]);
  const [renderInfo, setRenderInfo] = useState<{
    template: string;
    slides: number;
    audience: string;
    watermarkMode: string;
    reportLanguage: string;
  } | null>(null);

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

  return (
    <div>
      <div className="dp-row" style={{ marginBottom: 16 }}>
        <h2 className="dp-h2" style={{ margin: 0 }}>
          {t("report.title")}
        </h2>
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
            <option value="internal">{t("report.internal")}</option>
            <option value="client">{t("report.client")}</option>
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
          <button className="dp-btn dp-btn-primary" onClick={handleGenerate} disabled={busy}>
            {busy ? <span className="dp-spinner" /> : null}
            {busy ? t("common.working") : report ? t("report.regenerateReport") : t("report.generateReport")}
          </button>
        </div>
      </div>

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

      {!report ? (
        <EmptyState title={t("report.emptyTitle")} hint={t("report.emptyHint")} />
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
