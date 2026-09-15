"use client";

/**
 * Панель «Проверка с сайта» в карточке дела.
 *
 * Уведомлений о заявках нет, поэтому здесь менеджер видит, что посетитель
 * ввёл, под каким текстом согласия и как с ним связаться. Дело, заведённое не
 * с сайта, панели не показывает: отсутствие записи — обычное состояние, а не
 * ошибка.
 *
 * Полного прогона панель не запускает: платная пересборка — кнопка сбора в
 * шапке дела, со своим подтверждением, и второго входа в неё здесь нет.
 */

import { useEffect, useState, type ReactNode } from "react";
import { getCaseSelfCheck, type SelfCheckRecord } from "./api";
import { Card, ErrorBox } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; record: SelfCheckRecord | null }
  | { kind: "error" };

const STATUS_KEY: Record<string, string> = {
  CREATED: "selfCheck.statusCreated",
  PERSONA_PENDING: "selfCheck.statusPersonaPending",
  PERSONA_DECIDED: "selfCheck.statusPersonaDecided",
  RUNNING: "selfCheck.statusRunning",
  DONE: "selfCheck.statusDone",
  FAILED: "selfCheck.statusFailed",
  BLOCKED: "selfCheck.statusBlocked",
  EXPIRED: "selfCheck.statusExpired",
};

const LEAD_STATUS_KEY: Record<string, string> = {
  NEW: "selfCheck.leadStatusNew",
  CONTACTED: "selfCheck.leadStatusContacted",
  CLOSED: "selfCheck.leadStatusClosed",
};

const TIME_KEY: Record<string, string> = {
  any: "selfCheck.timeAny",
  morning: "selfCheck.timeMorning",
  day: "selfCheck.timeDay",
  evening: "selfCheck.timeEvening",
};

const SOURCE_KEY: Record<string, string> = {
  search: "selfCheck.sourceSearch",
  surfaces: "selfCheck.sourceSurfaces",
  open_sources: "selfCheck.sourceOpenSources",
  sanctions: "selfCheck.sourceSanctions",
};

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

export function SelfCheckPanel({ caseId }: { caseId: string }) {
  const { t, fmtDate } = useDigitalProfileI18n();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    getCaseSelfCheck(caseId).then(
      (record) => {
        if (!cancelled) setState({ kind: "ready", record });
      },
      () => {
        if (!cancelled) setState({ kind: "error" });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  if (state.kind === "loading") return null;
  if (state.kind === "error") {
    return (
      <Card>
        <ErrorBox>{t("selfCheck.loadFailed")}</ErrorBox>
      </Card>
    );
  }
  const r = state.record;
  if (!r) return null;

  const dash = <span className="dp-muted">—</span>;
  const text = (value: string | null | undefined): ReactNode => (value ? value : dash);
  const label = (keys: Record<string, string>, value: string | null) =>
    value && keys[value] ? t(keys[value]) : text(value);
  const input = r.inputJson ?? {};
  const themes = Array.isArray(r.themesJson) ? (r.themesJson as Array<{ label?: string; count?: number }>) : [];
  const sources = Array.isArray(r.sourcesJson) ? (r.sourcesJson as unknown[]).map(String) : [];

  return (
    <Card>
      <div className="dp-stack">
        <div>
          <h3 style={{ margin: 0 }}>{t("selfCheck.title")}</h3>
          <div className="dp-muted" style={{ fontSize: 13, marginTop: 4 }}>
            {t("selfCheck.hint")}
          </div>
        </div>

        <dl className="dp-kv">
          <Field label={t("selfCheck.status")}>{label(STATUS_KEY, r.status)}</Field>
          {r.blockedReason ? (
            <Field label={t("selfCheck.blockedReason")}>
              <span className="dp-mono">{r.blockedReason}</span>
            </Field>
          ) : null}
          <Field label={t("selfCheck.created")}>{fmtDate(r.createdAt)}</Field>
          <Field label={t("selfCheck.expires")}>
            {r.anonymizedAt
              ? t("selfCheck.anonymized", { at: fmtDate(r.anonymizedAt) })
              : fmtDate(r.expiresAt)}
          </Field>
          <Field label={t("selfCheck.run")}>
            {r.jobId ? <span className="dp-mono">{r.jobId}</span> : t("selfCheck.runNone")}
          </Field>
          <Field label={t("selfCheck.verdict")}>
            {r.verdict ? (
              <span className="dp-mono">
                {r.verdict}
                {r.riskLevel ? ` · ${r.riskLevel}` : ""}
              </span>
            ) : (
              t("selfCheck.verdictNone")
            )}
          </Field>
          {r.verdict ? (
            <>
              <Field label={t("selfCheck.verdictMaterials")}>{r.materialsFound ?? 0}</Field>
              <Field label={t("selfCheck.verdictThemes")}>
                {themes.length > 0
                  ? themes.map((theme) => `${theme.label ?? "—"} — ${theme.count ?? 0}`).join("; ")
                  : dash}
              </Field>
              <Field label={t("selfCheck.verdictSources")}>
                {sources.length > 0
                  ? sources.map((source) => (SOURCE_KEY[source] ? t(SOURCE_KEY[source]) : source)).join(", ")
                  : dash}
                {r.partial ? ` · ${t("selfCheck.verdictPartial")}` : ""}
              </Field>
            </>
          ) : null}
        </dl>

        <div>
          <strong>{t("selfCheck.form")}</strong>
          <dl className="dp-kv">
            <Field label={t("selfCheck.formCity")}>{text(input.city)}</Field>
            <Field label={t("selfCheck.formAliases")}>
              {input.aliases && input.aliases.length > 0 ? input.aliases.join(", ") : dash}
            </Field>
            <Field label={t("selfCheck.formInn")}>{text(input.inn)}</Field>
            <Field label={t("selfCheck.formEmployer")}>{text(input.employer)}</Field>
            <Field label={t("selfCheck.formPosition")}>{text(input.position)}</Field>
            <Field label={t("selfCheck.formWebsite")}>{text(input.website)}</Field>
          </dl>
        </div>

        <div>
          <strong>{t("selfCheck.consent")}</strong>
          <dl className="dp-kv">
            <Field label={t("selfCheck.consent")}>
              {t("selfCheck.consentValue", {
                version: r.consentVersion,
                at: fmtDate(r.consentAt),
              })}
            </Field>
            <Field label={t("selfCheck.captcha")}>
              {r.captchaVerifiedAt
                ? t("selfCheck.captchaVerified", { at: fmtDate(r.captchaVerifiedAt) })
                : t("selfCheck.captchaSkipped")}
            </Field>
            <Field label={t("selfCheck.visitor")}>
              {r.ip || r.userAgent ? (
                <span className="dp-mono" style={{ wordBreak: "break-all" }}>
                  {[r.ip, r.userAgent].filter(Boolean).join(" · ")}
                </span>
              ) : (
                dash
              )}
            </Field>
          </dl>
        </div>

        <div>
          <strong>{t("selfCheck.lead")}</strong>
          {r.leadAt ? (
            <dl className="dp-kv">
              <Field label={t("selfCheck.leadStatus")}>{label(LEAD_STATUS_KEY, r.leadStatus)}</Field>
              <Field label={t("selfCheck.leadAt")}>{fmtDate(r.leadAt)}</Field>
              <Field label={t("selfCheck.leadName")}>{text(r.leadName)}</Field>
              <Field label={t("selfCheck.leadPhone")}>{text(r.leadPhone)}</Field>
              <Field label={t("selfCheck.leadTelegram")}>{text(r.leadTelegram)}</Field>
              <Field label={t("selfCheck.leadEmail")}>{text(r.leadEmail)}</Field>
              <Field label={t("selfCheck.leadTime")}>{label(TIME_KEY, r.leadPreferredTime)}</Field>
              <Field label={t("selfCheck.leadMessage")}>
                {r.leadMessage ? <span style={{ whiteSpace: "pre-wrap" }}>{r.leadMessage}</span> : dash}
              </Field>
            </dl>
          ) : (
            <div className="dp-muted">{t("selfCheck.leadNone")}</div>
          )}
        </div>

        <div className="dp-muted" style={{ fontSize: 13 }}>
          {t("selfCheck.fullRunHint")}
        </div>
      </div>
    </Card>
  );
}
