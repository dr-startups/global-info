import type { InputHTMLAttributes, ReactNode, Ref } from "react";
import { ErrorIcon } from "./SiteIcons";

/**
 * Поле формы сайта: подпись, поле ввода, подсказка и ошибка, связанные для
 * экранного диктора (`aria-describedby`, `aria-invalid`). Форма проверки и заявка
 * рисуют поля отсюда: классы `site-input` и `site-error` в другом коде не пишутся
 * (`site-buttons-fields-and-faq-are-drawn-by-one-component.test.ts`).
 */

/** Текст ошибки со значком; без текста не рисуется. */
export function FieldError({ id, text }: { id: string; text: string | undefined }) {
  if (!text) return null;
  return (
    <p className="site-error" id={id}>
      <ErrorIcon />
      <span>{text}</span>
    </p>
  );
}

export function TextField(props: {
  id: string;
  label: string;
  /** Подпись только для диктора: видимую роль подписи играет что-то рядом (переключатель способа связи). */
  labelHidden?: boolean;
  required?: boolean;
  /**
   * Ошибка поля. Строка печатается под полем. `{ id }` — ошибка общая для группы полей
   * и напечатана после группы через `FieldError`: поле только ссылается на неё, и
   * текст не прыгает, когда видимое поле группы меняется.
   */
  error?: string | { id: string };
  hint?: ReactNode;
  /** Поле скрыто, но остаётся в разметке — группа, где видно одно поле из нескольких. */
  hidden?: boolean;
  input: Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "className">;
  inputRef?: Ref<HTMLInputElement>;
  /** Когда поле считается заполненным, если «не пусто» не подходит (дата — только полная). */
  filled?: boolean;
}) {
  const hintId = props.hint ? `${props.id}-hint` : null;
  const ownError = typeof props.error === "string" && props.error ? props.error : undefined;
  const errorId = ownError ? `${props.id}-error` : typeof props.error === "object" ? props.error.id : null;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const filled = props.filled ?? String(props.input.value ?? "").trim() !== "";
  return (
    <div className="site-field" hidden={props.hidden}>
      <label
        className={props.labelHidden ? "site-visually-hidden" : `site-label${props.required ? " site-label--req" : ""}`}
        htmlFor={props.id}
      >
        {props.label}
        {props.required ? <span className="site-visually-hidden">, обязательное поле</span> : null}
      </label>
      <input
        {...props.input}
        ref={props.inputRef}
        className={`site-input${filled ? " is-filled" : ""}`}
        id={props.id}
        aria-required={props.required || undefined}
        aria-invalid={errorId ? true : undefined}
        aria-describedby={describedBy}
      />
      {props.hint ? (
        <p className="site-hint" id={hintId!}>
          {props.hint}
        </p>
      ) : null}
      <FieldError id={`${props.id}-error`} text={ownError} />
    </div>
  );
}
