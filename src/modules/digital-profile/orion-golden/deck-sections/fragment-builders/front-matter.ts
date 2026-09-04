/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { SectionType } from "../contracts";
import type { PersonaDecisionRecord, ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import { pluralRu } from "../../../report/i18n/plural-ru";
import { clientAddress } from "../../client/client-address";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import { enumerateRu, makeSlotSlide } from "./shared";

/*
 * Слова листа «Кого проверяли» — свои, а не из словарей кабинета.
 *
 * Рядом живёт `i18n/dictionaries` панели выбора персоны, и слить их заманчиво.
 * Нельзя по двум причинам. Во-первых, у кабинета есть английский близнец, а
 * отчёт — русский документ: локаль оператора не имеет права менять язык
 * поставляемого клиенту файла. Во-вторых, регистр разный: кабинет подписывает
 * элементы управления («отказал»), отчёт объясняет читателю, что произошло.
 *
 * Незнакомое значение называется незаписанным, а не печатается как есть:
 * снимок приходит артефактом прогона, то есть через границу формата, и слово
 * вроде `NOT_CONFIGURED` в клиентском тексте — внутренний код в документе,
 * который читает человек.
 */

/** Чем карточка является — словами, а не машинным именем источника. */
const PERSONA_CARD_LABELS: Record<string, string> = {
  wikipedia: "статья Википедии",
  knowledge_graph: "панель знаний Google",
  opensanctions: "запись OpenSanctions",
};

/** Как источник панели зовётся в перечислении её состояния. */
const PERSONA_SOURCE_LABELS: Record<string, string> = {
  wikipedia: "Википедия",
  knowledge_graph: "панель знаний Google",
  opensanctions: "OpenSanctions",
};

/** Что с источником случилось — человеческой фразой, а не кодом состояния. */
const PERSONA_SOURCE_STATUS_LABELS: Record<string, string> = {
  SUCCESS: "данные получены",
  NOT_CONFIGURED: "доступ не настроен",
  FAILED: "источник не ответил",
  TIMEOUT: "ответ не получен в отведённое время",
  OFFLINE: "сбор шёл без обращения к внешним сервисам",
};

/**
 * Оговорка, которая и есть смысл листа.
 *
 * Отчёт читает сам субъект. Приняв материал об однофамильце за свой, он пойдёт
 * добиваться его удаления — потратит деньги и время не на то. Поэтому цена
 * ошибки называется словами на каждой ветке листа, а не подразумевается.
 */
const NAMESAKE_WARNING =
  "Если карточка описывает другого человека, материалы отчёта относятся к однофамильцу," +
  " и добиваться их удаления не нужно.";

const UNCONFIRMED_WARNING =
  "Принадлежность материалов внешним источником не подтверждалась, поэтому среди них" +
  " может оказаться материал об однофамильце.";

/** Принадлежность отдельной строки — другой вопрос, и на него отвечает ярлык. */
const PER_MATERIAL_NOTE =
  "Принадлежность отдельного материала проверяемому лицу отмечена на страницах отчёта" +
  " ярлыком «О другом лице»: этот лист отвечает на вопрос обо всём отчёте сразу.";

/*
 * Абзац листа собирается **строками**, а не одним предложением за другим.
 *
 * Между построителем и рендерером стоит `reflowNarrativeParagraphs`: сплошной
 * абзац он делит по предложениям с пределом `max(180, длина/3)` и молча
 * выбрасывает всё сверх трёх абзацев, а предложение длиннее предела обрезает.
 * На худшем законном входе это съедало третий источник целиком
 * («OpenSanctions — …», −59 знаков), а у записи с тремя датами рождения
 * обрывало перечисление посреди списка. Текст, уже разбитый на строки, резак
 * возвращает как есть — это его собственный контракт, а не обход.
 *
 * Сторож на случай, если строки отсюда исчезнут, стоит в `run-deck-build.ts`
 * (`narrativeReflowLoss`): он сверяет текст по обе стороны резака.
 */
type PersonaSheet = {
  narrative: string;
  bullets: string[];
  whatToCheck: string;
  /** Сноска состояния; общая сноска шаблона говорит только о методе. */
  sourceNote?: string;
};

/** Состояние источников панели — перечислением, словами. */
function sourcesClause(record: PersonaDecisionRecord): string {
  const parts = record.sources.map(
    (s) =>
      `${PERSONA_SOURCE_LABELS[s.source] ?? "источник не назван"} — ${
        PERSONA_SOURCE_STATUS_LABELS[s.status] ?? "состояние не записано"
      }`
  );
  return parts.length > 0 ? `Источники на момент решения: ${parts.join("; ")}.` : "";
}

/**
 * Содержимое листа «Кого проверяли» — три карточки, которые рисует раскладка.
 *
 * Признак задаётся данными: есть записанное решение — лист говорит, кого
 * выбрали; решения нет — лист говорит именно это, а не молчит. Пропуск листа
 * означал бы, что «блока нет» читается и как «решения не было», и как
 * «страница потерялась».
 */
function personaSheet(record: PersonaDecisionRecord | undefined): PersonaSheet {
  if (record?.decision === "PERSONA_SELECTED" && record.selected) {
    const card = record.selected;
    const sourceLabel = PERSONA_CARD_LABELS[card.source] ?? "источник карточки не назван";
    const address = clientAddress(card.url ?? undefined);
    // Адрес называется либо его отсутствие: молчание читается как «адрес есть,
    // просто не привели», и проверить выбор становится нечем.
    const addressPart = address
      ? `, ${address}`
      : "; адреса карточки источник не дал, и открыть её по ссылке нельзя";
    const birthPart =
      card.datesOfBirth.length > 0
        ? `, дата рождения записи ${enumerateRu(card.datesOfBirth, card.datesOfBirth.length)}`
        : "";
    return {
      narrative: [
        `Перед началом сбора оператор выбрал карточку «${card.title}» — ${sourceLabel}${addressPart}${birthPart}.`,
        "Отчёт целиком собран по этой персоне.",
      ].join("\n"),
      bullets: [NAMESAKE_WARNING, PER_MATERIAL_NOTE],
      whatToCheck:
        "Открыть карточку по указанному адресу и убедиться, что она описывает проверяемое лицо." +
        " Расхождение — повод пересобрать отчёт по другой персоне, а не работать с его выводами.",
      // Утверждение об адресе стоит только там, где адрес есть: на общей сноске
      // шаблона оно было бы ложью на трёх состояниях листа из четырёх.
      sourceNote: address ? "Карточка выбранной персоны открывается по указанному адресу." : undefined,
    };
  }

  if (record?.decision === "ANCHORS_CONFIRMED" && record.anchors) {
    /*
     * Малоизвестного человека внешние карточки не находят, и «персоны нет» —
     * не ответ: по нему прогон DPA-2026-0049 собрал четырёх разных людей.
     * Оператор называет признаки, и лист печатает их — читатель видит, чем
     * материал отличали от материала полного тёзки, и может это проверить.
     */
    const a = record.anchors;
    const named = [
      a.birthDate ? `дата рождения ${a.birthDate}` : "",
      ...a.phrases.filter((p) => p.strong).map((p) => `«${p.text}»`),
      ...a.inn.map((i) => `ИНН ${i}`),
      ...a.domains.map((d) => `сайт ${d}`),
    ].filter(Boolean);
    const weak = a.phrases.filter((p) => !p.strong).map((p) => `«${p.text}»`);
    const confirmedOn = a.confirmedOn.slice(0, 3);
    return {
      narrative: [
        `Перед началом сбора оператор назвал признаки проверяемого лица: ${enumerateRu(
          named,
          named.length
        )}.`,
        confirmedOn.length > 0
          ? `Признаки проверены по выдаче до сбора: ${enumerateRu(confirmedOn, confirmedOn.length)}.`
          : "",
        weak.length > 0
          ? `Дополнительно названы менее строгие признаки: ${enumerateRu(weak, weak.length)}.`
          : "",
        "Материал отнесён к проверяемому лицу, когда рядом с его именем стоит один из этих признаков.",
      ]
        .filter(Boolean)
        .join("\n"),
      bullets: [
        "Материалы, где совпало только имя, отмечены как «принадлежность не подтверждена»" +
          " и не входят ни в темы, ни в итоговую оценку.",
        PER_MATERIAL_NOTE,
      ],
      whatToCheck:
        "Сверить названные признаки с тем, что известно о проверяемом лице:" +
        " ошибка в признаке уводит из отчёта его материалы и приводит чужие.",
    };
  }

  if (record?.decision === "APPROVED_WITHOUT_PERSONA") {
    const cause =
      record.cardCount > 0
        ? `панель показала ${record.cardCount} карточ${pluralRu(
            record.cardCount,
            "ку",
            "ки",
            "ек"
          )}, и ни одна не отнесена к проверяемому лицу`
        : "панель не показала ни одной карточки";
    return {
      narrative: [
        `Перед началом сбора оператор записал решение «различимой персоны нет»: ${cause}.`,
        sourcesClause(record),
        "Сбор шёл по данным субъекта, которые ввёл оператор.",
      ]
        .filter(Boolean)
        .join("\n"),
      bullets: [UNCONFIRMED_WARNING, PER_MATERIAL_NOTE],
      // Регистр читателя: сбор панели — работа оператора, и требовать её от
      // читателя значит дать ему указание, которое он выполнить не может.
      whatToCheck:
        "Сверить материалы, принадлежность которых проверяемому лицу вызывает сомнение," +
        " по источнику каждого — там, где отчёт приводит его адрес: внешним источником" +
        " принадлежность не подтверждена ни у одного из них.",
    };
  }

  return {
    narrative: [
      "Решения по персоне у этого кейса нет: панель выбора персоны не собиралась либо решение" +
        " по ней не принималось.",
      "Сбор шёл по данным субъекта, которые ввёл оператор.",
    ].join("\n"),
    bullets: [UNCONFIRMED_WARNING, PER_MATERIAL_NOTE],
    // Тот же регистр: читатель не собирает панель — он читает отчёт. Проверяемое
    // им действие одно и то же на обеих ветках без персоны.
    whatToCheck:
      "Сверить материалы, принадлежность которых проверяемому лицу вызывает сомнение," +
      " по источнику каждого — там, где отчёт приводит его адрес: внешним источником" +
      " принадлежность не подтверждена ни у одного из них.",
  };
}

export function buildFrontMatterFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const [cover, toc, persona] = slotsForFragment("FRONT_MATTER_MAIN");
  const sheet = personaSheet(extras.personaDecision);
  return {
    slides: [
      makeSlotSlide({
        slot: cover,
        sectionId,
        title: `Отчёт о цифровом профиле — ${scoped.subject.displayName}`,
        content: { narrative: "Конфиденциально. Подготовлено для внутреннего использования клиента." },
        evidenceRefs: [],
        findingIds: [],
      }),
      // TOC content (titles/pages) is assembler-owned; slot only reserved here.
      makeSlotSlide({
        slot: toc,
        sectionId,
        content: { bullets: [] },
        evidenceRefs: [],
        findingIds: [],
      }),
      makeSlotSlide({
        slot: persona,
        sectionId,
        content: {
          narrative: sheet.narrative,
          bullets: sheet.bullets,
          whatToCheck: sheet.whatToCheck,
          sourceNote: sheet.sourceNote,
        },
        evidenceRefs: [],
        findingIds: [],
        metrics: { personaDecisionRecorded: extras.personaDecision ? 1 : 0 },
      }),
    ],
    status: "READY",
  };
}
