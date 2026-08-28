/**
 * Абзац страницы печатается один раз.
 *
 * «Уезжает ли абзац в список» — один вопрос, и отвечали на него в двух местах.
 * Склейка списка спрашивала только «есть ли абзац и есть ли буллеты», а поле
 * `narrative` рядом — ещё и «а нет ли на странице таблицы». Из-за расхождения
 * страница с таблицей везла один и тот же текст дважды: абзацем и первым
 * буллетом.
 *
 * На страницах обоих эталонов дубль не был виден: таблицы там непустые, а
 * буллеты шаблон `orion_golden_search_table` читает только при пустой таблице
 * — и тогда не списком, а веткой `if not rows and bullets`, разбирающей их в
 * строки таблицы. Поэтому на странице с пустой таблицей (сводная комплаенса
 * при нуле совпадений) клиент видел абзац дважды: телом сверху и обрезанной
 * строкой таблицы снизу. Дефект был молчаливым для приёмки, но не для отчёта.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toRendererPayload } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";

const NARRATIVE =
  "Показана выдача Яндекса по запросу «Тестов Иван». На странице 3 темы повышенного внимания.";
const OWN_BULLET = "Источники — example.ru, news.example и vestnik.example.";
const TABLE = {
  headers: ["№", "Заголовок", "Тип источника", "Оценка"],
  rows: [["1", "Материал о субъекте", "СМИ", "Нейтральный"]],
};

function slide(overrides: Partial<RendererSlide>): RendererSlide {
  return {
    slideKey: "p09_ru_serp_table",
    sectionKey: "RU_PROFILE",
    template: "orion_golden_search_table",
    title: "Россия — Яндекс: собранная выдача",
    pageNumber: 9,
    totalPageCount: 48,
    baseSlotId: "p09_ru_serp_table",
    isContinuation: false,
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    staticBlocks: [],
    ...overrides,
  } as RendererSlide;
}

/**
 * Через JSON — рендерер получает файл, а не объект: ключ со значением
 * `undefined` до него не доезжает, и «поля нет» проверяется там же, где это и
 * означает отсутствие.
 */
function payloadSlides(slides: RendererSlide[]): Array<Record<string, unknown>> {
  const payload = toRendererPayload({
    deckManifest: {
      pageCount: slides.length,
      toc: [],
      sectionPageRanges: [],
      slides: [],
    } as never,
    rendererSlides: slides,
    subjectName: "Тестов Иван",
  });
  const manifest = payload.deckManifest as { finalSlides: Array<Record<string, unknown>> };
  return JSON.parse(JSON.stringify(manifest.finalSlides)) as Array<Record<string, unknown>>;
}

/** Слайды нагрузки, чей абзац стоит ещё и буллетом. */
function slidesRepeatingTheirParagraph(
  slides: ReadonlyArray<{ slideKey?: string; narrative?: string; bullets?: string[] }>
): string[] {
  return slides
    .filter((s) => typeof s.narrative === "string" && (s.bullets ?? []).includes(s.narrative))
    .map((s) => String(s.slideKey));
}

describe("абзац страницы печатается один раз", () => {
  it("страница с таблицей печатает абзац сама — вторым экземпляром в список он не уезжает", () => {
    // Шаблон со списком и таблицей сразу: у страницы выдачи списка нет вовсе
    // (`maxBulletsPerSlide: 0`), и повторить на ней абзац нечем — свойство
    // проверяется там, где список законно есть.
    const [out] = payloadSlides([
      slide({
        template: "orion_golden_surface_panel",
        narrative: NARRATIVE,
        bullets: [OWN_BULLET],
        table: TABLE,
      }),
    ]);
    expect(out!.narrative).toBe(NARRATIVE);
    expect(out!.bullets).toEqual([OWN_BULLET]);
  });

  it("страница без таблицы печатает абзац первым буллетом, и своего поля у него нет", () => {
    // Работающая ветка. Из шаблонов, до которых склейка доходит, только
    // `orion_golden_toc` читает `bullets` и игнорирует `narrative` — для него
    // склейка единственный носитель абзаца.
    // Прозаические макеты печатают тело и список друг за другом, поэтому там
    // снятие склейки меняет вид страницы, а не сохранность текста.
    const [out] = payloadSlides([
      slide({
        template: "orion_golden_prose",
        narrative: NARRATIVE,
        bullets: [OWN_BULLET],
      }),
    ]);
    expect(out!.bullets).toEqual([NARRATIVE, OWN_BULLET]);
    expect("narrative" in out!).toBe(false);
  });

  it("страница с таблицей и без собственных буллетов поля bullets не отдаёт вовсе", () => {
    // «Буллетов нет» выражается отсутствием поля, а не пустым списком: так же
    // нормализует свой выход редактор деки (`bullets.length > 0 ? … :
    // undefined`), и только по `undefined` отличается «правки нет» от правки.
    // Рендерер оба входа читает одинаково (`slide.get("bullets") or []`).
    //
    // Шаблон — со списком: у страницы выдачи поле не заполняется первой же
    // строкой сборки (`maxBulletsPerSlide: 0`), и на ней это свойство
    // проверяется вхолостую — пустой список до правила «пустой ≠ отсутствие»
    // не доходит.
    const [out] = payloadSlides([
      slide({
        template: "orion_golden_surface_panel",
        narrative: NARRATIVE,
        bullets: [],
        table: TABLE,
      }),
    ]);
    expect("bullets" in out!).toBe(false);
    expect(out!.narrative).toBe(NARRATIVE);
  });

  it("эталон 72: ни один слайд собранной деки не повторяет свой абзац буллетом", () => {
    // Утверждение о собранной деке, а не о построителе: вход — закреплённый
    // артефакт эталона. `render-payload.json` в git не лежит (это выход
    // сессии), поэтому нагрузка собирается из `assembled-deck.json`.
    //
    // Ассеты не передаются, и вход от этого **шире** настоящего: у 16 слайдов
    // с привязанным визуалом настоящая нагрузка не несёт `bullets` вовсе, а
    // здесь они есть. Различие одностороннее — ложное срабатывание возможно,
    // пропуск нет, — поэтому сторож от него только строже.
    const assembled = JSON.parse(
      readFileSync(
        join(process.cwd(), "baselines/report-72/artifacts/deck-sections/assembled-deck.json"),
        "utf8"
      )
    ) as { slides: RendererSlide[] };
    const slides = payloadSlides(assembled.slides) as unknown as ReadonlyArray<{
      slideKey?: string;
      narrative?: string;
      bullets?: string[];
    }>;
    expect(slides.length).toBeGreaterThan(0);
    expect(slidesRepeatingTheirParagraph(slides)).toEqual([]);
  });

  it("золотой кейс: ни один слайд текстового эталона не повторяет свой абзац буллетом", () => {
    const baseline = JSON.parse(
      readFileSync(join(process.cwd(), "fixtures/golden-case/client-text.baseline.json"), "utf8")
    ) as { slides: Array<{ slideKey: string; text: Record<string, string>; bullets?: string[] }> };
    const slides = baseline.slides.map((s) => ({
      slideKey: s.slideKey,
      narrative: s.text.narrative,
      bullets: s.bullets,
    }));
    expect(slides.length).toBeGreaterThan(0);
    expect(slidesRepeatingTheirParagraph(slides)).toEqual([]);
  });
});
