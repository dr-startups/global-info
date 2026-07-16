"use client";

import { useEffect, useRef, useState } from "react";
import {
  DigitalProfileApiError,
  runAgent as runAgentApi,
  type AgentInfo,
  type AgentRun,
  type FullAuditRunSummaryItem,
} from "./api";
import { Badge, EmptyState, ErrorBox, StatusBadge, SuccessBox } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";

function arsenkinOutcomeBadge(outcome: string | null | undefined, status: string): {
  label: string;
  tone: "ok" | "warn" | "danger" | "neutral" | "info";
} {
  const o = String(outcome ?? "").toUpperCase();
  if (status === "RUNNING" || o === "RUNNING") return { label: "Выполняется", tone: "info" };
  if (o === "SUCCESS" || o === "REUSED") return { label: o === "REUSED" ? "Переиспользовано" : "Успешно", tone: "ok" };
  if (o === "PARTIAL_SUCCESS") return { label: "Частично успешно", tone: "warn" };
  if (o === "NO_RESULTS") return { label: "Нет результатов", tone: "neutral" };
  if (o === "FAILED" || status === "FAILED") return { label: "Ошибка", tone: "danger" };
  if (status === "SUCCEEDED") return { label: "Успешно", tone: "ok" };
  return { label: status || "—", tone: "neutral" };
}

/**
 * Agents tab: lists all agents, lets the user run one agent or the full
 * audit, and shows recent agent_runs. Durable Arsenkin agents stay RUNNING
 * until finalize; UI polls every 3s while any lastRun is RUNNING.
 */
export function AgentsTab({
  caseId,
  agents,
  agentRuns,
  auditing,
  lastFullAuditSummary,
  onRunFullAudit,
  onChanged,
}: {
  caseId: string;
  agents: AgentInfo[];
  agentRuns: AgentRun[];
  auditing: boolean;
  lastFullAuditSummary: {
    mode: "legacy_mock_first" | "real_first_with_fallback" | "real_only" | "mock_only";
    items: FullAuditRunSummaryItem[];
  } | null;
  onRunFullAudit: () => void;
  onChanged: () => void;
}) {
  const { t, tError, tKind, tStatus, fmtDate } = useDigitalProfileI18n();
  const { can } = useDpAuth();
  const canRun = can("agents.run");
  const [busyAgent, setBusyAgent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const anyArsenkinRunning = agents.some(
    (a) =>
      a.executionMode === "DURABLE_ASYNC" &&
      (a.lastRun?.status === "RUNNING" || a.lastRun?.outcome === "RUNNING")
  );

  useEffect(() => {
    if (!anyArsenkinRunning) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    pollRef.current = setInterval(() => {
      onChanged();
    }, 3000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [anyArsenkinRunning, onChanged]);

  async function run(name: string) {
    // Block only this agent (and unified audit), not the whole table.
    if (busyAgent === name || auditing) return;
    const agent = agents.find((a) => a.name === name);
    if (agent?.kind === "REAL" && typeof window !== "undefined") {
      if (!window.confirm(t("agents.realRunConfirm"))) return;
    }
    setBusyAgent(name);
    setError(null);
    setInfo(null);
    try {
      const result = await runAgentApi(caseId, name);
      if (result.status === "RUNNING") {
        setInfo("Arsenkin-агент выполняется. Статус обновится автоматически…");
      } else if (name === "REAL_YANDEX_SEARCH") setInfo(t("agents.realYandexHint"));
      else if (name === "REAL_GOOGLE_SEARCH") setInfo(t("agents.realGoogleHint"));
      else if (name === "REAL_ORION_SEARCH_PROFILE") setInfo(t("agents.realOrionProfileHint"));
      else if (name === "REAL_ORION_GOOGLE_SURFACES") setInfo(t("agents.realOrionSurfacesHint"));
      else if (name === "REAL_ORION_UAE_INTERNATIONAL") setInfo(t("agents.realOrionUaeHint"));
      onChanged();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
    } finally {
      setBusyAgent(null);
    }
  }

  return (
    <div>
      <div className="dp-row" style={{ alignItems: "center" }}>
        <h2 className="dp-h2" style={{ margin: 0 }}>
          {t("agents.title")} <span className="dp-muted">{t("agents.unifiedCollectionHint")}</span>
        </h2>
        {canRun ? (
          <button
            className="dp-btn dp-btn-primary"
            onClick={onRunFullAudit}
            disabled={auditing || busyAgent !== null}
            data-testid="agents-tab-unified-cta"
          >
            {auditing ? <span className="dp-spinner" /> : null}
            {auditing ? t("agents.runningUnifiedCollection") : t("agents.runUnifiedCollection")}
          </button>
        ) : null}
      </div>

      {error ? (
        <div style={{ margin: "12px 0" }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}
      {info ? (
        <div style={{ margin: "12px 0" }}>
          <SuccessBox>{info}</SuccessBox>
        </div>
      ) : null}
      {lastFullAuditSummary ? (
        <div style={{ margin: "12px 0" }}>
          <h3 className="dp-h2" style={{ fontSize: 16, marginBottom: 8 }}>
            {t("agents.lastFullAuditSummary")}
          </h3>
          <div className="dp-muted" style={{ marginBottom: 8 }}>
            {t("agents.runtimeModeLabel", { mode: lastFullAuditSummary.mode })}
          </div>
          <table className="dp-table">
            <thead>
              <tr>
                <th>{t("agents.provider")}</th>
                <th>{t("agents.phase")}</th>
                <th>Status</th>
                <th>{t("agents.summary")}</th>
              </tr>
            </thead>
            <tbody>
              {lastFullAuditSummary.items.map((item) => (
                <tr key={`${item.providerId}-${item.phase}`}>
                  <td>{item.providerId}</td>
                  <td>{item.phase}</td>
                  <td>
                    <Badge
                      tone={
                        item.status === "completed"
                          ? "ok"
                          : item.status === "failed"
                            ? "danger"
                            : item.status === "unavailable"
                              ? "warn"
                              : "neutral"
                      }
                    >
                      {item.status === "completed"
                        ? t("agents.summaryCompleted")
                        : item.status === "failed"
                          ? t("agents.summaryFailed")
                          : item.status === "unavailable"
                            ? t("agents.summaryUnavailable")
                            : t("agents.summarySkipped")}
                    </Badge>
                    {item.fallbackAgent ? (
                      <span style={{ marginLeft: 6 }}>
                        <Badge tone="info">{t("agents.summaryFallback")}</Badge>
                      </span>
                    ) : null}
                  </td>
                  <td className="dp-muted">
                    {item.agentName ? `${item.agentName}. ` : ""}
                    {item.reason}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <table className="dp-table" style={{ marginTop: 14 }}>
        <thead>
          <tr>
            <th>{t("agents.agent")}</th>
            <th>{t("agents.type")}</th>
            <th>{t("agents.availability")}</th>
            <th>{t("agents.lastRun")}</th>
            <th>{t("agents.finished")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => {
            const isDurable = a.executionMode === "DURABLE_ASYNC";
            const badge = isDurable
              ? arsenkinOutcomeBadge(a.lastRun?.outcome, a.lastRun?.status ?? "")
              : null;
            const running =
              a.lastRun?.status === "RUNNING" || a.lastRun?.outcome === "RUNNING";
            const thisBusy = busyAgent === a.name;
            return (
              <tr key={a.name} data-testid={`agent-row-${a.name}`}>
                <td>
                  <div>{a.displayName}</div>
                  <div className="dp-muted">{a.description}</div>
                  {isDurable && a.lastRun?.summary ? (
                    <div className="dp-muted" style={{ fontSize: 12, marginTop: 4 }}>
                      {a.lastRun.summary}
                    </div>
                  ) : null}
                </td>
                <td>
                  <Badge tone={a.kind === "REAL" ? "ok" : "neutral"}>{tKind(a.kind)}</Badge>
                </td>
                <td>
                  <Badge
                    tone={
                      a.availability.status === "ENABLED"
                        ? "ok"
                        : a.availability.status === "NOT_CONFIGURED"
                          ? "warn"
                          : "neutral"
                    }
                    title={a.availability.message}
                  >
                    {tStatus(a.availability.status)}
                  </Badge>
                </td>
                <td>
                  {a.lastRun ? (
                    isDurable && badge ? (
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    ) : (
                      <StatusBadge status={a.lastRun.status} />
                    )
                  ) : (
                    <span className="dp-muted">—</span>
                  )}
                </td>
                <td className="dp-muted">{a.lastRun ? fmtDate(a.lastRun.finishedAt) : "—"}</td>
                <td style={{ textAlign: "right" }}>
                  {canRun ? (
                    <button
                      className="dp-btn dp-btn-sm"
                      disabled={thisBusy || auditing}
                      onClick={() => void run(a.name)}
                      data-testid={`agent-run-${a.name}`}
                      title={
                        running && isDurable
                          ? "Принудительно перезапустить (прервать зависший RUNNING)"
                          : undefined
                      }
                    >
                      {thisBusy ? <span className="dp-spinner" /> : null}
                      {thisBusy
                        ? t("agents.running")
                        : running && isDurable
                          ? "Перезапустить"
                          : t("agents.runAudit")}
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <h3 className="dp-h2" style={{ fontSize: 16, marginTop: 24 }}>
        {t("agents.recentRuns")}
      </h3>
      {agentRuns.length === 0 ? (
        <EmptyState title={t("agents.noRuns")} hint={t("agents.noRunsHint")} />
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>{t("agents.agent")}</th>
              <th>{t("agents.type")}</th>
              <th>Status</th>
              <th>{t("agents.summary")}</th>
              <th>{t("agents.started")}</th>
            </tr>
          </thead>
          <tbody>
            {agentRuns.slice(0, 20).map((r) => {
              const durableOutcome = r.outcome;
              const badge = durableOutcome
                ? arsenkinOutcomeBadge(durableOutcome, r.status)
                : null;
              return (
                <tr key={r.id}>
                  <td>{r.agentName}</td>
                  <td>
                    <Badge tone={r.kind === "REAL" ? "ok" : "neutral"}>{tKind(r.kind)}</Badge>
                  </td>
                  <td>
                    {badge ? (
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    ) : (
                      <StatusBadge status={r.status} />
                    )}
                  </td>
                  <td className="dp-muted">
                    {r.summary && r.summary !== "No new records" ? r.summary : r.error ?? "—"}
                  </td>
                  <td className="dp-muted">{fmtDate(r.startedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
