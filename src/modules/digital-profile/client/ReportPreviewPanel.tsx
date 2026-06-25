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
  errorMessage,
  formatDate,
} from "./components";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [templateVersion, setTemplateVersion] = useState("report-template-v2");
  const [warnings, setWarnings] = useState<string[]>([]);
  const [renderInfo, setRenderInfo] = useState<{ template: string; slides: number } | null>(null);

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
      const rendered = await renderReport(caseId, templateVersion);
      onReportChange({ ...generated, ...rendered });
      setWarnings(rendered.warnings ?? []);
      setRenderInfo({
        template: rendered.templateVersion ?? templateVersion,
        slides: rendered.slideCount ?? 0,
      });
      setSuccess(
        `Report v${rendered.version} generated and rendered with ${rendered.templateVersion ?? templateVersion} (${rendered.slideCount ?? 0} slides).`
      );
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "INTERNAL_ERROR";
      const msg = err instanceof Error ? err.message : "Failed to generate report";
      setError(errorMessage(code, msg));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="dp-row" style={{ marginBottom: 16 }}>
        <h2 className="dp-h2" style={{ margin: 0 }}>
          Report preview
        </h2>
        <div className="dp-inline">
          <select
            className="dp-select"
            style={{ maxWidth: 220 }}
            value={templateVersion}
            onChange={(e) => setTemplateVersion(e.target.value)}
            disabled={busy}
            aria-label="Template version"
          >
            <option value="report-template-v2">Template v2 (full audit)</option>
            <option value="report-template-v1">Template v1 (corporate)</option>
            <option value="simple">Simple (generic)</option>
          </select>
          <button className="dp-btn dp-btn-primary" onClick={handleGenerate} disabled={busy}>
            {busy ? <span className="dp-spinner" /> : null}
            {busy ? "Working…" : report ? "Re-generate report" : "Generate report"}
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
            <strong>Renderer warnings ({warnings.length}):</strong>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {warnings.slice(0, 6).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : null}

      {!report ? (
        <EmptyState
          title="No report generated yet"
          hint="Click “Generate report” to build the report and render PPTX/PDF."
        />
      ) : (
        <>
          <dl className="dp-kv">
            <dt>Version</dt>
            <dd>v{report.version}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={report.status} />
            </dd>
            <dt>Watermark</dt>
            <dd>{report.watermark ?? "—"}</dd>
            <dt>Rendered at</dt>
            <dd>{report.renderedAt ? formatDate(report.renderedAt) : "Not rendered yet"}</dd>
            {renderInfo ? (
              <>
                <dt>Template</dt>
                <dd>{renderInfo.template}</dd>
                <dt>Slides</dt>
                <dd>{renderInfo.slides}</dd>
              </>
            ) : null}
            <dt>Created at</dt>
            <dd>{formatDate(report.createdAt)}</dd>
          </dl>

          <div className="dp-inline" style={{ marginTop: 18 }}>
            {report.pdfDownloadUrl ? (
              <a
                className="dp-btn dp-btn-primary"
                href={report.pdfDownloadUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Download PDF
              </a>
            ) : (
              <button className="dp-btn" disabled title="Render the report first">
                Download PDF
              </button>
            )}
            {report.pptxDownloadUrl ? (
              <a
                className="dp-btn"
                href={report.pptxDownloadUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Download PPTX
              </a>
            ) : (
              <button className="dp-btn" disabled title="Render the report first">
                Download PPTX
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
