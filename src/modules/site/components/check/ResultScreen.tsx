"use client";

/**
 * Результат: показание дугой, темы раскрывающимися строками и лист действия.
 *
 * Показание — то же, что в отчёте: три ступени, число материалов внутри дуги.
 * Тема раскрывается строками о самих материалах, и в строках не выдуманные
 * заголовки, а прямая фраза о том, что заголовок скрыт: ручка заголовков не
 * отдаёт, и снятое размытие не должно показать материала, которого нет.
 *
 * Единственное действие экрана — единственный тёмный предмет на листе: лист
 * действия на чернилах с кадром серии 5 шапкой. На широком окне он справа и
 * держится, пока читаются темы; на телефоне стоит после того, что найдено.
 */

import { Fragment, type Ref } from "react";
import { formatDay } from "@/modules/site/check/format";
import { answeredLedger, dialView, resultView, sourcesAnswered, themeRows, type ResultJson } from "@/modules/site/check/result-view";
import type { PublicStatusJson } from "@/modules/site/check/types";
import { DISCLAIMER, NEXT_STEPS, RESULT_TEXT } from "@/modules/site/content/check";
import { Button, ButtonLink } from "../Button";
import { Dial } from "../Dial";
import { Blurred } from "../Hidden";
import { vars } from "../css-vars";
import { CopyButton, CopyStatus, useCopyLink } from "./CopyLink";
import { Board, Ledger, SlipArt, VERDICT_TONE_CLASS } from "./parts";

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

function Themes({ result }: { result: ResultJson }) {
  const rows = themeRows(result);
  let line = 0;
  return (
    <>
      <div className="site-themes">
        {rows.map((row, index) => (
          // Первая тема раскрыта: у экрана должно быть видно, что за строками стоит
          <details className={`site-theme ${VERDICT_TONE_CLASS[row.tone]}`} key={row.id} open={index === 0}>
            <summary>
              <span className="site-theme__name">{row.label}</span>
              {row.levelText ? <span className="site-theme__level">{row.levelText}</span> : null}
              <span className="site-theme__count">{row.countText}</span>
              <svg className="site-theme__chev" viewBox="0 0 20 20" aria-hidden="true">
                <use href="#ic-chev" />
              </svg>
              <span className="site-theme__bar" aria-hidden="true">
                <i style={vars({ "--p": row.fraction, "--i": index })} />
              </span>
            </summary>
            <div className="site-theme__body">
              <ul className="site-finding__list">
                {row.hidden.map((text) => (
                  <li key={text} style={vars({ "--i": line++ })}>
                    <Blurred text={text} label={RESULT_TEXT.hiddenMaterial} />
                  </li>
                ))}
              </ul>
            </div>
          </details>
        ))}
      </div>
      <p className="site-hidden-note">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <use href="#ic-hidden" />
        </svg>
        {RESULT_TEXT.hidden}
      </p>
    </>
  );
}

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
  const dial = dialView(result);
  const answered = sourcesAnswered(result.sourcesChecked);
  const copy = useCopyLink();
  const negative = view.verdict === "NEGATIVE_FOUND";

  const slipFoot = (
    <div className="site-slip__foot">
      <p>{RESULT_TEXT.savedUntil(formatDay(status.expiresAt))}</p>
      <CopyButton state={copy} variant="ghost" />
      <CopyStatus state={copy} />
    </div>
  );

  return (
    <section
      className={`site-screen site-result ${VERDICT_TONE_CLASS[view.scale.tone]}${negative ? "" : " site-result--even"} is-active site-enter${reveal ? " is-revealing" : ""}`}
      aria-labelledby="result-title"
    >
      <div className="site-result__verdict">
        <div className="site-result__head">
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
        </div>

        <div className="site-readout">
          <Dial
            filled={dial.filled}
            pointerAngle={dial.pointerAngle}
            ghost={dial.filled === 0}
            ticks
            num={dial.num}
            unit={dial.unit}
            labels={dial.labels}
            levelIndex={dial.levelIndex}
            ariaLabel={dial.ariaLabel}
          />
          <div className="site-readout__text">
            <p className="site-result__summary">
              {view.summary.map((part, i) =>
                part.strong ? <b key={i}>{part.text}</b> : <Fragment key={i}>{part.text}</Fragment>
              )}
            </p>
            {negative ? (
              <div className="site-readout__checked">
                <p>
                  Ответили <b>{answered.answered}</b> из {answered.total} групп источников
                </p>
                <Ledger rows={answeredLedger(result.sourcesChecked)} inline label={RESULT_TEXT.checkedTitle} />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="site-result__details">
        {negative ? (
          <Themes result={result} />
        ) : (
          <Board
            meter={answered.fraction}
            title={view.verdict === "CLEAN" ? RESULT_TEXT.CLEAN.ledgerTitle : RESULT_TEXT.INSUFFICIENT_DATA.ledgerTitle}
            count={
              <>
                ответили <b>{answered.answered}</b> из {answered.total}
              </>
            }
          >
            <div className="site-board__body">
              <Ledger rows={view.ledger} />
            </div>
          </Board>
        )}
      </div>

      <aside className="site-result__aside" aria-labelledby="result-next">
        <div className="site-slip site-slip--ink site-ticks">
          {view.verdict === "NEGATIVE_FOUND" ? (
            <>
              <SlipArt frame="found" position="38% 50%" />
              <div className="site-slip__body">
                <h2 className="site-slip__title" id="result-next">
                  {RESULT_TEXT.NEGATIVE_FOUND.slipTitle}
                </h2>
                <p>{RESULT_TEXT.NEGATIVE_FOUND.slipText}</p>
                <ul className="site-slip__list">
                  {NEXT_STEPS.NEGATIVE_FOUND.slice(1).map(([title, text]) => (
                    <li key={title}>
                      <b>{title}</b>
                      <span>{text}</span>
                    </li>
                  ))}
                </ul>
                <Button variant="accent" large block arrow onClick={onLead}>
                  {RESULT_TEXT.NEGATIVE_FOUND.cta}
                </Button>
              </div>
              {slipFoot}
            </>
          ) : view.verdict === "CLEAN" ? (
            <>
              <SlipArt frame="clean" position="50% 50%" />
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
            <>
              <SlipArt frame="unknown" position="45% 50%" />
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
            </>
          )}
        </div>
      </aside>

      <div className="site-result__foot">
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
