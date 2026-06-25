"use client";

import { useState } from "react";
import {
  addSearchResult,
  DigitalProfileApiError,
  reviewFinding,
  type AgentInfo,
  type AgentRun,
  type AiProfile,
  type CaseDetail,
  type CaseEvidence,
  type ReportVersion,
} from "./api";
import {
  Badge,
  EmptyState,
  ErrorBox,
  RiskBadge,
  StatusBadge,
  errorMessage,
  formatDate,
} from "./components";
import { ReportPreviewPanel } from "./ReportPreviewPanel";
import { AgentsTab } from "./AgentsTab";

type TabKey =
  | "subject"
  | "agents"
  | "search"
  | "screenshots"
  | "wikipedia"
  | "ai"
  | "compliance"
  | "risk"
  | "report";

const NEXT_STEP_HINT = "Data input for this section will be available in the next step.";

export function CaseTabs({
  caseDetail,
  evidence,
  report,
  agents,
  agentRuns,
  auditing,
  onRunFullAudit,
  onAgentsChanged,
  onEvidenceChanged,
  onReportChange,
}: {
  caseDetail: CaseDetail;
  evidence: CaseEvidence;
  report: ReportVersion | null;
  agents: AgentInfo[];
  agentRuns: AgentRun[];
  auditing: boolean;
  onRunFullAudit: () => void;
  onAgentsChanged: () => void;
  onEvidenceChanged: () => void;
  onReportChange: (r: ReportVersion) => void;
}) {
  const [tab, setTab] = useState<TabKey>("subject");

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "subject", label: "Subject" },
    { key: "agents", label: "Agents", count: agents.length },
    { key: "search", label: "Search Results", count: evidence.searchResults.length },
    { key: "screenshots", label: "Screenshots", count: evidence.screenshots.length },
    { key: "wikipedia", label: "Wikipedia", count: evidence.wikipediaChecks.length },
    { key: "ai", label: "AI Profile", count: evidence.aiProfiles.length },
    { key: "compliance", label: "Compliance Databases", count: evidence.databaseProfiles.length },
    { key: "risk", label: "Risk Findings", count: evidence.riskFindings.length },
    { key: "report", label: "Report Preview" },
  ];

  return (
    <div>
      <div className="dp-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`dp-tab ${tab === t.key ? "dp-tab-active" : ""}`}
            onClick={() => setTab(t.key)}
            role="tab"
            aria-selected={tab === t.key}
          >
            {t.label}
            {typeof t.count === "number" ? <span className="dp-tab-count">{t.count}</span> : null}
          </button>
        ))}
      </div>

      {tab === "subject" ? <SubjectTab caseDetail={caseDetail} /> : null}
      {tab === "agents" ? (
        <AgentsTab
          caseId={caseDetail.id}
          agents={agents}
          agentRuns={agentRuns}
          auditing={auditing}
          onRunFullAudit={onRunFullAudit}
          onChanged={onAgentsChanged}
        />
      ) : null}
      {tab === "search" ? (
        <SearchResultsTab
          caseId={caseDetail.id}
          evidence={evidence}
          onChanged={onEvidenceChanged}
        />
      ) : null}
      {tab === "screenshots" ? <ScreenshotsTab evidence={evidence} /> : null}
      {tab === "wikipedia" ? <WikipediaTab evidence={evidence} /> : null}
      {tab === "ai" ? <AiProfileTab evidence={evidence} /> : null}
      {tab === "compliance" ? <ComplianceTab evidence={evidence} /> : null}
      {tab === "risk" ? (
        <RiskFindingsTab evidence={evidence} onChanged={onEvidenceChanged} />
      ) : null}
      {tab === "report" ? (
        <ReportPreviewPanel
          caseId={caseDetail.id}
          report={report}
          onReportChange={onReportChange}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

function SubjectTab({ caseDetail }: { caseDetail: CaseDetail }) {
  const s = caseDetail.subject;
  return (
    <div>
      <h2 className="dp-h2">Subject</h2>
      <dl className="dp-kv">
        <dt>Full name</dt>
        <dd>{s?.fullName ?? "—"}</dd>
        <dt>Aliases</dt>
        <dd>{s?.aliases?.length ? s.aliases.join(", ") : "—"}</dd>
        <dt>Birth date</dt>
        <dd>{s?.dateOfBirth ? formatDate(s.dateOfBirth) : "—"}</dd>
        <dt>Target regions</dt>
        <dd>{caseDetail.targetRegions.length ? caseDetail.targetRegions.join(", ") : "—"}</dd>
        <dt>Lawful basis</dt>
        <dd>{caseDetail.lawfulBasis ? caseDetail.lawfulBasis.replace(/_/g, " ") : "—"}</dd>
        <dt>Consent status</dt>
        <dd>
          <StatusBadge status={caseDetail.consentStatus} />
        </dd>
        <dt>Notes</dt>
        <dd>{caseDetail.notes ?? "—"}</dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search results (+ minimal add form)
// ---------------------------------------------------------------------------

const ENGINES = ["GOOGLE", "YANDEX", "BING", "OTHER"];
const CLASSIFICATIONS = [
  "UNCLASSIFIED",
  "RELEVANT",
  "IRRELEVANT",
  "ADVERSE_MEDIA",
  "SOCIAL_PROFILE",
  "CORPORATE",
  "LEGAL",
];

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function SearchResultsTab({
  caseId,
  evidence,
  onChanged,
}: {
  caseId: string;
  evidence: CaseEvidence;
  onChanged: () => void;
}) {
  const [engine, setEngine] = useState("GOOGLE");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [classification, setClassification] = useState("UNCLASSIFIED");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !url.trim()) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await addSearchResult(caseId, {
        engine,
        url: url.trim(),
        title: title.trim() || undefined,
        classification,
      });
      setInfo(res.deduplicated ? "Duplicate URL — existing result reused." : "Search result added.");
      setUrl("");
      setTitle("");
      onChanged();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "INTERNAL_ERROR";
      const msg = err instanceof Error ? err.message : "Failed to add search result";
      setError(errorMessage(code, msg));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="dp-h2">Search results</h2>

      <form onSubmit={add} style={{ marginBottom: 18 }}>
        <div className="dp-form-grid">
          <div className="dp-field">
            <label>Engine</label>
            <select className="dp-select" value={engine} onChange={(e) => setEngine(e.target.value)}>
              {ENGINES.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </div>
          <div className="dp-field">
            <label>Classification</label>
            <select
              className="dp-select"
              value={classification}
              onChange={(e) => setClassification(e.target.value)}
            >
              {CLASSIFICATIONS.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </div>
          <div className="dp-field dp-field-full">
            <label>URL</label>
            <input
              className="dp-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/page"
            />
          </div>
          <div className="dp-field dp-field-full">
            <label>Title</label>
            <input className="dp-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </div>
        <div className="dp-inline" style={{ marginTop: 12 }}>
          <button className="dp-btn dp-btn-primary dp-btn-sm" disabled={busy || !url.trim()}>
            {busy ? "Adding…" : "Add search result"}
          </button>
          {info ? <span className="dp-muted">{info}</span> : null}
        </div>
        {error ? (
          <div style={{ marginTop: 10 }}>
            <ErrorBox>{error}</ErrorBox>
          </div>
        ) : null}
      </form>

      {evidence.searchResults.length === 0 ? (
        <EmptyState title="No search results yet" hint="Add results manually above." />
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>Engine</th>
              <th>Title</th>
              <th>Domain</th>
              <th>Classification</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {evidence.searchResults.map((r) => (
              <tr key={r.id}>
                <td>{r.engine}</td>
                <td>
                  <a href={r.url} target="_blank" rel="noopener noreferrer">
                    {r.title ?? r.url}
                  </a>
                </td>
                <td className="dp-muted">{domainOf(r.url)}</td>
                <td>
                  <Badge tone="neutral">{r.classification}</Badge>
                </td>
                <td>
                  <StatusBadge status={r.reviewStatus} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

function ScreenshotsTab({ evidence }: { evidence: CaseEvidence }) {
  return (
    <div>
      <h2 className="dp-h2">Screenshots</h2>
      {evidence.screenshots.length === 0 ? (
        <EmptyState title="No screenshots" hint="Screenshot uploads are done via the API/agents." />
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>Source URL</th>
              <th>Type</th>
              <th>Captured</th>
              <th>SHA-256</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {evidence.screenshots.map((s) => (
              <tr key={s.id}>
                <td>{s.sourceUrl ?? <span className="dp-muted">—</span>}</td>
                <td className="dp-muted">{s.mimeType}</td>
                <td className="dp-muted">{formatDate(s.capturedAt)}</td>
                <td className="dp-mono">{s.sha256.slice(0, 12)}…</td>
                <td style={{ textAlign: "right" }}>
                  <a
                    className="dp-btn dp-btn-sm"
                    href={s.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    View
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Wikipedia
// ---------------------------------------------------------------------------

function notabilityOf(snapshot: unknown): number | null {
  if (snapshot && typeof snapshot === "object") {
    const v = (snapshot as Record<string, unknown>).notabilityScore;
    if (typeof v === "number") return v;
  }
  return null;
}

function WikipediaTab({ evidence }: { evidence: CaseEvidence }) {
  return (
    <div>
      <h2 className="dp-h2">Wikipedia</h2>
      {evidence.wikipediaChecks.length === 0 ? (
        <EmptyState title="No Wikipedia checks" hint={NEXT_STEP_HINT} />
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>Exists</th>
              <th>Source</th>
              <th>Language</th>
              <th>Page title</th>
              <th>Notability</th>
              <th>URL</th>
              <th>Checked</th>
            </tr>
          </thead>
          <tbody>
            {evidence.wikipediaChecks.map((w) => {
              const isReal = (w.checkedBy ?? "").startsWith("real");
              return (
              <tr key={w.id}>
                <td>{w.exists ? <Badge tone="ok">Yes</Badge> : <Badge tone="neutral">No</Badge>}</td>
                <td>
                  <Badge tone={isReal ? "ok" : "neutral"}>{isReal ? "REAL" : "MOCK"}</Badge>
                </td>
                <td>{w.language ?? "—"}</td>
                <td>{w.pageTitle ?? "—"}</td>
                <td>{notabilityOf(w.snapshot) ?? "—"}</td>
                <td>
                  {w.url ? (
                    <a href={w.url} target="_blank" rel="noopener noreferrer">
                      open
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="dp-muted">{formatDate(w.lastChecked)}</td>
              </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Profile (display saved ai_profiles; never calls an LLM from the UI)
// ---------------------------------------------------------------------------

function citedSourcesOf(classifications: unknown): number | null {
  if (classifications && typeof classifications === "object") {
    const v = (classifications as Record<string, unknown>).citedSources;
    if (typeof v === "number") return v;
  }
  return null;
}

function AiProfileTab({ evidence }: { evidence: CaseEvidence }) {
  return (
    <div>
      <h2 className="dp-h2">AI Profile</h2>
      {evidence.aiProfiles.length === 0 ? (
        <EmptyState
          title="No AI profiles"
          hint="AI summaries are evidence-based. Run the audit (Agents tab) to generate demo profiles."
        />
      ) : (
        <div className="dp-stack">
          {evidence.aiProfiles.map((p: AiProfile) => {
            const cited = citedSourcesOf(p.classifications);
            return (
              <div key={p.id} className="dp-card" style={{ padding: 14 }}>
                <div className="dp-inline" style={{ justifyContent: "space-between" }}>
                  <Badge tone="info">{p.model}</Badge>
                  <span className="dp-muted">{formatDate(p.createdAt)}</span>
                </div>
                <p style={{ marginTop: 10 }}>{p.summary ?? "—"}</p>
                <div className="dp-muted" style={{ marginTop: 8 }}>
                  {cited !== null ? `Cited sources: ${cited} · ` : ""}
                  {p.disclaimer}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compliance databases
// ---------------------------------------------------------------------------

function ComplianceTab({ evidence }: { evidence: CaseEvidence }) {
  return (
    <div>
      <h2 className="dp-h2">Compliance databases</h2>
      {evidence.databaseProfiles.length === 0 ? (
        <EmptyState
          title="No database profiles"
          hint="LexisNexis / Dow Jones / World-Check profiles are added via official API or manual import."
        />
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>Provider</th>
              <th>Import method</th>
              <th>Match type</th>
              <th>Score</th>
              <th>Evidence</th>
              <th>Imported</th>
            </tr>
          </thead>
          <tbody>
            {evidence.databaseProfiles.map((d) => (
              <tr key={d.id}>
                <td>{d.provider}</td>
                <td>
                  <Badge tone="info">{d.importMethod.replace(/_/g, " ")}</Badge>
                </td>
                <td>{d.matchType ?? "—"}</td>
                <td>{d.matchScore ?? "—"}</td>
                <td>{d.evidenceRefs.length}</td>
                <td className="dp-muted">{formatDate(d.importedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Risk findings (+ review)
// ---------------------------------------------------------------------------

function RiskFindingsTab({
  evidence,
  onChanged,
}: {
  evidence: CaseEvidence;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function review(id: string, status: "REVIEWED" | "DISMISSED") {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      await reviewFinding(id, status);
      onChanged();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "INTERNAL_ERROR";
      const msg = err instanceof Error ? err.message : "Failed to update finding";
      setError(errorMessage(code, msg));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <h2 className="dp-h2">Risk findings</h2>
      {error ? (
        <div style={{ marginBottom: 12 }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}
      {evidence.riskFindings.length === 0 ? (
        <EmptyState
          title="No risk findings"
          hint="Findings are evidence-first and require human review before inclusion in the report."
        />
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Category</th>
              <th>Finding</th>
              <th>Evidence</th>
              <th>Review</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {evidence.riskFindings.map((f) => (
              <tr key={f.id}>
                <td>
                  <RiskBadge severity={f.severity} />
                </td>
                <td>{f.category}</td>
                <td>
                  <div>{f.title}</div>
                  {f.summary ? <div className="dp-muted">{f.summary}</div> : null}
                </td>
                <td>{f.evidenceRefs.length}</td>
                <td>
                  <StatusBadge status={f.reviewStatus} />
                </td>
                <td style={{ textAlign: "right" }}>
                  {f.reviewStatus === "PENDING" ? (
                    <div className="dp-inline" style={{ justifyContent: "flex-end" }}>
                      <button
                        className="dp-btn dp-btn-sm"
                        disabled={busyId === f.id}
                        onClick={() => review(f.id, "REVIEWED")}
                      >
                        Mark reviewed
                      </button>
                      <button
                        className="dp-btn dp-btn-sm dp-btn-danger"
                        disabled={busyId === f.id}
                        onClick={() => review(f.id, "DISMISSED")}
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : (
                    <span className="dp-muted">{f.reviewedBy ?? "—"}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
