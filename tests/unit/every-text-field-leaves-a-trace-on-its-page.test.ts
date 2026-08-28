/**
 * Переданное текстовое поле обязано оставить след на своей странице.
 *
 * Ворот приёмки на втором инструменте: нагрузка говорит, что на странице
 * напечатано, а нарисованный текст читается из готового PPTX. Между ними живёт
 * молчаливая потеря — поле доезжает до рендерера, и его ветка на листе не
 * исполняется: так `sourceNote` страницы выдачи ехал единственным буллетом на
 * 18 страницах эталона и не был напечатан ни на одной.
 *
 * Утверждение намеренно слабое — «поле не исчезло целиком». Рендерер законно
 * переносит, склеивает и режет по словам, а обрезку судит другой ворот
 * (`services/render-telemetry-gate.ts`); требование дословного совпадения
 * краснело бы на здоровом прогоне, и ворот выключили бы.
 */

import { describe, expect, it } from "vitest";
import { textFieldsWithoutTraceOnTheirPage } from "../../scripts/run-orion-deck-sections-report72";

const NARRATIVE =
  "По запросу «Сергей Глинка» собрано 20 результатов Яндекса; из них 4 отнесены " +
  "к проверяемому лицу, остальные — к однофамильцам.";

const SOURCE_NOTE = "Источники — runews24.ru, kommersant.ru, vedomosti.ru и ещё 2.";

/** Как текст страницы отдаёт инспектор: фигурами, с переносами внутри абзаца. */
const SERP_PAGE = `Россия — Яндекс: собранная выдача
По запросу «Сергей Глинка» собрано 20 результатов
Яндекса; из них 4 отнесены к проверяемому лицу,
остальные — к однофамильцам.
№ Заголовок Тип источника Оценка
1 Материал о субъекте СМИ Нейтральный
runews24.ru/material`;

const SERP_SLIDE = {
  slideKey: "p09_ru_serp_table",
  template: "orion_golden_search_table",
  pageNumber: 9,
  title: "Россия — Яндекс: собранная выдача",
  narrative: NARRATIVE,
};

describe("каждое текстовое поле оставило след на своей странице", () => {
  it("здоровая страница расхождений не даёт", () => {
    expect(textFieldsWithoutTraceOnTheirPage([SERP_SLIDE], () => SERP_PAGE)).toEqual([]);
  });

  it("буллет, которого нет на листе, назван вместе со слайдом, полем и страницей", () => {
    // Ровно тот случай: страница выдачи с непустой таблицей ветку списка не
    // исполняет, и «Источники — …» на листе нет.
    const withBullet = { ...SERP_SLIDE, bullets: [SOURCE_NOTE] };
    expect(textFieldsWithoutTraceOnTheirPage([withBullet], () => SERP_PAGE)).toEqual([
      {
        slideKey: "p09_ru_serp_table",
        page: 9,
        field: "bullets[0]",
        text: SOURCE_NOTE,
      },
    ]);
  });

  it("законная обрезка следом считается: напечатанное начало поля достаточно", () => {
    // Обрезку судит ворот телеметрии. Здесь спрашивают только одно: поле не
    // исчезло целиком.
    const clipped = `Россия — Яндекс: собранная выдача
По запросу «Сергей Глинка» собрано 20 результатов Яндекса; из них 4 отнесены`;
    expect(textFieldsWithoutTraceOnTheirPage([SERP_SLIDE], () => clipped)).toEqual([]);
  });

  it("поле, исчезнувшее целиком, названо и на плотной странице", () => {
    const busy = `Россия — Яндекс: собранная выдача
№ Заголовок Тип источника Оценка
1 Материал о субъекте СМИ Нейтральный
2 Ещё один материал СМИ Нейтральный
3 Третий материал Реестр Не проверено
runews24.ru/material`;
    const out = textFieldsWithoutTraceOnTheirPage([SERP_SLIDE], () => busy);
    expect(out.map((m) => m.field)).toEqual(["narrative"]);
  });

  it("текст, доехавший на другую страницу, следом не считается", () => {
    expect(
      textFieldsWithoutTraceOnTheirPage([SERP_SLIDE], (page) => (page === 8 ? SERP_PAGE : ""))
    ).toHaveLength(2);
  });

  it("ссылка на источник, которую страница рисует своим полем, следом считается", () => {
    // Спрашивают только о переданном: у страницы выдачи `sourceNote` нет
    // вовсе, а у карточной страницы он есть и напечатан.
    const card = {
      slideKey: "p13_ru_wikipedia",
      template: "orion_golden_wikipedia_check",
      pageNumber: 13,
      title: "Россия — Википедия",
      sourceNote: SOURCE_NOTE,
    };
    const page = `Россия — Википедия\nСтатус сбора\n${SOURCE_NOTE}`;
    expect(textFieldsWithoutTraceOnTheirPage([card], () => page)).toEqual([]);
  });

  it("пустая строка поля следа не требует", () => {
    const empty = { ...SERP_SLIDE, statusNote: "   " };
    expect(textFieldsWithoutTraceOnTheirPage([empty], () => SERP_PAGE)).toEqual([]);
  });

  it("обложка печатает хвост заголовка после тире — и это след", () => {
    // Служебную приставку «Отчёт о цифровом профиле — » обложка отбрасывает по
    // замыслу и печатает имя субъекта крупно. Требовать от неё начала поля
    // значило бы краснеть на замысле.
    const cover = {
      slideKey: "p01_cover",
      template: "orion_golden_cover",
      pageNumber: 1,
      title: "Отчёт о цифровом профиле — Сергей Глинка",
    };
    const page = "cleeq\nЦифровой профиль\nСергей Глинка\nКонфиденциально.";
    expect(textFieldsWithoutTraceOnTheirPage([cover], () => page)).toEqual([]);
    // Имя субъекта на обложке ворот всё же сторожит: без него след не найден.
    expect(
      textFieldsWithoutTraceOnTheirPage([cover], () => "cleeq\nЦифровой профиль")
    ).toHaveLength(1);
  });

  it("сравнение переживает кавычки, тире и разный регистр", () => {
    // Инспектор отдаёт то, что положил рендерер: он схлопывает пробелы и
    // чистит запрещённые символы. Сравнивать «в лоб» — значит краснеть на
    // здоровой странице.
    const slide = {
      ...SERP_SLIDE,
      statusNote: "Прочитано 4 страницы из 20 — остальные не открывались.",
    };
    const page = `${SERP_PAGE}\nПРОЧИТАНО 4 СТРАНИЦЫ ИЗ 20 -- ОСТАЛЬНЫЕ\nНЕ ОТКРЫВАЛИСЬ.`;
    expect(textFieldsWithoutTraceOnTheirPage([slide], () => page)).toEqual([]);
  });
});
