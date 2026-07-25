"use client";

/**
 * Operator-facing report quality panel (REMEDIATION_PLAN §0.4).
 * Read-only: funnel counts, GPT traffic lights, empty-state reasons, visual warnings.
 */

import { Badge } from "./components";
import type { JobReportQualityDTO } from "./api";
import { getUnifiedDiagnosticsBundleUrl } from "./api";
import {
  describeEmptyStateReason,
  describeGptStage1Status,
  formatFunnelValue,
  gptStage1Tone,
  normalizeJobReportQuality,
} from "./report-quality-labels";
import {
  OFFLINE_ENRICHMENT_CLIENT_MESSAGE,
  OFFLINE_ENRICHMENT_WARNING,
} from "../config/offline-enrichment-guard";
import { useDpAuth } from "./auth-provider";
import { useDigitalProfileI18n } from "./i18n-provider";

function FunnelCell({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        minWidth: 72,
        padding: "6px 8px",
        border: "1px solid var(--dp-border, #e5e7eb)",
        borderRadius: 4,
        background: "var(--dp-surface-2, #fafafa)",
      }}
    >
      <div className="dp-muted" style={{ fontSize: 11, lineHeight: 1.2 }}>
        {label}
      </div>
      <div className="dp-mono" style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

export function ReportQualityPanel({
  quality,
  jobWarnings,
  caseId,
  jobId,
  onRetryGptCopy,
  retryingGptCopy,
  gptCopyRetryAllowed,
}: {
  quality: JobReportQualityDTO | null | undefined;
  /** Unified job.warnings — used for §8.2 offline-enrichment banner. */
  jobWarnings?: string[] | null;
  /** REMEDIATION §8.3 — diagnostics zip download. */
  caseId?: string;
  jobId?: string;
  /** REMEDIATION §4.3 — selective FALLBACK_* stage-2 retry. */
  onRetryGptCopy?: () => void;
  retryingGptCopy?: boolean;
  gptCopyRetryAllowed?: boolean;
}) {
  const { can } = useDpAuth();
  const { t, locale } = useDigitalProfileI18n();
  const offlineEnrichment = (jobWarnings ?? []).some(
    (w) => w === OFFLINE_ENRICHMENT_WARNING || w.startsWith(`${OFFLINE_ENRICHMENT_WARNING}:`)
  );
  const diagnosticsUrl =
    caseId && jobId && can("evidence.viewRaw")
      ? getUnifiedDiagnosticsBundleUrl(caseId, jobId)
      : null;

  if (!quality && !offlineEnrichment) return null;

  const q = quality ? normalizeJobReportQuality(quality) : null;
  const fallbackTotal = q
    ? (q.gpt.stage2FallbackError ?? 0) + (q.gpt.stage2FallbackValidation ?? 0)
    : 0;
  const stage2Tone: "ok" | "warn" | "danger" | "neutral" = !q
    ? "neutral"
    : fallbackTotal > 0
      ? "danger"
      : (q.gpt.stage2Applied ?? 0) > 0
        ? "ok"
        : (q.gpt.stage2SkippedCached ?? 0) > 0 || (q.gpt.stage2NoChanges ?? 0) > 0
          ? "warn"
          : "neutral";
  const showRetry =
    Boolean(q) &&
    Boolean(onRetryGptCopy) &&
    (gptCopyRetryAllowed ?? fallbackTotal > 0);

  return (
    <div className="dp-stack" style={{ gap: 12 }} data-testid="report-quality-panel">
      <div>
        <strong>{t("quality.title")}</strong>
        <p className="dp-muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
          {t("quality.hint")}
        </p>
      </div>

      {offlineEnrichment ? (
        <div
          data-testid="offline-enrichment-warning"
          style={{
            color: "#b42318",
            background: "#fef3f2",
            border: "1px solid #fecdca",
            borderRadius: 4,
            padding: "8px 10px",
            fontSize: 13,
            fontWeight: 600,
          }}
        >
          {OFFLINE_ENRICHMENT_CLIENT_MESSAGE}
        </div>
      ) : null}

      {diagnosticsUrl ? (
        <div>
          <a
            className="dp-btn"
            href={diagnosticsUrl}
            data-testid="diagnostics-bundle-download"
            title={t("quality.diagnosticsHint")}
          >
            {t("quality.diagnosticsDownload")}
          </a>
        </div>
      ) : null}

      {q ? (
        <>
          <div>
            <div className="dp-muted" style={{ fontSize: 12, marginBottom: 6 }}>
              {t("quality.funnel")}
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <FunnelCell label={t("quality.dbOrganic")} value={formatFunnelValue(q.counts.dbSearchResults)} />
              <FunnelCell label={t("quality.dbSurfaces")} value={formatFunnelValue(q.counts.dbSurfaceItems)} />
              <FunnelCell label={t("quality.manifest")} value={formatFunnelValue(q.counts.manifestIds)} />
              {(q.counts.manifestCorpusCount ?? 0) > 0 ? (
                <FunnelCell
                  label={t("quality.deltaCorpus")}
                  value={`${formatFunnelValue(q.counts.manifestDeltaCount)}/${formatFunnelValue(q.counts.manifestCorpusCount)}`}
                />
              ) : null}
              <FunnelCell
                label="Composite"
                value={formatFunnelValue(q.counts.compositeObservations)}
              />
              <FunnelCell label={t("quality.subject")} value={formatFunnelValue(q.counts.subjectMatch)} />
              <FunnelCell label={t("quality.likely")} value={formatFunnelValue(q.counts.likelySubject)} />
              <FunnelCell label={t("quality.namesakes")} value={formatFunnelValue(q.counts.otherSubject)} />
              <FunnelCell label="Findings" value={formatFunnelValue(q.counts.verifiedFindings)} />
              <FunnelCell
                label={t("quality.slides")}
                value={`${formatFunnelValue(q.slides.withContent)}/${formatFunnelValue(q.slides.total)}`}
              />
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: 12,
              alignItems: "flex-start",
            }}
          >
            <div>
              <div className="dp-muted" style={{ fontSize: 12, marginBottom: 4 }}>
                GPT stage 1
              </div>
              <Badge tone={gptStage1Tone(q.gpt.stage1Status)} title={q.gpt.stage1Reason}>
                {describeGptStage1Status(q.gpt.stage1Status, locale)}
              </Badge>
              {q.gpt.stage1Reason ? (
                <div className="dp-muted" style={{ fontSize: 12, marginTop: 4, maxWidth: 360 }}>
                  {q.gpt.stage1Reason}
                </div>
              ) : null}
            </div>
            <div>
              <div className="dp-muted" style={{ fontSize: 12, marginBottom: 4 }}>
                GPT stage 2
              </div>
              <Badge tone={stage2Tone}>
                {t("quality.applied")} {q.gpt.stage2Applied ?? 0}
                {fallbackTotal > 0 ? ` / fallback ${fallbackTotal}` : ""}
                {(q.gpt.stage2SkippedCached ?? 0) > 0
                  ? ` · ${t("quality.cached")} ${q.gpt.stage2SkippedCached}`
                  : ""}
                {(q.gpt.stage2NoChanges ?? 0) > 0
                  ? ` · ${t("quality.noChanges")} ${q.gpt.stage2NoChanges}`
                  : ""}
                {q.gpt.caseAnalysisUsed ? ` · ${t("quality.caseAnalysis")}` : ""}
              </Badge>
              {showRetry ? (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="dp-btn"
                    data-testid="retry-gpt-copy-cta"
                    disabled={retryingGptCopy}
                    title={t("quality.retryGptHint")}
                    onClick={onRetryGptCopy}
                  >
                    {retryingGptCopy ? t("quality.retryingGpt") : t("quality.retryGpt")}
                  </button>
                </div>
              ) : null}
            </div>
            <div>
              <div className="dp-muted" style={{ fontSize: 12, marginBottom: 4 }}>
                {t("quality.visuals")}
              </div>
              <Badge
                tone={
                  q.visuals.warning || (q.visuals.failed ?? 0) > 0
                    ? "warn"
                    : (q.visuals.built ?? 0) > 0
                      ? "ok"
                      : "neutral"
                }
              >
                {t("quality.built")} {q.visuals.built ?? 0}
                {(q.visuals.failed ?? 0) > 0 ? ` · ${t("quality.failed")} ${q.visuals.failed}` : ""}
              </Badge>
              {q.visuals.warning ? (
                <div style={{ color: "#b42318", fontSize: 12, marginTop: 4, maxWidth: 420 }}>
                  {q.visuals.warning}
                </div>
              ) : null}
            </div>
            <div>
              <div className="dp-muted" style={{ fontSize: 12, marginBottom: 4 }}>
                Arsenkin
              </div>
              <Badge
                tone={
                  (q.arsenkin.agentsFailed ?? 0) > 0
                    ? "warn"
                    : q.arsenkin.enrichmentComplete
                      ? "ok"
                      : "neutral"
                }
              >
                {t("quality.agentsOk")} {q.arsenkin.agentsOk ?? 0}
                {(q.arsenkin.agentsFailed ?? 0) > 0 ? ` · ${t("quality.failed")} ${q.arsenkin.agentsFailed}` : ""}
                {q.arsenkin.enrichmentObservationCount != null
                  ? ` · ${t("quality.observations")} ${q.arsenkin.enrichmentObservationCount}`
                  : ""}
              </Badge>
            </div>
          </div>

          <div>
            <div className="dp-muted" style={{ fontSize: 12, marginBottom: 6 }}>
              {t("quality.emptySlides")} ({q.slides.emptyStateCount ?? 0})
            </div>
            {(q.slides.emptyState ?? []).length === 0 ? (
              <div className="dp-muted" style={{ fontSize: 13 }}>
                {(q.slides.emptyStateCount ?? 0) > 0
                  ? t("quality.emptyListUnavailable", { count: q.slides.emptyStateCount ?? 0 })
                  : t("quality.noEmptySlides")}
              </div>
            ) : (
              <ul
                data-testid="report-quality-empty-states"
                style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.45 }}
              >
                {(q.slides.emptyState ?? []).map((e) => (
                  <li key={`${e.slotId}:${e.reason}`}>
                    <span className="dp-mono">{e.slotId}</span>
                    {" — "}
                    {describeEmptyStateReason(e.reason, locale)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
