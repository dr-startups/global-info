"use client";

/**
 * Результат: уровень → действие → подробности. На широком окне лист действия
 * справа и держится, пока читаются темы; на телефоне стоит сразу под вердиктом.
 * Материалы сгруппированы по темам, и число материалов видно числом закрашенных
 * строк: ни заголовков, ни ссылок, ни доменов.
 */

import { Fragment, type Ref } from "react";
import { formatDay } from "@/modules/site/check/format";
import { resultView, type ResultJson } from "@/modules/site/check/result-view";
import type { PublicStatusJson } from "@/modules/site/check/types";
import { DISCLAIMER, RESULT_TEXT } from "@/modules/site/content/check";
import { Button, ButtonLink } from "../Button";
import { vars } from "../css-vars";
import { CopyButton, CopyStatus, useCopyLink } from "./CopyLink";
import { Ledger, RiskScale, VERDICT_TONE_CLASS } from "./parts";

/** Ширины плашек по кругу: одинаковые полосы читались бы таблицей, а не скрытыми заголовками. */
const BAR_WIDTHS = ["78%", "54%", "84%", "66%", "72%", "58%", "80%", "62%"];

/** Проверка без результата (его не должно быть у DONE) печатается как «данных недостаточно». */
const NO_RESULT: ResultJson = {
  verdict: "INSUFFICIENT_DATA",
  riskLevel: null,
  materialsFound: 0,
  findingsTotal: 0,
  themes: [],
  partial: false,
  sourcesChecked: [],
  checkedAt: null,
};

export function ResultScreen({
  status,
  reveal,
  onLead,
  headingRef,
}: {
  status: PublicStatusJson;
  reveal: boolean;
  onLead: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const result = status.result ?? NO_RESULT;
  const view = resultView(result);
  const copy = useCopyLink();
  let bar = 0;

  const slipFoot = (
    <div className="site-slip__foot">
      <p>{RESULT_TEXT.savedUntil(formatDay(status.expiresAt))}</p>
      <CopyButton state={copy} variant="ghost" />
      <CopyStatus state={copy} />
    </div>
  );

  return (
    <section
      className={`site-screen site-result ${VERDICT_TONE_CLASS[view.scale.tone]} is-active site-enter${reveal ? " is-revealing" : ""}`}
      aria-labelledby="result-title"
    >
      <div className="site-result__verdict">
        {view.checkedAtText ? <p className="site-result__date">{view.checkedAtText}</p> : null}
        <h1 className="site-result__level" id="result-title" tabIndex={-1} ref={headingRef}>
          {view.title.word ? (
            <>
              <span className="site-result__word">{view.title.word}</span> {view.title.text}
            </>
          ) : (
            view.title.text
          )}
        </h1>
        <RiskScale scale={view.scale} />
        <p className="site-result__summary">
          {view.summary.map((part, i) => (part.strong ? <b key={i}>{part.text}</b> : <Fragment key={i}>{part.text}</Fragment>))}
        </p>
      </div>

      <aside className="site-result__aside" aria-labelledby="result-next">
        <div className="site-slip site-ticks">
          {view.verdict === "NEGATIVE_FOUND" ? (
            <>
              <div className="site-slip__body">
                <h2 className="site-slip__title" id="result-next">
                  {RESULT_TEXT.NEGATIVE_FOUND.slipTitle}
                </h2>
                <p>{RESULT_TEXT.NEGATIVE_FOUND.slipText}</p>
                <Button variant="accent" large block arrow onClick={onLead}>
                  {RESULT_TEXT.NEGATIVE_FOUND.cta}
                </Button>
              </div>
              {slipFoot}
            </>
          ) : view.verdict === "CLEAN" ? (
            <>
              <div className="site-slip__body">
                <h2 className="site-slip__title" id="result-next">
                  {RESULT_TEXT.CLEAN.slipTitle}
                </h2>
                <p>{RESULT_TEXT.CLEAN.slipText}</p>
                <div className="site-slip__actions">
                  <ButtonLink variant="accent" large block arrow href="/#form">
                    {RESULT_TEXT.CLEAN.cta}
                  </ButtonLink>
                  <Button variant="secondary" block onClick={onLead}>
                    {RESULT_TEXT.CLEAN.secondary}
                  </Button>
                </div>
              </div>
              {slipFoot}
            </>
          ) : (
            <div className="site-slip__body">
              <h2 className="site-slip__title" id="result-next">
                {RESULT_TEXT.INSUFFICIENT_DATA.slipTitle}
              </h2>
              <p>{RESULT_TEXT.INSUFFICIENT_DATA.slipText}</p>
              <div className="site-slip__actions">
                <Button variant="accent" large block arrow onClick={onLead}>
                  {RESULT_TEXT.INSUFFICIENT_DATA.cta}
                </Button>
                <ButtonLink variant="secondary" block href="/#form">
                  {RESULT_TEXT.INSUFFICIENT_DATA.secondary}
                </ButtonLink>
              </div>
            </div>
          )}
        </div>
      </aside>

      <div className="site-result__details">
        {view.groups.length > 0 ? (
          <>
            <div className="site-findings">
              {view.groups.map((group, gi) => (
                <div className="site-finding" key={group.label ?? `group-${gi}`}>
                  <h2 className="site-finding__theme">
                    <span className="site-finding__label">
                      {group.label ? <span className="site-topics__name">{group.label}</span> : null}
                    </span>
                    <span className="site-finding__count">{group.countText}</span>
                  </h2>
                  <ul className="site-finding__list">
                    {Array.from({ length: group.bars }, () => bar++).map((index) => (
                      <li key={index}>
                        <span
                          className="site-mark"
                          style={vars({ "--w": BAR_WIDTHS[index % BAR_WIDTHS.length]!, "--i": index })}
                          role="img"
                          aria-label="Материал, заголовок скрыт"
                        />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="site-caption">{RESULT_TEXT.hidden}</p>
          </>
        ) : null}

        {view.ledger.length > 0 ? (
          <>
            <h2 className="site-screen__subtitle">
              {view.verdict === "CLEAN" ? RESULT_TEXT.CLEAN.ledgerTitle : RESULT_TEXT.INSUFFICIENT_DATA.ledgerTitle}
            </h2>
            <Ledger rows={view.ledger} />
          </>
        ) : null}

        {view.partialNote ? (
          // Частичный сбор — заметка на полях, а не цветная плашка: результат при этом есть.
          <div className="site-note">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <use href="#ic-warn" />
            </svg>
            <p>
              <b>{RESULT_TEXT.partial}</b> {view.partialNote}
            </p>
          </div>
        ) : null}
        <p className="site-disclaimer">{DISCLAIMER}</p>
      </div>
    </section>
  );
}
