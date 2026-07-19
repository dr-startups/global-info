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
}: {
  quality: JobReportQualityDTO | null | undefined;
}) {
  if (!quality) return null;

  const q = normalizeJobReportQuality(quality);
  const { counts, gpt, visuals, slides, arsenkin } = q;
  const stage2Tone: "ok" | "warn" | "danger" | "neutral" =
    (gpt.stage2FallbackError ?? 0) + (gpt.stage2FallbackValidation ?? 0) > 0
      ? "danger"
      : (gpt.stage2Applied ?? 0) > 0
        ? "ok"
        : (gpt.stage2SkippedCached ?? 0) > 0 || (gpt.stage2NoChanges ?? 0) > 0
          ? "warn"
          : "neutral";

  return (
    <div className="dp-stack" style={{ gap: 12 }} data-testid="report-quality-panel">
      <div>
        <strong>Качество отчёта</strong>
        <p className="dp-muted" style={{ margin: "4px 0 0", fontSize: 13 }}>
          Воронка данных и причины пустых слайдов. Обновляется после сборки / пересборки отчёта.
        </p>
      </div>

      <div>
        <div className="dp-muted" style={{ fontSize: 12, marginBottom: 6 }}>
          Воронка
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <FunnelCell label="БД (organic)" value={formatFunnelValue(counts.dbSearchResults)} />
          <FunnelCell label="БД (surfaces)" value={formatFunnelValue(counts.dbSurfaceItems)} />
          <FunnelCell label="Манифест" value={formatFunnelValue(counts.manifestIds)} />
          {(counts.manifestCorpusCount ?? 0) > 0 ? (
            <FunnelCell
              label="Дельта / корпус"
              value={`${formatFunnelValue(counts.manifestDeltaCount)}/${formatFunnelValue(counts.manifestCorpusCount)}`}
            />
          ) : null}
          <FunnelCell label="Composite" value={formatFunnelValue(counts.compositeObservations)} />
          <FunnelCell label="Субъект" value={formatFunnelValue(counts.subjectMatch)} />
          <FunnelCell label="Вероятно" value={formatFunnelValue(counts.likelySubject)} />
          <FunnelCell label="Тёзки/шум" value={formatFunnelValue(counts.otherSubject)} />
          <FunnelCell label="Findings" value={formatFunnelValue(counts.verifiedFindings)} />
          <FunnelCell
            label="Слайды"
            value={`${formatFunnelValue(slides.withContent)}/${formatFunnelValue(slides.total)}`}
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
          <Badge tone={gptStage1Tone(gpt.stage1Status)} title={gpt.stage1Reason}>
            {describeGptStage1Status(gpt.stage1Status)}
          </Badge>
          {gpt.stage1Reason ? (
            <div className="dp-muted" style={{ fontSize: 12, marginTop: 4, maxWidth: 360 }}>
              {gpt.stage1Reason}
            </div>
          ) : null}
        </div>
        <div>
          <div className="dp-muted" style={{ fontSize: 12, marginBottom: 4 }}>
            GPT stage 2
          </div>
          <Badge tone={stage2Tone}>
            применено {gpt.stage2Applied ?? 0}
            {(gpt.stage2FallbackError ?? 0) + (gpt.stage2FallbackValidation ?? 0) > 0
              ? ` / fallback ${(gpt.stage2FallbackError ?? 0) + (gpt.stage2FallbackValidation ?? 0)}`
              : ""}
            {(gpt.stage2SkippedCached ?? 0) > 0 ? ` · кэш ${gpt.stage2SkippedCached}` : ""}
            {(gpt.stage2NoChanges ?? 0) > 0 ? ` · без изменений ${gpt.stage2NoChanges}` : ""}
            {gpt.caseAnalysisUsed ? " · анализ кейса" : ""}
          </Badge>
        </div>
        <div>
          <div className="dp-muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Визуалы
          </div>
          <Badge
            tone={
              visuals.warning || (visuals.failed ?? 0) > 0
                ? "warn"
                : (visuals.built ?? 0) > 0
                  ? "ok"
                  : "neutral"
            }
          >
            собрано {visuals.built ?? 0}
            {(visuals.failed ?? 0) > 0 ? ` · сбой ${visuals.failed}` : ""}
          </Badge>
          {visuals.warning ? (
            <div style={{ color: "#b42318", fontSize: 12, marginTop: 4, maxWidth: 420 }}>
              {visuals.warning}
            </div>
          ) : null}
        </div>
        <div>
          <div className="dp-muted" style={{ fontSize: 12, marginBottom: 4 }}>
            Arsenkin
          </div>
          <Badge
            tone={
              (arsenkin.agentsFailed ?? 0) > 0
                ? "warn"
                : arsenkin.enrichmentComplete
                  ? "ok"
                  : "neutral"
            }
          >
            агентов ок {arsenkin.agentsOk ?? 0}
            {(arsenkin.agentsFailed ?? 0) > 0 ? ` · сбой ${arsenkin.agentsFailed}` : ""}
            {arsenkin.enrichmentObservationCount != null
              ? ` · наблюдений ${arsenkin.enrichmentObservationCount}`
              : ""}
          </Badge>
        </div>
      </div>

      <div>
        <div className="dp-muted" style={{ fontSize: 12, marginBottom: 6 }}>
          Пустые слайды ({slides.emptyStateCount ?? 0})
        </div>
        {(slides.emptyState ?? []).length === 0 ? (
          <div className="dp-muted" style={{ fontSize: 13 }}>
            {(slides.emptyStateCount ?? 0) > 0
              ? `Список причин недоступен в старой версии сводки (счётчик: ${slides.emptyStateCount}). Пересоберите отчёт.`
              : "Пустых слайдов нет"}
          </div>
        ) : (
          <ul
            data-testid="report-quality-empty-states"
            style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.45 }}
          >
            {(slides.emptyState ?? []).map((e) => (
              <li key={`${e.slotId}:${e.reason}`}>
                <span className="dp-mono">{e.slotId}</span>
                {" — "}
                {describeEmptyStateReason(e.reason)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
