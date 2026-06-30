"use client";

import { useCallback, useEffect, useState } from "react";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";

interface ReviewItem {
  id?: string;
  title?: string;
  surfaceType?: string;
  contentClass?: string;
  selectionReason?: string;
  region?: string | null;
  quality?: {
    reportEligibility?: string;
    identityConfidence?: string;
    riskConfidence?: string;
    contentClass?: string;
    selectionReason?: string;
  };
}

interface QualityResponse {
  summary?: {
    totals?: {
      collected?: number;
      clientIncluded?: number;
      reviewRequired?: number;
      excluded?: number;
      duplicates?: number;
    };
  };
  reviewRequired?: ReviewItem[];
}

export function EvidenceQualityTab({
  caseId,
  onChanged,
}: {
  caseId: string;
  onChanged?: () => void;
}) {
  const { t } = useDigitalProfileI18n();
  const { can } = useDpAuth();
  const [data, setData] = useState<QualityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/digital-profile/cases/${caseId}/evidence-quality`);
      const json = (await res.json()) as { data?: QualityResponse; error?: string };
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setData(json.data ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setEligibility(surfaceId: string, reportEligibility: string) {
    await fetch(`/api/digital-profile/search-surfaces/${surfaceId}/quality`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reportEligibility }),
    });
    await load();
    onChanged?.();
  }

  if (loading) return <p className="dp-muted">{t("common.loading")}</p>;
  if (error) return <p className="dp-error">{error}</p>;

  const totals = data?.summary?.totals;
  const queue = data?.reviewRequired ?? [];

  return (
    <div>
      <div className="dp-grid dp-grid-4" style={{ marginBottom: "1rem" }}>
        <div className="dp-card">
          <div className="dp-muted">{t("evidenceQuality.collected")}</div>
          <strong>{totals?.collected ?? 0}</strong>
        </div>
        <div className="dp-card">
          <div className="dp-muted">{t("evidenceQuality.clientIncluded")}</div>
          <strong>{totals?.clientIncluded ?? 0}</strong>
        </div>
        <div className="dp-card">
          <div className="dp-muted">{t("evidenceQuality.reviewRequired")}</div>
          <strong>{totals?.reviewRequired ?? 0}</strong>
        </div>
        <div className="dp-card">
          <div className="dp-muted">{t("evidenceQuality.excluded")}</div>
          <strong>{totals?.excluded ?? 0}</strong>
        </div>
      </div>

      <h3>{t("evidenceQuality.reviewQueue")}</h3>
      {queue.length === 0 ? (
        <p className="dp-muted">{t("evidenceQuality.emptyQueue")}</p>
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>{t("evidenceQuality.titleCol")}</th>
              <th>{t("evidenceQuality.surfaceCol")}</th>
              <th>{t("evidenceQuality.classCol")}</th>
              <th>{t("evidenceQuality.reasonCol")}</th>
              {can("risk.review") ? <th>{t("evidenceQuality.actionsCol")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {queue.map((item, idx) => {
              const q = item.quality ?? item;
              const id = item.id;
              return (
                <tr key={id ?? idx}>
                  <td>{item.title ?? "—"}</td>
                  <td>{item.surfaceType ?? "—"}</td>
                  <td>{q.contentClass ?? "—"}</td>
                  <td>{q.selectionReason ?? item.selectionReason ?? "—"}</td>
                  {can("risk.review") && id ? (
                    <td className="dp-actions">
                      <button type="button" className="dp-btn dp-btn-sm" onClick={() => void setEligibility(id, "CLIENT_INCLUDE")}>
                        {t("evidenceQuality.includeClient")}
                      </button>
                      <button type="button" className="dp-btn dp-btn-sm" onClick={() => void setEligibility(id, "EXCLUDE")}>
                        {t("evidenceQuality.exclude")}
                      </button>
                    </td>
                  ) : can("risk.review") ? (
                    <td>—</td>
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
