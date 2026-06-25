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
  errorMessage,
} from "./components";
import { CaseHeader } from "./CaseHeader";
import { CaseTabs } from "./CaseTabs";

type LoadState =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "notFound" }
  | { kind: "error"; message: string }
  | { kind: "ready"; caseDetail: CaseDetail; evidence: CaseEvidence };

export function CaseDetailView({ caseId }: { caseId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [report, setReport] = useState<ReportVersion | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agentRuns, setAgentRuns] = useState<AgentRun[]>([]);
  const [surfaces, setSurfaces] = useState<SearchSurfaceItem[]>([]);
  const [generating, setGenerating] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [banner, setBanner] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

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
      const code = err instanceof DigitalProfileApiError ? err.code : "INTERNAL_ERROR";
      const msg = err instanceof Error ? err.message : "Failed to load case";
      setState({ kind: "error", message: errorMessage(code, msg) });
    }
  }, [caseId]);

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
      const result = await runFullAudit(caseId);
      await refreshAgents();
      const ok = result.outcome === "SUCCESS";
      setBanner({
        kind: ok ? "ok" : "error",
        text:
          result.outcome === "SUCCESS"
            ? "Full audit completed. Demo data populated across tabs."
            : result.outcome === "PARTIAL_SUCCESS"
              ? "Audit finished with warnings — some agents failed. See the Agents tab."
              : "Audit failed — all agents errored. See the Agents tab.",
      });
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "INTERNAL_ERROR";
      const msg = err instanceof Error ? err.message : "Failed to run audit";
      setBanner({ kind: "error", text: errorMessage(code, msg) });
    } finally {
      setAuditing(false);
    }
  }, [auditing, generating, caseId, refreshAgents]);

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
      setBanner({ kind: "ok", text: `Report v${rendered.version} generated and rendered.` });
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "INTERNAL_ERROR";
      const msg = err instanceof Error ? err.message : "Failed to generate report";
      setBanner({ kind: "error", text: errorMessage(code, msg) });
    } finally {
      setGenerating(false);
    }
  }, [caseId, generating]);

  if (state.kind === "loading") {
    return (
      <Card>
        <Loading label="Loading case…" />
      </Card>
    );
  }

  if (state.kind === "disabled") {
    return (
      <Card>
        <Notice>
          The Digital Profile module is disabled. Set{" "}
          <code className="dp-mono">DIGITAL_PROFILE_ENABLED=true</code> and restart.
        </Notice>
      </Card>
    );
  }

  if (state.kind === "notFound") {
    return (
      <Card>
        <EmptyState title="Case not found" hint="It may have been deleted or never existed." />
        <div style={{ marginTop: 12 }}>
          <Link className="dp-btn" href="/admin/digital-profile">
            ← Back to cases
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
              Retry
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

      <Card>
        <CaseTabs
          caseDetail={state.caseDetail}
          evidence={state.evidence}
          surfaces={surfaces}
          report={report}
          agents={agents}
          agentRuns={agentRuns}
          auditing={auditing}
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
