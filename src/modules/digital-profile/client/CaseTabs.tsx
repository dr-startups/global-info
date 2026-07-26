"use client";

import { useState } from "react";
import {
  addSearchResult,
  buildAuditSummary,
  classifyRisks,
  classifySearchResults,
  clearManualResultClassification,
  setManualResultClassification,
  DigitalProfileApiError,
  reviewFinding,
  type AgentInfo,
  type AgentRun,
  type AiProfile,
  type CaseDetail,
  type CaseEvidence,
  type FullAuditRunSummaryItem,
  type ManualResultClass,
  type ResultRiskThemeKey,
  type SearchResult,
  type SearchSurfaceItem,
  type UnifiedCollectionJobStatus,
} from "./api";
import {
  Badge,
  EmptyState,
  ErrorBox,
  Notice,
  RiskBadge,
  StatusBadge,
  SuccessBox,
} from "./components";
import { ReportPreviewPanel } from "./ReportPreviewPanel";
import { AgentsTab } from "./AgentsTab";
import { ComplianceTab } from "./ComplianceTab";
import { SurfacesTab } from "./SurfacesTab";
import { SerpSnapshotTab } from "./SerpSnapshotTab";
import { AuditSummaryTab } from "./AuditSummaryTab";
import { EvidenceQualityTab } from "./EvidenceQualityTab";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";

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
  | "serpSnapshot"
  | "wikipedia"
  | "ai"
  | "compliance"
  | "risk"
  | "evidenceQuality"
  | "audit"
  | "report";

export function CaseTabs({
  caseDetail,
  evidence,
  surfaces,
  agents,
  agentRuns,
  auditing,
  unifiedJob = null,
  fullAuditBlocked = false,
  lastFullAuditSummary,
  manualAgentRun = false,
  onRunFullAudit,
  onAgentsChanged,
  onEvidenceChanged,
  onSurfacesChanged,
}: {
  caseDetail: CaseDetail;
  evidence: CaseEvidence;
  surfaces: SearchSurfaceItem[];
  agents: AgentInfo[];
  agentRuns: AgentRun[];
  auditing: boolean;
  /** Текущий unified-прогон: его артефакты и есть отчёт, который видит клиент. */
  unifiedJob?: UnifiedCollectionJobStatus | null;
  fullAuditBlocked?: boolean;
  lastFullAuditSummary: {
    mode: "legacy_mock_first" | "real_first_with_fallback" | "real_only" | "mock_only";
    items: FullAuditRunSummaryItem[];
  } | null;
  /** Режим отладки: ручной запуск отдельного агента (шаг 11.2, пункт 2). */
  manualAgentRun?: boolean;
  onRunFullAudit: () => void;
  onAgentsChanged: () => void;
  onEvidenceChanged: () => void;
  onSurfacesChanged: () => void;
}) {
  const { t } = useDigitalProfileI18n();
  const { can } = useDpAuth();
  // Raw evidence + agent/debug internals require the staff "view raw" permission;
  // CLIENT_VIEWER only ever sees the subject overview and the report.
  const canViewRaw = can("evidence.viewRaw");
  const [tab, setTab] = useState<TabKey>("subject");

  const surfaceList = surfaces ?? [];
  const byType = (ty: SearchSurfaceItem["type"]) => surfaceList.filter((s) => s.type === ty);
  const suggestions = byType("SUGGESTION");
  const related = byType("RELATED_QUERY");
  const images = byType("IMAGE_RESULT");
  const videos = byType("VIDEO_RESULT");
  const knowledge = byType("KNOWLEDGE_BLOCK");
  const searchResults = evidence.searchResults ?? [];
  const screenshots = evidence.screenshots ?? [];
  const wikipediaChecks = evidence.wikipediaChecks ?? [];
  const aiProfiles = evidence.aiProfiles ?? [];
  const databaseProfiles = evidence.databaseProfiles ?? [];
  const riskFindings = evidence.riskFindings ?? [];

  const allTabs: { key: TabKey; label: string; count?: number; raw?: boolean }[] = [
    { key: "subject", label: t("tabs.subject") },
    { key: "agents", label: t("tabs.agents"), count: (agents ?? []).length, raw: true },
    { key: "search", label: t("tabs.searchResults"), count: searchResults.length, raw: true },
    { key: "suggestions", label: t("tabs.suggestions"), count: suggestions.length, raw: true },
    { key: "related", label: t("tabs.relatedQueries"), count: related.length, raw: true },
    { key: "images", label: t("tabs.images"), count: images.length, raw: true },
    { key: "videos", label: t("tabs.videos"), count: videos.length, raw: true },
    { key: "knowledge", label: t("tabs.knowledgeBlock"), count: knowledge.length, raw: true },
    { key: "screenshots", label: t("tabs.screenshots"), count: screenshots.length, raw: true },
    { key: "serpSnapshot", label: t("tabs.serpSnapshot"), raw: true },
    { key: "wikipedia", label: t("tabs.wikipedia"), count: wikipediaChecks.length, raw: true },
    { key: "ai", label: t("tabs.aiProfile"), count: aiProfiles.length, raw: true },
    { key: "compliance", label: t("tabs.complianceDatabases"), count: databaseProfiles.length, raw: true },
    { key: "risk", label: t("tabs.riskFindings"), count: riskFindings.length, raw: true },
    { key: "evidenceQuality", label: t("tabs.evidenceQuality"), raw: true },
    { key: "audit", label: t("tabs.auditSummary"), raw: true },
    { key: "report", label: t("tabs.reportPreview") },
  ];
  const tabs = allTabs.filter((tb) => canViewRaw || !tb.raw);

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
          fullAuditBlocked={fullAuditBlocked}
          lastFullAuditSummary={lastFullAuditSummary}
          onRunFullAudit={onRunFullAudit}
          showUnifiedCta={false}
          manualAgentRun={manualAgentRun}
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
        <SurfacesTab type="SUGGESTION" label={t("tabs.suggestions")} items={suggestions} caseId={caseDetail.id} onChanged={onSurfacesChanged} />
      ) : null}
      {tab === "related" ? (
        <SurfacesTab type="RELATED_QUERY" label={t("tabs.relatedQueries")} items={related} caseId={caseDetail.id} onChanged={onSurfacesChanged} />
      ) : null}
      {tab === "images" ? (
        <SurfacesTab type="IMAGE_RESULT" label={t("tabs.images")} items={images} caseId={caseDetail.id} onChanged={onSurfacesChanged} />
      ) : null}
      {tab === "videos" ? (
        <SurfacesTab type="VIDEO_RESULT" label={t("tabs.videos")} items={videos} caseId={caseDetail.id} onChanged={onSurfacesChanged} />
      ) : null}
      {tab === "knowledge" ? (
        <SurfacesTab type="KNOWLEDGE_BLOCK" label={t("tabs.knowledgeBlock")} items={knowledge} caseId={caseDetail.id} onChanged={onSurfacesChanged} />
      ) : null}
      {tab === "screenshots" ? <ScreenshotsTab evidence={evidence} /> : null}
      {tab === "serpSnapshot" ? (
        <SerpSnapshotTab caseId={caseDetail.id} subjectName={caseDetail.subject?.fullName ?? ""} />
      ) : null}
      {tab === "wikipedia" ? <WikipediaTab evidence={evidence} /> : null}
      {tab === "ai" ? <AiProfileTab evidence={evidence} /> : null}
      {tab === "compliance" ? (
        <ComplianceTab caseId={caseDetail.id} evidence={evidence} onChanged={onEvidenceChanged} />
      ) : null}
      {tab === "risk" ? (
        <RiskFindingsTab caseId={caseDetail.id} evidence={evidence} onChanged={onEvidenceChanged} />
      ) : null}
      {tab === "evidenceQuality" ? (
        <EvidenceQualityTab caseId={caseDetail.id} onChanged={onSurfacesChanged} />
      ) : null}

      {tab === "audit" ? <AuditSummaryTab caseId={caseDetail.id} /> : null}
      {tab === "report" ? (
        <ReportPreviewPanel caseId={caseDetail.id} unifiedJob={unifiedJob} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subject
// ---------------------------------------------------------------------------

function SubjectTab({ caseDetail }: { caseDetail: CaseDetail }) {
  const { t, fmtDate } = useDigitalProfileI18n();
  const s = caseDetail.subject;
  return (
    <div>
      <h2 className="dp-h2">{t("subject.title")}</h2>
      <dl className="dp-kv">
        <dt>{t("subject.fullName")}</dt>
        <dd>{s?.fullName ?? "—"}</dd>
        <dt>{t("subject.aliases")}</dt>
        <dd>{s?.aliases?.length ? s.aliases.join(", ") : "—"}</dd>
        <dt>{t("subject.birthDate")}</dt>
        <dd>{s?.dateOfBirth ? fmtDate(s.dateOfBirth) : "—"}</dd>
        <dt>{t("subject.targetRegions")}</dt>
        <dd>
          {(caseDetail.targetRegions ?? []).length
            ? (caseDetail.targetRegions ?? []).join(", ")
            : "—"}
        </dd>
        <dt>{t("subject.lawfulBasis")}</dt>
        <dd>{caseDetail.lawfulBasis ? caseDetail.lawfulBasis.replace(/_/g, " ") : "—"}</dd>
        <dt>{t("subject.consentStatus")}</dt>
        <dd>
          <StatusBadge status={caseDetail.consentStatus} />
        </dd>
        <dt>{t("subject.notes")}</dt>
        <dd>{caseDetail.notes ?? "—"}</dd>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search results (+ minimal add form)
// ---------------------------------------------------------------------------

const ENGINES = ["GOOGLE", "YANDEX", "BING", "OTHER"];
// Stage N1.3 — richer classes that imply a risk highlight in the UI badge.
const RISKY_CLASS_SET = new Set([
  "ADVERSE_MEDIA",
  "SANCTIONS",
  "PEP",
  "CRIMINAL",
  "LEGAL_DISPUTE",
  "HIGH_RISK",
]);
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
  const { t, tError, tSource } = useDigitalProfileI18n();
  const { can } = useDpAuth();
  const [engine, setEngine] = useState("GOOGLE");
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [classification, setClassification] = useState("UNCLASSIFIED");
  const [sourceFilter, setSourceFilter] = useState<"ALL" | "MOCK" | "REAL" | "MANUAL">("ALL");
  const [busy, setBusy] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const RESULT_THEMES: ResultRiskThemeKey[] = [
    "adverse_media",
    "sanctions",
    "criminal",
    "legal_dispute",
    "pep",
    "political_exposure",
    "reputation",
    "business_conflict",
    "other",
  ];

  async function classify() {
    if (classifying) return;
    setClassifying(true);
    setError(null);
    setInfo(null);
    try {
      const s = await classifySearchResults(caseId);
      setInfo(
        t("search.classifyResult", {
          classified: s.classified,
          scanned: s.totalScanned,
          risky: s.risky,
          created: s.findingsCreated,
          updated: s.findingsUpdated,
        })
      );
      onChanged();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
    } finally {
      setClassifying(false);
    }
  }

  async function markResult(r: SearchResult, classification: ManualResultClass) {
    if (actingId) return;
    setActingId(r.id);
    setError(null);
    try {
      if (classification === "ADVERSE_MEDIA") {
        const theme = window.prompt(t("search.assignTheme"), "adverse_media");
        await setManualResultClassification(r.id, {
          classification,
          riskTheme: (theme?.trim() || undefined) as ResultRiskThemeKey | undefined,
        });
      } else {
        await setManualResultClassification(r.id, { classification });
      }
      onChanged();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      setError(tError(code, err instanceof Error ? err.message : undefined));
    } finally {
      setActingId(null);
    }
  }

  async function assignTheme(r: SearchResult) {
    if (actingId) return;
    const theme = window.prompt(`${t("search.assignTheme")} (${RESULT_THEMES.join(", ")})`, r.riskClassification?.effective.riskTheme ?? "adverse_media");
    if (!theme || !theme.trim()) return;
    setActingId(r.id);
    setError(null);
    try {
      await setManualResultClassification(r.id, {
        classification: "ADVERSE_MEDIA",
        riskTheme: theme.trim() as ResultRiskThemeKey,
      });
      onChanged();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      setError(tError(code, err instanceof Error ? err.message : undefined));
    } finally {
      setActingId(null);
    }
  }

  async function clearManual(r: SearchResult) {
    if (actingId) return;
    setActingId(r.id);
    setError(null);
    try {
      await clearManualResultClassification(r.id);
      onChanged();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      setError(tError(code, err instanceof Error ? err.message : undefined));
    } finally {
      setActingId(null);
    }
  }

  function sourceKind(src: string | null): "MOCK" | "REAL" | "MANUAL" {
    if ((src ?? "").startsWith("real")) return "REAL";
    if ((src ?? "").startsWith("mock")) return "MOCK";
    return "MANUAL";
  }
  const allResults = evidence.searchResults ?? [];
  const visibleResults = allResults.filter(
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
      setInfo(res.deduplicated ? t("search.duplicate") : t("search.added"));
      setUrl("");
      setTitle("");
      onChanged();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="dp-inline" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2 className="dp-h2" style={{ margin: 0 }}>{t("search.title")}</h2>
        {can("risk.classify") ? (
          <button className="dp-btn dp-btn-primary dp-btn-sm" disabled={classifying} onClick={classify}>
            {classifying ? t("search.classifying") : t("search.classifyResults")}
          </button>
        ) : null}
      </div>
      <Notice>{t("search.classifyNote")}</Notice>

      {can("evidence.create") ? (
      <form onSubmit={add} style={{ marginBottom: 18, marginTop: 14 }}>
        <div className="dp-form-grid">
          <div className="dp-field">
            <label>{t("search.engine")}</label>
            <select className="dp-select" value={engine} onChange={(e) => setEngine(e.target.value)}>
              {ENGINES.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </div>
          <div className="dp-field">
            <label>{t("search.classification")}</label>
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
            <label>{t("search.url")}</label>
            <input
              className="dp-input"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/page"
            />
          </div>
          <div className="dp-field dp-field-full">
            <label>{t("search.titleField")}</label>
            <input className="dp-input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </div>
        <div className="dp-inline" style={{ marginTop: 12 }}>
          <button className="dp-btn dp-btn-primary dp-btn-sm" disabled={busy || !url.trim()}>
            {busy ? t("common.adding") : t("search.addResult")}
          </button>
          {info ? <span className="dp-muted">{info}</span> : null}
        </div>
        {error ? (
          <div style={{ marginTop: 10 }}>
            <ErrorBox>{error}</ErrorBox>
          </div>
        ) : null}
      </form>
      ) : null}

      <div className="dp-inline" style={{ marginBottom: 10 }}>
        <label className="dp-muted" style={{ fontSize: 13 }}>
          {t("common.source")}
        </label>
        <select
          className="dp-select"
          style={{ maxWidth: 160 }}
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as "ALL" | "MOCK" | "REAL" | "MANUAL")}
        >
          {["ALL", "MOCK", "REAL", "MANUAL"].map((v) => (
            <option key={v} value={v}>
              {tSource(v)}
            </option>
          ))}
        </select>
        <span className="dp-muted" style={{ fontSize: 12 }}>
          {visibleResults.length} {t("common.of")} {allResults.length}
        </span>
      </div>

      {visibleResults.length === 0 ? (
        <EmptyState title={t("search.emptyTitle")} hint={t("search.emptyHint")} />
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>{t("search.engine")}</th>
              <th>{t("common.source")}</th>
              <th>{t("search.titleField")}</th>
              <th>{t("search.domain")}</th>
              <th>{t("search.riskCol")}</th>
              <th>{t("search.themeCol")}</th>
              {can("evidence.create") ? <th>{t("search.actions")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {visibleResults.map((r) => {
              const isReal = (r.source ?? "").startsWith("real");
              const rc = r.riskClassification;
              const eff = rc?.effective;
              const cls = eff?.classification ?? r.classification;
              const risky = !!eff && eff.source !== "none" && RISKY_CLASS_SET.has(eff.classification);
              const acting = actingId === r.id;
              return (
              <tr key={r.id}>
                <td>{r.engine}</td>
                <td>
                  <Badge tone={isReal ? "ok" : "neutral"}>{isReal ? tSource("REAL") : tSource("MOCK")}</Badge>
                </td>
                <td>
                  <a href={r.url} target="_blank" rel="noopener noreferrer">
                    {r.title ?? r.url}
                  </a>
                </td>
                <td className="dp-muted">{domainOf(r.url)}</td>
                <td>
                  <Badge tone={risky ? "danger" : "neutral"}>{cls}</Badge>
                  {eff?.confidence ? (
                    <span className="dp-muted" style={{ fontSize: 11, marginLeft: 6 }}>{eff.confidence}</span>
                  ) : null}
                  {eff?.manualOverride ? (
                    <span style={{ marginLeft: 6 }}>
                      <Badge tone="info">{t("search.manualMarker")}</Badge>
                    </span>
                  ) : null}
                </td>
                <td className="dp-muted">{eff?.riskTheme ?? "—"}</td>
                {can("evidence.create") ? (
                  <td>
                    <div className="dp-inline" style={{ flexWrap: "wrap", gap: 4 }}>
                      <button className="dp-btn dp-btn-xs" disabled={acting} onClick={() => markResult(r, "ADVERSE_MEDIA")}>
                        {t("search.markAdverse")}
                      </button>
                      <button className="dp-btn dp-btn-xs" disabled={acting} onClick={() => markResult(r, "NEUTRAL")}>
                        {t("search.markNeutral")}
                      </button>
                      <button className="dp-btn dp-btn-xs" disabled={acting} onClick={() => assignTheme(r)}>
                        {t("search.assignTheme")}
                      </button>
                      {rc?.manual ? (
                        <button className="dp-btn dp-btn-xs" disabled={acting} onClick={() => clearManual(r)}>
                          {t("search.clearManual")}
                        </button>
                      ) : null}
                    </div>
                  </td>
                ) : null}
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
  const { t, fmtDate } = useDigitalProfileI18n();
  return (
    <div>
      <h2 className="dp-h2">{t("screenshots.title")}</h2>
      <Notice>{t("screenshots.notice")}</Notice>
      {(evidence.screenshots ?? []).length === 0 ? (
        <EmptyState title={t("screenshots.emptyTitle")} hint={t("screenshots.emptyHint")} />
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>{t("screenshots.sourceUrl")}</th>
              <th>{t("screenshots.type")}</th>
              <th>{t("screenshots.captured")}</th>
              <th>SHA-256</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(evidence.screenshots ?? []).map((s) => (
              <tr key={s.id}>
                <td>{s.sourceUrl ?? <span className="dp-muted">—</span>}</td>
                <td className="dp-muted">{s.mimeType}</td>
                <td className="dp-muted">{fmtDate(s.capturedAt)}</td>
                <td className="dp-mono">{s.sha256.slice(0, 12)}…</td>
                <td style={{ textAlign: "right" }}>
                  <a
                    className="dp-btn dp-btn-sm"
                    href={s.downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {t("screenshots.view")}
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
  const { t, fmtDate, tSource } = useDigitalProfileI18n();
  return (
    <div>
      <h2 className="dp-h2">{t("wikipedia.title")}</h2>
      {(evidence.wikipediaChecks ?? []).length === 0 ? (
        <EmptyState title={t("wikipedia.emptyTitle")} hint={t("wikipedia.emptyHint")} />
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>{t("wikipedia.exists")}</th>
              <th>{t("common.source")}</th>
              <th>{t("wikipedia.language")}</th>
              <th>{t("wikipedia.pageTitle")}</th>
              <th>{t("wikipedia.notability")}</th>
              <th>{t("search.url")}</th>
              <th>{t("wikipedia.checked")}</th>
            </tr>
          </thead>
          <tbody>
            {(evidence.wikipediaChecks ?? []).map((w) => {
              const isReal = (w.checkedBy ?? "").startsWith("real");
              return (
              <tr key={w.id}>
                <td>{w.exists ? <Badge tone="ok">{t("common.yes")}</Badge> : <Badge tone="neutral">{t("common.no")}</Badge>}</td>
                <td>
                  <Badge tone={isReal ? "ok" : "neutral"}>{isReal ? tSource("REAL") : tSource("MOCK")}</Badge>
                </td>
                <td>{w.language ?? "—"}</td>
                <td>{w.pageTitle ?? "—"}</td>
                <td>{notabilityOf(w.snapshot) ?? "—"}</td>
                <td>
                  {w.url ? (
                    <a href={w.url} target="_blank" rel="noopener noreferrer">
                      {t("wikipedia.open")}
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="dp-muted">{fmtDate(w.lastChecked)}</td>
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
  const { t, fmtDate } = useDigitalProfileI18n();
  return (
    <div>
      <h2 className="dp-h2">{t("ai.title")}</h2>
      {(evidence.aiProfiles ?? []).length === 0 ? (
        <EmptyState title={t("ai.emptyTitle")} hint={t("ai.emptyHint")} />
      ) : (
        <div className="dp-stack">
          {(evidence.aiProfiles ?? []).map((p: AiProfile) => {
            const cited = citedSourcesOf(p.classifications);
            return (
              <div key={p.id} className="dp-card" style={{ padding: 14 }}>
                <div className="dp-inline" style={{ justifyContent: "space-between" }}>
                  <Badge tone="info">{p.model}</Badge>
                  <span className="dp-muted">{fmtDate(p.createdAt)}</span>
                </div>
                <p style={{ marginTop: 10 }}>{p.summary ?? "—"}</p>
                <div className="dp-muted" style={{ marginTop: 8 }}>
                  {cited !== null ? `${t("ai.citedSources")}: ${cited} · ` : ""}
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
  const { t, tError, tRisk, tStatus, tSource } = useDigitalProfileI18n();
  const { can } = useDpAuth();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [classifying, setClassifying] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [levelFilter, setLevelFilter] = useState("ALL");
  const [themeFilter, setThemeFilter] = useState("ALL");

  const findings = evidence.riskFindings ?? [];
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
        t("risk.classifyResult", {
          created: s.findingsCreated,
          updated: s.findingsUpdated,
          kept: s.findingsSkippedReviewed,
          ignored: s.findingsDismissedIgnored,
          highest: tRisk(s.highestRiskLevel),
        })
      );
      onChanged();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
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
        t("risk.rebuildResult", { risk: tRisk(res.auditSummary.overallRiskLevel) })
      );
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
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
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div>
      <div className="dp-inline" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2 className="dp-h2" style={{ margin: 0 }}>
          {t("risk.title")}
        </h2>
        <div className="dp-inline">
          {can("report.generateInternal") ? (
            <button className="dp-btn dp-btn-sm" disabled={rebuilding} onClick={rebuildSummary}>
              {rebuilding ? t("risk.rebuilding") : t("risk.rebuildAfterReview")}
            </button>
          ) : null}
          {can("risk.classify") ? (
            <button className="dp-btn dp-btn-primary dp-btn-sm" disabled={classifying} onClick={classify}>
              {classifying ? t("risk.classifying") : t("risk.classifyRisks")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="dp-grid-cards" style={{ margin: "12px 0" }}>
        <div className="dp-card" style={{ padding: 12 }}>
          <div className="dp-muted">{t("risk.total")}</div>
          <div style={{ fontSize: 22 }}>{counts.total}</div>
        </div>
        <div className="dp-card" style={{ padding: 12 }}>
          <div className="dp-muted">{t("risk.pending")}</div>
          <div style={{ fontSize: 22 }}>{counts.pending}</div>
        </div>
        <div className="dp-card" style={{ padding: 12 }}>
          <div className="dp-muted">{t("risk.reviewed")}</div>
          <div style={{ fontSize: 22 }}>{counts.reviewed}</div>
        </div>
        <div className="dp-card" style={{ padding: 12 }}>
          <div className="dp-muted">{t("risk.dismissed")}</div>
          <div style={{ fontSize: 22 }}>{counts.dismissed}</div>
        </div>
        <div className="dp-card" style={{ padding: 12 }}>
          <div className="dp-muted">{t("risk.highestRisk")}</div>
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
            <option key={v} value={v}>{v === "ALL" ? tSource("ALL") : tStatus(v)}</option>
          ))}
        </select>
        <select className="dp-select" style={{ maxWidth: 160 }} value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
          {["ALL", ...RISK_LEVELS].map((v) => (
            <option key={v} value={v}>{v === "ALL" ? tSource("ALL") : tRisk(v)}</option>
          ))}
        </select>
        <select className="dp-select" style={{ maxWidth: 200 }} value={themeFilter} onChange={(e) => setThemeFilter(e.target.value)}>
          {["ALL", ...themes].map((v) => (
            <option key={v} value={v}>{v === "ALL" ? tSource("ALL") : v}</option>
          ))}
        </select>
        <span className="dp-muted" style={{ fontSize: 12 }}>
          {visible.length} {t("common.of")} {findings.length}
        </span>
      </div>

      {findings.length === 0 ? (
        <EmptyState title={t("risk.emptyTitle")} hint={t("risk.emptyHint")} />
      ) : visible.length === 0 ? (
        <EmptyState title={t("risk.noMatch")} hint={t("risk.noMatchHint")} />
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>{t("risk.severity")}</th>
              <th>{t("risk.theme")}</th>
              <th>{t("risk.finding")}</th>
              <th>{t("risk.confidence")}</th>
              <th>{t("risk.evidence")}</th>
              <th>{t("risk.reviewCol")}</th>
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
                      {t("risk.why")}: {f.rationale}
                    </div>
                  ) : null}
                  {(f.evidenceRefs ?? []).length > 0 ? (
                    <div className="dp-muted" style={{ fontSize: 11, marginTop: 4 }}>
                      {(f.evidenceRefs ?? []).slice(0, 3).map((e, i) => (
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
                <td>{(f.evidenceRefs ?? []).length}</td>
                <td>
                  <StatusBadge status={f.reviewStatus} />
                </td>
                <td style={{ textAlign: "right" }}>
                  {f.reviewStatus === "PENDING" && can("risk.review") ? (
                    <div className="dp-inline" style={{ justifyContent: "flex-end" }}>
                      <button
                        className="dp-btn dp-btn-sm"
                        disabled={busyId === f.id}
                        onClick={() => review(f.id, "REVIEWED")}
                      >
                        {t("risk.markReviewed")}
                      </button>
                      <button
                        className="dp-btn dp-btn-sm dp-btn-danger"
                        disabled={busyId === f.id}
                        onClick={() => review(f.id, "DISMISSED")}
                      >
                        {t("common.dismiss")}
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
