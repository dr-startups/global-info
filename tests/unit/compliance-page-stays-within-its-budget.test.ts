/**
 * Ни один лист комплаенса не выходит за объявленный потолок.
 *
 * Потолок — не украшение: обрезанная строка на странице комплаенса
 * останавливает выдачу отчёта целиком, поэтому лист, вышедший за бюджет, — это
 * не «некрасиво», а отказ оплаченного прогона. Единиц две, потому что таблицы
 * две: у карточек записей слот — строка таблицы или полоса-заголовок
 * (`CARD_PAGE_SLOTS`), у сводки — строка записи (`SUMMARY_PAGE_ROWS`).
 *
 * Проверка держит **нижнюю** границу числа: набор, который построитель обязан
 * разложить, не должен давать лист больше потолка. Верхнюю границу (лист
 * потолка ещё влезает в белую сцену) держит смок
 * `renderer/smoke_search_table_layout.py`, Т8е/Т8ж: там меряется настоящая
 * страница, а не арифметика по константам.
 */

import { describe, expect, it } from "vitest";
import {
  CARD_PAGE_SLOTS,
  SUMMARY_PAGE_ROWS,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/compliance";
import {
  complianceSlides,
  fullRecord,
  isCardPage,
  isSummaryPage,
  minimalRecord,
  pageSlots,
} from "../fixtures/compliance-fragment";

/** Наборы, на которых потолок проверяется: у каждой базы своя ширина справки. */
const CORPORA: Array<[string, Array<Record<string, unknown>>]> = [
  // Справка LexisNexis — три строки, самая широкая: именно на ней лист
  // «одна предельная карточка + справка» и выходил за потолок.
  ["две предельные записи LexisNexis", [fullRecord("LEXISNEXIS", 1), fullRecord("LEXISNEXIS", 2)]],
  ["три предельные записи Dow Jones", [1, 2, 3].map((n) => fullRecord("DOW_JONES", n))],
  [
    "предельные и краткие вперемешку у обеих баз",
    [
      fullRecord("DOW_JONES", 1),
      minimalRecord("DOW_JONES", 2),
      fullRecord("LEXISNEXIS", 3),
      minimalRecord("LEXISNEXIS", 4),
      minimalRecord("LEXISNEXIS", 5),
    ],
  ],
  // База без своей страницы: карточки едут продолжением сводки, справки там нет.
  [
    "восемь предельных записей OpenSanctions",
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => fullRecord("OPEN_SANCTIONS", n)),
  ],
];

describe("лист комплаенса не выходит за свой потолок", () => {
  it.each(CORPORA)("%s: карточки укладываются в бюджет слотов", (_label, records) => {
    const pages = complianceSlides(records).filter(isCardPage);
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(
        pageSlots(page),
        `${page.slideId}: слотов ${pageSlots(page)} при потолке ${CARD_PAGE_SLOTS}`
      ).toBeLessThanOrEqual(CARD_PAGE_SLOTS);
    }
  });

  it.each(CORPORA)("%s: сводка укладывается в потолок строк", (_label, records) => {
    const pages = complianceSlides(records).filter(isSummaryPage);
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(page.content.table?.rows.length ?? 0).toBeLessThanOrEqual(SUMMARY_PAGE_ROWS);
    }
  });

  it("сорок импортированных записей не дают ни одного листа сверх потолка", () => {
    // Ручной импорт PDF LexisNexis берёт до сорока сигналов и заводит на каждый
    // строку `NEEDS_REVIEW` — все сорок доезжают до деки. Это и есть тот вход,
    // на котором сводная страница переполнялась гарантированно.
    const records = Array.from({ length: 40 }, (_, i) => minimalRecord("LEXISNEXIS", i + 1));
    const slides = complianceSlides(records);
    for (const page of slides.filter(isSummaryPage)) {
      expect(page.content.table?.rows.length ?? 0).toBeLessThanOrEqual(SUMMARY_PAGE_ROWS);
    }
    for (const page of slides.filter(isCardPage)) {
      expect(pageSlots(page)).toBeLessThanOrEqual(CARD_PAGE_SLOTS);
    }
  });
});
