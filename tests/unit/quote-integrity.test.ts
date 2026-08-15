/**
 * Цитата доходит до читателя целой.
 *
 * Тексты — дословно из прогона 14.08 (diagnostics-unified-…e3a6dc55). В деке
 * того прогона стояло `«ИП Юнусов Тимур Ильдарович зарегистрирован 25.12.2008.`
 * — без закрывающей кавычки и без источника: вычистка повторов сняла следующее
 * предложение, а ворот, которые бы это заметили, не было.
 */

import { describe, expect, it } from "vitest";
import {
  clampQuotedLine,
  closeDanglingQuote,
  quoteIntegrityProblems,
} from "@/modules/digital-profile/orion-golden/deck-sections/quote-integrity";
import { clampClientText } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

describe("целость цитат", () => {
  it("незакрытая кавычка — нарушение", () => {
    const bullet = [
      "«Финансовые претензии / долговые споры»",
      "Найдены публикации о финансовых претензиях и долговых спорах",
      "«ИП Юнусов Тимур Ильдарович зарегистрирован 25.12.2008. [finding-financial_claims-subject_match-d0bdaeb0]",
    ].join("\n");
    const problems = quoteIntegrityProblems(bullet);
    expect(problems.some((p) => p.startsWith("unclosed quote"))).toBe(true);
  });

  it("целый блок с цитатой и источником нарушений не даёт", () => {
    const bullet = [
      "«Криминальные / судебные материалы»",
      "Найдены публикации, в которых субъект связывается с судебными и криминальными сюжетами:",
      "«Timati has been suspected in Ukraine» — источник news.liga.net",
      "Где видно: news.liga.net, meduza.io.",
      "Всего по теме: 2 материала, с негативным контекстом — 2. [finding-criminal_legal-subject_match-ae9b4bfe]",
    ].join("\n");
    expect(quoteIntegrityProblems(bullet)).toEqual([]);
  });

  it("название темы в кавычках источника не требует", () => {
    // Название темы стоит первой строкой и иногда продолжается на той же строке.
    const bullet = [
      "«Биографический профиль» найдены 2 результата, оба относятся к субъекту; видимый источник — imdb.com:",
      "«Timur Yunusov - Biography» — источник imdb.com",
      "Всего по теме: 2 результата.",
    ].join("\n");
    expect(quoteIntegrityProblems(bullet)).toEqual([]);
  });

  it("издание вместо домена тоже считается источником", () => {
    const bullet = [
      "«Украинский правовой сюжет»",
      "найдено изображение, которое ведёт на негативный материал Ukrainska Pravda.",
      "«Ukraine's Security Service serves Russian rapper Timati with notice of suspicion» — Ukrainska Pravda",
      "Всего по теме: 1 изображение из 6.",
    ].join("\n");
    expect(quoteIntegrityProblems(bullet)).toEqual([]);
  });

  it("цитата без источника — нарушение", () => {
    const bullet = [
      "«Криминальные / судебные материалы»",
      "Найдены публикации по теме:",
      "«Ukraine's Security Service serves Russian rapper Timati with notice of suspicion»",
      "Всего по теме: 1 материал.",
    ].join("\n");
    expect(quoteIntegrityProblems(bullet).some((p) => p.startsWith("quote without a source"))).toBe(
      true
    );
  });

  it("блок, оборванный на предлоге, — нарушение", () => {
    const bullet = ["«Тема»", "Найдены материалы о связях субъекта с"].join("\n");
    expect(quoteIntegrityProblems(bullet).some((p) => p.startsWith("block ends mid-phrase"))).toBe(
      true
    );
  });

  it("кириллический предлог в конце виден: `\\b` его не находит", () => {
    expect(
      quoteIntegrityProblems("Материалы касаются судебных сюжетов и").some((p) =>
        p.startsWith("block ends mid-phrase")
      )
    ).toBe(true);
  });

  it("маркер находки в конце блока обрывом не считается", () => {
    const bullet = "«Тема»\nВсего по теме: 1 материал. [finding-criminal_legal-subject_match-ae9b4bfe]";
    expect(quoteIntegrityProblems(bullet)).toEqual([]);
  });
});

describe("обрезка не ломает цитату", () => {
  const quote =
    "«ИП Юнусов Тимур Ильдарович зарегистрирован 25.12.2008. Основным видом деятельности является «Деятельность в области исполнительских искусств».» — источник xfirm.ru";

  it("режет внутри кавычек и сохраняет источник", () => {
    const out = clampQuotedLine(quote, 90)!;
    expect(out).toBeDefined();
    expect(out.length).toBeLessThanOrEqual(90);
    expect(out.endsWith("— источник xfirm.ru")).toBe(true);
    expect(out).toContain("…»");
    // Сокращение видно, но это по-прежнему чужие слова с известным источником.
    expect(quoteIntegrityProblems(out).filter((p) => p.startsWith("quote without"))).toEqual([]);
  });

  it("строку, что и так помещается, не трогает", () => {
    expect(clampQuotedLine("«Коротко» — источник x.ru", 200)).toBe("«Коротко» — источник x.ru");
  });

  it("не цитату не трогает вовсе", () => {
    expect(clampQuotedLine("Обычная строка без кавычек", 10)).toBeUndefined();
  });

  it("когда под цитату не остаётся места, режет не она", () => {
    // Атрибуция длиннее бюджета: сокращать нечего, решение принимает вызывающий.
    expect(clampQuotedLine(quote, 25)).toBeUndefined();
  });

  it("висящая кавычка закрывается многоточием", () => {
    expect(closeDanglingQuote("Найдены публикации «ИП Юнусов зарегистрирован")).toBe(
      "Найдены публикации «ИП Юнусов зарегистрирован…»"
    );
    expect(closeDanglingQuote("«Цитата» — источник x.ru")).toBe("«Цитата» — источник x.ru");
  });

  it("обрезка клиентского текста больше не оставляет открытую кавычку", () => {
    const long = `Найдены публикации о финансовых претензиях ${quote}`;
    const out = clampClientText(long, 120);
    expect((out.match(/«/gu) ?? []).length).toBe((out.match(/»/gu) ?? []).length);
  });
});

describe("обрезка не трогает блок целиком", () => {
  /**
   * Эталонный кейс: блок темы начинается с названия в кавычках, и обрезка
   * приняла его за одну огромную цитату — резала по последней кавычке блока и
   * оставляла посреди страницы «…» — источник stockholm-kuriren.se» без начала.
   */
  const block = [
    "«Криминальные / судебные материалы»",
    "Найдены публикации, в которых субъект связывается с судебными и криминальными сюжетами:",
    "«Stockholm court schedules hearing involving Anders Holmström of Nordkap Capital» — источник kapitalnytt.se",
    "«Комментарий: Stockholm court schedules hearing» — источник stockholm-kuriren.se",
  ].join("\n");

  it("многострочный блок под правило цитаты не подпадает", () => {
    expect(clampQuotedLine(block, 200)).toBeUndefined();
  });

  it("строка с двумя атрибуциями — тоже не одна цитата", () => {
    const flat =
      "«Первая» — источник a.ru «Вторая» — источник b.ru";
    expect(clampQuotedLine(flat, 30)).toBeUndefined();
  });
});
