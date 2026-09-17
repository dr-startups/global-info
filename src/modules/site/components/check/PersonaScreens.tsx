"use client";

/**
 * Уточнение: «Кто из них вы?», «Уточнять нечего», сборка панели и запуск после
 * записанного решения.
 *
 * Нажатие «Это я» само запускает проверку — отдельной кнопки подтверждения нет,
 * поэтому подпись называет оба действия. Выбранную карточку отмечает выделитель,
 * остальные гаснут и отключаются: видно, по какому выбору пошла проверка, и
 * второй раз не нажать.
 */

import type { Ref } from "react";
import {
  cardSourceLabel,
  personaCardMatchNote,
  personaCardText,
  personaLedger,
  type PersonaCardJson,
  type PersonaPanelJson,
} from "@/modules/site/check/persona-view";
import { PERSONA_TEXT } from "@/modules/site/content/check";
import { Button } from "../Button";
import { Ledger } from "./parts";

const SOURCE_ICON: Record<PersonaCardJson["source"], string> = {
  wikipedia: "#ic-open",
  knowledge_graph: "#ic-serp",
  opensanctions: "#ic-list",
};

function RunButton({
  label,
  variant,
  busy,
  disabled,
  large,
  onClick,
}: {
  label: string;
  variant: "accent" | "secondary";
  busy: boolean;
  disabled: boolean;
  large?: boolean;
  onClick: () => void;
}) {
  // Крупная кнопка стоит одна под подводкой, остальные — в подвале карточки во всю её ширину.
  return (
    <Button variant={variant} large={large} block={!large} arrow={large} busy={busy} disabled={disabled} onClick={onClick}>
      {label}
    </Button>
  );
}

export function PersonaScreen({
  panel,
  fullName,
  busy,
  onPick,
  onNone,
  headingRef,
}: {
  panel: PersonaPanelJson;
  fullName: string;
  busy: string | null;
  onPick: (card: PersonaCardJson) => void;
  onNone: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  const picked = panel.cards.find((card) => card.cardId === busy);
  return (
    <section className="site-screen is-active site-enter" aria-labelledby="persona-title">
      <header className="site-screen__head">
        <h1 className="site-screen__title" id="persona-title" tabIndex={-1} ref={headingRef}>
          {PERSONA_TEXT.title}
        </h1>
        <p className="site-screen__lead">{PERSONA_TEXT.lead(fullName)}</p>
      </header>

      <div className={`site-cards site-cards--persona${busy ? " is-deciding" : ""}`}>
        {panel.cards.map((card) => {
          const text = personaCardText(card);
          const match = personaCardMatchNote(card);
          return (
            <article key={card.cardId} className={`site-card${busy === card.cardId ? " is-picked" : ""}`}>
              <p className="site-card__source">
                <svg viewBox="0 0 32 32" aria-hidden="true">
                  <use href={SOURCE_ICON[card.source]} />
                </svg>
                {cardSourceLabel(card.source)}
              </p>
              <h2 className="site-card__title">{card.title}</h2>
              {text ? <p className="site-card__text">{text}</p> : null}
              {match ? (
                <p className="site-card__match">
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <use href="#ic-check" />
                  </svg>
                  {match}
                </p>
              ) : null}
              {card.url ? (
                <a className="site-card__link" href={card.url} target="_blank" rel="noopener noreferrer">
                  {PERSONA_TEXT.openArticle}
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    <use href="#ic-ext" />
                  </svg>
                </a>
              ) : null}
              <div className="site-card__foot">
                <RunButton
                  label={PERSONA_TEXT.pick}
                  variant="accent"
                  busy={busy === card.cardId}
                  disabled={busy !== null && busy !== card.cardId}
                  onClick={() => onPick(card)}
                />
              </div>
            </article>
          );
        })}
        <div className={`site-card site-card--none${busy === "none" ? " is-picked" : ""}`}>
          <h2 className="site-card__title">{PERSONA_TEXT.noneTitle}</h2>
          <p className="site-card__text">{PERSONA_TEXT.noneText}</p>
          <div className="site-card__foot">
            <RunButton
              label={PERSONA_TEXT.noneButton}
              variant="secondary"
              busy={busy === "none"}
              disabled={busy !== null && busy !== "none"}
              onClick={onNone}
            />
          </div>
        </div>
      </div>
      <p className="site-visually-hidden" role="status">
        {picked ? PERSONA_TEXT.picked(picked.title) : busy === "none" ? PERSONA_TEXT.pickedNone : ""}
      </p>

      <div className="site-screen__foot">
        <p className="site-caption">{PERSONA_TEXT.caption}</p>
        <Ledger rows={personaLedger(panel.sources, panel.cards)} inline label={PERSONA_TEXT.ledgerTitle} />
      </div>
    </section>
  );
}

export function PersonaEmptyScreen({
  panel,
  busy,
  onNone,
  headingRef,
}: {
  panel: PersonaPanelJson;
  busy: string | null;
  onNone: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <section className="site-screen site-screen--split is-active site-enter" aria-labelledby="persona-empty-title">
      <div className="site-screen__head">
        <h1 className="site-screen__title" id="persona-empty-title" tabIndex={-1} ref={headingRef}>
          {PERSONA_TEXT.emptyTitle}
        </h1>
        <p className="site-screen__lead">{PERSONA_TEXT.emptyLead}</p>
        <div className="site-actions">
          <RunButton
            label={PERSONA_TEXT.start}
            variant="accent"
            large
            busy={busy !== null}
            disabled={busy !== null}
            onClick={onNone}
          />
        </div>
      </div>
      <div className="site-card site-card--none site-card--empty">
        <h2 className="site-screen__subtitle">{PERSONA_TEXT.ledgerTitle}</h2>
        <Ledger rows={personaLedger(panel.sources, panel.cards)} />
      </div>
    </section>
  );
}

export function PersonaLoadingScreen({ headingRef }: { headingRef: Ref<HTMLHeadingElement> }) {
  return (
    <section className="site-screen site-screen--split is-active site-enter" aria-labelledby="persona-loading-title" aria-busy="true">
      <div className="site-screen__head">
        <h1 className="site-screen__title" id="persona-loading-title" tabIndex={-1} ref={headingRef}>
          {PERSONA_TEXT.loadingTitle}
        </h1>
        <p className="site-screen__lead">{PERSONA_TEXT.loadingLead}</p>
      </div>
    </section>
  );
}

export function StartScreen({
  busy,
  onStart,
  headingRef,
}: {
  busy: boolean;
  onStart: () => void;
  headingRef: Ref<HTMLHeadingElement>;
}) {
  return (
    <section className="site-screen site-screen--split is-active site-enter" aria-labelledby="start-title">
      <div className="site-screen__head">
        <h1 className="site-screen__title" id="start-title" tabIndex={-1} ref={headingRef}>
          {PERSONA_TEXT.decidedTitle}
        </h1>
        <p className="site-screen__lead">{PERSONA_TEXT.decidedLead}</p>
        <div className="site-actions">
          <RunButton label={PERSONA_TEXT.start} variant="accent" large busy={busy} disabled={busy} onClick={onStart} />
        </div>
      </div>
    </section>
  );
}
