/**
 * Под якорями запрос принадлежности не подтверждает.
 *
 * Правило §2.2 («искали полное имя — значит, одна фамилия в заголовке всё же
 * говорит о субъекте») старше якорей и на прогоне DPA-2026-0053 дало 201
 * решение «вероятно о субъекте»: боксёр, тенор, дизайнер, officer из ICIJ, PDF
 * списка Навального, статья SSRN, юрфирма Egorov Puginsky. Все семь чужих
 * записей исполнительного резюме пришли оттуда — у каждой в отборе стоит
 * `subject:LIKELY_SUBJECT`.
 *
 * Запрос — это намерение оператора, а не свойство материала. Когда признаки
 * названы, принадлежность подтверждает признак: фамилия рядом с сильным якорем
 * поднимается до «вероятно», фамилия с одним лишь запросом — нет.
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import {
  classifySubjectRelevance,
  type SubjectIdentity,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";

let seq = 0;
function item(
  partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">
): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `q-${seq}`,
    caseId: "case-egorov",
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "topvisor-google",
    region: "UAE",
    query: "Егоров Алексей Евгеньевич",
    collectedAt: "2026-09-04T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    ...partial,
  };
}

const BASE: SubjectIdentity = {
  displayName: "Егоров Алексей Евгеньевич",
  lastName: "Егоров",
  lastNameVariants: ["egorov"],
  firstNames: ["Алексей", "aleksey"],
  patronymics: ["Евгеньевич", "evgenevich"],
  aliases: [],
  strongIdentifiers: [],
  contextIdentifiers: [],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

const ANCHORED: SubjectIdentity = {
  ...BASE,
  anchors: {
    birthDate: "1977-11-30",
    phrases: [
      { kind: "employer", text: "Арбитражный Суд Краснодарского края", strong: true },
      { kind: "position", text: "председатель Арбитражного суда Краснодарского края", strong: true },
    ],
    inn: ["231112942662"],
    domains: ["pravo.ru"],
  },
};

/** Строка ОАЭ-контура: в заголовке одна фамилия, запрос нёс полное имя. */
const ICIJ = item({
  title: "Alexey Egorov",
  snippet: "Officer in the Panama Papers database",
  sourceUrl: "https://offshoreleaks.icij.org/nodes/12345678",
});

describe("якорь старше запроса", () => {
  it("без якорей правило запроса работает по-прежнему", () => {
    const d = classifySubjectRelevance(ICIJ, BASE);
    expect(d.decision).toBe("LIKELY_SUBJECT");
    expect(d.reasonCode).toBe("surname_with_subject_query");
  });

  it("под якорями одна фамилия при запросе о субъекте — не «вероятно»", () => {
    const d = classifySubjectRelevance(ICIJ, ANCHORED);
    expect(d.decision).toBe("AMBIGUOUS");
    expect(d.reasonCode).toBe("surname_query_no_anchor");
  });

  it("фамилия рядом с сильным якорем поднимается до «вероятно»", () => {
    const d = classifySubjectRelevance(
      item({
        region: "RU",
        title: "Егоров возглавил Арбитражный суд Краснодарского края",
        snippet: "Кадровое решение принято на этой неделе",
        sourceUrl: "https://kubnews.ru/obshchestvo/2016/10/21/novyy-predsedatel/",
      }),
      ANCHORED
    );
    expect(d.decision).toBe("LIKELY_SUBJECT");
    expect(d.reasonCode).toBe("surname_with_anchor");
  });

  it("домен якорем принадлежности при одной фамилии не считается", () => {
    const d = classifySubjectRelevance(
      item({
        region: "RU",
        title: "Егоров — новости портала",
        snippet: "Материалы редакции",
        sourceUrl: "https://pravo.ru/news/246810/",
      }),
      ANCHORED
    );
    expect(d.decision).toBe("AMBIGUOUS");
    expect(d.reasonCode).toBe("surname_query_no_anchor");
  });

  it("без якорей та же строка судится прежней лестницей", () => {
    const row = item({
      region: "RU",
      title: "Егоров возглавил Арбитражный суд Краснодарского края",
      snippet: "Кадровое решение принято на этой неделе",
      sourceUrl: "https://kubnews.ru/obshchestvo/2016/10/21/novyy-predsedatel/",
    });
    const d = classifySubjectRelevance(row, BASE);
    expect(d.decision).toBe("LIKELY_SUBJECT");
    expect(d.reasonCode).toBe("surname_with_subject_query");
  });
});
