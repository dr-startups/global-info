/**
 * Детали экранов мастера: шапка проверки со степпером, шкала риска, ответы
 * источников, рамка листа. Без состояния — их рисуют и страницы, собранные на
 * сервере (`/check/limit`, `/check/disabled`).
 */

import Link from "next/link";
import type { ReactNode, Ref } from "react";
import { formatBirthDate } from "@/modules/site/check/format";
import type { RiskTone, ScaleView } from "@/modules/site/check/result-view";
import { STEP_LABELS, type ServiceAction, type ServiceScreenContent } from "@/modules/site/content/check";
import { Button, ButtonLink } from "../Button";
import { vars } from "../css-vars";

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

export const METER_TONE_CLASS: Record<RiskTone, string> = {
  low: "site-meter--low",
  medium: "site-meter--medium",
  high: "site-meter--high",
  none: "site-meter--none",
};

export const VERDICT_TONE_CLASS: Record<RiskTone, string> = {
  low: "site-verdict--low",
  medium: "site-verdict--medium",
  high: "site-verdict--high",
  none: "site-verdict--none",
};

/** Ответ источника: у результата — есть ответ или нет, у панели персоны ещё «не подключён». */
const LEDGER_TONE_CLASS = { ok: "is-ok", warn: "is-warn", off: "is-off" } as const;

const STATUS_TONE_CLASS: Record<NonNullable<ServiceScreenContent["tone"]>, string> = {
  warn: "site-status--warn",
  danger: "site-status--danger",
};

export function MeterSegments({ filled, animate }: { filled: number; animate?: boolean }) {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={`site-meter__seg${i < filled ? " is-on" : ""}`}
          style={animate ? vars({ "--i": i }) : undefined}
        />
      ))}
    </>
  );
}

export function RiskScale({ scale, decorative }: { scale: ScaleView; decorative?: boolean }) {
  return (
    <div className="site-scale">
      <div
        className={`site-meter ${METER_TONE_CLASS[scale.tone]} site-meter--lg`}
        role={decorative ? undefined : "img"}
        aria-label={decorative ? undefined : scale.ariaLabel}
        aria-hidden={decorative || undefined}
      >
        <MeterSegments filled={scale.filled} animate />
      </div>
      <ol className="site-scale__labels" aria-hidden="true">
        {scale.labels.map((label, i) => (
          <li key={label} className={i === scale.filled - 1 ? "is-level" : undefined}>
            {label}
          </li>
        ))}
      </ol>
    </div>
  );
}

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
 * Служебный экран: слева — что случилось и что делать, справа — что стало с
 * данными. Без цветной плашки ошибки: человеку, который проверяет свою
 * репутацию, достаточно объяснения, а не красной тревоги.
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
      className="site-screen site-screen--split site-screen--service is-active site-enter"
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
          <h2 className="site-screen__subtitle">{content.asideTitle}</h2>
          <dl className="site-facts">
            {content.facts.map(([term, value]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
      {content.actions.length > 0 ? (
        <div className="site-actions site-screen__actions">
          {content.actions.map((action) => {
            const look = {
              variant: action.variant,
              large: action.variant !== "ghost",
              arrow: action.variant === "accent",
            };
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
