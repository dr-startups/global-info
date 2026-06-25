"use client";

import Link from "next/link";
import type { CaseListItem } from "./api";
import { StatusBadge, formatDate } from "./components";

export function DigitalProfileCasesTable({ cases }: { cases: CaseListItem[] }) {
  return (
    <table className="dp-table">
      <thead>
        <tr>
          <th>Case</th>
          <th>Subject</th>
          <th>Status</th>
          <th>Consent</th>
          <th>Created</th>
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
            <td className="dp-muted">{formatDate(c.createdAt)}</td>
            <td style={{ textAlign: "right" }}>
              <Link className="dp-btn dp-btn-sm" href={`/admin/digital-profile/${c.id}`}>
                Open
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
