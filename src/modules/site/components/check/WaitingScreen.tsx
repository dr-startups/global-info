"use client";

/**
 * Ожидание: циферблат хода, стадии с составом и «призрак» будущего показания —
 * человек заранее знает, что получит. Прошедшее время — текст раз в секунду, без
 * анимации: это показание, а не украшение.
 *
 * Циферблат — шестьдесят рисок по кругу, пройденные чернилами: тот же язык, что
 * уголки приводки листа. По внутренней дорожке идёт отблеск выделителя — работа
 * видна и между ответами опроса, но ход при этом не выдумывается.
 */

import type { Ref } from "react";
import { waitingView, type RunJson } from "@/modules/site/check/waiting-view";
import { WAITING_TEXT } from "@/modules/site/content/check";
import { vars } from "../css-vars";
import { Dial } from "../Dial";
import { CopyButton, CopyStatus, LinkBox, useCopyLink } from "./CopyLink";
import { Art } from "./parts";
import { useElapsed } from "./timers";

/** Пустые строки будущего результата — пунктиром, как всякое пустое место на сайте. */
const GHOST_BARS = ["78%", "54%", "66%"];

function Gauge({ percent, elapsed, labelledBy }: { percent: number; elapsed: string; labelledBy: string }) {
  return (
    <div
      className="site-gauge"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-labelledby={labelledBy}
    >
      <svg viewBox="0 0 220 220" aria-hidden="true">
        <defs>
          <mask id="gauge-done" maskUnits="userSpaceOnUse" x="0" y="0" width="220" height="220">
            <circle
              cx="110"
              cy="110"
              r="97"
              fill="none"
              stroke="#fff"
              strokeWidth="26"
              pathLength={100}
              strokeDasharray={`${percent} 100`}
            />
          </mask>
        </defs>
        <circle className="site-gauge__glint" cx="110" cy="110" r="80" pathLength={100} strokeDasharray="16 84" />
        <g fill="none" transform="rotate(-90 110 110)" className="site-gauge__rest">
          <circle cx="110" cy="110" r="100" strokeWidth="9" strokeDasharray="2 8.472" strokeDashoffset="1" />
          <circle cx="110" cy="110" r="97" strokeWidth="15" strokeDasharray="1.94 48.849" strokeDashoffset="0.97" />
        </g>
        <g fill="none" transform="rotate(-90 110 110)" className="site-gauge__on" mask="url(#gauge-done)">
          <circle cx="110" cy="110" r="100" strokeWidth="9" strokeDasharray="2 8.472" strokeDashoffset="1" />
          <circle cx="110" cy="110" r="97" strokeWidth="15" strokeDasharray="1.94 48.849" strokeDashoffset="0.97" />
        </g>
      </svg>
      <div className="site-gauge__read">
        <p className="site-gauge__pct" aria-hidden="true">
          <span>{percent}</span>
          <small>%</small>
        </p>
        <p className="site-gauge__time">
          <span role="timer">{elapsed}</span> {WAITING_TEXT.elapsed}
        </p>
      </div>
    </div>
  );
}

export function WaitingScreen({
  run,
  publicId,
  headingRef,
}: {
  run: RunJson;
  publicId: string;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const copy = useCopyLink();
  const startedAt = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const elapsed = useElapsed(Number.isFinite(startedAt) ? startedAt : null);
  const view = waitingView(run, Date.now());

  return (
    <section
      className="site-screen site-screen--split site-screen--aside-wide site-screen--even is-active site-enter"
      aria-labelledby="waiting-title"
    >
      <div className="site-screen__head">
        <h1 className="site-screen__title" id="waiting-title" tabIndex={-1} ref={headingRef}>
          {WAITING_TEXT.title}
        </h1>
        <p className="site-screen__lead">{WAITING_TEXT.lead}</p>
        <LinkBox publicId={publicId}>
          <CopyButton state={copy} variant="secondary" />
        </LinkBox>
        <CopyStatus state={copy} />
        <Art frame="waiting" wideOnly />
      </div>

      <div className="site-run site-ticks">
        <div className="site-run__main">
          <div className="site-run__dial">
            <Gauge percent={view.percent} elapsed={elapsed} labelledBy="waiting-label" />
          </div>

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
                <span className="site-run__tags">
                  {stage.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </span>
              </li>
            ))}
          </ol>
        </div>
        <p className="site-visually-hidden" id="waiting-label" aria-live="polite">
          {view.currentLabel}
        </p>

        <div className="site-run__ghost">
          <div className="site-run__ghostrow">
            <Dial filled={0} ghost />
            <div className="site-run__ghostbars" aria-hidden="true">
              {GHOST_BARS.map((width) => (
                <i key={width} style={vars({ "--w": width })} />
              ))}
            </div>
          </div>
          <p className="site-caption">{WAITING_TEXT.ghost}</p>
        </div>
      </div>
    </section>
  );
}
