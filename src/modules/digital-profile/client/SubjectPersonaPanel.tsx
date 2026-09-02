"use client";

/**
 * Выбор персоны субъекта до первой траты (шаг 0032).
 *
 * Карточка панели — сущность источника, а не наша склейка: одна статья
 * Википедии, одна панель знаний, одна запись санкционного списка. Карточки
 * разных источников намеренно стоят рядом и не склеиваются — эвристика
 * тождества здесь была бы вторым ответом на вопрос принадлежности, а отвечает
 * на него оператор глазами.
 *
 * Подсветка «дата совпала» есть только у структурной даты записи: разбирать
 * дату из прозаического лида нельзя — неверно распарсенная дата с зелёной
 * отметкой это тихая ложь, хуже отсутствия отметки.
 *
 * Даже единственная карточка ждёт явного клика: автовыбор — тот же класс, что
 * автоподтверждение комплаенс-совпадения, которое в этом продукте запрещено.
 */

import { useCallback, useEffect, useState } from "react";
import {
  DigitalProfileApiError,
  buildPersonaCheck,
  decidePersonaCheck,
  getPersonaCheck,
  type PersonaCardDTO,
  type PersonaCheckStateDTO,
  type PersonaSourceStateDTO,
} from "./api";
import { ErrorBox, Notice, SuccessBox } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";
import {
  PERSONA_PANEL_ANCHOR,
  personaPanelView,
  personaSourceReason,
  personaWikipediaTail,
} from "./persona-panel-text";

type Message = { kind: "ok" | "error"; text: string };

/*
 * Права здесь не пересчитываются. На вопрос «может ли этот пользователь
 * решать» отвечают монтаж блока в `CaseDetailView` и гарды маршрутов; третий
 * ответ разошёлся бы с ними при первом же рефакторинге.
 */
export function SubjectPersonaPanel({ caseId }: { caseId: string }) {
  const { t } = useDigitalProfileI18n();
  const [state, setState] = useState<PersonaCheckStateDTO | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<"build" | "decide" | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  const reload = useCallback(async () => {
    // Отказ чтения — не «панель ещё не собиралась»: она, возможно, собиралась
    // и решение принято. Молчаливый `null` печатал выдуманное состояние.
    try {
      setState(await getPersonaCheck(caseId));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [caseId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const failure = useCallback(
    (err: unknown): Message => ({
      kind: "error",
      text:
        err instanceof DigitalProfileApiError
          ? `${err.code}${err.message ? `: ${err.message}` : ""}`
          : err instanceof Error
            ? err.message
            : "error",
    }),
    []
  );

  const handleBuild = useCallback(async () => {
    if (busy) return;
    setBusy("build");
    setMessage(null);
    try {
      await buildPersonaCheck(caseId);
      await reload();
    } catch (err) {
      setMessage(failure(err));
    } finally {
      setBusy(null);
    }
  }, [busy, caseId, failure, reload]);

  const handleDecide = useCallback(
    async (decision: "PERSONA_SELECTED" | "APPROVED_WITHOUT_PERSONA", cardId?: string) => {
      const checkId = state?.check?.checkId;
      if (busy || !checkId) return;
      setBusy("decide");
      setMessage(null);
      try {
        await decidePersonaCheck(caseId, {
          checkId,
          decision,
          selectedCardId: cardId ?? null,
        });
        await reload();
        setMessage({
          kind: "ok",
          text:
            decision === "PERSONA_SELECTED"
              ? t("persona.decidedSelected")
              : t("persona.decidedWithout"),
        });
      } catch (err) {
        setMessage(failure(err));
      } finally {
        setBusy(null);
      }
    },
    [busy, caseId, failure, reload, state?.check?.checkId, t]
  );

  const check = state?.check ?? null;
  const panel = check?.panel ?? null;
  const decided = Boolean(check?.decision);
  // Решать можно только по строке, собранной на нынешних данных субъекта:
  // прежний снимок отвечает на вопрос о других данных.
  const decidable = Boolean(check && !decided && check.matchesCurrentSubject);
  const view = personaPanelView({ state, loadFailed });

  const statusWord = (status: PersonaSourceStateDTO["status"]): string =>
    ({
      SUCCESS: t("persona.statusSuccess"),
      NOT_CONFIGURED: t("persona.statusNotConfigured"),
      FAILED: t("persona.statusFailed"),
      TIMEOUT: t("persona.statusTimeout"),
      OFFLINE: t("persona.statusOffline"),
    })[status];

  const sourceName = (source: PersonaSourceStateDTO["source"]): string =>
    ({
      wikipedia: t("persona.sourceWikipedia"),
      knowledge_graph: t("persona.sourceKnowledgeGraph"),
      opensanctions: t("persona.sourceOpenSanctions"),
    })[source];

  return (
    <div
      id={PERSONA_PANEL_ANCHOR}
      data-testid="subject-persona-panel"
      className="dp-stack"
      style={{ gap: 12 }}
    >
      <div className="dp-row" style={{ alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0 }}>{t("persona.title")}</h3>
          <div className="dp-muted" style={{ marginTop: 4, fontSize: 13 }}>
            {t("persona.hint")}
          </div>
        </div>
        <button
          type="button"
          className="dp-btn"
          onClick={() => void handleBuild()}
          disabled={busy !== null}
          data-testid="persona-build-cta"
        >
          {busy === "build"
            ? t("persona.building")
            : check
              ? t("persona.rebuild")
              : t("persona.build")}
        </button>
      </div>

      {/* Введённая оператором дата стоит над карточками: сверить её с датой на
          карточке нужно одним взглядом. */}
      <div style={{ fontWeight: 600 }}>
        {panel?.subjectDateOfBirth
          ? t("persona.subjectDob", { value: panel.subjectDateOfBirth })
          : t("persona.subjectDobUnknown")}
      </div>

      {state?.gate.mode === "STALE" ? <Notice>{t("persona.staleDecision")}</Notice> : null}
      {message?.kind === "ok" ? <SuccessBox>{message.text}</SuccessBox> : null}
      {message?.kind === "error" ? <ErrorBox>{message.text}</ErrorBox> : null}

      {view === "LOAD_FAILED" ? <ErrorBox>{t("persona.loadFailed")}</ErrorBox> : null}
      {view === "NOT_BUILT" ? <Notice>{t("persona.notBuiltYet")}</Notice> : null}

      {panel && panel.cards.length === 0 ? <Notice>{t("persona.emptyPanel")}</Notice> : null}

      {panel && panel.cards.length > 0 ? (
        <div className="dp-stack" style={{ gap: 8 }}>
          {panel.cards.map((card) => (
            <PersonaCard
              key={card.cardId}
              card={card}
              t={t}
              canChoose={decidable && busy === null}
              onChoose={() => void handleDecide("PERSONA_SELECTED", card.cardId)}
            />
          ))}
        </div>
      ) : null}

      {/* Отказ источника называется словами: пустая панель по причине «ключ не
          задан» и пустая панель по причине «никого нет» — разные ответы. */}
      {panel ? (
        <div className="dp-stack" style={{ gap: 4 }}>
          <strong>{t("persona.sourceStatus")}</strong>
          {panel.sources.map((s) => {
            // Причина приходит кодом: слова к ней подбирает словарь кабинета.
            const reason = personaSourceReason(s);
            return (
              <div key={s.source} className="dp-muted" style={{ fontSize: 13 }}>
                {sourceName(s.source)}: {statusWord(s.status)}
                {reason ? ` — ${t(reason.key, reason.vars)}` : ""}
              </div>
            );
          })}
        </div>
      ) : null}

      {panel && panel.serpRows.length > 0 ? (
        <div className="dp-stack" style={{ gap: 4 }}>
          <strong>{t("persona.serpTitle")}</strong>
          {panel.serpRows.map((row, i) => (
            <div key={`${row.url ?? row.title}-${i}`} className="dp-muted" style={{ fontSize: 13 }}>
              {row.domain ? `${row.domain} — ` : ""}
              {row.title}
            </div>
          ))}
        </div>
      ) : null}

      {decidable ? (
        <div>
          <button
            type="button"
            className="dp-btn"
            onClick={() => void handleDecide("APPROVED_WITHOUT_PERSONA")}
            disabled={busy !== null}
            data-testid="persona-approve-without-cta"
          >
            {busy === "decide" ? t("persona.deciding") : t("persona.approveWithoutPersona")}
          </button>
        </div>
      ) : null}

      {decided ? (
        <SuccessBox>
          {check?.decision === "PERSONA_SELECTED"
            ? t("persona.decidedSelected")
            : t("persona.decidedWithout")}
        </SuccessBox>
      ) : null}
    </div>
  );
}

function PersonaCard({
  card,
  t,
  canChoose,
  onChoose,
}: {
  card: PersonaCardDTO;
  t: (key: string, vars?: Record<string, string | number>) => string;
  canChoose: boolean;
  onChoose: () => void;
}) {
  return (
    <div
      className="dp-card"
      style={{ border: "1px solid #ddd", borderRadius: 6, padding: 10 }}
      data-testid={`persona-card-${card.cardId}`}
    >
      <div className="dp-row" style={{ alignItems: "flex-start", gap: 10 }}>
        <div style={{ flex: 1 }}>
          {card.source === "wikipedia" ? <WikipediaBody card={card} t={t} /> : null}
          {card.source === "knowledge_graph" ? <KnowledgeGraphBody card={card} /> : null}
          {card.source === "opensanctions" ? <SanctionsBody card={card} t={t} /> : null}
        </div>
        {canChoose ? (
          <button type="button" className="dp-btn" onClick={onChoose}>
            {t("persona.choose")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function WikipediaBody({
  card,
  t,
}: {
  card: Extract<PersonaCardDTO, { source: "wikipedia" }>;
  t: (key: string) => string;
}) {
  const tail = personaWikipediaTail(card);
  return (
    <div className="dp-stack" style={{ gap: 4 }}>
      <strong>{card.title}</strong>
      {/* Лид — первая строка вводной секции статьи: у персон именно в ней
          стоит полная дата рождения. */}
      {card.lead ? <div>{card.lead}</div> : null}
      {/* Лида нет — карточка не остаётся голым заголовком: сниппет поиска и
          причина, по которой первой строки не будет. */}
      {tail ? (
        <div className="dp-muted" style={{ fontSize: 12 }}>
          {t(tail.key)} {tail.snippet}
        </div>
      ) : null}
      <div className="dp-muted" style={{ fontSize: 12 }}>
        {card.articles.map((a) => (
          <span key={`${a.language}:${a.title}`} style={{ marginRight: 10 }}>
            <a href={a.url} target="_blank" rel="noreferrer">
              {a.language}: {a.title}
            </a>
          </span>
        ))}
      </div>
    </div>
  );
}

function KnowledgeGraphBody({
  card,
}: {
  card: Extract<PersonaCardDTO, { source: "knowledge_graph" }>;
}) {
  return (
    <div className="dp-row" style={{ gap: 10, alignItems: "flex-start" }}>
      {card.imageUrl ? (
        // Адрес фотографии показывается как есть: файл в продукт не сохраняется.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={card.imageUrl} alt={card.title} width={64} height={64} style={{ borderRadius: 4 }} />
      ) : null}
      <div className="dp-stack" style={{ gap: 4 }}>
        <strong>{card.title}</strong>
        {card.description ? <div>{card.description}</div> : null}
        {card.url ? (
          <a href={card.url} target="_blank" rel="noreferrer" className="dp-muted">
            {card.url}
          </a>
        ) : null}
      </div>
    </div>
  );
}

function SanctionsBody({
  card,
  t,
}: {
  card: Extract<PersonaCardDTO, { source: "opensanctions" }>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="dp-stack" style={{ gap: 4 }}>
      <strong>{card.matchedName}</strong>
      {card.datesOfBirth.length > 0 ? (
        <div>
          {card.datesOfBirth.join(", ")}
          {card.birthDateMatches ? ` — ${t("persona.dobMatches")}` : ""}
        </div>
      ) : null}
      {card.topicLabels.length > 0 ? (
        <div className="dp-muted" style={{ fontSize: 13 }}>
          {card.topicLabels.join(", ")}
        </div>
      ) : null}
      <div className="dp-muted" style={{ fontSize: 12 }}>
        {t("persona.matchScore", { value: card.matchScore })}
        {card.profileUrl ? (
          <>
            {" · "}
            <a href={card.profileUrl} target="_blank" rel="noreferrer">
              {card.profileId}
            </a>
          </>
        ) : null}
      </div>
    </div>
  );
}
