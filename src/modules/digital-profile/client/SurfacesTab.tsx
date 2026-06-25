"use client";

import { useState } from "react";
import {
  createSearchSurface,
  deleteSearchSurface,
  reviewSearchSurface,
  DigitalProfileApiError,
  type CreateSurfaceInput,
  type SearchSurfaceItem,
  type SearchSurfaceSource,
  type SearchSurfaceType,
} from "./api";
import { Badge, EmptyState, ErrorBox, StatusBadge } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";

type FieldKey = "query" | "title" | "snippet" | "url" | "imageUrl" | "videoUrl";

const FIELD_CONFIG: Record<SearchSurfaceType, FieldKey[]> = {
  ORGANIC_RESULT: ["title", "url"],
  SUGGESTION: ["query"],
  RELATED_QUERY: ["query"],
  IMAGE_RESULT: ["title", "url", "imageUrl"],
  VIDEO_RESULT: ["title", "videoUrl"],
  KNOWLEDGE_BLOCK: ["title", "snippet", "url"],
  SERP_SCREENSHOT: ["title", "url"],
  MANUAL_NOTE: ["title", "snippet"],
};

const FIELD_LABEL_KEY: Record<FieldKey, string> = {
  query: "surfaces.queryText",
  title: "surfaces.titleField",
  snippet: "surfaces.description",
  url: "surfaces.url",
  imageUrl: "surfaces.imageUrl",
  videoUrl: "surfaces.videoUrl",
};

export function SurfacesTab({
  type,
  label,
  items,
  caseId,
  onChanged,
}: {
  type: SearchSurfaceType;
  label: string;
  items: SearchSurfaceItem[];
  caseId: string;
  onChanged: () => void;
}) {
  const { t, tError, tSource } = useDigitalProfileI18n();
  const fields = FIELD_CONFIG[type];
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const required: FieldKey = fields.includes("query") ? "query" : "title";

  function sourceBadge(source: SearchSurfaceSource) {
    if (source === "MOCK") return <Badge tone="neutral">{tSource("MOCK")}</Badge>;
    if (source.startsWith("REAL_")) return <Badge tone="ok">{tSource("REAL")}</Badge>;
    if (source === "SYNTHETIC_SNAPSHOT") return <Badge tone="warn">{tSource("SYNTHETIC")}</Badge>;
    return <Badge tone="info">{tSource("MANUAL")}</Badge>;
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !(values[required] ?? "").trim()) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const input: CreateSurfaceInput = { type, source: "MANUAL_IMPORT", provider: "MANUAL" };
      for (const f of fields) {
        const v = (values[f] ?? "").trim();
        if (v) (input as unknown as Record<string, string>)[f] = v;
      }
      const res = await createSearchSurface(caseId, input);
      setInfo(res.deduplicated ? t("surfaces.duplicate") : t("surfaces.itemAdded"));
      setValues({});
      onChanged();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
    } finally {
      setBusy(false);
    }
  }

  async function act(id: string, fn: () => Promise<unknown>) {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
    } finally {
      setBusyId(null);
    }
  }

  const isMedia = type === "IMAGE_RESULT" || type === "VIDEO_RESULT";

  return (
    <div>
      <h2 className="dp-h2">{label}</h2>

      <form onSubmit={add} style={{ marginBottom: 18 }}>
        <div className="dp-form-grid">
          {fields.map((f) => (
            <div key={f} className={f === "snippet" ? "dp-field dp-field-full" : "dp-field"}>
              <label>
                {t(FIELD_LABEL_KEY[f])}
                {f === required ? " *" : ""}
              </label>
              <input
                className="dp-input"
                value={values[f] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <div className="dp-inline" style={{ marginTop: 12 }}>
          <button
            className="dp-btn dp-btn-primary dp-btn-sm"
            disabled={busy || !(values[required] ?? "").trim()}
          >
            {busy ? t("common.adding") : `${t("surfaces.add")}: ${label}`}
          </button>
          {info ? <span className="dp-muted">{info}</span> : null}
        </div>
        {error ? (
          <div style={{ marginTop: 10 }}>
            <ErrorBox>{error}</ErrorBox>
          </div>
        ) : null}
      </form>

      {items.length === 0 ? (
        <EmptyState title={`${label} — ${t("common.empty")}`} hint={t("surfaces.emptyHint")} />
      ) : isMedia ? (
        <div className="dp-grid-cards">
          {items.map((it) => (
            <div key={it.id} className="dp-card" style={{ padding: 12 }}>
              {it.thumbnailUrl || it.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={it.thumbnailUrl ?? it.imageUrl ?? ""}
                  alt={it.title ?? "preview"}
                  style={{ width: "100%", height: 110, objectFit: "cover", borderRadius: 6 }}
                  onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")}
                />
              ) : null}
              <div className="dp-inline" style={{ justifyContent: "space-between", marginTop: 8 }}>
                {sourceBadge(it.source)}
                <StatusBadge status={it.reviewStatus} />
              </div>
              <div style={{ marginTop: 6, fontSize: 13 }}>{it.title ?? "—"}</div>
              <a
                href={it.videoUrl ?? it.url ?? it.imageUrl ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                className="dp-muted"
                style={{ fontSize: 12 }}
              >
                {type === "VIDEO_RESULT" ? t("surfaces.openVideo") : t("surfaces.open")}
              </a>
              <div className="dp-inline" style={{ marginTop: 8 }}>
                {it.reviewStatus === "PENDING" ? (
                  <button
                    className="dp-btn dp-btn-sm"
                    disabled={busyId === it.id}
                    onClick={() => act(it.id, () => reviewSearchSurface(it.id, "REVIEWED"))}
                  >
                    {t("common.review")}
                  </button>
                ) : null}
                <button
                  className="dp-btn dp-btn-sm dp-btn-danger"
                  disabled={busyId === it.id}
                  onClick={() => act(it.id, () => deleteSearchSurface(it.id))}
                >
                  {t("common.delete")}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <table className="dp-table">
          <thead>
            <tr>
              <th>{fields.includes("query") ? t("surfaces.query") : t("surfaces.title")}</th>
              <th>{t("common.source")}</th>
              <th>{t("surfaces.reviewCol")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td>
                  <div>{it.query ?? it.title ?? it.url ?? "—"}</div>
                  {it.snippet ? <div className="dp-muted">{it.snippet}</div> : null}
                </td>
                <td>{sourceBadge(it.source)}</td>
                <td>
                  <StatusBadge status={it.reviewStatus} />
                </td>
                <td style={{ textAlign: "right" }}>
                  <div className="dp-inline" style={{ justifyContent: "flex-end" }}>
                    {it.reviewStatus === "PENDING" ? (
                      <button
                        className="dp-btn dp-btn-sm"
                        disabled={busyId === it.id}
                        onClick={() => act(it.id, () => reviewSearchSurface(it.id, "REVIEWED"))}
                      >
                        {t("common.review")}
                      </button>
                    ) : null}
                    <button
                      className="dp-btn dp-btn-sm dp-btn-danger"
                      disabled={busyId === it.id}
                      onClick={() => act(it.id, () => deleteSearchSurface(it.id))}
                    >
                      {t("common.delete")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
