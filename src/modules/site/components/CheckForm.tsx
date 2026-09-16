"use client";

/**
 * Форма проверки в первом экране.
 *
 * Поля проверяет схема ручки создания (через `check/form.ts`): текст у поля до
 * отправки и текст из ответа `400` — один и тот же. Ошибки показываются после
 * попытки отправить и снимаются, как только поле исправлено.
 *
 * Рубильник, ключ капчи и отказы создания форма узнаёт у сервера во время показа:
 * страница собрана заранее и о них не знает.
 */

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { track } from "@/modules/site/analytics";
import { siteApi } from "@/modules/site/api";
import {
  EMPTY_CHECK_FORM,
  checkFormErrors,
  checkFormPayload,
  checkFormProgress,
  serverFieldErrors,
  type CheckFormValues,
  type FieldErrors,
} from "@/modules/site/check/form";
import { birthDateToIso, caretAfterDigits, maskBirthDate } from "@/modules/site/check/birth-date";
import type { SitePublicConfig } from "@/modules/site/check/types";
import { CHECK_FORM_TEXT } from "@/modules/site/content/landing";
import { vars } from "./css-vars";
import { ArrowIcon, ErrorIcon } from "./SiteIcons";
import { useSmartCaptcha } from "./useSmartCaptcha";

/** Поля под «Уточнить поиск»: ошибка в них раскрывает блок, иначе её не видно. */
const DETAIL_FIELDS: ReadonlySet<string> = new Set(["aliases", "inn", "website", "employer", "position"]);

function FieldError({ id, text }: { id: string; text: string | undefined }) {
  if (!text) return null;
  return (
    <p className="site-error" id={id}>
      <ErrorIcon />
      <span>{text}</span>
    </p>
  );
}

function TextField(props: {
  id: string;
  label: string;
  required?: boolean;
  error?: string;
  hint?: ReactNode;
  input: Omit<React.InputHTMLAttributes<HTMLInputElement>, "id" | "className">;
  inputRef?: React.Ref<HTMLInputElement>;
  /** Когда поле считается заполненным, если «не пусто» не подходит (дата — только полная). */
  filled?: boolean;
}) {
  const hintId = props.hint ? `${props.id}-hint` : null;
  const errorId = props.error ? `${props.id}-error` : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const filled = props.filled ?? String(props.input.value ?? "").trim() !== "";
  return (
    <div className="site-field">
      <label className={`site-label${props.required ? " site-label--req" : ""}`} htmlFor={props.id}>
        {props.label}
        {props.required ? <span className="site-visually-hidden">, обязательное поле</span> : null}
      </label>
      <input
        {...props.input}
        ref={props.inputRef}
        className={`site-input${filled ? " is-filled" : ""}`}
        id={props.id}
        aria-required={props.required || undefined}
        aria-invalid={props.error ? true : undefined}
        aria-describedby={describedBy}
      />
      {props.hint ? (
        <p className="site-hint" id={hintId!}>
          {props.hint}
        </p>
      ) : null}
      <FieldError id={`${props.id}-error`} text={props.error} />
    </div>
  );
}

function DisabledPanel() {
  return (
    <div className="site-panel site-panel--form" role="status">
      <div className="site-panel__head">
        <h2 className="site-panel__title" id="form-title">
          {CHECK_FORM_TEXT.disabledTitle}
        </h2>
        <p className="site-caption">{CHECK_FORM_TEXT.disabledCaption}</p>
      </div>
    </div>
  );
}

export function CheckForm() {
  const router = useRouter();
  const [values, setValues] = useState<CheckFormValues>(EMPTY_CHECK_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [config, setConfig] = useState<SitePublicConfig | null>(null);
  const started = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const birthInput = useRef<HTMLInputElement>(null);
  const summaryBox = useRef<HTMLDivElement>(null);
  const captcha = useSmartCaptcha(config?.captchaClientKey ?? null);

  useEffect(() => {
    let alive = true;
    void siteApi.config().then((res) => {
      if (alive && res.ok) setConfig(res.data);
    });
    return () => {
      alive = false;
    };
  }, []);

  // «Проверить бесплатно» в конце страницы и «Изменить данные» в мастере ведут к форме:
  // курсор сразу в первом поле.
  useEffect(() => {
    const focusIfAsked = () => {
      if (window.location.hash === "#form") nameInput.current?.focus({ preventScroll: true });
    };
    focusIfAsked();
    window.addEventListener("hashchange", focusIfAsked);
    return () => window.removeEventListener("hashchange", focusIfAsked);
  }, []);

  useEffect(() => {
    if (summary) summaryBox.current?.focus();
  }, [summary]);

  if (config && !config.selfCheckEnabled) return <DisabledPanel />;

  const progress = checkFormProgress(values);

  function update<K extends keyof CheckFormValues>(field: K, value: CheckFormValues[K]) {
    if (!started.current) {
      started.current = true;
      track("form_start");
    }
    const next = { ...values, [field]: value };
    setValues(next);
    if (errors[field]) {
      const fresh = checkFormErrors(next);
      setErrors((prev) => {
        const copy = { ...prev };
        if (fresh[field]) copy[field] = fresh[field]!;
        else delete copy[field];
        return copy;
      });
    }
  }

  function showErrors(found: FieldErrors) {
    setErrors(found);
    if (Object.keys(found).some((field) => DETAIL_FIELDS.has(field))) setDetailsOpen(true);
    setSummary(null);
    // Новый текст сводки — новый фокус, даже если текст тот же.
    requestAnimationFrame(() => setSummary(CHECK_FORM_TEXT.summary));
  }

  function showFailure(text: string) {
    setSummary(null);
    requestAnimationFrame(() => setSummary(text));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const found = checkFormErrors(values);
    if (Object.keys(found).length > 0) {
      showErrors(found);
      return;
    }
    setBusy(true);
    setSummary(null);

    let token: string | undefined;
    if (config?.captchaClientKey) {
      try {
        token = await captcha.execute();
      } catch {
        setBusy(false);
        showFailure(CHECK_FORM_TEXT.captchaFailed);
        return;
      }
    }

    const res = await siteApi.create(checkFormPayload(values, token));
    captcha.reset();
    if (res.ok) {
      track("form_submit");
      const id = "existingPublicId" in res.data ? res.data.existingPublicId : res.data.publicId;
      router.push(`/check/${encodeURIComponent(id)}`);
      return;
    }
    setBusy(false);
    if (res.status === 429) {
      router.push("/check/limit");
      return;
    }
    if (res.status === 503 && res.reason === "SELF_CHECK_DISABLED") {
      router.push("/check/disabled");
      return;
    }
    if (res.reason === "CAPTCHA_FAILED") {
      showFailure(CHECK_FORM_TEXT.captchaFailed);
      return;
    }
    const fieldErrors = serverFieldErrors(res.fieldErrors);
    if (res.status === 400 && Object.keys(fieldErrors).length > 0) {
      showErrors(fieldErrors);
      return;
    }
    showFailure(CHECK_FORM_TEXT.failed);
  }

  const shown = Object.keys(errors).length > 0;

  return (
    <form
      className={`site-panel site-panel--form${shown ? " is-errors" : ""}`}
      id="check-form"
      noValidate
      aria-labelledby="form-title"
      onSubmit={submit}
    >
      <div className="site-panel__meter" aria-hidden="true">
        <i id="form-meter" style={vars({ "--p": `${progress.meter}%` })} />
      </div>
      <div className="site-panel__head">
        <h2 className="site-panel__title" id="form-title">
          {CHECK_FORM_TEXT.title}
        </h2>
        <p className="site-caption">{CHECK_FORM_TEXT.caption}</p>
      </div>

      <div className="site-panel__body">
        <div className="site-form-summary" role="alert" tabIndex={-1} ref={summaryBox} hidden={!summary}>
          {summary}
        </div>

        <TextField
          id="full-name"
          label="Фамилия, имя и отчество"
          required
          error={errors.fullName}
          inputRef={nameInput}
          input={{
            name: "fullName",
            type: "text",
            autoComplete: "name",
            placeholder: "Фамилия Имя Отчество",
            value: values.fullName,
            onChange: (e) => update("fullName", e.target.value),
          }}
        />

        <div className="site-input-group site-input-group--2">
          <TextField
            id="birth-date"
            label="Дата рождения"
            required
            error={errors.birthDate}
            inputRef={birthInput}
            filled={birthDateToIso(values.birthDate) !== null}
            input={{
              name: "birthDate",
              type: "text",
              inputMode: "numeric",
              autoComplete: "bday",
              placeholder: "дд.мм.гггг",
              value: values.birthDate,
              onChange: (e) => {
                const field = e.target;
                const caret = field.selectionStart ?? field.value.length;
                const digitsBefore = field.value.slice(0, caret).replace(/\D/gu, "").length;
                const masked = maskBirthDate(field.value);
                update("birthDate", masked);
                // Поле перерисуется значением маски, и курсор уехал бы в конец
                requestAnimationFrame(() => {
                  const input = birthInput.current;
                  if (!input || document.activeElement !== input) return;
                  const at = caretAfterDigits(masked, digitsBefore);
                  input.setSelectionRange(at, at);
                });
              },
            }}
          />
          <TextField
            id="city"
            label="Город"
            error={errors.city}
            input={{
              name: "city",
              type: "text",
              autoComplete: "address-level2",
              placeholder: "Москва",
              value: values.city,
              onChange: (e) => update("city", e.target.value),
            }}
          />
        </div>

        <details
          className="site-details"
          id="form-details"
          open={detailsOpen}
          onToggle={(e) => setDetailsOpen(e.currentTarget.open)}
        >
          <summary>Уточнить поиск</summary>
          <div className="site-details__body">
            <p className="site-hint">Чем больше данных, тем точнее проверка отличит вас от однофамильцев.</p>
            <TextField
              id="aliases"
              label="Другие написания имени"
              error={errors.aliases}
              hint="Латиницей, прежняя фамилия, через запятую."
              input={{
                name: "aliases",
                type: "text",
                value: values.aliases,
                onChange: (e) => update("aliases", e.target.value),
              }}
            />
            <div className="site-input-group site-input-group--2">
              <TextField
                id="inn"
                label="ИНН"
                error={errors.inn}
                input={{
                  name: "inn",
                  type: "text",
                  inputMode: "numeric",
                  placeholder: "10 или 12 цифр",
                  value: values.inn,
                  onChange: (e) => update("inn", e.target.value),
                }}
              />
              <TextField
                id="website"
                label="Сайт"
                error={errors.website}
                input={{
                  name: "website",
                  type: "text",
                  inputMode: "url",
                  placeholder: "example.ru",
                  value: values.website,
                  onChange: (e) => update("website", e.target.value),
                }}
              />
            </div>
            <div className="site-input-group site-input-group--2">
              <TextField
                id="employer"
                label="Место работы"
                error={errors.employer}
                input={{
                  name: "employer",
                  type: "text",
                  autoComplete: "organization",
                  value: values.employer,
                  onChange: (e) => update("employer", e.target.value),
                }}
              />
              <TextField
                id="position"
                label="Должность"
                error={errors.position}
                input={{
                  name: "position",
                  type: "text",
                  autoComplete: "organization-title",
                  value: values.position,
                  onChange: (e) => update("position", e.target.value),
                }}
              />
            </div>
          </div>
        </details>

        <div className="site-hp" aria-hidden="true">
          <label htmlFor="company">Компания</label>
          <input
            id="company"
            name="company"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={values.company}
            onChange={(e) => update("company", e.target.value)}
          />
        </div>

        <div className="site-field">
          <label className={`site-check${errors.consent ? " is-invalid" : ""}`} id="consent-label" htmlFor="consent">
            <input
              id="consent"
              name="consent"
              type="checkbox"
              checked={values.consent}
              aria-invalid={errors.consent ? true : undefined}
              aria-describedby={errors.consent ? "consent-error" : undefined}
              onChange={(e) => update("consent", e.target.checked)}
            />
            <span>
              Даю согласие на обработку персональных данных для проверки упоминаний обо мне в открытых источниках (
              <a href="/legal/soglasie" target="_blank" rel="noopener">
                текст согласия
              </a>
              ).
            </span>
          </label>
          <FieldError id="consent-error" text={errors.consent} />
        </div>

        {config?.captchaClientKey ? <div ref={captcha.container} /> : null}

        <button
          className="site-btn site-btn--accent site-btn--lg site-btn--block"
          id="check-submit"
          type="submit"
          aria-busy={busy || undefined}
        >
          <span className="site-spinner" aria-hidden="true" />
          <span>{CHECK_FORM_TEXT.submit}</span>
          <ArrowIcon />
        </button>
      </div>

      <div className="site-panel__foot">
        <p className="site-tag">{CHECK_FORM_TEXT.scanTitle}</p>
        <ul className="site-scan" aria-label="Что будет проверено">
          {CHECK_FORM_TEXT.scan.map((item) => (
            <li key={item}>
              <span className="site-mark" style={vars({ "--w": "3ch" })} aria-hidden="true" />
              {item}
            </li>
          ))}
        </ul>
      </div>
    </form>
  );
}
