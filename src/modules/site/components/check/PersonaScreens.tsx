"use client";

/**
 * Уточнение: поиск упоминаний, «Кто из них вы?», запуск после записанного решения.
 * Экрана «Уточнять нечего» нет: без карточек проверку запускает сервер
 * (`buildSelfCheckPersona`), и мастер переходит от поиска прямо к ожиданию.
 *
 * Кандидаты — картотека: карточка с язычком источника, бумагой и сиреневой
 * кромкой действия. «Это я» на карточке — отметка: карточек одного человека
 * бывает несколько (статья и запись санкционной базы у публичного лица —
 * предложение владельца 24.09.2026), поэтому проверку запускает отдельная кнопка
 * под картотекой. Отмеченная карточка вынимается из ряда (контур и жёсткая
 * тень); на запуске остальные уходят из фокуса: видно, по какому выбору пошла
 * проверка. Вымарки чёрным нет — скрытое на сайте показывается расфокусом
 * (владелец 19.09.2026).
 */

import { useState, type Ref } from "react";
import {
  cardSourceLabel,
  personaCardMatchNote,
  personaCardText,
  personaLedger,
  personaTrailRows,
  PERSONA_SOURCE_ROWS,
  type PersonaCardJson,
  type PersonaPanelJson,
} from "@/modules/site/check/persona-view";
import { PERSONA_TEXT, RESULT_TEXT } from "@/modules/site/content/check";
import { Button } from "../Button";
import { SourceSign } from "../SiteIcons";
import { Art, Board, Ledger, PERSONA_SOURCE_SIGN, SeekBar, SourceRows, Trail, type SourceRow } from "./parts";
import { useElapsed } from "./timers";

/** Пока панель собирается, у всех трёх источников одно состояние: запрос ушёл. */
const PROBE_ROWS: SourceRow[] = PERSONA_SOURCE_ROWS.map((row) => ({
  source: row.source,
  name: row.name,
  state: PERSONA_TEXT.probeState,
  mark: "",
  tone: "asking",
}));

function IdCard({
  card,
  picked,
  deciding,
  onToggle,
}: {
  card: PersonaCardJson;
  picked: boolean;
  /** Проверка запускается — отметки больше не меняются. */
  deciding: boolean;
  onToggle: (card: PersonaCardJson) => void;
}) {
  const text = personaCardText(card);
  const match = personaCardMatchNote(card);
  return (
    <article className={`site-idcard${picked ? " is-picked" : ""}`}>
      <p className="site-idcard__tab">
        <span className="site-tag">{cardSourceLabel(card.source)}</span>
      </p>
      <div className="site-idcard__sheet">
        <div className="site-idcard__body">
          <div className="site-idcard__head">
            <h2 className="site-idcard__title">{card.title}</h2>
            <SourceSign id={PERSONA_SOURCE_SIGN[card.source]} large />
          </div>
          {text ? <p className="site-idcard__text">{text}</p> : null}
          {match ? (
            <ul className="site-idcard__facts">
              <li className="site-card__match">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <use href="#ic-check" />
                </svg>
                {match}
              </li>
            </ul>
          ) : null}
        </div>
        <div className="site-idcard__foot">
          <Button variant={picked ? "accent" : "secondary"} pressed={picked} disabled={deciding} onClick={() => onToggle(card)}>
            {picked ? PERSONA_TEXT.unpick : PERSONA_TEXT.pick}
          </Button>
          {card.url ? (
            <a className="site-card__link" href={card.url} target="_blank" rel="noopener noreferrer">
              {PERSONA_TEXT.openArticle}
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <use href="#ic-ext" />
              </svg>
            </a>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function PersonaScreen({
  panel,
  fullName,
  picked,
  busy,
  onToggle,
  onStart,
  onNone,
  headingRef,
}: {
  panel: PersonaPanelJson;
  fullName: string;
  /** Отмеченные карточки — одного человека их может быть несколько. */
  picked: readonly string[];
  /** Идёт запуск: `picked` — по отмеченным, `none` — без персоны. */
  busy: "picked" | "none" | null;
  onToggle: (card: PersonaCardJson) => void;
  onStart: () => void;
  onNone: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const deciding = busy !== null;
  return (
    <section className="site-screen site-persona is-active site-enter" aria-labelledby="persona-title">
      <div className="site-persona__top">
        <header className="site-screen__head">
          <h1 className="site-screen__title" id="persona-title" tabIndex={-1} ref={headingRef}>
            {PERSONA_TEXT.title}
          </h1>
          <p className="site-screen__lead">{PERSONA_TEXT.lead(fullName)}</p>
        </header>
        <Art frame="persona" wideOnly priority />
      </div>

      {/* Где искали — до выбора: на телефоне рассказ идёт «что искали → что нашли → выбор» */}
      <Trail query={fullName} rows={personaTrailRows(panel.sources, panel.cards)} />

      <div className={`site-idcards${deciding ? " is-deciding" : ""}`}>
        {panel.cards.map((card) => (
          <IdCard
            key={card.cardId}
            card={card}
            picked={picked.includes(card.cardId)}
            deciding={deciding}
            onToggle={onToggle}
          />
        ))}
        <div className={`site-idcard site-idcard--none${busy === "none" ? " is-picked" : ""}`}>
          <p className="site-idcard__tab" aria-hidden="true" />
          <div className="site-idcard__sheet">
            <div className="site-idcard__body">
              <div className="site-idcard__head">
                <h2 className="site-idcard__title">{PERSONA_TEXT.noneTitle}</h2>
              </div>
              <p className="site-idcard__text">{PERSONA_TEXT.noneText}</p>
            </div>
            <div className="site-idcard__foot">
              <Button variant="secondary" busy={busy === "none"} disabled={deciding} onClick={onNone}>
                {PERSONA_TEXT.noneButton}
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* Запуск — после картотеки: отмечают все карточки о себе, потом начинают */}
      <div className="site-actions">
        <Button
          variant="accent"
          large
          arrow
          busy={busy === "picked"}
          disabled={picked.length === 0 || deciding}
          onClick={onStart}
        >
          {PERSONA_TEXT.start}
        </Button>
        <p className="site-hint" aria-live="polite">
          {PERSONA_TEXT.pickedCount(picked.length)}
        </p>
      </div>
      <p className="site-visually-hidden" role="status">
        {busy === "picked" ? PERSONA_TEXT.picked(picked.length) : busy === "none" ? PERSONA_TEXT.pickedNone : ""}
      </p>

      <div className="site-note site-note--tip">
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <use href="#ic-info" />
        </svg>
        <p>{PERSONA_TEXT.caption}</p>
      </div>
    </section>
  );
}

export function PersonaLoadingScreen({
  fullName,
  headingRef,
}: {
  fullName: string;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const [startedAt] = useState(() => Date.now());
  const elapsed = useElapsed(startedAt);
  return (
    <section
      className="site-screen site-screen--split site-screen--aside-wide site-screen--even is-active site-enter"
      aria-labelledby="persona-loading-title"
      aria-busy="true"
    >
      <div className="site-screen__head">
        <h1 className="site-screen__title" id="persona-loading-title" tabIndex={-1} ref={headingRef}>
          {PERSONA_TEXT.loadingTitle}
        </h1>
        <p className="site-screen__lead">{PERSONA_TEXT.loadingLead}</p>
        <p className="site-elapsed">
          <span role="timer">{elapsed}</span> {PERSONA_TEXT.probeElapsed}
        </p>
      </div>

      <Board
        head={
          <div className="site-board__seek">
            <SeekBar query={fullName} typing />
          </div>
        }
      >
        <SourceRows rows={PROBE_ROWS} label={PERSONA_TEXT.ledgerTitle} />
      </Board>
    </section>
  );
}

export function StartScreen({
  panel,
  nothingToClarify,
  busy,
  onStart,
  headingRef,
}: {
  panel: PersonaPanelJson | null;
  /** Карточек не было — решение записал сервер, и выбора посетитель не делал. */
  nothingToClarify: boolean;
  busy: boolean;
  onStart: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <section
      className="site-screen site-screen--split site-screen--even is-active site-enter"
      aria-labelledby="start-title"
    >
      <div className="site-screen__head">
        <h1 className="site-screen__title" id="start-title" tabIndex={-1} ref={headingRef}>
          {nothingToClarify ? PERSONA_TEXT.notStartedTitle : PERSONA_TEXT.decidedTitle}
        </h1>
        <p className="site-screen__lead">
          {nothingToClarify ? PERSONA_TEXT.notStartedLead : PERSONA_TEXT.decidedLead}
        </p>
        <div className="site-actions">
          <Button variant="accent" large arrow busy={busy} disabled={busy} onClick={onStart}>
            {PERSONA_TEXT.start}
          </Button>
        </div>
      </div>
      {panel ? (
        <div className="site-screen__aside">
          <Board title={RESULT_TEXT.checkedTitle}>
            <div className="site-board__body">
              <Ledger rows={personaLedger(panel.sources, panel.cards)} />
            </div>
          </Board>
        </div>
      ) : null}
    </section>
  );
}
