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
import { useDpAuth } from "./auth-provider";
import { releaseUnifiedReport, type ReportReleaseStatus } from "./api";
import type {
  ReviewSheet,
  ReviewSheetItem,
} from "../services/review-sheet";

/** Что предлагается решить по материалу — вопрос и ответы к нему. */
const EVIDENCE_ACTIONS: Array<{ kind: string; status: string; labelKey: string }> = [
  { kind: "belonging", status: "CONFIRMED_SUBJECT", labelKey: "reviewSheet.actConfirmSubject" },
  { kind: "belonging", status: "OTHER_SUBJECT", labelKey: "reviewSheet.actOtherSubject" },
  { kind: "adverse", status: "NEUTRAL", labelKey: "reviewSheet.actNotAdverse" },
  { kind: "adverse", status: "ADVERSE", labelKey: "reviewSheet.actAdverse" },
  { kind: "presence", status: "EXCLUDED", labelKey: "reviewSheet.actExclude" },
];

const GROUPS = [
  { kind: "evidence" as const, labelKey: "reviewSheet.groupEvidence" },
  { kind: "finding" as const, labelKey: "reviewSheet.groupFinding" },
  { kind: "compliance" as const, labelKey: "reviewSheet.groupCompliance" },
];

type LiveSheet = ReviewSheet & { currentDecisionsDigest?: string };

export function ReviewSheetTab({
  caseId,
  jobId,
  release,
  onReleased,
}: {
  caseId: string;
  jobId?: string | null;
  /** Состояние документа: черновик перед аналитиком или уже выпуск. */
  release?: ReportReleaseStatus | null;
  onReleased?: () => void;
}) {
  const { t, fmtDate } = useDigitalProfileI18n();
  const { can } = useDpAuth();
  const canDecide = can("evidence.create");
  const canRelease = can("report.release");
  const [confirmingRelease, setConfirmingRelease] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [sheet, setSheet] = useState<LiveSheet | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
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
      const json = (await res.json()) as { data?: LiveSheet; error?: string };
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

  /**
   * «Подтвердить тему» — это подтвердить принадлежность её материалов.
   *
   * Раскладывается прямо здесь, решениями по материалам: отдельного признака
   * «тема подтверждена» в продукте нет и не заводится — иначе отчёт объявил бы
   * тему подтверждённой при неподтверждённых уликах.
   */
  const confirmTheme = useCallback(
    async (item: ReviewSheetItem) => {
      const keys = item.materialKeys ?? [];
      if (keys.length === 0) return;
      setSaving(`${item.key}|belonging`);
      setError(null);
      try {
        for (const key of keys) {
          const res = await fetch(
            `/api/digital-profile/cases/${caseId}/unified-collection/review-decisions`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                itemKind: "evidence",
                itemKey: key,
                decisionKind: "belonging",
                status: "CONFIRMED_SUBJECT",
              }),
            }
          );
          if (!res.ok) {
            const json = (await res.json()) as { error?: string };
            throw new Error(json.error ?? `HTTP ${res.status}`);
          }
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(null);
      }
    },
    [caseId, load]
  );

  const decide = useCallback(
    async (item: ReviewSheetItem, decisionKind: string, status: string) => {
      setSaving(`${item.key}|${decisionKind}`);
      setError(null);
      try {
        const res = await fetch(
          `/api/digital-profile/cases/${caseId}/unified-collection/review-decisions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              itemKind: item.kind,
              itemKey: item.key,
              decisionKind,
              status,
            }),
          }
        );
        if (!res.ok) {
          const json = (await res.json()) as { error?: string };
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(null);
      }
    },
    [caseId, load]
  );

  const doRelease = useCallback(async () => {
    if (!jobId) return;
    setReleasing(true);
    setError(null);
    try {
      await releaseUnifiedReport(caseId, jobId);
      setConfirmingRelease(false);
      onReleased?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReleasing(false);
    }
  }, [caseId, jobId, onReleased]);

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
      <div className="dp-card" style={{ marginBottom: "0.75rem" }}>
        <div>
          <strong>
            {release?.state === "released"
              ? t("reviewSheet.stateReleased")
              : t("reviewSheet.stateDraft")}
          </strong>
        </div>
        {release?.state === "released" ? (
          <div className="dp-muted">
            {release.releasedAt ? fmtDate(release.releasedAt) : ""}
            {release.releasedBy ? ` · ${release.releasedBy}` : ""}
            {typeof release.openItems === "number"
              ? ` · ${t("reviewSheet.openAtRelease", { count: release.openItems })}`
              : ""}
          </div>
        ) : (
          <div className="dp-muted">{t("reviewSheet.draftHint")}</div>
        )}
        {canRelease && jobId ? (
          confirmingRelease ? (
            <div style={{ marginTop: "0.5rem" }}>
              <div>
                {t("reviewSheet.releaseConfirm", {
                  evidence: sheet.summary.evidence.open,
                  finding: sheet.summary.finding.open,
                  compliance: sheet.summary.compliance.open,
                })}
              </div>
              <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.4rem" }}>
                <button
                  className="dp-btn dp-btn-primary dp-btn-sm"
                  disabled={releasing}
                  onClick={() => void doRelease()}
                >
                  {t("reviewSheet.releaseConfirmCta")}
                </button>
                <button
                  className="dp-btn dp-btn-sm"
                  disabled={releasing}
                  onClick={() => setConfirmingRelease(false)}
                >
                  {t("common.cancel")}
                </button>
              </div>
            </div>
          ) : (
            <button
              className="dp-btn dp-btn-primary dp-btn-sm"
              style={{ marginTop: "0.5rem" }}
              onClick={() => setConfirmingRelease(true)}
            >
              {t("reviewSheet.release")}
            </button>
          )
        ) : null}
      </div>
      <Notice>{t("reviewSheet.decisionsNotice")}</Notice>
      {sheet.currentDecisionsDigest && sheet.currentDecisionsDigest !== sheet.decisionsDigest ? (
        <Notice>{t("reviewSheet.staleDocument")}</Notice>
      ) : null}

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
                  <ReviewRow
                    key={`${item.kind}:${item.key}`}
                    item={item}
                    canDecide={canDecide && (item.kind === "evidence" || item.kind === "finding")}
                    saving={saving}
                    onDecide={decide}
                    onConfirmTheme={confirmTheme}
                  />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ReviewRow({
  item,
  canDecide,
  saving,
  onDecide,
  onConfirmTheme,
}: {
  item: ReviewSheetItem;
  canDecide: boolean;
  saving: string | null;
  onDecide: (item: ReviewSheetItem, kind: string, status: string) => void | Promise<void>;
  onConfirmTheme: (item: ReviewSheetItem) => void | Promise<void>;
}) {
  const { t } = useDigitalProfileI18n();
  const decided = item.decisions ?? {};
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
      {Object.entries(decided).map(([kind, d]) =>
        d ? (
          <div key={kind} className="dp-muted">
            {t("reviewSheet.decided")}: {t(`reviewSheet.status.${d.status}`)}
            {d.decidedBy ? ` · ${d.decidedBy}` : ""}
            {d.decidedAt ? ` · ${d.decidedAt.slice(0, 10)}` : ""}
          </div>
        ) : null
      )}
      {canDecide && item.kind === "finding" ? (
        <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.4rem" }}>
          {(item.materialKeys ?? []).length > 0 ? (
            <button
              className="dp-btn dp-btn-sm"
              disabled={saving === `${item.key}|belonging`}
              onClick={() => void onConfirmTheme(item)}
            >
              {t("reviewSheet.actConfirmTheme")}
            </button>
          ) : null}
          <button
            className="dp-btn dp-btn-sm"
            disabled={
              saving === `${item.key}|presence` || decided.presence?.status === "EXCLUDED"
            }
            onClick={() => void onDecide(item, "presence", "EXCLUDED")}
          >
            {t("reviewSheet.actRemoveTheme")}
          </button>
          {decided.presence ? (
            <button
              className="dp-btn dp-btn-sm"
              disabled={saving === `${item.key}|presence`}
              onClick={() => void onDecide(item, "presence", "CLEARED")}
            >
              {t("reviewSheet.actClear")}
            </button>
          ) : null}
        </div>
      ) : null}
      {canDecide && item.kind === "evidence" ? (
        <div style={{ display: "flex", gap: "0.35rem", flexWrap: "wrap", marginTop: "0.4rem" }}>
          {EVIDENCE_ACTIONS.map((a) => (
            <button
              key={`${a.kind}:${a.status}`}
              className="dp-btn dp-btn-sm"
              disabled={saving === `${item.key}|${a.kind}` || decided[a.kind]?.status === a.status}
              onClick={() => void onDecide(item, a.kind, a.status)}
            >
              {t(a.labelKey)}
            </button>
          ))}
          {Object.keys(decided).map((kind) => (
            <button
              key={`clear:${kind}`}
              className="dp-btn dp-btn-sm"
              disabled={saving === `${item.key}|${kind}`}
              onClick={() => void onDecide(item, kind, "CLEARED")}
            >
              {t("reviewSheet.actClear")} · {t(`reviewSheet.kind.${kind}`)}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
