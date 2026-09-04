import { describe, expect, it } from "vitest";
import {
  anchorFormFromProfile,
  anchorFormWarnings,
  anchorsFromForm,
  strongByDefault,
  type AnchorFormState,
} from "@/modules/digital-profile/client/subject-anchors-form";
import { hasStrongSubjectAnchor } from "@/modules/digital-profile/orion-golden/analytics/subject-anchors";
import { t } from "@/modules/digital-profile/i18n";
import { en } from "@/modules/digital-profile/i18n/dictionaries/en";
import { ru } from "@/modules/digital-profile/i18n/dictionaries/ru";

/**
 * Форма признаков субъекта отвечает оператору до траты, а не после отчёта.
 *
 * Заказчик прогона DPA-2026-0049 нажал «его нет в списке» и получил отчёт о
 * четырёх разных людях. Панель обязана сказать словами, что признака нет и
 * платный сбор не начнётся, — и сказать это тогда, когда его ещё можно ввести.
 */

const empty: AnchorFormState = { birthDate: null, rows: [], innText: "", domainsText: "" };

function phrase(dict: typeof ru, key: string, vars?: Record<string, string | number>): string {
  const text = t(dict, key, vars);
  expect(text, key).not.toBe(key);
  return text;
}

describe("сила признака берётся из самой фразы", () => {
  it("многословная фраза сильна сама по себе, однословная — нет", () => {
    expect(strongByDefault("Арбитражный суд Краснодарского края")).toBe(true);
    expect(strongByDefault("судья")).toBe(false);
  });

  it("галочка делает сильным одно слово, но не наоборот", () => {
    const anchors = anchorsFromForm({
      ...empty,
      rows: [
        { kind: "position", text: "судья", strong: true },
        { kind: "employer", text: "Арбитражный суд Краснодарского края", strong: false },
      ],
    });
    expect(anchors.phrases.map((p) => p.strong)).toEqual([true, true]);
  });

  it("пустые строки формы в признаки не попадают", () => {
    const anchors = anchorsFromForm({
      ...empty,
      rows: [{ kind: "fact", text: "   ", strong: false }],
      innText: "\n 231112942662 \n\n",
      domainsText: "https://www.pro-sud-123.ru/spisok\n",
    });
    expect(anchors.phrases).toEqual([]);
    expect(anchors.inn).toEqual(["231112942662"]);
    expect(anchors.domains).toEqual(["https://www.pro-sud-123.ru/spisok"]);
  });
});

describe("форма заполняется из профиля кейса", () => {
  it("признаки оператора показываются как есть", () => {
    const form = anchorFormFromProfile({
      caseId: "case-1",
      displayName: "Егоров Алексей Евгеньевич",
      aliases: [],
      transliterations: [],
      anchors: {
        birthDate: "1977-11-30",
        phrases: [{ kind: "employer", text: "Арбитражный суд Краснодарского края", strong: true }],
        inn: ["231112942662"],
        domains: ["pro-sud-123.ru"],
      },
    });
    expect(form.birthDate).toBe("1977-11-30");
    expect(form.rows).toEqual([
      { kind: "employer", text: "Арбитражный суд Краснодарского края", strong: true },
    ]);
    expect(form.innText).toBe("231112942662");
    expect(form.domainsText).toBe("pro-sud-123.ru");
  });

  it("прежние контекст-слова переезжают в строки формы", () => {
    const form = anchorFormFromProfile({
      caseId: "case-1",
      displayName: "Егоров Алексей Евгеньевич",
      aliases: [],
      transliterations: [],
      contextIdentifiers: ["Арбитражный суд Краснодарского края", "судья"],
    });
    expect(form.rows).toEqual([
      { kind: "fact", text: "Арбитражный суд Краснодарского края", strong: true },
      { kind: "fact", text: "судья", strong: false },
    ]);
  });

  it("ИНН из корпуса в поле оператора не подставляется", () => {
    // Три чужих ИНН прогона 0049 лежат в профиле как добытые. Подставить их в
    // поле «со слов клиента» значило бы выдать находку за слова клиента.
    const form = anchorFormFromProfile({
      caseId: "case-1",
      displayName: "Егоров Алексей Евгеньевич",
      aliases: [],
      transliterations: [],
      knownIdentifiers: { inn: ["230811088018"] },
    });
    expect(form.innText).toBe("");
  });
});

describe("панель говорит, чего не хватает", () => {
  const keysOf = (state: AnchorFormState): string[] =>
    anchorFormWarnings(state).map((w) => w.key);

  it("признака нет вовсе — сказано, что сбор не начнётся", () => {
    expect(keysOf(empty)).toContain("persona.anchorsNoStrong");
    expect(hasStrongSubjectAnchor(anchorsFromForm(empty))).toBe(false);
  });

  it("названы только слабые слова — тот же ответ, ворота закрыты", () => {
    const state: AnchorFormState = {
      ...empty,
      rows: [{ kind: "position", text: "судья", strong: false }],
    };
    expect(keysOf(state)).toContain("persona.anchorsNoStrong");
    expect(keysOf(state)).toContain("persona.anchorsSingleWord");
    expect(hasStrongSubjectAnchor(anchorsFromForm(state))).toBe(false);
  });

  it("одна дата рождения ворота открывает, но панель просит работодателя", () => {
    const state: AnchorFormState = { ...empty, birthDate: "1977-11-30" };
    expect(hasStrongSubjectAnchor(anchorsFromForm(state))).toBe(true);
    expect(keysOf(state)).toEqual(["persona.anchorsOnlyBirthDate"]);
  });

  it("ИНН с битой контрольной суммой назван до отказа сервера", () => {
    const warnings = anchorFormWarnings({ ...empty, innText: "231112942661" });
    const bad = warnings.find((w) => w.key === "persona.anchorsBadInn");
    expect(String(bad?.vars?.items)).toContain("231112942661");
  });

  it("сильный признак назван — панель молчит", () => {
    expect(
      keysOf({
        ...empty,
        birthDate: "1977-11-30",
        rows: [{ kind: "employer", text: "Арбитражный суд Краснодарского края", strong: false }],
      })
    ).toEqual([]);
  });

  it("каждое предупреждение переводится в обоих кабинетах", () => {
    const states: AnchorFormState[] = [
      empty,
      { ...empty, rows: [{ kind: "position", text: "судья", strong: false }] },
      { ...empty, birthDate: "1977-11-30" },
      { ...empty, innText: "231112942661" },
    ];
    for (const state of states) {
      for (const warning of anchorFormWarnings(state)) {
        for (const dict of [ru, en]) phrase(dict, warning.key, warning.vars);
      }
    }
  });
});
