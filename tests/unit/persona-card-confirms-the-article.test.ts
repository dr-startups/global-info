/**
 * Карточка персоны подтверждает статью Википедии.
 *
 * QA MVP 14.09.2026: оператор до сбора выбрал карточку Википедии «Дуров, Павел
 * Валерьевич», лист «Кого проверяли» это печатает — а страница «Википедия»
 * того же отчёта писала «принадлежность статьи проверяемому лицу не
 * подтверждена» и не приводила фрагменты. Решение о персоне до записи
 * проверки Википедии не доходило (шаг 0088).
 *
 * Правило: запись проверки той же статьи, что выбрана оператором, —
 * `SUBJECT_MATCH`; сестра по межъязыковой ссылке — тоже; чужая статья и
 * отсутствие решения ничего не меняют; решение оператора сильнее понижения
 * разбором статьи.
 */

import { describe, expect, it } from "vitest";
import { personaConfirmsArticles } from "@/modules/digital-profile/orion-golden/deck-sections/persona-confirms-article";
import type { PersonaDecisionRecord } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

type Entry = {
  kind?: string;
  url?: string;
  title?: string;
  language?: string;
  langlinkOf?: { language?: string; title?: string };
  subjectDecision?: string;
};

const SELECTED: PersonaDecisionRecord = {
  decision: "PERSONA_SELECTED",
  selected: {
    source: "wikipedia",
    title: "Дуров, Павел Валерьевич",
    url: "https://ru.wikipedia.org/wiki/%D0%94%D1%83%D1%80%D0%BE%D0%B2%2C_%D0%9F%D0%B0%D0%B2%D0%B5%D0%BB_%D0%92%D0%B0%D0%BB%D0%B5%D1%80%D1%8C%D0%B5%D0%B2%D0%B8%D1%87",
    datesOfBirth: [],
  },
  sources: [{ source: "wikipedia", status: "SUCCESS" }],
  cardCount: 9,
  decidedAt: "2026-09-14T00:00:00.000Z",
} as PersonaDecisionRecord;

function entries(): Entry[] {
  return [
    { kind: "wikipedia_check", url: "https://ru.wikipedia.org/wiki/Дуров,_Павел_Валерьевич", title: "Дуров, Павел Валерьевич", language: "ru" },
    { kind: "wikipedia_check", url: "https://en.wikipedia.org/wiki/Pavel_Durov", title: "Pavel Durov", language: "en", langlinkOf: { language: "ru", title: "Дуров, Павел Валерьевич" } },
    { kind: "wikipedia_check", url: "https://ru.wikipedia.org/wiki/Дуров,_Валерий_Семёнович", title: "Дуров, Валерий Семёнович", language: "ru" },
    { kind: "serp_row", url: "https://ru.wikipedia.org/wiki/Дуров,_Павел_Валерьевич", title: "строка выдачи, не проверка" },
  ];
}

describe("карточка персоны подтверждает статью", () => {
  it("та же статья (адрес с процентным кодированием) и её сестра по межъязыковой ссылке — SUBJECT_MATCH", () => {
    const list = entries();
    const confirmed = personaConfirmsArticles(list, SELECTED);
    expect(list[0]!.subjectDecision).toBe("SUBJECT_MATCH");
    expect(list[1]!.subjectDecision).toBe("SUBJECT_MATCH");
    expect(list[2]!.subjectDecision).toBeUndefined();
    expect(list[3]!.subjectDecision).toBeUndefined();
    expect(confirmed).toEqual(["ru:дуров, павел валерьевич", "en:pavel durov"]);
  });

  it("без решения, без карточки или с другой статьёй ничего не меняется", () => {
    for (const persona of [
      null,
      { ...SELECTED, decision: "APPROVED_WITHOUT_PERSONA", selected: null } as PersonaDecisionRecord,
      { ...SELECTED, selected: { ...SELECTED.selected!, url: "https://ru.wikipedia.org/wiki/Дуров,_Николай_Валерьевич", title: "Дуров, Николай Валерьевич" } } as PersonaDecisionRecord,
    ]) {
      const list = entries();
      expect(personaConfirmsArticles(list, persona)).toEqual([]);
      expect(list.map((e) => e.subjectDecision)).toEqual([undefined, undefined, undefined, undefined]);
    }
  });

  it("решение оператора сильнее понижения разбором статьи", () => {
    const list = entries();
    list[0]!.subjectDecision = "OTHER_SUBJECT";
    personaConfirmsArticles(list, SELECTED);
    expect(list[0]!.subjectDecision).toBe("SUBJECT_MATCH");
  });

  it("без адреса статья узнаётся по языку и заголовку", () => {
    const list = entries();
    list[0]!.url = undefined;
    personaConfirmsArticles(list, SELECTED);
    expect(list[0]!.subjectDecision).toBe("SUBJECT_MATCH");
  });
});
