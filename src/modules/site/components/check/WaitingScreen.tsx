"use client";

/**
 * Ожидание: прошедшее время, прогресс, стадии и пустая шкала риска — человек
 * заранее знает, что получит. Прошедшее время — текст раз в секунду, без
 * анимации: это показание, а не украшение.
 */

import { useEffect, useState, type Ref } from "react";
import { scaleView } from "@/modules/site/check/result-view";
import { waitingView, type RunJson } from "@/modules/site/check/waiting-view";
import { WAITING_TEXT } from "@/modules/site/content/check";
import { vars } from "../css-vars";
import { CopyButton, CopyStatus, useCopyLink } from "./CopyLink";
import { RiskScale } from "./parts";

export function WaitingScreen({ run, headingRef }: { run: RunJson; headingRef: Ref<HTMLHeadingElement> }) {
  const [now, setNow] = useState(() => Date.now());
  const copy = useCopyLink();

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const view = waitingView(run, now);

  return (
    <section
      className="site-screen site-screen--split site-screen--aside-wide is-active site-enter"
      aria-labelledby="waiting-title"
    >
      <div className="site-screen__head">
        <h1 className="site-screen__title" id="waiting-title" tabIndex={-1} ref={headingRef}>
          {WAITING_TEXT.title}
        </h1>
        <p className="site-screen__lead">{WAITING_TEXT.lead}</p>
        <div className="site-actions">
          <CopyButton state={copy} variant="secondary" />
        </div>
        <CopyStatus state={copy} />
      </div>

      <div className="site-run site-ticks">
        <div className="site-run__top">
          <p className="site-run__time">
            <span role="timer">{view.elapsedText}</span>
            <span className="site-run__unit">{WAITING_TEXT.elapsed}</span>
          </p>
          <div
            className="site-run__meter"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={view.percent}
            aria-labelledby="waiting-label"
          >
            <i style={vars({ "--p": view.percent / 100 })} />
          </div>
          <p className="site-run__pct" aria-hidden="true">
            <span>{view.percent}</span>
            {" %"}
          </p>
        </div>
        <p className="site-visually-hidden" id="waiting-label" aria-live="polite">
          {view.currentLabel}
        </p>
        <ol className="site-run__stages">
          {view.stages.map((stage) => (
            <li
              key={stage.key}
              className={stage.state === "done" ? "is-done" : stage.state === "current" ? "is-current" : undefined}
            >
              <span className="site-run__mark" aria-hidden="true">
                <svg viewBox="0 0 16 16">
                  <use href="#ic-check" />
                </svg>
              </span>
              <span className="site-run__stage">{stage.label}</span>
              <span className="site-run__state">{stage.stateWord}</span>
              <span className="site-run__what">{stage.what}</span>
            </li>
          ))}
        </ol>
        <div className="site-run__ghost">
          <RiskScale scale={scaleView(null)} decorative />
          <p className="site-caption">{WAITING_TEXT.ghost}</p>
        </div>
      </div>
    </section>
  );
}
