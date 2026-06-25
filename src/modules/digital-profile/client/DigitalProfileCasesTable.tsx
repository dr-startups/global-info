"use client";

import Link from "next/link";
import type { CaseListItem } from "./api";
import { StatusBadge } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";

export function DigitalProfileCasesTable({ cases }: { cases: CaseListItem[] }) {
  const { t, fmtDate } = useDigitalProfileI18n();
  return (
    <table className="dp-table">
      <thead>
        <tr>
          <th>{t("cases.case")}</th>
          <th>{t("cases.subject")}</th>
          <th>{t("cases.status")}</th>
          <th>{t("cases.consent")}</th>
          <th>{t("cases.created")}</th>
          <th aria-label="actions" />
        </tr>
      </thead>
      <tbody>
        {cases.map((c) => (
          <tr key={c.id}>
            <td>
              <div className="dp-mono">{c.caseNumber}</div>
            </td>
            <td>{c.subjectName ?? <span className="dp-muted">—</span>}</td>
            <td>
              <StatusBadge status={c.status} />
            </td>
            <td>
              <StatusBadge status={c.consentStatus} />
            </td>
            <td className="dp-muted">{fmtDate(c.createdAt)}</td>
            <td style={{ textAlign: "right" }}>
              <Link className="dp-btn dp-btn-sm" href={`/admin/digital-profile/${c.id}`}>
                {t("common.open")}
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
