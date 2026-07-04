"use client";

import { useState } from "react";
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

/**
 * Agents tab: lists all agents, lets the user run one agent or the full
 * audit, and shows recent agent_runs. The full audit is owned by the parent so
 * the header button and this tab share one loading state; single-agent runs are
 * handled locally and then ask the parent to refresh.
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

  async function run(name: string) {
    if (busyAgent || auditing) return;
    const agent = agents.find((a) => a.name === name);
    // Real connectors hit a paid external API — confirm before spending.
    if (agent?.kind === "REAL" && typeof window !== "undefined") {
      if (!window.confirm(t("agents.realRunConfirm"))) return;
    }
    setBusyAgent(name);
    setError(null);
    setInfo(null);
    try {
      await runAgentApi(caseId, name);
      if (name === "REAL_YANDEX_SEARCH") setInfo(t("agents.realYandexHint"));
      if (name === "REAL_GOOGLE_SEARCH") setInfo(t("agents.realGoogleHint"));
      if (name === "REAL_ORION_SEARCH_PROFILE") setInfo(t("agents.realOrionProfileHint"));
      if (name === "REAL_ORION_GOOGLE_SURFACES") setInfo(t("agents.realOrionSurfacesHint"));
      if (name === "REAL_ORION_UAE_INTERNATIONAL") setInfo(t("agents.realOrionUaeHint"));
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
          {t("agents.title")} <span className="dp-muted">{t("agents.fullAuditScopeHint")}</span>
        </h2>
        {canRun ? (
          <button
            className="dp-btn dp-btn-primary"
            onClick={onRunFullAudit}
            disabled={auditing || busyAgent !== null}
          >
            {auditing ? <span className="dp-spinner" /> : null}
            {auditing ? t("agents.runningAudit") : t("agents.runFullAudit")}
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
                <th>{t("agents.type")}</th>
                <th>{t("cases.status")}</th>
                <th>{t("agents.summary")}</th>
              </tr>
            </thead>
            <tbody>
              {lastFullAuditSummary.items.map((item) => (
                <tr key={`${item.providerId}-${item.phase}`}>
                  <td>{item.providerId}</td>
                  <td>{item.phase}</td>
                  <td>
                    <Badge tone={item.runtime === "real" ? "ok" : item.runtime === "mock" ? "neutral" : "warn"}>
                      {item.runtime.toUpperCase()}
                    </Badge>
                  </td>
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
          {agents.map((a) => (
            <tr key={a.name}>
              <td>
                <div>{a.displayName}</div>
                <div className="dp-muted">{a.description}</div>
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
              <td>{a.lastRun ? <StatusBadge status={a.lastRun.status} /> : <span className="dp-muted">—</span>}</td>
              <td className="dp-muted">{a.lastRun ? fmtDate(a.lastRun.finishedAt) : "—"}</td>
              <td style={{ textAlign: "right" }}>
                {canRun ? (
                  <button
                    className="dp-btn dp-btn-sm"
                    disabled={auditing || busyAgent !== null || !a.enabled}
                    onClick={() => run(a.name)}
                    title={a.enabled ? t("common.run") : a.availability.message}
                  >
                    {busyAgent === a.name ? t("agents.running") : t("common.run")}
                  </button>
                ) : (
                  <span className="dp-muted">—</span>
                )}
              </td>
            </tr>
          ))}
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
              <th>{t("cases.status")}</th>
              <th>{t("agents.summary")}</th>
              <th>{t("agents.started")}</th>
              <th>{t("agents.finished")}</th>
            </tr>
          </thead>
          <tbody>
            {agentRuns.map((r) => (
              <tr key={r.id}>
                <td>{r.agentName}</td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td>
                  {r.status === "FAILED" && r.error ? (
                    <Badge tone="danger">{r.error}</Badge>
                  ) : (
                    <span className="dp-muted">{r.summary ?? "—"}</span>
                  )}
                </td>
                <td className="dp-muted">{fmtDate(r.startedAt)}</td>
                <td className="dp-muted">{fmtDate(r.finishedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
