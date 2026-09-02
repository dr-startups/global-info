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

/**
 * Блоки панели ворот не видел вовсе.
 *
 * У панельных макетов (`orion_golden_surface_panel`, `orion_golden_image_grid`,
 * `orion_golden_serp_screenshot`, `orion_golden_knowledge_panel`) клиентский
 * текст лежит внутри `visualAnalysis`, а на верхнем уровне слайда его нет.
 * Замер по нагрузке эталона-72: таких слайдов 16 из 61, и у каждого ворот
 * проверял ровно одно поле — заголовок.
 *
 * Прогон 91, стр. 46: панель подсказок не напечатала ни «Что сделать»
 * (`recommendedActions`), ни последнее предложение вывода — про негатив в
 * собранном наборе. Ворот молчал по построению.
 */
const PANEL_ANALYSIS = {
  sidebarMode: "context",
  headlineConclusion: "Собрано 50 подсказок. На панели показаны 10: 4 относятся к субъекту.",
  whatIsVisible: "Подсказки описывают интерес к биографии и написанию имени.",
  clientMeaning: "Подсказки влияют на первое впечатление при поиске.",
  recommendedActions: ["Проверить строки со статусом «вероятно» и отслеживать риск-формулировки."],
  provenanceLabel: "Источник — поисковая выдача: у показанных элементов нет отдельных адресов.",
  highlightExplanations: [],
  moreSignalsCount: 0,
};

const PANEL_SLIDE = {
  slideKey: "p11_ru_suggestions_yandex",
  template: "orion_golden_surface_panel",
  pageNumber: 11,
  title: "Россия — подсказки Яндекса",
  visualAnalysis: PANEL_ANALYSIS,
};

/** Лист панели: заголовок, подписи блоков и сами блоки. */
function panelPage(): string {
  const a = PANEL_ANALYSIS;
  return [
    "Россия — подсказки Яндекса",
    a.headlineConclusion,
    "Что показывает экран",
    a.whatIsVisible,
    "Что это значит",
    a.clientMeaning,
    "Что сделать",
    (a.recommendedActions ?? [])[0],
    a.provenanceLabel,
  ]
    .filter(Boolean)
    .join("\n");
}

describe("блоки панели тоже оставляют след на своей странице", () => {
  it("панель, напечатавшая свои блоки, расхождений не даёт", () => {
    expect(textFieldsWithoutTraceOnTheirPage([PANEL_SLIDE], () => panelPage())).toEqual([]);
  });

  it("вывод, потерянный при укладке, назван полем и страницей", () => {
    // Ровно случай стр. 46: последнее предложение блока не влезло, и рендерер
    // оставил только влезающие — но здесь блока нет целиком.
    const page = panelPage().replace(PANEL_ANALYSIS.clientMeaning, "");
    const out = textFieldsWithoutTraceOnTheirPage([PANEL_SLIDE], () => page);
    expect(out.map((m) => m.field)).toEqual(["visualAnalysis.clientMeaning"]);
    expect(out[0]!.page).toBe(11);
    expect(out[0]!.slideKey).toBe("p11_ru_suggestions_yandex");
  });

  it("рекомендация, выброшенная целиком, названа", () => {
    const page = panelPage().replace(PANEL_ANALYSIS.recommendedActions[0]!, "");
    const out = textFieldsWithoutTraceOnTheirPage([PANEL_SLIDE], () => page);
    expect(out.map((m) => m.field)).toEqual(["visualAnalysis.recommendedActions[0]"]);
  });

  it("ворот проверяет все блоки панели, а не один заголовок", () => {
    // Мера слепоты: на пустом листе ворот обязан назвать каждый блок.
    const out = textFieldsWithoutTraceOnTheirPage([PANEL_SLIDE], () => "");
    expect(out.map((m) => m.field)).toEqual([
      "title",
      "visualAnalysis.headlineConclusion",
      "visualAnalysis.whatIsVisible",
      "visualAnalysis.clientMeaning",
      "visualAnalysis.recommendedActions[0]",
      "visualAnalysis.provenanceLabel",
    ]);
  });

  it("объяснение рамки на месте среднего блока следом считается", () => {
    /*
     * Средним блоком панель рисует либо «что показывает экран», либо объяснения
     * рамок — какое из двух, решает набор рамок и то, нашлась ли для страницы
     * картинка (`_sidebar_analysis` против `_render_analysis_cards_full_width`).
     * Требовать оба значило бы краснеть на законной ветке, и ворот выключили бы.
     */
    const adverse = {
      ...PANEL_ANALYSIS,
      sidebarMode: "adverse_explanation",
      highlightExplanations: [
        { clientReason: "На странице rucompromat.eu — обвинения в криминальном прошлом.", frameTone: "red" },
      ],
    };
    const page = [
      "Россия — снимок выдачи",
      adverse.headlineConclusion,
      "Почему выделено",
      adverse.highlightExplanations[0]!.clientReason,
      "Что это значит",
      adverse.clientMeaning,
      "Что сделать",
      adverse.recommendedActions[0],
      adverse.provenanceLabel,
    ].join("\n");
    const slide = { ...PANEL_SLIDE, title: "Россия — снимок выдачи", visualAnalysis: adverse };
    expect(textFieldsWithoutTraceOnTheirPage([slide], () => page)).toEqual([]);
  });

  it("страница без панели проверяется как прежде", () => {
    // Слайд без `visualAnalysis` новых полей не приобретает.
    expect(textFieldsWithoutTraceOnTheirPage([SERP_SLIDE], () => SERP_PAGE)).toEqual([]);
  });
});
