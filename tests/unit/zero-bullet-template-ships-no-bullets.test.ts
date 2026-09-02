/**
 * Шаблон без списка не получает списка в нагрузке.
 *
 * Ответ на вопрос «есть ли у этой страницы список» записан один раз —
 * `maxBulletsPerSlide` в реестре шаблонов. Ноль означает «списка нет»:
 * `orion_golden_search_table` при непустой таблице ветку `elif bullets` не
 * исполняет вовсе, а карточная сетка матрицы рисует темы из `keyFindings`.
 *
 * Нагрузка этому ответу противоречила: `sourceNote` («Источники — …»)
 * приклеивался единственным буллетом уже после пагинации построителя, на сборке
 * нагрузки, — то есть вне досягаемости ёмкости, которую пагинатор применяет к
 * `s.bullets`. На эталоне 72 так уезжали 18 страниц выдачи из 18, в золотом
 * кейсе — 20 из 20; на лист поле не попадало ни разу. Адреса материалов
 * печатаются полосой под каждой строкой, поэтому решение — убрать поле из
 * нагрузки, а не начать его печатать.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toRendererPayload } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import { DECK_TEMPLATE_REGISTRY } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";

const SOURCE_NOTE = "Источники — runews24.ru, kommersant.ru, vedomosti.ru и ещё 2.";

const TABLE = {
  headers: ["№", "Заголовок", "Тип источника", "Оценка"],
  rows: [["1", "Материал о субъекте", "СМИ", "Нейтральный"]],
  rowAddresses: ["runews24.ru/material"],
};

function slide(overrides: Partial<RendererSlide> & { template: string }): RendererSlide {
  return {
    slideKey: "p09_ru_serp_table",
    sectionKey: "RU_PROFILE",
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
 * `undefined` до него не доезжает, и «поля нет» проверяется там, где это и
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
    subjectName: "Сергей Глинка",
  });
  const manifest = payload.deckManifest as { finalSlides: Array<Record<string, unknown>> };
  return JSON.parse(JSON.stringify(manifest.finalSlides)) as Array<Record<string, unknown>>;
}

describe("шаблон без списка не везёт список", () => {
  it("страница выдачи с непустой таблицей поля bullets не получает", () => {
    const [out] = payloadSlides([slide({ template: "orion_golden_search_table", table: TABLE })]);
    // Пустой список вместо отсутствия поля — не то же самое: «списка нет»
    // выражается отсутствием ключа.
    expect("bullets" in out!).toBe(false);
  });

  it("ссылка на источник на такую страницу вообще не попадает — а попадёт, сборка откажет", () => {
    // Строку источников для листа без списка ассемблер больше не кладёт: её
    // некуда напечатать. Слайд деки, всё-таки принёсший её сюда, — дефект
    // построителя, и сборка называет его вслух, а не роняет поле молча.
    expect(() =>
      payloadSlides([
        slide({ template: "orion_golden_search_table", table: TABLE, sourceNote: SOURCE_NOTE }),
      ])
    ).toThrow(/p09_ru_serp_table · sourceNote/u);
  });

  it("у шаблона с положительной ёмкостью списка буллеты и ссылка на месте", () => {
    const [out] = payloadSlides([
      slide({
        slideKey: "appendix_main_base",
        template: "orion_golden_executive_card",
        bullets: ["Первая строка приложения", "Вторая строка приложения"],
        sourceNote: SOURCE_NOTE,
      }),
    ]);
    expect(out!.bullets).toEqual([
      "Первая строка приложения",
      "Вторая строка приложения",
      SOURCE_NOTE,
    ]);
  });

  it.each(["orion_golden_wikipedia_check", "orion_golden_no_data_compact"])(
    "%s рисует ссылку на источник своим полем и получает её",
    (template) => {
      const [out] = payloadSlides([
        slide({
          slideKey: "p13_ru_wikipedia",
          template,
          narrative: "Статья о проверяемом лице не найдена.",
          sourceNote: SOURCE_NOTE,
        }),
      ]);
      expect(out!.sourceNote).toBe(SOURCE_NOTE);
    }
  );

  it("правило берётся из реестра: ни один шаблон с нулевой ёмкостью списка не получает bullets", () => {
    // Список шаблонов выводится из реестра, а не переписывается сюда: иначе
    // проверка останется зелёной, когда нулевую ёмкость объявит следующий
    // шаблон.
    const zeroCapacity = Object.values(DECK_TEMPLATE_REGISTRY).filter(
      (t) => t.maxBulletsPerSlide === 0
    );
    expect(zeroCapacity.length).toBeGreaterThan(0);
    const slides = zeroCapacity.map((t, i) =>
      slide({
        slideKey: `p${i}_${t.templateId}`,
        template: t.rendererTemplate,
        bullets: ["Строка списка, которую этот шаблон не рисует"],
        table: TABLE,
      })
    );
    const withBullets = payloadSlides(slides)
      .filter((s) => "bullets" in s)
      .map((s) => String(s.slideKey));
    expect(withBullets).toEqual([]);
  });

  it("эталон 72: ни одна страница выдачи собранной деки не везёт буллетов", () => {
    // Утверждение о собранной деке, а не о построителе: вход — закреплённый
    // артефакт эталона (`render-payload.json` в git не лежит, это выход сессии).
    const assembled = JSON.parse(
      readFileSync(
        join(process.cwd(), "baselines/report-72/artifacts/deck-sections/assembled-deck.json"),
        "utf8"
      )
    ) as { slides: RendererSlide[] };
    const searchTables = assembled.slides.filter(
      (s) => s.template === "orion_golden_search_table"
    );
    // Ворота без входа выглядят ровно так же, как пройденные.
    expect(searchTables.length).toBeGreaterThan(0);
    const withBullets = payloadSlides(assembled.slides)
      .filter((s) => s.template === "orion_golden_search_table" && "bullets" in s)
      .map((s) => String(s.slideKey));
    expect(withBullets).toEqual([]);
  });
});
