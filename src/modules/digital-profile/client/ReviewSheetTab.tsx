"use client";

/**
 * Вкладка «Проверка перед выпуском» — лист собранного черновика.
 *
 * Показывает то, что напечатано в документе, и решение машины по каждому
 * пункту. Действий здесь нет намеренно: решения аналитика — следующий шаг, и
 * кнопка, которая ничего не меняет, врала бы о готовности.
 *
 * Вкладка служебная: лист несёт машинные коды и решения о принадлежности, и
 * клиенту он не показывается — как и остальные внутренние данные модуля.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, EmptyState, ErrorBox, Notice } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";
import type {
  ReviewSheet,
  ReviewSheetItem,
} from "../services/review-sheet";

const GROUPS = [
  { kind: "evidence" as const, labelKey: "reviewSheet.groupEvidence" },
  { kind: "finding" as const, labelKey: "reviewSheet.groupFinding" },
  { kind: "compliance" as const, labelKey: "reviewSheet.groupCompliance" },
];

export function ReviewSheetTab({ caseId, jobId }: { caseId: string; jobId?: string | null }) {
  const { t } = useDigitalProfileI18n();
  const [sheet, setSheet] = useState<ReviewSheet | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openOnly, setOpenOnly] = useState(true);

  const load = useCallback(async () => {
    if (!jobId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/digital-profile/cases/${caseId}/unified-collection/review-sheet?jobId=${encodeURIComponent(jobId)}`
      );
      const json = (await res.json()) as { data?: ReviewSheet; error?: string };
      if (res.status === 404) {
        setSheet(null);
        setError(t("reviewSheet.notBuilt"));
        return;
      }
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSheet(json.data ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [caseId, jobId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const items = sheet?.items ?? [];
    return openOnly ? items.filter((i) => i.open) : items;
  }, [sheet?.items, openOnly]);

  if (!jobId) return <EmptyState title={t("reviewSheet.noJob")} />;
  if (loading) return <p className="dp-muted">{t("common.loading")}</p>;
  if (error) return <ErrorBox>{error}</ErrorBox>;
  if (!sheet) return <EmptyState title={t("reviewSheet.notBuilt")} />;

  const counts = (kind: (typeof GROUPS)[number]["kind"]) =>
    kind === "evidence"
      ? sheet.summary.evidence
      : kind === "finding"
        ? sheet.summary.finding
        : sheet.summary.compliance;

  return (
    <div>
      <h2 className="dp-h2">{t("reviewSheet.title")}</h2>
      <p className="dp-muted">{t("reviewSheet.lead")}</p>
      <Notice>{t("reviewSheet.readOnlyNotice")}</Notice>

      <div style={{ margin: "0.75rem 0" }}>
        <label>
          <input
            type="checkbox"
            checked={openOnly}
            onChange={(e) => setOpenOnly(e.target.checked)}
          />{" "}
          {openOnly ? t("reviewSheet.openOnly") : t("reviewSheet.allItems")}
        </label>
      </div>

      {GROUPS.map((group) => {
        const rows = shown.filter((i) => i.kind === group.kind);
        const summary = counts(group.kind);
        return (
          <section key={group.kind} style={{ marginBottom: "1.5rem" }}>
            <h2 className="dp-h2">
              {t(group.labelKey)}{" "}
              <span className="dp-muted">
                {t("reviewSheet.countLine", { total: summary.total, open: summary.open })}
              </span>
            </h2>
            {rows.length === 0 ? (
              <p className="dp-muted">{t("reviewSheet.empty")}</p>
            ) : (
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {rows.map((item) => (
                  <ReviewRow key={`${item.kind}:${item.key}`} item={item} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ReviewRow({ item }: { item: ReviewSheetItem }) {
  const { t } = useDigitalProfileI18n();
  return (
    <li className="dp-card" style={{ marginBottom: "0.5rem" }}>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline", flexWrap: "wrap" }}>
        <strong>{item.title}</strong>
        {item.open ? <Badge tone="warn">{t("reviewSheet.openBadge")}</Badge> : null}
        {item.framedAs ? <Badge tone="danger">{t("reviewSheet.framedBadge")}</Badge> : null}
      </div>
      <div className="dp-muted">{item.state}</div>
      {item.url ? (
        <div className="dp-muted" style={{ wordBreak: "break-all" }}>
          {item.url}
        </div>
      ) : null}
      {item.reason ? (
        <div className="dp-muted">
          {t("reviewSheet.reason")}: {item.reason.label}
        </div>
      ) : null}
      {item.framedAs ? <div className="dp-muted">{item.framedAs}</div> : null}
      {item.pages.length > 0 ? (
        <div className="dp-muted">
          {t("reviewSheet.pages")}: {item.pages.join(", ")}
        </div>
      ) : null}
    </li>
  );
}
