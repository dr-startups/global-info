import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Кнопка сайта — `<button>` и ссылка с видом кнопки.
 *
 * Классы `site-btn` живут только здесь: вид кнопки правится в одном месте
 * (`site-buttons-fields-and-faq-are-drawn-by-one-component.test.ts`). Варианты — полными
 * строками, а не собираются из значения: имя класса находит и поиск, и тест
 * `site-css-declares-only-classes-the-site-uses`.
 */

const VARIANT_CLASS = {
  accent: "site-btn--accent",
  secondary: "site-btn--secondary",
  ghost: "site-btn--ghost",
} as const;

interface ButtonLook {
  /** `accent` — решающее действие страницы; у остальных метки маркера нет. */
  variant: keyof typeof VARIANT_CLASS;
  large?: boolean;
  /** Во всю ширину контейнера. */
  block?: boolean;
  /** Стрелка после подписи. */
  arrow?: boolean;
  /** Классы сверх вида кнопки — у тех, чью разметку дополняет своё поведение. */
  className?: string;
  children: ReactNode;
}

function lookClass({ variant, large, block, className }: ButtonLook): string {
  return ["site-btn", VARIANT_CLASS[variant], large ? "site-btn--lg" : null, block ? "site-btn--block" : null, className]
    .filter(Boolean)
    .join(" ");
}

/** Стрелка решающей кнопки. */
function ArrowIcon() {
  return (
    <svg className="site-btn__arrow" viewBox="0 0 16 16" aria-hidden="true">
      <use href="#ic-arrow" />
    </svg>
  );
}

export function Button(
  props: ButtonLook & {
    type?: "button" | "submit";
    id?: string;
    disabled?: boolean;
    /**
     * Кнопка ждёт ответа сервера. Переданное значение (и `false`) ставит в разметку
     * спиннер, а подпись — в `<span>`: при смене состояния меняется только
     * `aria-busy`, спиннер показывает CSS, и кнопка не прыгает по ширине.
     */
    busy?: boolean;
    onClick?: () => void;
  }
) {
  const waits = props.busy !== undefined;
  return (
    <button
      className={lookClass(props)}
      id={props.id}
      type={props.type ?? "button"}
      disabled={props.disabled}
      aria-busy={props.busy || undefined}
      onClick={props.onClick}
    >
      {waits ? <span className="site-spinner" aria-hidden="true" /> : null}
      {waits ? <span>{props.children}</span> : props.children}
      {props.arrow ? <ArrowIcon /> : null}
    </button>
  );
}

/**
 * Ссылка с видом кнопки. Якорь на этой же странице (`#…`) — обычный `<a>`: форма
 * проверки ставит курсор в первое поле по событию `hashchange`, а переход `next/link`
 * меняет адрес через `history.pushState`, и события не было бы.
 */
export function ButtonLink(props: ButtonLook & { href: string; onClick?: () => void }) {
  const content = (
    <>
      {props.children}
      {props.arrow ? <ArrowIcon /> : null}
    </>
  );
  if (props.href.startsWith("#")) {
    return (
      <a className={lookClass(props)} href={props.href} onClick={props.onClick}>
        {content}
      </a>
    );
  }
  return (
    <Link className={lookClass(props)} href={props.href} onClick={props.onClick}>
      {content}
    </Link>
  );
}
