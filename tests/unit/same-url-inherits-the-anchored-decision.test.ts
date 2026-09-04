/**
 * Одна страница — одно решение о принадлежности.
 *
 * Наблюдения одного адреса различаются запросом и сниппетом: у строки, пришедшей
 * по запросу «ФИО инн», сниппет может не нести якоря, который стоит в сниппете
 * той же страницы по другому запросу. Заякоренное решение наследуется по
 * нормализованному адресу; конфликт не наследуется никогда.
 *
 * Продвижение по общему домену в строгом режиме выключено: домен, подтверждённый
 * якорем судьи, поднимал бы чужих ИП на rusprofile.
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import {
  buildSubjectResolution,
  type SubjectIdentity,
} from "@/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";

let seq = 0;
function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `inh-${seq}`,
    caseId: "case-egorov",
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-09-03T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    ...partial,
  };
}

const SUBJECT: SubjectIdentity = {
  displayName: "Егоров Алексей Евгеньевич",
  lastName: "Егоров",
  lastNameVariants: ["egorov"],
  firstNames: ["Алексей"],
  patronymics: ["Евгеньевич"],
  aliases: [],
  strongIdentifiers: [],
  contextIdentifiers: [],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
  anchors: {
    birthDate: "1977-11-30",
    phrases: [{ kind: "employer", text: "Арбитражный суд Краснодарского края", strong: true }],
    inn: [],
    domains: [],
  },
};

function resolve(items: RawInventoryItem[]) {
  const res = buildSubjectResolution({
    caseId: "case-egorov",
    datasetId: "ds-1",
    subject: SUBJECT,
    items,
    sourceHashes: [],
  });
  return new Map(res.items.map((i) => [i.evidenceRef, i]));
}

describe("наследование по адресу", () => {
  it("строка того же адреса без якоря в сниппете наследует подтверждение", () => {
    const anchored = item({
      title: "Судья Егоров Алексей Евгеньевич на портале Право.ру",
      snippet: "Родился 30.11.1977г.",
      sourceUrl: "https://pravo.ru/arbitr_practice/judge/1465/",
    });
    const bare = item({
      title: "Егоров Алексей Евгеньевич",
      sourceUrl: "https://www.pravo.ru/arbitr_practice/judge/1465/?utm_source=serp",
    });
    const by = resolve([anchored, bare]);
    expect(by.get(`inventory:${anchored.inventoryId}`)?.decision).toBe("SUBJECT_MATCH");
    const inherited = by.get(`inventory:${bare.inventoryId}`);
    expect(inherited?.decision).toBe("SUBJECT_MATCH");
    expect(inherited?.reasonCode).toBe("url_inherited");
  });

  it("конфликтная строка того же адреса не наследует", () => {
    const anchored = item({
      title: "Егоров Алексей Евгеньевич | Арбитражный суд Краснодарского края",
      sourceUrl: "https://example.org/page",
    });
    const conflicting = item({
      title: "Егоров Алексей Евгеньевич",
      snippet: "Родился: 10 августа 1983 года",
      sourceUrl: "https://example.org/page",
    });
    const by = resolve([anchored, conflicting]);
    expect(by.get(`inventory:${conflicting.inventoryId}`)?.decision).toBe("OTHER_SUBJECT");
  });

  it("строка одной фамилии на подтверждённом домене не поднимается", () => {
    // Продвижение по общему домену в строгом режиме выключено: страница судьи
    // на rusprofile.ru иначе поднимала бы страницы чужих ИП того же домена.
    const anchored = item({
      title: "Егоров Алексей Евгеньевич | Арбитражный суд Краснодарского края",
      sourceUrl: "https://rusprofile.ru/person/egorov-ae-1",
    });
    const surnameOnly = item({
      title: "Егоров — выписка из ЕГРИП",
      snippet: "индивидуальный предприниматель",
      sourceUrl: "https://rusprofile.ru/ip/324510000025576",
    });
    const by = resolve([anchored, surnameOnly]);
    const row = by.get(`inventory:${surnameOnly.inventoryId}`);
    expect(row?.decision).toBe("AMBIGUOUS");
    expect(row?.reasonCode).toBe("surname_only");
  });

  it("общий домен в строгом режиме ничего не поднимает", () => {
    const anchored = item({
      title: "Егоров Алексей Евгеньевич | Арбитражный суд Краснодарского края",
      sourceUrl: "https://rusprofile.ru/person/egorov-ae-1",
    });
    const otherPage = item({
      title: "Егоров Алексей Евгеньевич",
      snippet: "ИП, Мончегорск",
      sourceUrl: "https://rusprofile.ru/ip/324510000025576",
    });
    const by = resolve([anchored, otherPage]);
    const other = by.get(`inventory:${otherPage.inventoryId}`);
    expect(other?.decision).toBe("AMBIGUOUS");
    expect(other?.reasonCode).toBe("full_name_no_anchor");
  });
});
