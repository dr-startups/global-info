"use client";

import { useEffect, useState } from "react";
import {
  buildAuditSummary,
  getAuditSummary,
  DigitalProfileApiError,
  type AuditSummary,
} from "./api";
import { EmptyState, ErrorBox, RiskBadge, SuccessBox, errorMessage } from "./components";

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function Card({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="dp-card" style={{ padding: 12 }}>
      <div className="dp-muted">{label}</div>
      <div style={{ fontSize: 20, marginTop: 4 }}>{value}</div>
    </div>
  );
}

export function AuditSummaryTab({ caseId }: { caseId: string }) {
  const [summary, setSummary] = useState<AuditSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await getAuditSummary(caseId);
      setSummary(res.auditSummary);
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "INTERNAL_ERROR";
      const msg = err instanceof Error ? err.message : "Failed to load audit summary";
      setError(errorMessage(code, msg));
    } finally {
      setLoading(false);
    }
  }

  async function build() {
    if (building) return;
    setBuilding(true);
    setError(null);
    setInfo(null);
    try {
      const res = await buildAuditSummary(caseId);
      setSummary(res.auditSummary);
      setInfo(`Audit summary rebuilt. Overall risk: ${res.auditSummary.overallRiskLevel}.`);
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "INTERNAL_ERROR";
      const msg = err instanceof Error ? err.message : "Failed to build audit summary";
      setError(errorMessage(code, msg));
    } finally {
      setBuilding(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseId]);

  return (
    <div>
      <div className="dp-inline" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h2 className="dp-h2" style={{ margin: 0 }}>
          Audit summary
        </h2>
        <button className="dp-btn dp-btn-primary dp-btn-sm" disabled={building} onClick={build}>
          {building ? "Building…" : "Build audit summary"}
        </button>
      </div>

      {info ? (
        <div style={{ margin: "12px 0" }}>
          <SuccessBox>{info}</SuccessBox>
        </div>
      ) : null}
      {error ? (
        <div style={{ margin: "12px 0" }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}

      {loading ? (
        <p className="dp-muted">Loading…</p>
      ) : !summary ? (
        <EmptyState title="No audit summary yet" hint="Click “Build audit summary” to generate it from collected evidence." />
      ) : (
        <div style={{ marginTop: 12 }}>
          <div className="dp-grid-cards">
            <Card label="Overall risk" value={<RiskBadge severity={summary.overallRiskLevel} />} />
            <Card label="Tone" value={summary.overallTone} />
            <Card label="Evidence items" value={summary.dataQualitySummary.evidenceCount} />
            <Card label="Findings (active)" value={summary.riskSummary.totalFindings} />
          </div>

          <h3 className="dp-h3" style={{ marginTop: 20 }}>Executive summary</h3>
          <ul>
            {summary.executiveSummary.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>

          <h3 className="dp-h3" style={{ marginTop: 16 }}>Search profile</h3>
          <div className="dp-grid-cards">
            <Card label="Total results" value={summary.searchSummary.totalResults} />
            <Card label="Negative share" value={pct(summary.searchSummary.negativeShare)} />
            <Card label="Unique negative URLs" value={summary.searchSummary.topNegativeUrls.length} />
          </div>
          {summary.searchSummary.negativeDomains.length > 0 ? (
            <p className="dp-muted" style={{ marginTop: 8 }}>
              Negative domains: {summary.searchSummary.negativeDomains.join(", ")}
            </p>
          ) : null}

          <h3 className="dp-h3" style={{ marginTop: 16 }}>Search surfaces</h3>
          <div className="dp-grid-cards">
            <Card
              label="Suggestions (neg/total)"
              value={`${summary.surfacesSummary.suggestions.negative}/${summary.surfacesSummary.suggestions.total}`}
            />
            <Card
              label="Images (neg/total)"
              value={`${summary.surfacesSummary.images.negative}/${summary.surfacesSummary.images.total}`}
            />
            <Card
              label="Videos (neg/total)"
              value={`${summary.surfacesSummary.videos.negative}/${summary.surfacesSummary.videos.total}`}
            />
            <Card label="Synthetic snapshots" value={summary.surfacesSummary.syntheticSnapshots} />
          </div>

          <h3 className="dp-h3" style={{ marginTop: 16 }}>Regions</h3>
          <table className="dp-table">
            <thead>
              <tr>
                <th>Region</th>
                <th>Organic (neg/total)</th>
                <th>Neg. share</th>
                <th>Suggestions</th>
                <th>Images</th>
                <th>Videos</th>
                <th>Wiki block</th>
                <th>Risk</th>
              </tr>
            </thead>
            <tbody>
              {summary.regions.map((r) => (
                <tr key={r.region}>
                  <td>{r.region}</td>
                  <td>{`${r.organicNegative}/${r.organicTotal}`}</td>
                  <td>{pct(r.organicNegativeShare)}</td>
                  <td>{`${r.suggestionsNegative}/${r.suggestionsTotal}`}</td>
                  <td>{`${r.imagesNegative}/${r.imagesTotal}`}</td>
                  <td>{`${r.videosNegative}/${r.videosTotal}`}</td>
                  <td>{r.knowledgeBlockStatus}</td>
                  <td>
                    <RiskBadge severity={r.regionRiskLevel} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 className="dp-h3" style={{ marginTop: 16 }}>Wikipedia</h3>
          <p>{summary.wikipediaSummary.conclusion}</p>
          <p className="dp-muted">
            Exists: {summary.wikipediaSummary.exists ? "Yes" : "No"} · Notability score:{" "}
            {summary.wikipediaSummary.notabilityScore}
            {summary.wikipediaSummary.pageUrl ? (
              <>
                {" "}·{" "}
                <a href={summary.wikipediaSummary.pageUrl} target="_blank" rel="noopener noreferrer">
                  page
                </a>
              </>
            ) : null}
          </p>

          <h3 className="dp-h3" style={{ marginTop: 16 }}>Compliance databases</h3>
          <p>{summary.complianceDatabaseSummary.conclusion}</p>
          <p className="dp-muted">
            Providers: {summary.complianceDatabaseSummary.providersChecked.join(", ") || "—"} · PEP:{" "}
            {summary.complianceDatabaseSummary.pepMatches} · RCA:{" "}
            {summary.complianceDatabaseSummary.rcaMatches} · Sanctions:{" "}
            {summary.complianceDatabaseSummary.sanctionsMatches} · Active:{" "}
            {summary.complianceDatabaseSummary.activeMatches}
          </p>

          <h3 className="dp-h3" style={{ marginTop: 16 }}>Key findings</h3>
          {summary.keyFindings.map((g) => (
            <div key={g.group} style={{ marginBottom: 8 }}>
              <strong>{g.title}</strong>
              <ul style={{ marginTop: 4 }}>
                {g.points.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          ))}

          <h3 className="dp-h3" style={{ marginTop: 16 }}>Recommended actions</h3>
          <ul>
            {summary.recommendedActions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>

          {summary.dataQualitySummary.warnings.length > 0 ? (
            <>
              <h3 className="dp-h3" style={{ marginTop: 16 }}>Data quality warnings</h3>
              <ul>
                {summary.dataQualitySummary.warnings.map((w, i) => (
                  <li key={i} className="dp-muted">
                    {w}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          <p className="dp-muted" style={{ marginTop: 16, fontSize: 11 }}>
            Generated {new Date(summary.generatedAt).toLocaleString()}. Deterministic, evidence-derived; all
            conclusions require manual review.
          </p>
        </div>
      )}
    </div>
  );
}
