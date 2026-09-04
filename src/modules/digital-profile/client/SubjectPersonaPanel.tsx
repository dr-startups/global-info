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
  getSubjectIdentityProfile,
  saveSubjectIdentityProfile,
  type PersonaCardDTO,
  type PersonaCheckStateDTO,
  type PersonaPanelDTO,
  type PersonaProbeDTO,
  type PersonaSourceStateDTO,
  type SubjectIdentityProfileDTO,
} from "./api";
import { ErrorBox, Notice, SuccessBox } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";
import {
  PERSONA_PANEL_ANCHOR,
  personaPanelView,
  personaSourceReason,
  personaWikipediaTail,
} from "./persona-panel-text";
import {
  ANCHOR_KINDS,
  anchorFormFromProfile,
  anchorFormWarnings,
  anchorsFromForm,
  strongByDefault,
  type AnchorFormRow,
  type AnchorFormState,
} from "./subject-anchors-form";
import { hasStrongSubjectAnchor } from "../orion-golden/analytics/subject-anchors";

type Message = { kind: "ok" | "error"; text: string };

type PersonaAnswer = "PERSONA_SELECTED" | "ANCHORS_CONFIRMED" | "APPROVED_WITHOUT_PERSONA";

/** Слова решения — по ответу, а не двумя ветками `if` в двух местах разметки. */
const DECIDED_KEYS: Record<PersonaAnswer, string> = {
  PERSONA_SELECTED: "persona.decidedSelected",
  ANCHORS_CONFIRMED: "persona.decidedAnchors",
  APPROVED_WITHOUT_PERSONA: "persona.decidedWithout",
};

/** Причина, по которой строка отвергнута, — по коду пробы. */
const PROBE_CONFLICT_KEYS: Record<PersonaProbeDTO["conflicts"][number]["reason"], string> = {
  foreign_birth_date: "persona.probeReasonForeignBirthDate",
  foreign_inn: "persona.probeReasonForeignInn",
  registry_inn_unverified: "persona.probeReasonRegistryInn",
};

const ANCHOR_KIND_KEYS: Record<AnchorFormRow["kind"], string> = {
  employer: "persona.anchorsKindEmployer",
  position: "persona.anchorsKindPosition",
  birthPlace: "persona.anchorsKindBirthPlace",
  education: "persona.anchorsKindEducation",
  fact: "persona.anchorsKindFact",
};

/*
 * Права здесь не пересчитываются. На вопрос «может ли этот пользователь
 * решать» отвечают монтаж блока в `CaseDetailView` и гарды маршрутов; третий
 * ответ разошёлся бы с ними при первом же рефакторинге. Форма признаков живёт
 * по тому же правилу: запись требует `case.update`, и отказывает в ней сервер —
 * панель показывает его отказ словами, а не гасит кнопку своей догадкой.
 */
export function SubjectPersonaPanel({ caseId }: { caseId: string }) {
  const { t } = useDigitalProfileI18n();
  const [state, setState] = useState<PersonaCheckStateDTO | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<"build" | "decide" | "anchors" | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [profile, setProfile] = useState<SubjectIdentityProfileDTO | null>(null);
  const [form, setForm] = useState<AnchorFormState | null>(null);

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

  /*
   * Признаки читаются из профиля кейса — того самого файла, которым размечается
   * прогон. Форма их показывает и правит; проба приходит из состояния панели,
   * посчитанная сервером по уже сохранённым признакам.
   */
  const reloadProfile = useCallback(async () => {
    try {
      const { profile: p } = await getSubjectIdentityProfile(caseId);
      setProfile(p);
      setForm(anchorFormFromProfile(p));
    } catch {
      /* профиль не прочитан — форма не показывается; ошибка всплывёт при записи */
    }
  }, [caseId]);

  useEffect(() => {
    void reload();
    void reloadProfile();
  }, [reload, reloadProfile]);

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
    async (decision: PersonaAnswer, cardId?: string) => {
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
        setMessage({ kind: "ok", text: t(DECIDED_KEYS[decision]) });
      } catch (err) {
        setMessage(failure(err));
      } finally {
        setBusy(null);
      }
    },
    [busy, caseId, failure, reload, state?.check?.checkId, t]
  );

  const handleSaveAnchors = useCallback(async () => {
    if (busy || !form) return;
    setBusy("anchors");
    setMessage(null);
    try {
      await saveSubjectIdentityProfile(caseId, { anchors: anchorsFromForm(form) });
      await reloadProfile();
      // Проба считается сервером по сохранённым признакам: после записи её
      // нужно прочитать заново, иначе панель показывала бы прежний ответ.
      await reload();
      setMessage({ kind: "ok", text: t("persona.anchorsSaved") });
    } catch (err) {
      setMessage(failure(err));
    } finally {
      setBusy(null);
    }
  }, [busy, caseId, failure, form, reload, reloadProfile, t]);

  const check = state?.check ?? null;
  const panel = check?.panel ?? null;
  const decided = Boolean(check?.decision);
  // Решать можно только по строке, собранной на нынешних данных субъекта:
  // прежний снимок отвечает на вопрос о других данных.
  const decidable = Boolean(check && !decided && check.matchesCurrentSubject);
  const view = personaPanelView({ state, loadFailed });
  /*
   * Подтвердить признаками можно только тогда, когда есть признак, который
   * действительно отличает субъекта от полного тёзки. Тот же вопрос задают
   * ворота на сервере, и отвечает на него одна функция.
   */
  const anchorsConfirmable = decidable && hasStrongSubjectAnchor(profile?.anchors ?? null);
  const warnings = form ? anchorFormWarnings(form) : [];

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

      {/* Признаки стоят выше карточек: сначала оператор говорит, чем субъект
          отличается от тёзки, и только потом смотрит на людей с таким именем. */}
      {form ? (
        <AnchorsForm
          t={t}
          form={form}
          warnings={warnings}
          busy={busy !== null}
          saving={busy === "anchors"}
          onChange={setForm}
          onSave={() => void handleSaveAnchors()}
        />
      ) : null}

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

      {/* Строки выдачи показываются разложенными по признакам: «нашлось здесь»,
          «здесь стоит признак другого человека», «здесь ничего». Плоский список
          отвечал только на вопрос «что вообще нашлось». */}
      {panel && panel.serpRows.length > 0 && state?.probe ? (
        <ProbeBlocks t={t} probe={state.probe} />
      ) : null}
      {panel && panel.serpRows.length > 0 && !state?.probe ? (
        <div className="dp-stack" style={{ gap: 4 }}>
          <strong>{t("persona.serpTitle")}</strong>
          <div className="dp-muted" style={{ fontSize: 13 }}>
            {t("persona.probeNoAnchors")}
          </div>
          {panel.serpRows.map((row, i) => (
            <SerpRow key={`${row.url ?? row.title}-${i}`} row={row} />
          ))}
        </div>
      ) : null}

      {decidable ? (
        <div className="dp-inline" style={{ gap: 8 }}>
          {/* Подтверждение по признакам — ответ для малоизвестного субъекта, у
              которого карточки нет ни в одном источнике и быть не может. */}
          {anchorsConfirmable ? (
            <button
              type="button"
              className="dp-btn dp-btn-primary"
              onClick={() => void handleDecide("ANCHORS_CONFIRMED")}
              disabled={busy !== null}
              data-testid="persona-anchors-confirm-cta"
            >
              {busy === "decide" ? t("persona.deciding") : t("persona.anchorsConfirm")}
            </button>
          ) : null}
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

      {decided && check?.decision ? (
        <SuccessBox>{t(DECIDED_KEYS[check.decision])}</SuccessBox>
      ) : null}
    </div>
  );
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Строка выдачи с адресом: её открывают и проверяют глазами. */
function SerpRow({ row }: { row: PersonaPanelDTO["serpRows"][number] }) {
  return (
    <div className="dp-muted" style={{ fontSize: 13 }}>
      {row.domain ? `${row.domain} — ` : ""}
      {row.url ? (
        <a href={row.url} target="_blank" rel="noreferrer">
          {row.title}
        </a>
      ) : (
        row.title
      )}
      {row.snippet ? <div style={{ fontSize: 12 }}>{row.snippet}</div> : null}
    </div>
  );
}

/**
 * Форма признаков субъекта.
 *
 * Разбор строк и предупреждения живут в `subject-anchors-form.ts` и проверяются
 * исполнением; здесь только разметка.
 */
function AnchorsForm({
  t,
  form,
  warnings,
  busy,
  saving,
  onChange,
  onSave,
}: {
  t: Translate;
  form: AnchorFormState;
  warnings: Array<{ key: string; vars?: Record<string, string | number> }>;
  busy: boolean;
  saving: boolean;
  onChange: (next: AnchorFormState) => void;
  onSave: () => void;
}) {
  const setRow = (index: number, patch: Partial<AnchorFormRow>): void =>
    onChange({
      ...form,
      rows: form.rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    });

  return (
    <div
      className="dp-stack"
      style={{ gap: 8, border: "1px solid #ddd", borderRadius: 6, padding: 10 }}
      data-testid="subject-anchors-form"
    >
      <strong>{t("persona.anchorsTitle")}</strong>
      <div className="dp-muted" style={{ fontSize: 12 }}>
        {t("persona.anchorsHint")}
      </div>

      <div style={{ fontSize: 13 }}>
        {form.birthDate
          ? t("persona.anchorsBirthDate", { value: form.birthDate })
          : t("persona.anchorsBirthDateMissing")}
      </div>

      {form.rows.map((row, index) => (
        <div key={index} className="dp-inline" style={{ gap: 6, alignItems: "center" }}>
          <select
            className="dp-input"
            value={row.kind}
            onChange={(e) => setRow(index, { kind: e.target.value as AnchorFormRow["kind"] })}
            disabled={busy}
          >
            {ANCHOR_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(ANCHOR_KIND_KEYS[kind])}
              </option>
            ))}
          </select>
          <input
            className="dp-input"
            style={{ flex: 1, minWidth: 220 }}
            value={row.text}
            placeholder={t("persona.anchorsTextPlaceholder")}
            onChange={(e) => setRow(index, { text: e.target.value })}
            disabled={busy}
            data-testid={`subject-anchor-text-${index}`}
          />
          {/* Многословная фраза сильна сама по себе: галочка у неё стоит и не
              снимается — иначе интерфейс обещал бы то, чего сервер не сделает. */}
          <label className="dp-muted" style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={row.strong || strongByDefault(row.text)}
              onChange={(e) => setRow(index, { strong: e.target.checked })}
              disabled={busy || strongByDefault(row.text)}
            />{" "}
            {strongByDefault(row.text)
              ? t("persona.anchorsStrongByDefault")
              : t("persona.anchorsStrong")}
          </label>
          <button
            type="button"
            className="dp-btn"
            onClick={() => onChange({ ...form, rows: form.rows.filter((_, i) => i !== index) })}
            disabled={busy}
          >
            {t("persona.anchorsRemoveRow")}
          </button>
        </div>
      ))}

      <div>
        <button
          type="button"
          className="dp-btn"
          onClick={() =>
            onChange({ ...form, rows: [...form.rows, { kind: "employer", text: "", strong: false }] })
          }
          disabled={busy}
          data-testid="subject-anchor-add-cta"
        >
          {t("persona.anchorsAddRow")}
        </button>
      </div>

      <label style={{ display: "block" }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("persona.anchorsInn")}</div>
        <div className="dp-muted" style={{ fontSize: 12, marginBottom: 4 }}>
          {t("persona.anchorsInnHint")}
        </div>
        <textarea
          className="dp-input"
          style={{ width: "100%", minHeight: 40, fontFamily: "inherit" }}
          value={form.innText}
          onChange={(e) => onChange({ ...form, innText: e.target.value })}
          disabled={busy}
          data-testid="subject-anchor-inn-input"
        />
      </label>

      <label style={{ display: "block" }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("persona.anchorsDomains")}</div>
        <div className="dp-muted" style={{ fontSize: 12, marginBottom: 4 }}>
          {t("persona.anchorsDomainsHint")}
        </div>
        <textarea
          className="dp-input"
          style={{ width: "100%", minHeight: 40, fontFamily: "inherit" }}
          value={form.domainsText}
          onChange={(e) => onChange({ ...form, domainsText: e.target.value })}
          disabled={busy}
        />
      </label>

      {/* Чего не хватает, панель говорит до траты, а не отказом старта. */}
      {warnings.map((warning) => (
        <Notice key={warning.key}>{t(warning.key, warning.vars)}</Notice>
      ))}

      <div>
        <button
          type="button"
          className="dp-btn dp-btn-primary"
          onClick={onSave}
          disabled={busy}
          data-testid="subject-anchors-save-cta"
        >
          {saving ? t("persona.anchorsSaving") : t("persona.anchorsSave")}
        </button>
      </div>
    </div>
  );
}

/** Строки панели, разложенные по признакам оператора. */
function ProbeBlocks({ t, probe }: { t: Translate; probe: PersonaProbeDTO }) {
  return (
    <div className="dp-stack" style={{ gap: 8 }} data-testid="subject-anchors-probe">
      <strong>{t("persona.probeTitle")}</strong>

      {probe.hits.map((hit) => (
        <div key={hit.anchor} className="dp-stack" style={{ gap: 2 }}>
          <div style={{ fontSize: 13 }}>
            <strong>{hit.anchor}</strong> — {t("persona.probeHitRows", { count: hit.rows.length })}
          </div>
          {hit.rows.map((row, i) => (
            <SerpRow key={`${row.url ?? row.title}-${i}`} row={row} />
          ))}
        </div>
      ))}

      {probe.missing.length > 0 ? (
        <Notice>{t("persona.probeMissing", { items: probe.missing.join(", ") })}</Notice>
      ) : null}

      {probe.conflicts.length > 0 ? (
        <div className="dp-stack" style={{ gap: 2 }}>
          <strong>{t("persona.probeConflicts")}</strong>
          <div className="dp-muted" style={{ fontSize: 12 }}>
            {t("persona.probeConflictsHint")}
          </div>
          {probe.conflicts.map((conflict, i) => (
            <div key={`${conflict.url ?? conflict.title}-${i}`} className="dp-muted" style={{ fontSize: 13 }}>
              {conflict.domain ? `${conflict.domain} — ` : ""}
              {conflict.url ? (
                <a href={conflict.url} target="_blank" rel="noreferrer">
                  {conflict.title}
                </a>
              ) : (
                conflict.title
              )}
              {" — "}
              {t(PROBE_CONFLICT_KEYS[conflict.reason], { value: conflict.value })}
            </div>
          ))}
        </div>
      ) : null}

      {probe.unmatchedRows.length > 0 ? (
        <div className="dp-stack" style={{ gap: 2 }}>
          <strong>{t("persona.probeUnmatched")}</strong>
          {probe.unmatchedRows.map((row, i) => (
            <SerpRow key={`${row.url ?? row.title}-${i}`} row={row} />
          ))}
        </div>
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
