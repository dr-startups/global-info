"use client";

/**
 * Operator-facing report quality panel (REMEDIATION_PLAN §0.4).
 * Read-only: funnel counts, GPT traffic lights, empty-state reasons, visual warnings.
 */

import { Badge } from "./components";
import type { JobReportQualityDTO } from "./api";
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
  onRetryGptCopy,
  retryingGptCopy,
  gptCopyRetryAllowed,
}: {
  quality: JobReportQualityDTO | null | undefined;
  /** Unified job.warnings — used for §8.2 offline-enrichment banner. */
  jobWarnings?: string[] | null;
  /** REMEDIATION §4.3 — selective FALLBACK_* stage-2 retry. */
  onRetryGptCopy?: () => void;
  retryingGptCopy?: boolean;
  gptCopyRetryAllowed?: boolean;
}) {
  const offlineEnrichment = (jobWarnings ?? []).some(
    (w) => w === OFFLINE_ENRICHMENT_WARNING || w.startsWith(`${OFFLINE_ENRICHMENT_WARNING}:`)
  );

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
        <strong>Качество отчёта</strong>
        <p className="dp-muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
          Воронка данных и причины пустых слайдов. Обновляется после сборки / пересборки отчёта.
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

      {q ? (
        <>
          <div>
            <div className="dp-muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Воронка
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <FunnelCell label="БД (organic)" value={formatFunnelValue(q.counts.dbSearchResults)} />
              <FunnelCell label="БД (surfaces)" value={formatFunnelValue(q.counts.dbSurfaceItems)} />
              <FunnelCell label="Манифест" value={formatFunnelValue(q.counts.manifestIds)} />
              {(q.counts.manifestCorpusCount ?? 0) > 0 ? (
                <FunnelCell
                  label="Дельта / корпус"
                  value={`${formatFunnelValue(q.counts.manifestDeltaCount)}/${formatFunnelValue(q.counts.manifestCorpusCount)}`}
                />
              ) : null}
              <FunnelCell
                label="Composite"
                value={formatFunnelValue(q.counts.compositeObservations)}
              />
              <FunnelCell label="Субъект" value={formatFunnelValue(q.counts.subjectMatch)} />
              <FunnelCell label="Вероятно" value={formatFunnelValue(q.counts.likelySubject)} />
              <FunnelCell label="Тёзки/шум" value={formatFunnelValue(q.counts.otherSubject)} />
              <FunnelCell label="Findings" value={formatFunnelValue(q.counts.verifiedFindings)} />
              <FunnelCell
                label="Слайды"
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
                {describeGptStage1Status(q.gpt.stage1Status)}
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
                применено {q.gpt.stage2Applied ?? 0}
                {fallbackTotal > 0 ? ` / fallback ${fallbackTotal}` : ""}
                {(q.gpt.stage2SkippedCached ?? 0) > 0 ? ` · кэш ${q.gpt.stage2SkippedCached}` : ""}
                {(q.gpt.stage2NoChanges ?? 0) > 0 ? ` · без изменений ${q.gpt.stage2NoChanges}` : ""}
                {q.gpt.caseAnalysisUsed ? " · анализ кейса" : ""}
              </Badge>
              {showRetry ? (
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="dp-btn"
                    data-testid="retry-gpt-copy-cta"
                    disabled={retryingGptCopy}
                    title="Повторно вызвать GPT только для фрагментов со статусом FALLBACK. Платный сбор не запускается."
                    onClick={onRetryGptCopy}
                  >
                    {retryingGptCopy ? "Дожимаем GPT…" : "Дожать GPT-копирайт"}
                  </button>
                </div>
              ) : null}
            </div>
            <div>
              <div className="dp-muted" style={{ fontSize: 12, marginBottom: 4 }}>
                Визуалы
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
                собрано {q.visuals.built ?? 0}
                {(q.visuals.failed ?? 0) > 0 ? ` · сбой ${q.visuals.failed}` : ""}
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
                агентов ок {q.arsenkin.agentsOk ?? 0}
                {(q.arsenkin.agentsFailed ?? 0) > 0 ? ` · сбой ${q.arsenkin.agentsFailed}` : ""}
                {q.arsenkin.enrichmentObservationCount != null
                  ? ` · наблюдений ${q.arsenkin.enrichmentObservationCount}`
                  : ""}
              </Badge>
            </div>
          </div>

          <div>
            <div className="dp-muted" style={{ fontSize: 12, marginBottom: 6 }}>
              Пустые слайды ({q.slides.emptyStateCount ?? 0})
            </div>
            {(q.slides.emptyState ?? []).length === 0 ? (
              <div className="dp-muted" style={{ fontSize: 13 }}>
                {(q.slides.emptyStateCount ?? 0) > 0
                  ? `Список причин недоступен в старой версии сводки (счётчик: ${q.slides.emptyStateCount}). Пересоберите отчёт.`
                  : "Пустых слайдов нет"}
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
                    {describeEmptyStateReason(e.reason)}
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
