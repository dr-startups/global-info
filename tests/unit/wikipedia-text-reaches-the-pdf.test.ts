import { describe, expect, it } from "vitest";
import { wikipediaCheckTextInPdf } from "../../scripts/run-orion-deck-sections-report72";

/**
 * Ворота меряют PDF, а не полезную нагрузку.
 *
 * Регресс страницы Википедии прошёл при 22 зелёных воротах именно здесь: текст
 * доезжал до `render-payload.json` целиком, а до листа — нет. Проверять надо
 * последний зазор, «payload → PDF», и сравнением, которое переживает перенос
 * строки: `pdftotext` рвёт строки и расставляет дефисы там, где их не было.
 */

const NARRATIVE =
  "Наличие статьи о проверяемом лице проверено через официальный поисковый API Википедии " +
  "в русскоязычном разделе (ru.wikipedia.org); запрос: «Рашников Виктор Филиппович», " +
  "проверка выполнена 17.08.2026. Проверка по этому запросу статью не нашла.";

const SLIDES = [
  { template: "orion_golden_cover", pageNumber: 1, narrative: "Конфиденциально." },
  { template: "orion_golden_wikipedia_check", pageNumber: 25, narrative: NARRATIVE },
];

/** Как текст страницы отдаёт fitz: с переносами посреди фразы. */
const PDF_PAGE = `Россия — Википедия
Статус сбора
Наличие статьи о проверяемом лице проверено через официальный
поисковый API Википедии в русскоязычном разделе (ru.wikipedia.org);
запрос: «Рашников Виктор Филиппович», проверка выполнена 17.08.2026.
Проверка по этому запросу статью не нашла.`;

describe("текст страницы проверки доезжает до PDF", () => {
  it("голова нарратива найдена в тексте страницы, несмотря на переносы", () => {
    expect(wikipediaCheckTextInPdf(SLIDES, (page) => (page === 25 ? PDF_PAGE : ""))).toBe(true);
  });

  it("пустая страница PDF — отказ", () => {
    expect(wikipediaCheckTextInPdf(SLIDES, () => "Россия — Википедия")).toBe(false);
  });

  it("текст, доехавший на другую страницу, воротами не засчитывается", () => {
    expect(wikipediaCheckTextInPdf(SLIDES, (page) => (page === 24 ? PDF_PAGE : ""))).toBe(false);
  });

  it("деки без страницы проверки достаточно, чтобы считать ворота непройденными", () => {
    // Проверка без входа выглядит ровно так же, как пройденная.
    expect(wikipediaCheckTextInPdf([SLIDES[0]!], () => PDF_PAGE)).toBe(false);
  });

  it("страница без нарратива — отказ, а не пропуск", () => {
    const empty = [{ template: "orion_golden_wikipedia_check", pageNumber: 25 }];
    expect(wikipediaCheckTextInPdf(empty, () => PDF_PAGE)).toBe(false);
  });

  it("страница-продолжение воротам не мешает: нарратива у неё нет по построению", () => {
    // Нарратив принадлежит первой странице блока; продолжение несёт строки
    // выдачи. Пока ворота требовали голову нарратива с каждой страницы шаблона,
    // здоровая дека с пятью строками выдачи валила приёмку с диагнозом,
    // указывающим не туда.
    const withContinuation = [
      ...SLIDES,
      {
        template: "orion_golden_wikipedia_check",
        pageNumber: 26,
        isContinuation: true,
        continuationOf: "p13_ru_wikipedia",
      },
    ];
    expect(
      wikipediaCheckTextInPdf(withContinuation, (page) => (page === 25 ? PDF_PAGE : "строки выдачи"))
    ).toBe(true);
  });

  it("дека из одних продолжений воротами не засчитывается", () => {
    const onlyContinuations = [
      { template: "orion_golden_wikipedia_check", pageNumber: 26, isContinuation: true },
    ];
    expect(wikipediaCheckTextInPdf(onlyContinuations, () => PDF_PAGE)).toBe(false);
  });
});
