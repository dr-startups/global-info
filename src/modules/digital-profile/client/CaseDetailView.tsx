"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  DigitalProfileApiError,
  generateReport,
  getCase,
  getEvidence,
  getReport,
  listAgentRuns,
  listAgents,
  listSearchSurfaces,
  renderReport,
  runFullAudit,
  type AgentInfo,
  type AgentRun,
  type CaseDetail,
  type CaseEvidence,
  type FullAuditRunSummaryItem,
  type ReportVersion,
  type SearchSurfaceItem,
} from "./api";
import {
  Card,
  EmptyState,
  ErrorBox,
  Loading,
  Notice,
  SuccessBox,
} from "./components";
import { CaseHeader } from "./CaseHeader";
import { CaseTabs } from "./CaseTabs";
import { OrionV2ReportPanel } from "./OrionV2ReportPanel";
import { OrionClientStoryboardReportPanel } from "./OrionClientStoryboardReportPanel";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";

type LoadState =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "ready"; caseDetail: CaseDetail; evidence: CaseEvidence };

export function CaseDetailView({ caseId }: { caseId: string }) {
  const { t, tError } = useDigitalProfileI18n();
  const { user } = useDpAuth();
  const isAdmin = user?.role === "ADMIN" || user?.role === "SUPER_ADMIN";
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [report, setReport] = useState<ReportVersion | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [surfaces, setSurfaces] = useState<SearchSurfaceItem[]>([]);
  const [generating, setGenerating] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [banner, setBanner] = useState<{ kind: "error" | "ok"; text: string } | null>(null);
  const [lastFullAuditSummary, setLastFullAuditSummary] = useState<{
    mode: "legacy_mock_first" | "real_first_with_fallback" | "real_only" | "mock_only";
    items: FullAuditRunSummaryItem[];
  } | null>(null);

  const loadAll = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const [caseDetail, evidence, latestReport, agentList, runs, surfaceList] = await Promise.all([
        getCase(caseId),
        getEvidence(caseId),
        getReport(caseId),
        listAgents(caseId),
        listAgentRuns(caseId),
        listSearchSurfaces(caseId),
      ]);
      setReport(latestReport);
      setAgents(agentList);
      setAgentRuns(runs);
      setSurfaces(surfaceList);
      setState({ kind: "ready", caseDetail, evidence });
    } catch (err) {
      if (err instanceof DigitalProfileApiError) {
        if (err.code === "MODULE_DISABLED") return setState({ kind: "disabled" });
        if (err.code === "NOT_FOUND") return setState({ kind: "notFound" });
      }
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setState({ kind: "error", message: tError(code, msg) });
    }
  }, [caseId, tError]);

  const refreshEvidence = useCallback(async () => {
    try {
      const evidence = await getEvidence(caseId);
      setState((prev) =>
        prev.kind === "ready" ? { ...prev, evidence } : prev
      );
    } catch {
      // Non-fatal: keep existing data; tab-level errors are shown inline.
    }
  }, [caseId]);

  const refreshSurfaces = useCallback(async () => {
    try {
      setSurfaces(await listSearchSurfaces(caseId));
    } catch {
      // Non-fatal: inline errors are surfaced by the triggering action.
    }
  }, [caseId]);

  // Refresh agents + runs + evidence + surfaces together (after running agents).
  const refreshAgents = useCallback(async () => {
    try {
      const [agentList, runs, evidence, surfaceList] = await Promise.all([
        listAgents(caseId),
        listAgentRuns(caseId),
        getEvidence(caseId),
        listSearchSurfaces(caseId),
      ]);
      setAgents(agentList);
      setAgentRuns(runs);
      setSurfaces(surfaceList);
      setState((prev) => (prev.kind === "ready" ? { ...prev, evidence } : prev));
    } catch {
      // Non-fatal: inline errors are surfaced by the action that triggered this.
    }
  }, [caseId]);

  const handleRunAudit = useCallback(async () => {
    if (auditing || generating) return;
    setAuditing(true);
    setBanner(null);
    try {
      const result = await runFullAudit(caseId, {
        runtimeMode: "real_first_with_fallback",
      });
      await refreshAgents();
      setLastFullAuditSummary({
        mode: result.runtimeStrategy?.mode ?? "real_first_with_fallback",
        items: result.runSummary ?? [],
      });
      const completedCount = result.runSummary?.filter((item) => item.status === "completed").length ?? 0;
      const skippedCount = result.runSummary?.filter((item) => item.status === "skipped").length ?? 0;
      const unavailableCount = result.runSummary?.filter((item) => item.status === "unavailable").length ?? 0;
      const failedCount = result.runSummary?.filter((item) => item.status === "failed").length ?? 0;
      const fallbackCount = result.runSummary?.filter((item) => !!item.fallbackAgent).length ?? 0;
      const mode = result.runtimeStrategy?.mode ?? "real_first_with_fallback";
      const ok = result.outcome === "SUCCESS";
      const baseText =
        result.outcome === "SUCCESS"
          ? t("agents.auditDone")
          : result.outcome === "PARTIAL_SUCCESS"
            ? t("agents.auditPartial")
            : t("agents.auditFailed");
      setBanner({
        kind: ok ? "ok" : "error",
        text: `${baseText} ${t("agents.auditRunStats", {
          completed: completedCount,
          skipped: skippedCount,
          unavailable: unavailableCount,
          fallback: fallbackCount,
          failed: failedCount,
          mode,
        })}`,
      });
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setBanner({ kind: "error", text: tError(code, msg) });
    } finally {
      setAuditing(false);
    }
  }, [auditing, generating, caseId, refreshAgents, t, tError]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // "Generate report" from the header: build + render, then surface the result.
  const handleHeaderGenerate = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    setBanner(null);
    try {
      const generated = await generateReport(caseId);
      setReport(generated);
      const rendered = await renderReport(caseId);
      setReport({ ...generated, ...rendered });
      setBanner({
        kind: "ok",
        text: t("report.generatedShort", { version: rendered.version }),
      });
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setBanner({ kind: "error", text: tError(code, msg) });
    } finally {
      setGenerating(false);
    }
  }, [caseId, generating, t, tError]);

  if (state.kind === "loading") {
    return (
      <Card>
        <Loading />
      </Card>
    );
  }

  if (state.kind === "disabled") {
    return (
      <Card>
        <Notice>{t("cases.moduleDisabled")}</Notice>
      </Card>
    );
  }

  if (state.kind === "notFound") {
    return (
      <Card>
        <EmptyState title={t("cases.notFoundTitle")} hint={t("cases.notFoundHint")} />
        <div style={{ marginTop: 12 }}>
          <Link className="dp-btn" href="/admin/digital-profile">
            ← {t("common.back")}
          </Link>
        </div>
      </Card>
    );
  }

  if (state.kind === "error") {
    return (
      <Card>
        <div className="dp-stack">
          <ErrorBox>{state.message}</ErrorBox>
          <div>
            <button className="dp-btn" onClick={() => void loadAll()}>
              {t("common.retry")}
            </button>
          </div>
        </div>
      </Card>
    );
  }

  return (
    <div className="dp-stack">
      <Card>
        <CaseHeader
          caseDetail={state.caseDetail}
          onGenerate={handleHeaderGenerate}
          generating={generating}
          onRunAudit={handleRunAudit}
          auditing={auditing}
          lastRunStatus={agentRuns[0]?.status ?? null}
        />
      </Card>

      {banner ? (
        <div>
          {banner.kind === "ok" ? (
            <SuccessBox>{banner.text}</SuccessBox>
          ) : (
            <ErrorBox>{banner.text}</ErrorBox>
          )}
        </div>
      ) : null}

      {isAdmin ? (
        <Card>
          <OrionV2ReportPanel caseId={state.caseDetail.id} />
        </Card>
      ) : null}

      {isAdmin ? (
        <Card>
          <OrionClientStoryboardReportPanel caseId={state.caseDetail.id} />
        </Card>
      ) : null}

      <Card>
        <CaseTabs
          caseDetail={state.caseDetail}
          evidence={state.evidence}
          surfaces={surfaces}
          report={report}
          agents={agents}
          agentRuns={agentRuns}
          auditing={auditing}
          lastFullAuditSummary={lastFullAuditSummary}
          onRunFullAudit={handleRunAudit}
          onAgentsChanged={() => void refreshAgents()}
          onEvidenceChanged={() => void refreshEvidence()}
          onSurfacesChanged={() => void refreshSurfaces()}
          onReportChange={setReport}
        />
      </Card>
    </div>
  );
}
