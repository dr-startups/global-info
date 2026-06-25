"use client";

import { useEffect, useState } from "react";
import {
  buildAuditSummary,
  getAuditSummary,
  DigitalProfileApiError,
  type AuditSummary,
} from "./api";
import { EmptyState, ErrorBox, RiskBadge, SuccessBox } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";

function Card({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="dp-card" style={{ padding: 12 }}>
      <div className="dp-muted">{label}</div>
      <div style={{ fontSize: 20, marginTop: 4 }}>{value}</div>
    </div>
  );
}

export function AuditSummaryTab({ caseId }: { caseId: string }) {
  const { t, tError, tRisk, fmtPercent, fmtDate } = useDigitalProfileI18n();
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
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
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
      setInfo(t("auditSummary.rebuiltMessage", { risk: tRisk(res.auditSummary.overallRiskLevel) }));
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
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
          {t("auditSummary.title")}
        </h2>
        <button className="dp-btn dp-btn-primary dp-btn-sm" disabled={building} onClick={build}>
          {building ? t("auditSummary.building") : t("auditSummary.build")}
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
        <p className="dp-muted">{t("common.loading")}</p>
      ) : !summary ? (
        <EmptyState title={t("auditSummary.emptyTitle")} hint={t("auditSummary.emptyHint")} />
      ) : (
        <div style={{ marginTop: 12 }}>
          <div className="dp-grid-cards">
            <Card label={t("auditSummary.overallRiskLevel")} value={<RiskBadge severity={summary.overallRiskLevel} />} />
            <Card label={t("auditSummary.tone")} value={summary.overallTone} />
            <Card label={t("auditSummary.evidenceItems")} value={summary.dataQualitySummary.evidenceCount} />
            <Card label={t("auditSummary.findingsActive")} value={summary.riskSummary.totalFindings} />
          </div>

          <h3 className="dp-h3" style={{ marginTop: 20 }}>{t("auditSummary.executiveSummary")}</h3>
          <ul>
            {summary.executiveSummary.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>

          <h3 className="dp-h3" style={{ marginTop: 16 }}>{t("auditSummary.searchProfile")}</h3>
          <div className="dp-grid-cards">
            <Card label={t("auditSummary.totalResults")} value={summary.searchSummary.totalResults} />
            <Card label={t("auditSummary.negativeShare")} value={fmtPercent(summary.searchSummary.negativeShare)} />
            <Card label={t("auditSummary.uniqueNegativeUrls")} value={summary.searchSummary.topNegativeUrls.length} />
          </div>
          {summary.searchSummary.negativeDomains.length > 0 ? (
            <p className="dp-muted" style={{ marginTop: 8 }}>
              {t("auditSummary.negativeDomains")}: {summary.searchSummary.negativeDomains.join(", ")}
            </p>
          ) : null}

          <h3 className="dp-h3" style={{ marginTop: 16 }}>{t("auditSummary.searchSurfaces")}</h3>
          <div className="dp-grid-cards">
            <Card
              label={t("auditSummary.suggestionsNegTotal")}
              value={`${summary.surfacesSummary.suggestions.negative}/${summary.surfacesSummary.suggestions.total}`}
            />
            <Card
              label={t("auditSummary.imagesNegTotal")}
              value={`${summary.surfacesSummary.images.negative}/${summary.surfacesSummary.images.total}`}
            />
            <Card
              label={t("auditSummary.videosNegTotal")}
              value={`${summary.surfacesSummary.videos.negative}/${summary.surfacesSummary.videos.total}`}
            />
            <Card label={t("auditSummary.syntheticSnapshots")} value={summary.surfacesSummary.syntheticSnapshots} />
          </div>

          <h3 className="dp-h3" style={{ marginTop: 16 }}>{t("auditSummary.regions")}</h3>
          <table className="dp-table">
            <thead>
              <tr>
                <th>{t("auditSummary.region")}</th>
                <th>{t("auditSummary.organicNegTotal")}</th>
                <th>{t("auditSummary.negativeShare")}</th>
                <th>{t("tabs.suggestions")}</th>
                <th>{t("tabs.images")}</th>
                <th>{t("tabs.videos")}</th>
                <th>{t("auditSummary.wikiBlock")}</th>
                <th>{t("auditSummary.risk")}</th>
              </tr>
            </thead>
            <tbody>
              {summary.regions.map((r) => (
                <tr key={r.region}>
                  <td>{r.region}</td>
                  <td>{`${r.organicNegative}/${r.organicTotal}`}</td>
                  <td>{fmtPercent(r.organicNegativeShare)}</td>
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

          <h3 className="dp-h3" style={{ marginTop: 16 }}>{t("tabs.wikipedia")}</h3>
          <p>{summary.wikipediaSummary.conclusion}</p>
          <p className="dp-muted">
            {t("auditSummary.exists")}: {summary.wikipediaSummary.exists ? t("common.yes") : t("common.no")} ·{" "}
            {t("auditSummary.notabilityScore")}: {summary.wikipediaSummary.notabilityScore}
            {summary.wikipediaSummary.pageUrl ? (
              <>
                {" "}·{" "}
                <a href={summary.wikipediaSummary.pageUrl} target="_blank" rel="noopener noreferrer">
                  {t("auditSummary.page")}
                </a>
              </>
            ) : null}
          </p>

          <h3 className="dp-h3" style={{ marginTop: 16 }}>{t("tabs.complianceDatabases")}</h3>
          <p>{summary.complianceDatabaseSummary.conclusion}</p>
          <p className="dp-muted">
            {t("auditSummary.providers")}: {summary.complianceDatabaseSummary.providersChecked.join(", ") || "—"} · PEP:{" "}
            {summary.complianceDatabaseSummary.pepMatches} · RCA:{" "}
            {summary.complianceDatabaseSummary.rcaMatches} · Sanctions:{" "}
            {summary.complianceDatabaseSummary.sanctionsMatches} · Active:{" "}
            {summary.complianceDatabaseSummary.activeMatches}
          </p>

          <h3 className="dp-h3" style={{ marginTop: 16 }}>{t("auditSummary.keyFindings")}</h3>
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

          <h3 className="dp-h3" style={{ marginTop: 16 }}>{t("auditSummary.recommendedActions")}</h3>
          <ul>
            {summary.recommendedActions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>

          {summary.dataQualitySummary.warnings.length > 0 ? (
            <>
              <h3 className="dp-h3" style={{ marginTop: 16 }}>{t("auditSummary.dataQuality")}</h3>
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
            {t("auditSummary.generatedNote", { date: fmtDate(summary.generatedAt) })}
          </p>
        </div>
      )}
    </div>
  );
}
