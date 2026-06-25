"use client";

import { useState } from "react";
import {
  DigitalProfileApiError,
  runAgent as runAgentApi,
  type AgentInfo,
  type AgentRun,
} from "./api";
import { Badge, EmptyState, ErrorBox, StatusBadge } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";

/**
 * Agents tab: lists the (mock) agents, lets the user run one agent or the full
 * audit, and shows recent agent_runs. The full audit is owned by the parent so
 * the header button and this tab share one loading state; single-agent runs are
 * handled locally and then ask the parent to refresh.
 */
export function AgentsTab({
  caseId,
  agents,
  agentRuns,
  auditing,
  onRunFullAudit,
  onChanged,
}: {
  caseId: string;
  agents: AgentInfo[];
  agentRuns: AgentRun[];
  auditing: boolean;
  onRunFullAudit: () => void;
  onChanged: () => void;
}) {
  const { t, tError, tKind, tStatus, fmtDate } = useDigitalProfileI18n();
  const [busyAgent, setBusyAgent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(name: string) {
    if (busyAgent || auditing) return;
    setBusyAgent(name);
    setError(null);
    try {
      await runAgentApi(caseId, name);
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
          {t("agents.title")} <span className="dp-muted">{t("agents.mockSuffix")}</span>
        </h2>
        <button
          className="dp-btn dp-btn-primary"
          onClick={onRunFullAudit}
          disabled={auditing || busyAgent !== null}
        >
          {auditing ? <span className="dp-spinner" /> : null}
          {auditing ? t("agents.runningAudit") : t("agents.runFullAudit")}
        </button>
      </div>

      {error ? (
        <div style={{ margin: "12px 0" }}>
          <ErrorBox>{error}</ErrorBox>
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
                <button
                  className="dp-btn dp-btn-sm"
                  disabled={auditing || busyAgent !== null || !a.enabled}
                  onClick={() => run(a.name)}
                  title={a.enabled ? t("common.run") : a.availability.message}
                >
                  {busyAgent === a.name ? t("agents.running") : t("common.run")}
                </button>
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
