/**
 * Пустой ответ Arsenkin — это ответ, а не сломанная схема.
 *
 * Прогон DPA-2026-0054 (11.09.2026): на «люди также спрашивают» Google по обоим
 * регионам Arsenkin ответил честно — `total: 0`, по одному пустому списку на
 * запрос (`result: [[]]`). Конверт раскрыл вложенные блоки, вопросов не нашёл и
 * вернул нагрузку без `items`; адаптер не увидел массива и объявил
 * `ARSENKIN_SCHEMA_INVALID`. Оба задания отклонены, конвейер встал, а
 * авто-возобновление повторяло детерминированную ошибку каждые пять минут.
 *
 * Контейнер «по запросу» есть — значит провайдер ответил, и пустой ответ
 * читается как `EMPTY_VALID`. Контейнера нет вовсе — форма неизвестна, и отказ
 * остаётся: выдумывать пустоту там, где ответа не было, нельзя.
 *
 * Та же форма у подсказок Google: список списков. Шаг 0053 научил ей
 * провайдерный адаптер, а единый прогон разбирает ответ конвертом, который знал
 * только словарь `{"0": […]}` — и из 338 подсказок ОАЭ оставлял одну строку,
 * сам запрос из `words`. Один вопрос, два разборщика, два ответа.
 */

import { describe, expect, it } from "vitest";
import { adaptArsenkinToolResponse } from "@/modules/digital-profile/services/arsenkin-tool-adapters";

const CTX = {
  providerTaskId: "pt-1",
  externalTaskId: "31308469",
  caseAgent: "ARSENKIN_PAA_REAL",
  toolName: "paa",
  enrichmentRunId: "run-1",
  unifiedJobId: "job-1",
} as const;

function envelope(result: Record<string, unknown>) {
  return { code: "TASK_RESULT", result, task_id: "31308469", created_at: "2026-09-11 11:48:58", finished_at: "2026-09-11 11:52:24" };
}

/** Форма, наблюдённая на прогоне 0054: вопросов нет. */
function emptyPaa(queries: string[]) {
  return envelope({
    ss: "Google",
    found: [],
    sites: [],
    total: 0,
    region: "Москва",
    result: queries.map(() => []),
    queries,
    google_reg: { from: null, lang: null, domain: null },
  });
}

function paaRequest(queries: string[]) {
  return { data: { se: 2, count: 10, depth: 1, region: 1011969, queries, google_from: "RU", google_lang: "ru", google_domain: "www.google.ru" }, tools_name: "paa" };
}

function adapt(toolName: string, responseJson: unknown, requestJson: unknown) {
  return adaptArsenkinToolResponse({ toolName, responseJson, requestJson, ctx: { ...CTX, toolName } as never });
}

describe("люди также спрашивают", () => {
  it("пустой контейнер по запросу — ответ «вопросов нет», а не ошибка схемы", () => {
    const r = adapt("paa", emptyPaa(["тестов сергей михайлович"]), paaRequest(["Тестов Сергей Михайлович"]));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.emptyValid).toBe(true);
    expect(r.observations).toEqual([]);
    expect(r.warnings).toContain("PAA:EMPTY_VALID");
  });

  it("два запроса без вопросов — тоже ответ", () => {
    const r = adapt("paa", emptyPaa(["тестов сергей", "sergey testov"]), paaRequest(["Тестов Сергей", "Sergey Testov"]));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.emptyValid).toBe(true);
  });

  it("вопросы по-прежнему читаются", () => {
    const body = envelope({
      ss: "Google",
      total: 2,
      result: [[
        { link: "", level: 1, answer: "…", question: "Кто такой Тестов Сергей Михайлович?", answerHtml: false },
        { link: "", level: 1, answer: "…", question: "Где работает Сергей Тестов?", answerHtml: false },
      ]],
      queries: ["тестов сергей михайлович"],
    });
    const r = adapt("paa", body, paaRequest(["Тестов Сергей Михайлович"]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.observations.map((o) => o.title)).toEqual([
      "Кто такой Тестов Сергей Михайлович?",
      "Где работает Сергей Тестов?",
    ]);
  });

  it("без контейнера по запросу форма неизвестна — отказ остаётся", () => {
    const r = adapt("paa", envelope({ ss: "Google", total: 0, queries: ["тестов сергей михайлович"] }), paaRequest(["Тестов Сергей Михайлович"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ARSENKIN_SCHEMA_INVALID");
  });
});

const NESTED_SUGGEST = envelope({
  se: 2,
  check: ["nrm", "spc", "cyr"],
  count: 15,
  words: ["sergey testov"],
  region: 1011981,
  result: [
    ["sergey testov biography", "сергей тестов биография", "сергей тестов кто он", "sergey testov company", "sergey testov"],
    ["sergey testov biography", "сергей тестов компания", "sergey testov wife", "sergey testov net worth", "sergey testov interview"],
    ["testov sergey", "сергей тестов бизнес", "sergey testov linkedin", "sergey testov bio", "sergey testov news"],
  ],
});

const DICT_SUGGEST = envelope({
  se: 2,
  count: 4,
  words: ["тестов сергей михайлович"],
  region: 1011969,
  result: { "0": ["тестов сергей михайлович", "тестов сергей михайлович биография"], "1": ["тестов сергей михайлович компания", "тестов сергей михайлович интервью"] },
});

function suggestRequest(queries: string[], region: number) {
  return { data: { se: 2, check: ["nrm", "spc", "cyr"], depth: 1, region, queries }, tools_name: "suggest" };
}

describe("подсказки", () => {
  it("список списков разворачивается целиком, без дублей", () => {
    const r = adapt("suggest", NESTED_SUGGEST, suggestRequest(["Sergey Testov"], 1011981));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const titles = r.observations.map((o) => o.title);
    expect(titles.length).toBeGreaterThanOrEqual(13);
    expect(titles).toContain("сергей тестов компания");
    expect(new Set(titles.map((t) => String(t ?? "").toLowerCase())).size).toBe(titles.length);
  });

  it("словарь по-прежнему читается", () => {
    const r = adapt("suggest", DICT_SUGGEST, suggestRequest(["Тестов Сергей Михайлович"], 1011969));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.observations.map((o) => o.title)).toEqual(
        expect.arrayContaining(["тестов сергей михайлович компания", "тестов сергей михайлович интервью"])
      );
    }
  });

  it("пустой контейнер подсказок — ответ «подсказок нет»", () => {
    const body = envelope({ se: 2, count: 0, words: ["sergey testov"], region: 1011981, result: [[]] });
    const r = adapt("suggest", body, suggestRequest(["Sergey Testov"], 1011981));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.emptyValid).toBe(true);
    expect(r.warnings).toContain("SUGGESTIONS:EMPTY_VALID");
  });
});
