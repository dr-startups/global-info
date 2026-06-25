"use client";

import Link from "next/link";
import type { CaseDetail } from "./api";
import { StatusBadge } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";

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
  const { t, fmtDate } = useDigitalProfileI18n();
  const { can } = useDpAuth();
  const subjectName = caseDetail.subject?.fullName ?? caseDetail.title;
  return (
    <div>
      <Link className="dp-back" href="/admin/digital-profile">
        ← {t("common.back")}
      </Link>
      <div className="dp-row">
        <div>
          <h1 className="dp-h1">{subjectName}</h1>
          <div className="dp-inline" style={{ marginTop: 6 }}>
            <span className="dp-mono">{caseDetail.caseNumber}</span>
            <StatusBadge status={caseDetail.status} />
            <span className="dp-muted">
              {t("cases.created")} {fmtDate(caseDetail.createdAt)}
            </span>
            <span className="dp-muted">
              · {t("cases.updated")} {fmtDate(caseDetail.updatedAt)}
            </span>
            {lastRunStatus ? (
              <span className="dp-inline">
                <span className="dp-muted">· {t("agents.lastRun")}:</span>
                <StatusBadge status={lastRunStatus} />
              </span>
            ) : null}
          </div>
        </div>
        <div className="dp-inline">
          {can("agents.run") ? (
            <button
              className="dp-btn"
              onClick={onRunAudit}
              disabled={auditing || generating}
            >
              {auditing ? <span className="dp-spinner" /> : null}
              {auditing ? t("agents.runningAudit") : t("agents.runAudit")}
            </button>
          ) : null}
          {can("report.generateInternal") ? (
            <button
              className="dp-btn dp-btn-primary"
              onClick={onGenerate}
              disabled={generating || auditing}
            >
              {generating ? <span className="dp-spinner" /> : null}
              {generating ? t("report.generating") : t("report.generateReport")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
