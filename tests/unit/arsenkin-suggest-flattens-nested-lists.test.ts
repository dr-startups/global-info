/**
 * Подсказки Arsenkin: ответ списком списков читается целиком.
 *
 * Прогон DPA-2026-0051: для google.ae провайдер вернул 185 подсказок списком
 * из 35 списков по 5 строк, а разборщик вложенные массивы отбрасывал — в отчёт
 * попала одна строка, исходная фраза из `words`. Для google.ru ответ пришёл
 * словарём и разобрался (126 → 32 уникальных).
 */

import { describe, expect, it } from "vitest";
import { mapSuggestToObservations } from "@/modules/digital-profile/providers/arsenkin/adapters/suggest";

const NESTED = {
  code: "TASK_RESULT",
  result: {
    se: 2,
    check: ["nrm", "spc", "cyr"],
    count: 15,
    words: ["kremlev umar nazarovich"],
    region: 1011981,
    result: [
      ["umar nazarovich kremlev", "умар назарович кремлёв биография", "умар кремлев кто он", "umar nasarowitsch kremlew", "umar kremlev"],
      ["umar nazarovich kremlev", "умар кремлев iba", "umar kremlev wife", "umar kremlev net worth", "umar kremlev boxing"],
      ["kremlev umar", "умар кремлев рольф", "umar kremlev ioc", "umar kremlev bio", "umar kremlev news"],
    ],
  },
};

const DICT = {
  code: "TASK_RESULT",
  result: {
    se: 2,
    count: 4,
    words: ["kremlev umar nazarovich"],
    region: 1011969,
    result: { "0": ["кремлёв умар назарович", "кремлев умар назарович личная жизнь"], "1": ["кремлёв умар назарович рольф", "кремлёв умар назарович жена"] },
  },
};

function drafts(payload: unknown) {
  return mapSuggestToObservations({
    caseId: "case-1",
    auditRunId: "run-1",
    regionLabel: "UAE",
    language: "en",
    queries: ["Kremlev Umar Nazarovich"],
    se: 2,
    payload,
  });
}

describe("разбор ответа подсказок", () => {
  it("список списков разворачивается в строки без дублей", () => {
    const titles = drafts(NESTED).map((d) => d.title);
    expect(titles.length).toBeGreaterThanOrEqual(13);
    expect(titles).toContain("умар кремлев рольф");
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("словарь по-прежнему читается", () => {
    const titles = drafts(DICT).map((d) => d.title);
    expect(titles).toEqual(expect.arrayContaining(["кремлёв умар назарович рольф", "кремлев умар назарович личная жизнь"]));
  });
});
