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
import { nextStepsFor } from "@/modules/site/check/next-view";
import { dialView, resultView } from "@/modules/site/check/result-view";
import type { PublicStatusJson } from "@/modules/site/check/types";
import { LEAD_TEXT, RESULT_TEXT } from "@/modules/site/content/check";
import { PHONE_COUNTRIES, phoneComplete, phoneCountry, phoneDigits, phoneMasked } from "@/modules/site/check/phone";
import { Button } from "../Button";
import { Dial } from "../Dial";
import { FieldError, Select, TextField } from "../Field";
import { VERDICT_TONE_CLASS } from "./parts";

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
  const dial = dialView(result);
  const themes =
    result.themes.length > 0
      ? result.themes.map((theme) => [theme.label, theme.count] as const)
      : result.verdict === "NEGATIVE_FOUND"
        ? [[RESULT_TEXT.noTheme, result.materialsFound] as const]
        : [];
  return (
    <div className={`site-slip__body ${VERDICT_TONE_CLASS[view.scale.tone]}`}>
      <h2 className="site-slip__subtitle" id="lead-attached">
        {LEAD_TEXT.attached}
      </h2>
      {/* Показание в малом размере: к заявке приложено ровно то, что человек видел на результате */}
      <div className="site-attached">
        <Dial filled={dial.filled} size="sm" ghost={dial.filled === 0} />
        <div>
          <p className="site-attached__level">
            {view.title.word ? (
              <>
                <span className="site-result__word">{view.title.word}</span> {view.title.text}
              </>
            ) : (
              view.title.text
            )}
          </p>
          {result.checkedAt ? <p className="site-caption">Проверка от {formatDay(result.checkedAt)}</p> : null}
        </div>
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

  /** Смена страны переписывает номер под её маску: лишние цифры отсекаются сразу. */
  function setCountry(id: string) {
    const next = { ...values, phoneCountry: id, phone: phoneDigits(phoneMasked(id, values.phone)) };
    setValues(next);
    if (errors.phone) setErrors((prev) => ({ ...prev, phone: leadFormErrors(next).phone ?? "" }));
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
    <section className="site-screen site-screen--split site-screen--even is-active site-enter" aria-labelledby="lead-title">
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

          <TextField
            id="lead-name"
            label={LEAD_TEXT.name}
            required
            error={errors.name}
            input={{
              name: "name",
              type: "text",
              autoComplete: "given-name",
              value: values.name,
              onChange: (e) => update("name", e.target.value),
            }}
          />

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
              if (key === "phone") {
                const country = phoneCountry(values.phoneCountry);
                return (
                  <TextField
                    key={key}
                    id="lead-phone"
                    label={channel.label}
                    labelHidden
                    hidden={!on}
                    error={on && contactError ? { id: "lead-contact-error" } : undefined}
                    /* Галочка заполненности значит «номер набран целиком», а не «в поле что-то есть» */
                    filled={phoneComplete(values.phoneCountry, values.phone)}
                    before={
                      <Select
                        id="lead-phone-country"
                        label={LEAD_TEXT.country}
                        value={values.phoneCountry}
                        onChange={(id) => setCountry(id)}
                      >
                        {PHONE_COUNTRIES.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.dial ? `${item.name} +${item.dial}` : item.name}
                          </option>
                        ))}
                      </Select>
                    }
                    input={{
                      name: key,
                      type: channel.type,
                      inputMode: channel.inputMode,
                      autoComplete: channel.autoComplete,
                      placeholder: country.example,
                      value: phoneMasked(values.phoneCountry, values.phone),
                      onChange: (e) => update("phone", phoneDigits(phoneMasked(values.phoneCountry, e.target.value))),
                    }}
                  />
                );
              }
              return (
                <TextField
                  key={key}
                  id={`lead-${key}`}
                  label={channel.label}
                  labelHidden
                  hidden={!on}
                  error={on && contactError ? { id: "lead-contact-error" } : undefined}
                  input={{
                    name: key,
                    type: channel.type,
                    inputMode: channel.inputMode,
                    autoComplete: channel.autoComplete,
                    placeholder: channel.placeholder,
                    value: values[key],
                    onChange: (e) => update(key, e.target.value),
                  }}
                />
              );
            })}
            <FieldError id="lead-contact-error" text={contactError} />
          </fieldset>

          <fieldset className="site-fieldset">
            <legend className="site-label">{LEAD_TEXT.time}</legend>
            {/* На узком экране варианты — сетка 2×2 из равных ячеек: пилюли разной длины
                вставали лесенкой 3 + 1 и читались перекосом (владелец 20.09.2026) */}
            <div className="site-choice site-choice--even">
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

          {/* Раскрытие — место под поле: та же ширина, высота и радиус, что у полей формы,
              пунктир — язык пустого места на сайте. Раскрытое становится обычным полем */}
          <details className="site-details site-details--slot">
            <summary>
              <span className="site-details__closed">{LEAD_TEXT.comment}</span>
              <span className="site-details__opened">{LEAD_TEXT.commentLabel}</span>
            </summary>
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
            <Button variant="accent" large arrow id="lead-submit" type="submit" busy={busy}>
              {LEAD_TEXT.submit}
            </Button>
            {/* Контурная кнопка того же размера: без контура второе действие теряется */}
            <Button variant="secondary" large onClick={onBack}>
              {failed ? LEAD_TEXT.backFailed : LEAD_TEXT.back}
            </Button>
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
