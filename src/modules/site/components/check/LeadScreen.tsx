"use client";

/**
 * Заявка. Способ связи выбирается переключателем, и поле одно: ручка принимает
 * хотя бы один контакт, а четыре пустых поля подряд читались как анкета. Поля
 * проверяет схема ручки заявки (через `check/form.ts`). Справа — что уйдёт вместе
 * с заявкой и что будет дальше.
 */

import { useEffect, useRef, useState, type FormEvent, type Ref } from "react";
import { siteApi, type ApiRefusal } from "@/modules/site/api";
import {
  EMPTY_LEAD_FORM,
  leadFormErrors,
  leadFormPayload,
  serverFieldErrors,
  type FieldErrors,
  type LeadChannel,
  type LeadFormValues,
} from "@/modules/site/check/form";
import { formatDay } from "@/modules/site/check/format";
import { resultView } from "@/modules/site/check/result-view";
import type { PublicStatusJson } from "@/modules/site/check/types";
import { LEAD_TEXT, NEXT_STEPS } from "@/modules/site/content/check";
import { ArrowIcon, ErrorIcon } from "../SiteIcons";
import { MeterSegments } from "./parts";

export function nextStepsFor(status: PublicStatusJson) {
  if (status.status === "DONE" && status.result?.verdict === "NEGATIVE_FOUND") return NEXT_STEPS.NEGATIVE_FOUND;
  if (status.status === "DONE" && status.result?.verdict === "CLEAN") return NEXT_STEPS.CLEAN;
  return NEXT_STEPS.MANUAL;
}

function Attached({ status }: { status: PublicStatusJson }) {
  const result = status.result;
  if (status.status !== "DONE" || !result) {
    return (
      <div className="site-slip__body">
        <h2 className="site-slip__subtitle" id="lead-attached">
          {LEAD_TEXT.attachedFailed}
        </h2>
        <p>{LEAD_TEXT.attachedFailedText}</p>
      </div>
    );
  }
  const view = resultView(result);
  const themes =
    result.themes.length > 0
      ? result.themes.map((theme) => [theme.label, theme.count] as const)
      : result.verdict === "NEGATIVE_FOUND"
        ? [["Материалы без темы", result.materialsFound] as const]
        : [];
  return (
    <div className={`site-slip__body site-verdict--${view.scale.tone}`}>
      <h2 className="site-slip__subtitle" id="lead-attached">
        {LEAD_TEXT.attached}
      </h2>
      <p className="site-attached__level">
        {view.title.word ? (
          <>
            <span className="site-result__word">{view.title.word}</span> {view.title.text}
          </>
        ) : (
          view.title.text
        )}
      </p>
      <div className={`site-meter site-meter--${view.scale.tone}`} aria-hidden="true">
        <MeterSegments filled={view.scale.filled} />
      </div>
      {themes.length > 0 ? (
        <ul className="site-attached__themes">
          {themes.map(([label, count]) => (
            <li key={label}>
              <span>{label}</span>
              <span>{count}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {result.checkedAt ? <p className="site-caption">Проверка от {formatDay(result.checkedAt)}</p> : null}
    </div>
  );
}

export function LeadScreen({
  publicId,
  status,
  onSent,
  onStale,
  onRefusal,
  onBack,
  headingRef,
}: {
  publicId: string;
  status: PublicStatusJson;
  onSent: () => void;
  onStale: () => void;
  onRefusal: (refusal: ApiRefusal) => void;
  onBack: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const [values, setValues] = useState<LeadFormValues>(EMPTY_LEAD_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const summaryBox = useRef<HTMLDivElement>(null);
  const failed = status.status === "FAILED";

  useEffect(() => {
    if (summary) summaryBox.current?.focus();
  }, [summary]);

  function update<K extends keyof LeadFormValues>(field: K, value: LeadFormValues[K]) {
    const next = { ...values, [field]: value };
    setValues(next);
    if (Object.keys(errors).length > 0) {
      // Ошибка снимается, как только поле исправлено; новых до отправки не появляется.
      const fresh = leadFormErrors(next);
      setErrors((prev) => Object.fromEntries(Object.keys(prev).flatMap((key) => (fresh[key] ? [[key, fresh[key]!]] : []))));
    }
  }

  function show(text: string) {
    setSummary(null);
    requestAnimationFrame(() => setSummary(text));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const found = leadFormErrors(values);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      show(LEAD_TEXT.summary);
      return;
    }
    setBusy(true);
    const res = await siteApi.lead(publicId, leadFormPayload(values));
    if (res.ok) {
      onSent();
      return;
    }
    setBusy(false);
    const fieldErrors = serverFieldErrors(res.fieldErrors);
    if (res.status === 400 && Object.keys(fieldErrors).length > 0) {
      setErrors(fieldErrors);
      show(LEAD_TEXT.summary);
      return;
    }
    if (res.status === 409) {
      onStale();
      return;
    }
    if (res.status === 0) {
      show(LEAD_TEXT.offline);
      return;
    }
    onRefusal(res);
  }

  const contactError = errors.contact ?? errors[values.channel];

  return (
    <section className="site-screen site-screen--split is-active site-enter" aria-labelledby="lead-title">
      <div className="site-screen__main">
        <header className="site-screen__head">
          <h1 className="site-screen__title" id="lead-title" tabIndex={-1} ref={headingRef}>
            {LEAD_TEXT.title}
          </h1>
          <p className="site-screen__lead">{failed ? LEAD_TEXT.leadManual : LEAD_TEXT.lead}</p>
        </header>
        <form className="site-form site-contact" id="lead-form" noValidate onSubmit={submit}>
          <div className="site-form-summary" role="alert" tabIndex={-1} ref={summaryBox} hidden={!summary}>
            {summary}
          </div>

          <div className="site-field">
            <label className="site-label site-label--req" htmlFor="lead-name">
              {LEAD_TEXT.name}
              <span className="site-visually-hidden">, обязательное поле</span>
            </label>
            <input
              className={`site-input${values.name.trim() ? " is-filled" : ""}`}
              id="lead-name"
              name="name"
              type="text"
              autoComplete="given-name"
              aria-required="true"
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? "lead-name-error" : undefined}
              value={values.name}
              onChange={(e) => update("name", e.target.value)}
            />
            {errors.name ? (
              <p className="site-error" id="lead-name-error">
                <ErrorIcon />
                <span>{errors.name}</span>
              </p>
            ) : null}
          </div>

          <fieldset className="site-fieldset">
            <legend className="site-label site-label--req">
              {LEAD_TEXT.channel}
              <span className="site-visually-hidden">, обязательное поле</span>
            </legend>
            {/* Радиокнопки, а не вкладки: стрелки с клавиатуры переключают варианты без Tab */}
            <div className="site-segmented">
              {LEAD_TEXT.channels.map((channel) => (
                <label key={channel.value}>
                  <input
                    type="radio"
                    name="lead-channel"
                    value={channel.value}
                    checked={values.channel === channel.value}
                    onChange={() => update("channel", channel.value as LeadChannel)}
                  />
                  <span>{channel.label}</span>
                </label>
              ))}
            </div>
            {LEAD_TEXT.channels.map((channel) => {
              const key = channel.value as LeadChannel;
              const on = values.channel === key;
              return (
                <div className="site-field" key={key} hidden={!on}>
                  <label className="site-visually-hidden" htmlFor={`lead-${key}`}>
                    {channel.label}
                  </label>
                  <input
                    className={`site-input${values[key].trim() ? " is-filled" : ""}`}
                    id={`lead-${key}`}
                    name={key}
                    type={channel.type}
                    inputMode={channel.inputMode}
                    autoComplete={channel.autoComplete}
                    placeholder={channel.placeholder}
                    aria-invalid={on && contactError ? true : undefined}
                    aria-describedby={on && contactError ? "lead-contact-error" : undefined}
                    value={values[key]}
                    onChange={(e) => update(key, e.target.value)}
                  />
                </div>
              );
            })}
            {contactError ? (
              <p className="site-error" id="lead-contact-error">
                <ErrorIcon />
                <span>{contactError}</span>
              </p>
            ) : null}
          </fieldset>

          <fieldset className="site-fieldset">
            <legend className="site-label">{LEAD_TEXT.time}</legend>
            <div className="site-choice">
              {LEAD_TEXT.times.map((time) => (
                <label key={time.value}>
                  <input
                    type="radio"
                    name="preferredTime"
                    value={time.value}
                    checked={values.preferredTime === time.value}
                    onChange={() => update("preferredTime", time.value)}
                  />
                  <span>{time.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <details className="site-details">
            <summary>{LEAD_TEXT.comment}</summary>
            <div className="site-details__body">
              <label className="site-visually-hidden" htmlFor="lead-message">
                {LEAD_TEXT.commentLabel}
              </label>
              <textarea
                className="site-textarea"
                id="lead-message"
                name="message"
                rows={3}
                placeholder={LEAD_TEXT.commentPlaceholder}
                value={values.message}
                onChange={(e) => update("message", e.target.value)}
              />
            </div>
          </details>

          <div className="site-actions">
            <button className="site-btn site-btn--accent site-btn--lg" id="lead-submit" type="submit" aria-busy={busy || undefined}>
              <span className="site-spinner" aria-hidden="true" />
              <span>{LEAD_TEXT.submit}</span>
              <ArrowIcon />
            </button>
            <button className="site-btn site-btn--ghost" type="button" onClick={onBack}>
              {failed ? LEAD_TEXT.backFailed : LEAD_TEXT.back}
            </button>
          </div>
        </form>
      </div>

      <aside className="site-screen__aside" aria-labelledby="lead-attached">
        <div className="site-slip site-ticks">
          <Attached status={status} />
          <div className="site-slip__foot">
            <h2 className="site-slip__subtitle">{LEAD_TEXT.nextTitle}</h2>
            <ol className="site-timeline">
              {nextStepsFor(status).map(([title, text]) => (
                <li key={title}>
                  <b>{title}</b>
                  <span>{text}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </aside>
    </section>
  );
}
