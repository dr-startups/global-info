"use client";

/**
 * «Спасибо». Действие называется одинаково на всём пути: «Отправить заявку» →
 * «Заявка принята»; отметка о приёме — первый шаг того же списка «что будет
 * дальше», что был на заявке.
 */

import { useState, type Ref } from "react";
import { formatDay } from "@/modules/site/check/format";
import type { PublicStatusJson } from "@/modules/site/check/types";
import { RESULT_TEXT, THANKS_TEXT } from "@/modules/site/content/check";
import { Button } from "../Button";
import { CopyButton, CopyStatus, useCopyLink } from "./CopyLink";
import { nextStepsFor } from "./LeadScreen";

export function ThanksScreen({
  status,
  onBack,
  headingRef,
}: {
  status: PublicStatusJson;
  onBack: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const [acceptedAt] = useState(() => new Date());
  const copy = useCopyLink();
  const time = `${String(acceptedAt.getHours()).padStart(2, "0")}:${String(acceptedAt.getMinutes()).padStart(2, "0")}`;

  return (
    <section className="site-screen site-screen--split is-active site-enter" aria-labelledby="thanks-title">
      <div className="site-screen__main site-thanks">
        <span className="site-stamp" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <use href="#ic-check" />
          </svg>
        </span>
        <header className="site-screen__head">
          <h1 className="site-screen__title" id="thanks-title" tabIndex={-1} ref={headingRef}>
            {THANKS_TEXT.title}
          </h1>
          <p className="site-screen__lead">{THANKS_TEXT.lead}</p>
        </header>
        <ol className="site-timeline" aria-label="Что будет дальше">
          <li className="is-done">
            <b>{THANKS_TEXT.accepted}</b>
            <span>
              {THANKS_TEXT.todayAt} <time dateTime={acceptedAt.toISOString()}>{time}</time>
            </span>
          </li>
          {nextStepsFor(status).map(([title, text]) => (
            <li key={title}>
              <b>{title}</b>
              <span>{text}</span>
            </li>
          ))}
        </ol>
        <div className="site-actions">
          <Button variant="secondary" onClick={onBack}>
            {status.status === "FAILED" ? THANKS_TEXT.backFailed : THANKS_TEXT.back}
          </Button>
        </div>
      </div>
      <aside className="site-screen__aside" aria-labelledby="thanks-saved">
        <div className="site-slip site-ticks">
          <div className="site-slip__body">
            <h2 className="site-slip__subtitle" id="thanks-saved">
              {RESULT_TEXT.savedUntil(formatDay(status.expiresAt))}
            </h2>
            <p>{THANKS_TEXT.retention}</p>
            <CopyButton state={copy} variant="secondary" block />
            <CopyStatus state={copy} />
          </div>
        </div>
      </aside>
    </section>
  );
}
