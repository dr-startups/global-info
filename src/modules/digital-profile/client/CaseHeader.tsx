"use client";

import Link from "next/link";
import type { CaseDetail } from "./api";
import { StatusBadge, formatDate } from "./components";

export function CaseHeader({
  caseDetail,
  onGenerate,
  generating,
}: {
  caseDetail: CaseDetail;
  onGenerate: () => void;
  generating: boolean;
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
          </div>
        </div>
        <button
          className="dp-btn dp-btn-primary"
          onClick={onGenerate}
          disabled={generating}
          title="Build report_json and render PPTX/PDF"
        >
          {generating ? <span className="dp-spinner" /> : null}
          {generating ? "Generating…" : "Generate report"}
        </button>
      </div>
    </div>
  );
}
