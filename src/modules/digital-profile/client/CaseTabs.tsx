"use client";

import { useState } from "react";
import {
  addSearchResult,
  buildAuditSummary,
  classifyRisks,
  DigitalProfileApiError,
  reviewFinding,
  type AgentInfo,
  type AgentRun,
  type AiProfile,
  type CaseDetail,
  type CaseEvidence,
  type ReportVersion,
  type SearchSurfaceItem,
} from "./api";
import {
  Badge,
  EmptyState,
  ErrorBox,
  Notice,
  RiskBadge,
  StatusBadge,
  SuccessBox,
  errorMessage,
  formatDate,
} from "./components";
import { ReportPreviewPanel } from "./ReportPreviewPanel";
import { AgentsTab } from "./AgentsTab";
import { SurfacesTab } from "./SurfacesTab";
import { AuditSummaryTab } from "./AuditSummaryTab";

type TabKey =
  | "subject"
  | "agents"
  | "search"
  | "suggestions"
  | "related"
  | "images"
  | "videos"
  | "knowledge"
  | "screenshots"
  | "wikipedia"
  | "ai"
  | "compliance"
  | "risk"
  | "audit"
  | "report";

const NEXT_STEP_HINT = "Data input for this section will be available in the next step.";

export function CaseTabs({
  caseDetail,
  evidence,
  surfaces,
  report,
  agents,
  agentRuns,
  auditing,
  onRunFullAudit,
  onAgentsChanged,
  onEvidenceChanged,
  onSurfacesChanged,
  onReportChange,
}: {
  caseDetail: CaseDetail;
  evidence: CaseEvidence;
  surfaces: SearchSurfaceItem[];
  report: ReportVersion | null;
  agents: AgentInfo[];
  agentRuns: AgentRun[];
  auditing: boolean;
  onRunFullAudit: () => void;
  onAgentsChanged: () => void;
  onEvidenceChanged: () => void;
  onSurfacesChanged: () => void;
  onReportChange: (r: ReportVersion) => void;
}) {
  const [tab, setTab] = useState<TabKey>("subject");

  const byType = (t: SearchSurfaceItem["type"]) => surfaces.filter((s) => s.type === t);
  const suggestions = byType("SUGGESTION");
  const related = byType("RELATED_QUERY");
  const images = byType("IMAGE_RESULT");
  const videos = byType("VIDEO_RESULT");
  const knowledge = byType("KNOWLEDGE_BLOCK");

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "subject", label: "Subject" },
    { key: "agents", label: "Agents", count: agents.length },
    { key: "search", label: "Search Results", count: evidence.searchResults.length },
    { key: "suggestions", label: "Suggestions", count: suggestions.length },
    { key: "related", label: "Related Queries", count: related.length },
    { key: "images", label: "Images", count: images.length },
    { key: "videos", label: "Videos", count: videos.length },
    { key: "knowledge", label: "Knowledge Block", count: knowledge.length },
    { key: "screenshots", label: "Screenshots", count: evidence.screenshots.length },
    { key: "wikipedia", label: "Wikipedia", count: evidence.wikipediaChecks.length },
    { key: "ai", label: "AI Profile", count: evidence.aiProfiles.length },
    { key: "compliance", label: "Compliance Databases", count: evidence.databaseProfiles.length },
    { key: "risk", label: "Risk Findings", count: evidence.riskFindings.length },
    { key: "audit", label: "Audit Summary" },
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
      {tab === "suggestions" ? (
        <SurfacesTab type="SUGGESTION" label="Suggestions" items={suggestions} caseId={caseDetail.id} onChanged={onSurfacesChanged} />
      ) : null}
      {tab === "related" ? (
        <SurfacesTab type="RELATED_QUERY" label="Related Queries" items={related} caseId={caseDetail.id} onChanged={onSurfacesChanged} />
      ) : null}
      {tab === "images" ? (
        <SurfacesTab type="IMAGE_RESULT" label="Images" items={images} caseId={caseDetail.id} onChanged={onSurfacesChanged} />
      ) : null}
      {tab === "videos" ? (
        <SurfacesTab type="VIDEO_RESULT" label="Videos" items={videos} caseId={caseDetail.id} onChanged={onSurfacesChanged} />
      ) : null}
      {tab === "knowledge" ? (
        <SurfacesTab type="KNOWLEDGE_BLOCK" label="Knowledge Block" items={knowledge} caseId={caseDetail.id} onChanged={onSurfacesChanged} />
      ) : null}
      {tab === "screenshots" ? <ScreenshotsTab evidence={evidence} /> : null}
      {tab === "wikipedia" ? <WikipediaTab evidence={evidence} /> : null}
      {tab === "ai" ? <AiProfileTab evidence={evidence} /> : null}
      {tab === "compliance" ? <ComplianceTab evidence={evidence} /> : null}
      {tab === "risk" ? (
        <RiskFindingsTab caseId={caseDetail.id} evidence={evidence} onChanged={onEvidenceChanged} />
      ) : null}

      {tab === "audit" ? <AuditSummaryTab caseId={caseDetail.id} /> : null}
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
  const [sourceFilter, setSourceFilter] = useState<"ALL" | "MOCK" | "REAL" | "MANUAL">("ALL");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function sourceKind(src: string | null): "MOCK" | "REAL" | "MANUAL" {
    if ((src ?? "").startsWith("real")) return "REAL";
    if ((src ?? "").startsWith("mock")) return "MOCK";
    return "MANUAL";
  }
  const visibleResults = evidence.searchResults.filter(
    (r) => sourceFilter === "ALL" || sourceKind(r.source) === sourceFilter
  );

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

      <div className="dp-inline" style={{ marginBottom: 10 }}>
        <label className="dp-muted" style={{ fontSize: 13 }}>
          Source
        </label>
        <select
          className="dp-select"
          style={{ maxWidth: 160 }}
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as "ALL" | "MOCK" | "REAL" | "MANUAL")}
        >
          {["ALL", "MOCK", "REAL", "MANUAL"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <span className="dp-muted" style={{ fontSize: 12 }}>
          {visibleResults.length} of {evidence.searchResults.length}
        </span>
      </div>

      {visibleResults.length === 0 ? (
        <EmptyState title="No search results" hint="Add results manually above or adjust the source filter." />
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>Engine</th>
              <th>Source</th>
              <th>Title</th>
              <th>Domain</th>
              <th>Classification</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {visibleResults.map((r) => {
              const isReal = (r.source ?? "").startsWith("real");
              return (
              <tr key={r.id}>
                <td>{r.engine}</td>
                <td>
                  <Badge tone={isReal ? "ok" : "neutral"}>{isReal ? "REAL" : "MOCK"}</Badge>
                </td>
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
              );
            })}
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
      <Notice>
        Automatic SERP screenshots are not enabled. Upload/import screenshots manually or use
        synthetic snapshots (generated from API results, not live SERP captures).
      </Notice>
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

const RISK_LEVELS = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
const RISK_RANK: Record<string, number> = { INFO: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

function RiskFindingsTab({
  caseId,
  evidence,
  onChanged,
}: {
  caseId: string;
  evidence: CaseEvidence;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [classifying, setClassifying] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [levelFilter, setLevelFilter] = useState("ALL");
  const [themeFilter, setThemeFilter] = useState("ALL");

  const findings = evidence.riskFindings;
  const counts = {
    total: findings.length,
    pending: findings.filter((f) => f.reviewStatus === "PENDING").length,
    reviewed: findings.filter((f) => f.reviewStatus === "REVIEWED").length,
    dismissed: findings.filter((f) => f.reviewStatus === "DISMISSED").length,
  };
  const highest =
    findings.reduce((acc, f) => Math.max(acc, RISK_RANK[f.severity] ?? 0), 0) || 0;
  const highestLabel = RISK_LEVELS[highest] ?? "NONE";
  const themes = Array.from(new Set(findings.map((f) => f.riskTheme ?? f.category))).sort();

  const visible = findings.filter(
    (f) =>
      (statusFilter === "ALL" || f.reviewStatus === statusFilter) &&
      (levelFilter === "ALL" || f.severity === levelFilter) &&
      (themeFilter === "ALL" || (f.riskTheme ?? f.category) === themeFilter)
  );

  async function classify() {
    if (classifying) return;
    setClassifying(true);
    setError(null);
    setInfo(null);
    try {
      const s = await classifyRisks(caseId);
      setInfo(
        `Classified: ${s.findingsCreated} created, ${s.findingsUpdated} updated, ${s.findingsSkippedReviewed} kept (reviewed), ${s.findingsDismissedIgnored} ignored (dismissed). Highest: ${s.highestRiskLevel}.`
      );
      onChanged();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "INTERNAL_ERROR";
      const msg = err instanceof Error ? err.message : "Failed to classify risks";
      setError(errorMessage(code, msg));
    } finally {
      setClassifying(false);
    }
  }

  async function rebuildSummary() {
    if (rebuilding) return;
    setRebuilding(true);
    setError(null);
    setInfo(null);
    try {
      const res = await buildAuditSummary(caseId);
      setInfo(
        `Audit summary rebuilt — dismissed findings excluded from top findings. Overall risk: ${res.auditSummary.overallRiskLevel}.`
      );
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "INTERNAL_ERROR";
      const msg = err instanceof Error ? err.message : "Failed to rebuild audit summary";
      setError(errorMessage(code, msg));
    } finally {
      setRebuilding(false);
    }
  }

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
      <div className="dp-inline" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2 className="dp-h2" style={{ margin: 0 }}>
          Risk findings
        </h2>
        <div className="dp-inline">
          <button className="dp-btn dp-btn-sm" disabled={rebuilding} onClick={rebuildSummary}>
            {rebuilding ? "Rebuilding…" : "Rebuild audit summary after review"}
          </button>
          <button className="dp-btn dp-btn-primary dp-btn-sm" disabled={classifying} onClick={classify}>
            {classifying ? "Classifying…" : "Classify risks"}
          </button>
        </div>
      </div>

      <div className="dp-grid-cards" style={{ margin: "12px 0" }}>
        <div className="dp-card" style={{ padding: 12 }}>
          <div className="dp-muted">Total</div>
          <div style={{ fontSize: 22 }}>{counts.total}</div>
        </div>
        <div className="dp-card" style={{ padding: 12 }}>
          <div className="dp-muted">Pending</div>
          <div style={{ fontSize: 22 }}>{counts.pending}</div>
        </div>
        <div className="dp-card" style={{ padding: 12 }}>
          <div className="dp-muted">Reviewed</div>
          <div style={{ fontSize: 22 }}>{counts.reviewed}</div>
        </div>
        <div className="dp-card" style={{ padding: 12 }}>
          <div className="dp-muted">Dismissed</div>
          <div style={{ fontSize: 22 }}>{counts.dismissed}</div>
        </div>
        <div className="dp-card" style={{ padding: 12 }}>
          <div className="dp-muted">Highest risk</div>
          <div style={{ marginTop: 4 }}>
            <RiskBadge severity={highestLabel} />
          </div>
        </div>
      </div>

      {info ? (
        <div style={{ marginBottom: 12 }}>
          <SuccessBox>{info}</SuccessBox>
        </div>
      ) : null}
      {error ? (
        <div style={{ marginBottom: 12 }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}

      <div className="dp-inline" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <select className="dp-select" style={{ maxWidth: 160 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          {["ALL", "PENDING", "REVIEWED", "DISMISSED"].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <select className="dp-select" style={{ maxWidth: 160 }} value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
          {["ALL", ...RISK_LEVELS].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <select className="dp-select" style={{ maxWidth: 200 }} value={themeFilter} onChange={(e) => setThemeFilter(e.target.value)}>
          {["ALL", ...themes].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </select>
        <span className="dp-muted" style={{ fontSize: 12 }}>
          {visible.length} of {findings.length}
        </span>
      </div>

      {findings.length === 0 ? (
        <EmptyState
          title="No risk findings"
          hint="Click “Classify risks” to derive evidence-first findings, or add manual findings via the API. All findings require human review before the report."
        />
      ) : visible.length === 0 ? (
        <EmptyState title="No findings match the filters" hint="Adjust the filters above." />
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Theme</th>
              <th>Finding</th>
              <th>Conf.</th>
              <th>Evidence</th>
              <th>Review</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((f) => (
              <tr key={f.id}>
                <td>
                  <RiskBadge severity={f.severity} />
                  {f.demo ? (
                    <div style={{ marginTop: 4 }}>
                      <Badge tone="neutral">demo</Badge>
                    </div>
                  ) : null}
                </td>
                <td>{f.riskTheme ?? f.category}</td>
                <td>
                  <div>{f.title}</div>
                  {f.summary ? <div className="dp-muted">{f.summary}</div> : null}
                  {f.rationale ? (
                    <div className="dp-muted" style={{ fontSize: 11, marginTop: 2 }}>
                      Why: {f.rationale}
                    </div>
                  ) : null}
                  {f.evidenceRefs.length > 0 ? (
                    <div className="dp-muted" style={{ fontSize: 11, marginTop: 4 }}>
                      {f.evidenceRefs.slice(0, 3).map((e, i) => (
                        <div key={i}>
                          {e.provider ? `[${e.provider}] ` : ""}
                          {e.url ? (
                            <a href={e.url} target="_blank" rel="noopener noreferrer">
                              {e.title ?? e.label ?? e.url}
                            </a>
                          ) : (
                            e.title ?? e.label ?? e.type ?? "evidence"
                          )}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </td>
                <td className="dp-muted">{f.confidence != null ? f.confidence.toFixed(2) : "—"}</td>
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
