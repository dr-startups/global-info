"use client";

import Link from "next/link";
import type { CaseDetail } from "./api";
import { StatusBadge, formatDate } from "./components";

export function CaseHeader({
  caseDetail,
  onGenerate,
  generating,
  onRunAudit,
  auditing,
  lastRunStatus,
}: {
  caseDetail: CaseDetail;
  onGenerate: () => void;
  generating: boolean;
  onRunAudit: () => void;
  auditing: boolean;
  lastRunStatus: string | null;
}) {
  const subjectName = caseDetail.subject?.fullName ?? caseDetail.title;
  return (
    <div>
      <Link className="dp-back" href="/admin/digital-profile">
        ← Back to cases
      </Link>
      <div className="dp-row">
        <div>
          <h1 className="dp-h1">{subjectName}</h1>
          <div className="dp-inline" style={{ marginTop: 6 }}>
            <span className="dp-mono">{caseDetail.caseNumber}</span>
            <StatusBadge status={caseDetail.status} />
            <span className="dp-muted">Created {formatDate(caseDetail.createdAt)}</span>
            <span className="dp-muted">· Updated {formatDate(caseDetail.updatedAt)}</span>
            {lastRunStatus ? (
              <span className="dp-inline">
                <span className="dp-muted">· Last agent run:</span>
                <StatusBadge status={lastRunStatus} />
              </span>
            ) : null}
          </div>
        </div>
        <div className="dp-inline">
          <button
            className="dp-btn"
            onClick={onRunAudit}
            disabled={auditing || generating}
            title="Run all mock agents and populate the tabs"
          >
            {auditing ? <span className="dp-spinner" /> : null}
            {auditing ? "Running audit…" : "Run audit"}
          </button>
          <button
            className="dp-btn dp-btn-primary"
            onClick={onGenerate}
            disabled={generating || auditing}
            title="Build report_json and render PPTX/PDF"
          >
            {generating ? <span className="dp-spinner" /> : null}
            {generating ? "Generating…" : "Generate report"}
          </button>
        </div>
      </div>
    </div>
  );
}
