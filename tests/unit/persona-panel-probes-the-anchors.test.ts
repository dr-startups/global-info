import { describe, expect, it } from "vitest";
import {
  personaProbeOfCheck,
  hasStrongSubjectAnchor,
} from "@/modules/digital-profile/services/subject-persona-check";
import type { SubjectAnchors } from "@/modules/digital-profile/orion-golden/analytics/subject-anchors";

/**
 * Панель показывает пробу по нынешним признакам, а не по признакам на момент
 * снимка.
 *
 * Оператор вводит признаки и хочет увидеть, на каких купленных строках они
 * нашлись, — не переплачивая за новый сбор панели. Значит, проба считается
 * из снимка при каждом чтении, а не замораживается в нём.
 */

const ANCHORS: SubjectAnchors = {
  birthDate: "1977-11-30",
  phrases: [{ kind: "employer", text: "Арбитражный суд Краснодарского края", strong: true }],
  inn: [],
  domains: [],
};

const SNAPSHOT = {
  subjectFullName: "Егоров Алексей Евгеньевич",
  subjectDateOfBirth: "1977-11-30",
  cards: [],
  sources: [],
  fetchStatus: "SUCCESS",
  errorCode: null,
  serpRows: [
    {
      title: "На Кубани новый председатель арбитражного суда",
      snippet: "Председателем Арбитражного суда Краснодарского края назначен Алексей Егоров",
      url: "https://kubnews.ru/obshchestvo/2016/10/21/na-kubani-novyy-predsedatel/",
      domain: "kubnews.ru",
      engine: "GOOGLE",
    },
    {
      title: "Егоров Алексей Евгеньевич — ИП",
      snippet: "ИНН 230811088018, дата рождения 15.06.1984",
      url: "https://audit-it.ru/ip/230811088018",
      domain: "audit-it.ru",
      engine: "YANDEX",
    },
  ],
};

describe("проба якорей по последнему снимку панели", () => {
  it("признак назван — панель знает, на какой строке он нашёлся", () => {
    const probe = personaProbeOfCheck({ personasJson: SNAPSHOT, anchors: ANCHORS });
    expect(probe?.hits.map((h) => h.anchor)).toContain("Арбитражный суд Краснодарского края");
    expect(probe?.hits[0]?.rows.map((r) => r.domain)).toEqual(["kubnews.ru"]);
  });

  it("чужая дата рождения на строке названа конфликтом с адресом", () => {
    const probe = personaProbeOfCheck({ personasJson: SNAPSHOT, anchors: ANCHORS });
    const conflict = probe?.conflicts.find((c) => c.domain === "audit-it.ru");
    expect(conflict?.reason).toBe("foreign_birth_date");
    expect(conflict?.url).toBe("https://audit-it.ru/ip/230811088018");
  });

  it("признаков нет — пробы нет вовсе, а не пустая проба", () => {
    // «Ничего не нашли» и «нечего искать» — разные ответы: панель во втором
    // случае показывает строки выдачи как есть и просит ввести признак.
    expect(personaProbeOfCheck({ personasJson: SNAPSHOT, anchors: null })).toBeNull();
    expect(
      personaProbeOfCheck({
        personasJson: SNAPSHOT,
        anchors: { birthDate: null, phrases: [], inn: [], domains: [] },
      })
    ).toBeNull();
    expect(hasStrongSubjectAnchor(null)).toBe(false);
  });

  it("снимка ещё нет — пробы тоже нет", () => {
    expect(personaProbeOfCheck({ personasJson: null, anchors: ANCHORS })).toBeNull();
  });
});
