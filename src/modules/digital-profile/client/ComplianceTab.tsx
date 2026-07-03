"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DigitalProfileApiError,
  importLexisNexisDocx,
  importManualComplianceHit,
  listProviders,
  reviewComplianceHit,
  runComplianceScreening,
  type CaseEvidence,
  type ComplianceHitReviewStatus,
  type ComplianceRiskType,
  type DatabaseProfile,
  type ProviderStatus,
} from "./api";
import { Badge, EmptyState, ErrorBox, Notice } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";

const COMPLIANCE_REAL = new Set(["DOW_JONES", "LEXISNEXIS", "WORLD_CHECK"]);
const RISK_TYPES: ComplianceRiskType[] = [
  "SANCTIONS",
  "PEP",
  "ADVERSE_MEDIA",
  "WATCHLIST",
  "LAW_ENFORCEMENT",
  "LEGAL",
  "INSOLVENCY",
  "POLITICAL_EXPOSURE",
  "OTHER",
];
const DB_PROVIDERS = ["DOW_JONES", "LEXISNEXIS", "WORLD_CHECK", "OTHER"] as const;

function reviewTone(status: string): "warn" | "ok" | "danger" | "info" | "neutral" {
  if (status === "MATCH_CONFIRMED") return "ok";
  if (status === "FALSE_POSITIVE" || status === "DISMISSED") return "neutral";
  if (status === "NEEDS_REVIEW") return "warn";
  return "warn";
}

export function ComplianceTab({
  caseId,
  evidence,
  onChanged,
}: {
  caseId: string;
  evidence: CaseEvidence;
  onChanged: () => void;
}) {
  const { t, tStatus, fmtDate } = useDigitalProfileI18n();
  const { can } = useDpAuth();
  const canEdit = can("evidence.create");

  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [lexisBusy, setLexisBusy] = useState(false);
  const [lexisStatus, setLexisStatus] = useState<string | null>(null);

  const [form, setForm] = useState({
    provider: "DOW_JONES" as (typeof DB_PROVIDERS)[number],
    matchedName: "",
    profileUrl: "",
    riskTypes: ["SANCTIONS"] as ComplianceRiskType[],
    summary: "",
    evidenceUrl: "",
  });

  const loadProviders = useCallback(async () => {
    try {
      const all = await listProviders();
      setProviders(
        all.filter(
          (p) =>
            COMPLIANCE_REAL.has(p.name) ||
            p.name === "MANUAL_IMPORT" ||
            p.label.toLowerCase().includes("compliance")
        )
      );
    } catch {
      /* optional */
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  async function handleScreen(provider: string) {
    setBusy(`screen-${provider}`);
    setError(null);
    try {
      const res = await runComplianceScreening(caseId, provider as "DOW_JONES" | "LEXISNEXIS" | "WORLD_CHECK");
      if (res.status === "SUCCESS" && res.hits.length > 0) {
        setInfo(t("compliance.screenSuccess", { count: String(res.hits.length) }));
      } else if (res.error) {
        setInfo(res.error.message);
      }
      onChanged();
    } catch (e) {
      setError(e instanceof DigitalProfileApiError ? e.message : t("errors.UNKNOWN"));
    } finally {
      setBusy(null);
    }
  }

  async function handleImport(e: React.FormEvent) {
    e.preventDefault();
    setBusy("import");
    setError(null);
    try {
      await importManualComplianceHit(caseId, {
        provider: form.provider,
        matchedName: form.matchedName.trim(),
        profileUrl: form.profileUrl.trim() || undefined,
        riskTypes: form.riskTypes,
        summary: form.summary.trim() || undefined,
        evidenceUrl: form.evidenceUrl.trim() || undefined,
      });
      setInfo(t("compliance.importSuccess"));
      setShowForm(false);
      setForm({ ...form, matchedName: "", profileUrl: "", summary: "", evidenceUrl: "" });
      onChanged();
    } catch (err) {
      setError(err instanceof DigitalProfileApiError ? err.message : t("errors.UNKNOWN"));
    } finally {
      setBusy(null);
    }
  }

  async function handleReview(hitId: string, reviewStatus: ComplianceHitReviewStatus) {
    setBusy(hitId);
    setError(null);
    try {
      await reviewComplianceHit(hitId, reviewStatus);
      onChanged();
    } catch (e) {
      setError(e instanceof DigitalProfileApiError ? e.message : t("errors.UNKNOWN"));
    } finally {
      setBusy(null);
    }
  }

  async function handleLexisUpload(file: File) {
    if (lexisBusy) return;
    setLexisBusy(true);
    setError(null);
    setLexisStatus(t("compliance.lexisUploaded"));
    try {
      setLexisStatus(t("compliance.lexisConverting"));
      const result = await importLexisNexisDocx(caseId, file);
      setLexisStatus(t("compliance.lexisParsing"));
      const finalLabel =
        result.document.status === "ready"
          ? t("compliance.lexisReady")
          : result.document.status === "conversion_warning" ||
              result.document.status === "parse_warning"
            ? t("compliance.lexisReviewRequired")
            : t("compliance.lexisError");
      setInfo(
        `${finalLabel} ${t("compliance.lexisCompactSummary", {
          pages: result.document.pageCount,
          signals: result.document.parsedAnalytics.signalCounts.totalSignals,
          review: result.document.parsedAnalytics.signalCounts.reviewRequired,
          parser: result.parserStatus,
          conversion: result.conversionStatus,
        })}`
      );
      setLexisStatus(finalLabel);
      onChanged();
    } catch (err) {
      setLexisStatus(t("compliance.lexisError"));
      setError(err instanceof DigitalProfileApiError ? err.message : t("errors.UNKNOWN"));
    } finally {
      setLexisBusy(false);
    }
  }

  const hits = evidence.databaseProfiles;
  const lexisImports = hits.filter((h) => {
    const safe = (h.rawMetadataSafe ?? {}) as Record<string, unknown>;
    const hybrid = (safe.lexisNexisHybrid ?? {}) as Record<string, unknown>;
    return String(hybrid.kind ?? "") === "lexisnexis_report";
  });

  return (
    <div>
      <h2 className="dp-h2">{t("compliance.title")}</h2>
      <Notice>{t("compliance.reviewWarning")}</Notice>

      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {info ? <Notice>{info}</Notice> : null}

      <div className="dp-card-grid" style={{ marginTop: "1rem", marginBottom: "1rem" }}>
        {providers.map((p) => (
          <div key={p.name} className="dp-card" style={{ padding: "0.75rem 1rem" }}>
            <strong>{p.label}</strong>
            <div style={{ marginTop: "0.35rem" }}>
              <Badge tone={p.status === "ENABLED" ? "ok" : p.status === "NOT_CONFIGURED" ? "warn" : "neutral"}>
                {tStatus(p.status)}
              </Badge>
            </div>
            {p.missingConfigKeys.length > 0 ? (
              <p className="dp-muted" style={{ fontSize: "0.85rem", marginTop: "0.35rem" }}>
                {p.missingConfigKeys.join(", ")}
              </p>
            ) : null}
            {COMPLIANCE_REAL.has(p.name) && canEdit ? (
              <button
                type="button"
                className="dp-btn dp-btn-secondary"
                style={{ marginTop: "0.5rem" }}
                disabled={busy !== null}
                onClick={() => void handleScreen(p.name)}
              >
                {busy === `screen-${p.name}` ? "…" : t("compliance.runScreening")}
              </button>
            ) : null}
          </div>
        ))}
      </div>

      {canEdit ? (
        <div style={{ marginBottom: "1rem" }}>
          <button type="button" className="dp-btn dp-btn-primary" onClick={() => setShowForm((v) => !v)}>
            {t("compliance.addManualHit")}
          </button>
          <label className="dp-btn" style={{ marginLeft: 8, cursor: "pointer" }}>
            {t("compliance.uploadLexisNexis")}
            <input
              type="file"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              style={{ display: "none" }}
              disabled={lexisBusy}
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                if (file) void handleLexisUpload(file);
                e.currentTarget.value = "";
              }}
            />
          </label>
          {lexisStatus ? (
            <span className="dp-muted" style={{ marginLeft: 8 }}>
              {lexisStatus}
            </span>
          ) : null}
        </div>
      ) : null}
      {lexisImports.length > 0 ? (
        <div className="dp-card" style={{ marginBottom: "1rem", padding: "0.75rem 1rem" }}>
          <strong>{t("compliance.lexisLastImportTitle")}</strong>
          {lexisImports.slice(0, 1).map((row) => {
            const safe = (row.rawMetadataSafe ?? {}) as Record<string, unknown>;
            const hybrid = (safe.lexisNexisHybrid ?? {}) as Record<string, unknown>;
            const parsed = (hybrid.parsedAnalytics ?? {}) as Record<string, unknown>;
            const counts = (parsed.signalCounts ?? {}) as Record<string, unknown>;
            return (
              <div key={row.id} className="dp-muted" style={{ marginTop: 6, fontSize: 13 }}>
                {t("compliance.lexisCompactSummary", {
                  pages: Number(hybrid.pageCount ?? 0),
                  signals: Number(counts.totalSignals ?? 0),
                  review: Number(counts.reviewRequired ?? 0),
                  parser: String(parsed.parserStatus ?? "unknown"),
                  conversion:
                    String(hybrid.status ?? "").includes("conversion") || Number(hybrid.pageCount ?? 0) === 0
                      ? "warning"
                      : "ready",
                })}
              </div>
            );
          })}
        </div>
      ) : null}

      {showForm && canEdit ? (
        <form className="dp-form dp-card" onSubmit={(e) => void handleImport(e)} style={{ marginBottom: "1.5rem" }}>
          <h3 className="dp-h3">{t("compliance.manualImportTitle")}</h3>
          <label>
            {t("compliance.provider")}
            <select
              value={form.provider}
              onChange={(e) => setForm({ ...form, provider: e.target.value as typeof form.provider })}
            >
              {DB_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("compliance.matchedName")}
            <input
              required
              value={form.matchedName}
              onChange={(e) => setForm({ ...form, matchedName: e.target.value })}
            />
          </label>
          <label>
            {t("compliance.profileUrl")}
            <input
              type="url"
              value={form.profileUrl}
              onChange={(e) => setForm({ ...form, profileUrl: e.target.value })}
            />
          </label>
          <label>
            {t("compliance.riskTypes")}
            <select
              multiple
              value={form.riskTypes}
              onChange={(e) =>
                setForm({
                  ...form,
                  riskTypes: Array.from(e.target.selectedOptions).map((o) => o.value as ComplianceRiskType),
                })
              }
            >
              {RISK_TYPES.map((rt) => (
                <option key={rt} value={rt}>
                  {rt}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("compliance.summary")}
            <textarea value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} rows={3} />
          </label>
          <label>
            {t("compliance.evidenceUrl")}
            <input
              type="url"
              value={form.evidenceUrl}
              onChange={(e) => setForm({ ...form, evidenceUrl: e.target.value })}
            />
          </label>
          <p className="dp-muted">{t("compliance.manualImportHint")}</p>
          <button type="submit" className="dp-btn dp-btn-primary" disabled={busy === "import"}>
            {busy === "import" ? "…" : t("compliance.saveHit")}
          </button>
        </form>
      ) : null}

      {hits.length === 0 ? (
        <EmptyState title={t("compliance.emptyTitle")} hint={t("compliance.emptyHint")} />
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>{t("compliance.provider")}</th>
              <th>{t("compliance.matchedName")}</th>
              <th>{t("compliance.riskTypes")}</th>
              <th>{t("compliance.score")}</th>
              <th>{t("compliance.confidence")}</th>
              <th>{t("compliance.reviewStatus")}</th>
              <th>{t("compliance.source")}</th>
              {canEdit ? <th>{t("searchResults.actions")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {hits.map((d: DatabaseProfile) => (
              <tr key={d.id}>
                <td>{d.provider.replace(/_/g, " ")}</td>
                <td>{d.matchedName ?? "—"}</td>
                <td>{(d.riskTypes ?? []).join(", ") || d.matchType || "—"}</td>
                <td>{d.matchScore ?? "—"}</td>
                <td>{d.confidence ?? "—"}</td>
                <td>
                  <Badge tone={reviewTone(d.reviewStatus ?? "PENDING")}>
                    {d.reviewStatus ?? "PENDING"}
                  </Badge>
                </td>
                <td>
                  <Badge tone="info">{d.hitSource === "MANUAL" ? t("compliance.sourceManual") : d.hitSource ?? d.importMethod}</Badge>
                </td>
                {canEdit ? (
                  <td className="dp-actions">
                    <button
                      type="button"
                      className="dp-btn dp-btn-secondary dp-btn-sm"
                      disabled={busy === d.id}
                      onClick={() => void handleReview(d.id, "MATCH_CONFIRMED")}
                    >
                      {t("compliance.confirmMatch")}
                    </button>
                    <button
                      type="button"
                      className="dp-btn dp-btn-secondary dp-btn-sm"
                      disabled={busy === d.id}
                      onClick={() => void handleReview(d.id, "FALSE_POSITIVE")}
                    >
                      {t("compliance.falsePositive")}
                    </button>
                    <button
                      type="button"
                      className="dp-btn dp-btn-secondary dp-btn-sm"
                      disabled={busy === d.id}
                      onClick={() => void handleReview(d.id, "NEEDS_REVIEW")}
                    >
                      {t("compliance.needsReview")}
                    </button>
                    <button
                      type="button"
                      className="dp-btn dp-btn-secondary dp-btn-sm"
                      disabled={busy === d.id}
                      onClick={() => void handleReview(d.id, "DISMISSED")}
                    >
                      {t("compliance.dismiss")}
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
