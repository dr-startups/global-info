"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";

interface QualityItem {
  id?: string;
  title?: string;
  surfaceType?: string;
  region?: string | null;
  thumbnailUrl?: string | null;
  quality?: {
    reportEligibility?: string;
    identityConfidence?: string;
    identityDecision?: string;
    identityReason?: string;
    autocompleteClass?: string;
    riskConfidence?: string;
    contentClass?: string;
    selectionReason?: string;
    isSubjectEvidence?: boolean;
    thumbnailStatus?: string;
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
    identity?: Record<string, number>;
    autocompleteExposure?: Record<string, number>;
    imageEvidence?: Record<string, number>;
  };
  items?: QualityItem[];
  reviewRequired?: QualityItem[];
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
  const [identityFilter, setIdentityFilter] = useState("");
  const [autocompleteFilter, setAutocompleteFilter] = useState("");
  const [thumbnailFilter, setThumbnailFilter] = useState("");
  const [showNamesakes, setShowNamesakes] = useState(false);

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

  const filteredItems = useMemo(() => {
    const rows = data?.items ?? [];
    return rows.filter((item) => {
      const q = item.quality ?? {};
      if (identityFilter && q.identityDecision !== identityFilter) return false;
      if (autocompleteFilter && q.autocompleteClass !== autocompleteFilter) return false;
      if (thumbnailFilter && q.thumbnailStatus !== thumbnailFilter) return false;
      if (!showNamesakes && q.identityDecision === "NAMESAKE") return false;
      return true;
    });
  }, [data?.items, identityFilter, autocompleteFilter, thumbnailFilter, showNamesakes]);

  if (loading) return <p className="dp-muted">{t("common.loading")}</p>;
  if (error) return <p className="dp-error">{error}</p>;

  const totals = data?.summary?.totals;
  const identity = data?.summary?.identity;
  const autocomplete = data?.summary?.autocompleteExposure;
  const images = data?.summary?.imageEvidence;

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

      {identity ? (
        <p className="dp-muted" style={{ marginBottom: "0.75rem" }}>
          {t("evidenceQuality.identityMetrics")}: exact {identity.exactSubject ?? 0}, likely{" "}
          {identity.likelySubject ?? 0}, namesakes excluded {identity.namesakesExcluded ?? 0}
        </p>
      ) : null}
      {autocomplete ? (
        <p className="dp-muted" style={{ marginBottom: "0.75rem" }}>
          {t("evidenceQuality.autocompleteMetrics")}: {autocomplete.total ?? 0} exposure, adjacent{" "}
          {autocomplete.adjacentPersonQueries ?? 0}
        </p>
      ) : null}
      {images ? (
        <p className="dp-muted" style={{ marginBottom: "0.75rem" }}>
          {t("evidenceQuality.imageMetrics")}: {images.subjectMatched ?? 0} matched,{" "}
          {images.thumbnailsAvailable ?? 0} thumbnails
        </p>
      ) : null}

      <div className="dp-grid dp-grid-4" style={{ marginBottom: "1rem" }}>
        <label>
          <span className="dp-muted">{t("evidenceQuality.filterIdentity")}</span>
          <select value={identityFilter} onChange={(e) => setIdentityFilter(e.target.value)}>
            <option value="">{t("evidenceQuality.filterAll")}</option>
            <option value="EXACT_SUBJECT">EXACT_SUBJECT</option>
            <option value="LIKELY_SUBJECT">LIKELY_SUBJECT</option>
            <option value="POSSIBLE_SUBJECT">POSSIBLE_SUBJECT</option>
            <option value="NAMESAKE">NAMESAKE</option>
            <option value="ENTITY_MISMATCH">ENTITY_MISMATCH</option>
            <option value="INSUFFICIENT_MATCH">INSUFFICIENT_MATCH</option>
          </select>
        </label>
        <label>
          <span className="dp-muted">{t("evidenceQuality.filterAutocomplete")}</span>
          <select value={autocompleteFilter} onChange={(e) => setAutocompleteFilter(e.target.value)}>
            <option value="">{t("evidenceQuality.filterAll")}</option>
            <option value="EXACT_SUBJECT_QUERY">EXACT_SUBJECT_QUERY</option>
            <option value="ADJACENT_PERSON_QUERY">ADJACENT_PERSON_QUERY</option>
            <option value="TYPO_OR_SIMILAR_QUERY">TYPO_OR_SIMILAR_QUERY</option>
            <option value="NAMESAKE_QUERY">NAMESAKE_QUERY</option>
          </select>
        </label>
        <label>
          <span className="dp-muted">{t("evidenceQuality.filterThumbnail")}</span>
          <select value={thumbnailFilter} onChange={(e) => setThumbnailFilter(e.target.value)}>
            <option value="">{t("evidenceQuality.filterAll")}</option>
            <option value="AVAILABLE">AVAILABLE</option>
            <option value="FAILED">FAILED</option>
            <option value="NOT_FETCHED">NOT_FETCHED</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={showNamesakes}
            onChange={(e) => setShowNamesakes(e.target.checked)}
          />{" "}
          {t("evidenceQuality.showNamesakes")}
        </label>
      </div>

      <h3>{t("evidenceQuality.allItems")}</h3>
      {filteredItems.length === 0 ? (
        <p className="dp-muted">{t("evidenceQuality.emptyQueue")}</p>
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>{t("evidenceQuality.titleCol")}</th>
              <th>{t("evidenceQuality.surfaceCol")}</th>
              <th>{t("evidenceQuality.identityCol")}</th>
              <th>{t("evidenceQuality.classCol")}</th>
              <th>{t("evidenceQuality.reasonCol")}</th>
              {can("risk.review") ? <th>{t("evidenceQuality.actionsCol")}</th> : null}
            </tr>
          </thead>
          <tbody>
            {filteredItems.slice(0, 100).map((item, idx) => {
              const q = item.quality ?? {};
              const id = item.id;
              return (
                <tr key={id ?? idx}>
                  <td>{item.title ?? "—"}</td>
                  <td>{item.surfaceType ?? "—"}</td>
                  <td>{q.identityDecision ?? q.autocompleteClass ?? "—"}</td>
                  <td>{q.contentClass ?? "—"}</td>
                  <td>{q.selectionReason ?? "—"}</td>
                  {can("risk.review") && id ? (
                    <td className="dp-actions">
                      <button
                        type="button"
                        className="dp-btn dp-btn-sm"
                        onClick={() => void setEligibility(id, "CLIENT_INCLUDE")}
                      >
                        {t("evidenceQuality.includeClient")}
                      </button>
                      <button
                        type="button"
                        className="dp-btn dp-btn-sm"
                        onClick={() => void setEligibility(id, "EXCLUDE")}
                      >
                        {t("evidenceQuality.exclude")}
                      </button>
                      {item.surfaceType === "IMAGE_RESULT" ? (
                        <button
                          type="button"
                          className="dp-btn dp-btn-sm"
                          onClick={() => void setEligibility(id, "INTERNAL_ONLY")}
                        >
                          {t("evidenceQuality.includeImage")}
                        </button>
                      ) : null}
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
