/**
 * Детали экранов мастера: шапка проверки со степпером, доска с ходом, строки
 * источников, след поиска, кадр серии 5, рамка листа. Без состояния — их рисуют и
 * страницы, собранные на сервере (`/check/limit`, `/check/disabled`).
 */

import Image from "next/image";
import Link from "next/link";
import type { ReactNode, Ref } from "react";
import { formatBirthDate } from "@/modules/site/check/format";
import type { PersonaTrailRow } from "@/modules/site/check/persona-view";
import { STEP_LABELS, type ServiceAction, type ServiceScreenContent } from "@/modules/site/content/check";
import { Button, ButtonLink } from "../Button";
import { vars } from "../css-vars";
import { SourceSign } from "../SiteIcons";

export function WizardBand({
  subject,
  step,
  editable,
}: {
  subject: { fullName: string; birthDate: string } | null;
  step: number;
  editable: boolean;
}) {
  // Шапка проверки видна только внутри сценария: на служебных экранах шагов нет.
  return (
    <div className="site-container site-wizard__band" hidden={step <= 0}>
      {subject ? (
        <div className="site-wizard__who">
          <p className="site-wizard__name">
            Проверка: <strong>{subject.fullName}</strong>, {formatBirthDate(subject.birthDate)}
          </p>
          {/* После запуска данные уже ушли в прогон, и ссылка обещала бы то, чего нельзя */}
          {editable ? (
            <Link className="site-wizard__edit" href="/#form">
              Изменить данные
            </Link>
          ) : null}
        </div>
      ) : null}
      <ol className="site-stepper" aria-label="Шаги проверки">
        {STEP_LABELS.map((label, i) => {
          const n = i + 1;
          return (
            <li
              key={label}
              className={n < step ? "is-done" : n === step ? "is-current" : undefined}
              aria-current={n === step ? "step" : undefined}
            >
              <span className="site-stepper__label">
                {label}
                <span className="site-visually-hidden site-stepper__state">{n < step ? ", пройден" : ""}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Лист мастера: шапка проверки на столе, под ней белый лист с экраном. */
export function WizardFrame({ band, children }: { band?: ReactNode; children: ReactNode }) {
  return (
    <main className="site-wizard" id="main">
      {band ?? <div className="site-container site-wizard__band" hidden />}
      <div className="site-wizard__sheet">
        <div className="site-container">{children}</div>
      </div>
    </main>
  );
}

/*
 * Тон → класс — таблицами, а не сборкой имени из значения: полное имя видят поиск и тест
 * `site-css-declares-only-classes-the-site-uses`, а полноту таблицы проверяет TypeScript.
 */

export { VERDICT_TONE_CLASS } from "../Dial";

/** Ответ источника: у результата — есть ответ или нет, у панели персоны ещё «не подключён». */
const LEDGER_TONE_CLASS = { ok: "is-ok", warn: "is-warn", off: "is-off" } as const;

/**
 * Строка источника в панели поиска и в следе: «спрашиваем», «есть совпадения»,
 * «совпадений нет», «не ответил», «не подключён».
 */
const SOURCE_TONE_CLASS = {
  asking: "is-asking",
  hit: "is-hit",
  none: "",
  warn: "is-warn",
  off: "is-off",
} as const;

const STATUS_TONE_CLASS: Record<NonNullable<ServiceScreenContent["tone"]>, string> = {
  warn: "site-status--warn",
  danger: "site-status--danger",
};

/** Знак источника панели персоны: тот же предмет, что в схеме «Где мы ищем». */
export const PERSONA_SOURCE_SIGN = {
  wikipedia: "sg-open",
  knowledge_graph: "sg-panel",
  opensanctions: "sg-list",
} as const;

export function Ledger({
  rows,
  inline,
  label,
}: {
  rows: ReadonlyArray<{ name: string; value: string | null; tone: keyof typeof LEDGER_TONE_CLASS }>;
  inline?: boolean;
  label?: string;
}) {
  return (
    <ul className={`site-ledger${inline ? " site-ledger--inline" : ""}`} aria-label={label}>
      {rows.map((row) => (
        <li key={row.name} className={LEDGER_TONE_CLASS[row.tone]}>
          <span className="site-ledger__name">{row.name}</span>
          {row.value ? <span className="site-ledger__value">{row.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Доска: панель с ходом по верхней кромке. Общий предмет для «где искали», «что
 * проверено» и «что будет дальше» — ход по кромке тот же приём, что шкала
 * заполнения формы на главной.
 */
export function Board({
  meter,
  title,
  count,
  head,
  children,
}: {
  meter?: number;
  title?: string;
  count?: ReactNode;
  /** Шапка доски до её тела — например, строка поиска. */
  head?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="site-board site-ticks">
      {meter === undefined ? null : (
        <div className="site-board__meter" aria-hidden="true">
          <i style={vars({ "--p": meter })} />
        </div>
      )}
      {head}
      {title ? (
        <div className="site-board__head">
          <h2 className="site-board__title">{title}</h2>
          {count ? <p className="site-board__count">{count}</p> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export interface SourceRow {
  source: keyof typeof PERSONA_SOURCE_SIGN;
  name: string;
  state: string;
  mark: string;
  tone: keyof typeof SOURCE_TONE_CLASS;
}

/** Строки источников панели поиска: знак, имя, состояние словами, отметка справа. */
export function SourceRows({ rows, label }: { rows: readonly SourceRow[]; label?: string }) {
  return (
    <ul className="site-sources" aria-label={label}>
      {rows.map((row) => (
        <li key={row.source} className={SOURCE_TONE_CLASS[row.tone] || undefined}>
          <SourceSign id={PERSONA_SOURCE_SIGN[row.source]} />
          <span className="site-sources__name">{row.name}</span>
          <span className="site-sources__state">{row.state}</span>
          <span className="site-sources__mark" aria-hidden="true">
            {row.tone === "asking" ? <span className="site-spinner" /> : row.mark}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Строка поиска панели: имя со свечением. Это показание работы, а не поле ввода,
 * поэтому она скрыта от экранного диктора — соседние строки источников говорят
 * то же самое словами.
 */
export function SeekBar({ query, typing }: { query: string; typing?: boolean }) {
  return (
    <div className={typing ? "site-seek is-typing" : "site-seek"} aria-hidden="true">
      <div className="site-seek__field">
        <div className="site-seek__aura">
          <i />
        </div>
        <div className="site-seek__bar">
          <svg className="site-seek__icon" viewBox="0 0 18 18" aria-hidden="true">
            <use href="#ic-search" />
          </svg>
          <span className="site-seek__query">
            <span className="site-seek__word">{query}</span>
            {typing ? <span className="site-seek__caret" /> : null}
          </span>
        </div>
      </div>
    </div>
  );
}

/** След поиска: запрос и три источника одной полосой — малая схема «Где мы ищем». */
export function Trail({ query, rows }: { query: string; rows: readonly PersonaTrailRow[] }) {
  return (
    <div className="site-trail" role="group" aria-label="Где искали совпадения">
      <p className="site-trail__query">
        <svg viewBox="0 0 18 18" aria-hidden="true">
          <use href="#ic-search" />
        </svg>
        <span>{query}</span>
      </p>
      <ol className="site-trail__nodes">
        {rows.map((row, i) => (
          <li key={row.source} className={SOURCE_TONE_CLASS[row.tone] || undefined} style={vars({ "--i": i })}>
            <SourceSign id={PERSONA_SOURCE_SIGN[row.source]} />
            <span className="site-trail__name">{row.name}</span>
            <span className="site-trail__state">{row.state}</span>
            <span className="site-sources__mark" aria-hidden="true">
              {row.mark}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Кадры серии 5 на экранах мастера: имя файла в `public/site/check`. */
export const CHECK_ART = {
  persona: { name: "check-persona", width: 1600, height: 679 },
  waiting: { name: "check-waiting", width: 1600, height: 1073 },
  found: { name: "check-found", width: 1600, height: 679 },
  clean: { name: "check-clean", width: 1600, height: 679 },
  unknown: { name: "check-unknown", width: 1600, height: 679 },
  thanks: { name: "check-thanks", width: 1600, height: 1073 },
  pause: { name: "check-pause", width: 1600, height: 1073 },
} as const;

/**
 * Кадр серии 5 на бумаге. Декоративный: `alt` пустой — всё, что кадр говорит,
 * сказано словами рядом.
 */
export function Art({
  frame,
  wideOnly,
  fill,
  priority,
}: {
  frame: keyof typeof CHECK_ART;
  /** На узком экране кадр не нужен: там важнее само действие. */
  wideOnly?: boolean;
  /** Высоту задаёт соседняя колонка, а не пропорция картинки. */
  fill?: boolean;
  priority?: boolean;
}) {
  const art = CHECK_ART[frame];
  const className = ["site-art", wideOnly ? "site-art--wide-only" : null, fill ? "site-art--fill" : null]
    .filter(Boolean)
    .join(" ");
  return (
    <figure className={className} aria-hidden="true">
      <Image
        src={`/site/check/${art.name}.webp`}
        width={art.width}
        height={art.height}
        sizes="(min-width: 1024px) 520px, 100vw"
        alt=""
        {...(priority ? { priority: true } : { loading: "lazy" as const })}
      />
    </figure>
  );
}

/**
 * Кадр шапкой листа действия: широкая полоса, уходящая в чернила маской. Кадр
 * стоит внутри тёмной панели, поэтому у него своё место по горизонтали — лицо
 * кадра не должно уезжать под текст.
 */
export function SlipArt({ frame, position }: { frame: keyof typeof CHECK_ART; position: string }) {
  const art = CHECK_ART[frame];
  return (
    <figure className="site-slip__art" style={vars({ "--pos": position })} aria-hidden="true">
      <Image
        src={`/site/check/${art.name}.webp`}
        width={art.width}
        height={art.height}
        sizes="(min-width: 1024px) 420px, 100vw"
        alt=""
        loading="lazy"
      />
    </figure>
  );
}

/**
 * Служебный экран: слева — что случилось и что делать, справа — кадр и доска с
 * тем, что стало с данными. Без цветной плашки ошибки: человеку, который
 * проверяет свою репутацию, достаточно объяснения, а не красной тревоги.
 *
 * Кнопки — отдельный блок после фактов, а не часть заголовка: на телефоне человек
 * сначала дочитывает, что стало с данными, и действие ждёт его внизу, под пальцем.
 * На широком экране сетка возвращает блок под подводку.
 */
export function ServiceScreen({
  content,
  onAction,
  headingRef,
}: {
  content: ServiceScreenContent;
  onAction?: (action: NonNullable<ServiceAction["action"]>) => void;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <section
      className="site-screen site-screen--split site-screen--service site-screen--even is-active site-enter"
      aria-labelledby="service-title"
    >
      <div className="site-screen__head">
        <p className={`site-status${content.tone ? ` ${STATUS_TONE_CLASS[content.tone]}` : ""}`}>{content.status}</p>
        <h1 className="site-screen__title" id="service-title" tabIndex={-1} ref={headingRef}>
          {content.title}
        </h1>
        <p className="site-screen__lead">{content.lead}</p>
      </div>
      {content.facts ? (
        <div className="site-screen__aside">
          <Art frame="pause" fill />
          <Board title={content.asideTitle}>
            <div className="site-board__body">
              <dl className="site-facts">
                {content.facts.map(([term, value]) => (
                  <div key={term}>
                    <dt>{term}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </Board>
        </div>
      ) : null}
      {content.actions.length > 0 ? (
        <div className="site-actions site-screen__actions">
          {content.actions.map((action) => {
            const look = { variant: action.variant, large: true, arrow: action.variant === "accent" };
            return action.href ? (
              <ButtonLink key={action.label} {...look} href={action.href}>
                {action.label}
              </ButtonLink>
            ) : (
              <Button key={action.label} {...look} onClick={() => action.action && onAction?.(action.action)}>
                {action.label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
