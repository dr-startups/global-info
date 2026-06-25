"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  DigitalProfileApiError,
  generateReport,
  getCase,
  getEvidence,
  getReport,
  renderReport,
  type CaseDetail,
  type CaseEvidence,
  type ReportVersion,
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
  const [generating, setGenerating] = useState(false);
  const [banner, setBanner] = useState<{ kind: "error" | "ok"; text: string } | null>(null);

  const loadAll = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const [caseDetail, evidence, latestReport] = await Promise.all([
        getCase(caseId),
        getEvidence(caseId),
        getReport(caseId),
      ]);
      setReport(latestReport);
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
          report={report}
          onEvidenceChanged={() => void refreshEvidence()}
          onReportChange={setReport}
        />
      </Card>
    </div>
  );
}
