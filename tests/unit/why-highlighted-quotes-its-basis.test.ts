/**
 * «Почему выделено» цитирует основание рамки, а не фразу принадлежности (шаг 0117).
 *
 * Стр. 28 отчёта Бондарчука 19.09.2026: «На странице ru.wikipedia.org —
 * Биография и карьера Фёдора Бондарчука с упоминанием скандалов», а цитата —
 * «Фёдор Сергеевич Бондарчук (род. 9 мая 1967, Москва, СССР) — советский и
 * российский актёр кино». Это первая цитата прочитанной страницы, по промпту
 * чтения — фрагмент принадлежности (имя рядом с признаком). Основание вывода
 * стоит дальше: «Член Высшего совета политической партии «Единая Россия»…»,
 * «Не отличался успешной учёбой…, стал пить, курить и хулиганить».
 *
 * Правило: основание рамки — первая цитата со словом негатива; иначе первая
 * цитата, не являющаяся лидом принадлежности; иначе первая, как прежде.
 */

import { describe, expect, it } from "vitest";
import { highlightPhrase } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { VisibleAssetItem } from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";

const URL = "https://ru.wikipedia.org/wiki/Бондарчук,_Фёдор_Сергеевич";
const LEAD =
  "Фёдор Сергеевич Бондарчук (род. 9 мая 1967, Москва, СССР) — советский и российский актёр кино";
const PARTY = "Член Высшего совета политической партии «Единая Россия» в 2009—2021 годах.";
const SCHOOL =
  "Не отличался успешной учёбой и хорошим поведением, в школьные годы стал пить, курить и хулиганить";
const COURT = "Суд Москвы арестовал имущество режиссёра по иску кредиторов на 40 млн рублей.";

const row: VisibleAssetItem = {
  ref: "inventory:wiki",
  url: URL,
  domain: "ru.wikipedia.org",
  title: "Бондарчук, Фёдор Сергеевич — Википедия",
  adverse: true,
  themeTitle: "Потенциально негативные публикации",
};

function index(over: Partial<ScopedEvidenceIndex[string]>): ScopedEvidenceIndex {
  return {
    "inventory:wiki": {
      url: URL,
      domain: "ru.wikipedia.org",
      title: "Бондарчук, Фёдор Сергеевич — Википедия",
      readVerdictTone: "adverse",
      verdictSubjectMatch: "subject",
      verdictTheme: "Биография и карьера Фёдора Бондарчука с упоминанием скандалов",
      ...over,
    },
  };
}

describe("основание рамки на снимке выдачи", () => {
  it("В1: из [лид, партия, хулиганство] печатается не лид", () => {
    const phrase = highlightPhrase({
      row,
      evidence: index({ pageQuote: LEAD, pageQuotes: [LEAD, PARTY, SCHOOL] }),
      budget: 1000,
    });
    expect(phrase.full).not.toContain("актёр кино");
    expect(phrase.full).toContain("Единая Россия");
    expect(phrase.sidebar).not.toContain("актёр кино");
  });

  /**
   * Правка кавычек внутри основания (шаг 0137).
   *
   * Стр. 26 отчёта Галицкого 20.09.2026: «Президент и владелец футбольного
   * клуба « Краснодар »». Внутренние ёлочки не стали лапками, и внутри них
   * остались пробелы разметки — строка собиралась склейкой «${quote}» и общую
   * чистку не звала. Тот же дефект, что шаг 0131 чинил в списке признаков.
   */
  it("В4: внутренние ёлочки становятся лапками, пары »» не бывает", () => {
    const raw = "Президент и владелец футбольного клуба « Краснодар »";
    const phrase = highlightPhrase({
      row,
      evidence: index({ pageQuote: raw, pageQuotes: [raw] }),
      budget: 1000,
    });
    expect(phrase.full).not.toContain("»»");
    expect(phrase.full).not.toContain("« Краснодар »");
    expect(phrase.full).toContain("„Краснодар“");
  });

  it("В2: цитата со словом негатива идёт первой, даже если стоит позже лида", () => {
    const phrase = highlightPhrase({
      row,
      evidence: index({ pageQuote: LEAD, pageQuotes: [LEAD, PARTY, COURT] }),
      budget: 1000,
    });
    expect(phrase.full).toContain("арестовал имущество");
    expect(phrase.full).not.toContain("актёр кино");
    expect(phrase.full).not.toContain("Единая Россия");
  });

  it("В3: запись без pageQuotes печатает pageQuote, как прежде", () => {
    const phrase = highlightPhrase({
      row,
      evidence: index({ pageQuote: LEAD }),
      budget: 1000,
    });
    expect(phrase.full).toContain("актёр кино");
  });
});
