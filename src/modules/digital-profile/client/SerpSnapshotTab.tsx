"use client";

import { useEffect, useState } from "react";
import {
  generateSerpSnapshot,
  getSerpSnapshot,
  DigitalProfileApiError,
  type SerpSnapshot,
} from "./api";
import { Badge, EmptyState, ErrorBox, Notice, SuccessBox } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";

export function SerpSnapshotTab({
  caseId,
  subjectName,
}: {
  caseId: string;
  subjectName: string;
}) {
  const { t, fmtDate } = useDigitalProfileI18n();
  const { can } = useDpAuth();
  const canGenerate = can("evidence.create");

  const [snapshot, setSnapshot] = useState<SerpSnapshot | null>(null);
  const [query, setQuery] = useState(subjectName ?? "");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await getSerpSnapshot(caseId);
        if (!active) return;
        setSnapshot(res.snapshot);
        if (res.snapshot?.query) setQuery(res.snapshot.query);
      } catch {
        // Non-fatal: just show the empty state.
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [caseId]);

  async function generate() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const res = await generateSerpSnapshot(caseId, { query: query.trim() || undefined });
      setSnapshot(res.snapshot);
      setInfo(t("serpSnapshot.generated"));
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "INTERNAL_ERROR";
      const msg = err instanceof Error ? err.message : undefined;
      setError(`${code}${msg ? `: ${msg}` : ""}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="dp-h2">{t("serpSnapshot.title")}</h2>
      <Notice>{t("serpSnapshot.subtitle")}</Notice>

      {canGenerate ? (
        <div className="dp-form-grid" style={{ marginTop: 14, marginBottom: 12 }}>
          <div className="dp-field dp-field-full">
            <label>{t("serpSnapshot.queryLabel")}</label>
            <input
              className="dp-input"
              value={query}
              placeholder={t("serpSnapshot.queryPlaceholder")}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      ) : null}

      {canGenerate ? (
        <div className="dp-inline" style={{ marginBottom: 12 }}>
          <button className="dp-btn dp-btn-primary dp-btn-sm" disabled={busy} onClick={generate}>
            {busy
              ? t("serpSnapshot.generating")
              : snapshot
                ? t("serpSnapshot.regenerate")
                : t("serpSnapshot.generate")}
          </button>
        </div>
      ) : null}

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

      {loading ? (
        <p className="dp-muted">{t("common.loading")}</p>
      ) : snapshot ? (
        <div>
          {snapshot.sourceMode !== "MOCK_ONLY" ? (
            <div style={{ marginBottom: 12 }}>
              <Badge tone="ok">
                {t("serpSnapshot.realBadge")}
                {snapshot.sourceMode === "MIXED" ? ` (${t("serpSnapshot.mixedSources")})` : ""}
              </Badge>
            </div>
          ) : null}
          <div className="dp-grid-cards" style={{ marginBottom: 12 }}>
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("serpSnapshot.mode")}</div>
              <div style={{ fontSize: 18 }}>{snapshot.mode}</div>
            </div>
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("serpSnapshot.themeCount")}</div>
              <div style={{ fontSize: 18 }}>{snapshot.themeCount}</div>
            </div>
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("serpSnapshot.highlightedCount")}</div>
              <div style={{ fontSize: 18 }}>{snapshot.highlightedCount}</div>
            </div>
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("serpSnapshot.resultCount")}</div>
              <div style={{ fontSize: 18 }}>{snapshot.resultCount}</div>
            </div>
            <div className="dp-card" style={{ padding: 12 }}>
              <div className="dp-muted">{t("serpSnapshot.generatedAt")}</div>
              <div style={{ fontSize: 14 }}>{fmtDate(snapshot.generatedAt)}</div>
            </div>
          </div>

          <div className="dp-card" style={{ padding: 12 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={snapshot.signedUrl}
              alt="ORION-style SERP snapshot"
              style={{ width: "100%", height: "auto", borderRadius: 6, border: "1px solid #e5e7eb" }}
            />
          </div>

          <div className="dp-inline" style={{ marginTop: 10 }}>
            <a
              className="dp-btn dp-btn-sm"
              href={snapshot.signedUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("serpSnapshot.view")}
            </a>
            <a className="dp-btn dp-btn-sm" href={snapshot.signedUrl} download>
              {t("serpSnapshot.download")}
            </a>
          </div>

          <p className="dp-muted" style={{ marginTop: 10, fontSize: 12 }}>
            {t("serpSnapshot.syntheticNote")}
          </p>
        </div>
      ) : (
        <EmptyState title={t("serpSnapshot.emptyTitle")} hint={t("serpSnapshot.emptyHint")} />
      )}
    </div>
  );
}
