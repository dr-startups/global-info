/**
 * Отказ сборки называет код, а не только страницы.
 *
 * Живой прогон 21.08 (кейс Кремлёв) встал на воротах качества текста, и
 * оператор прочитал: «внутренние коды в клиентском тексте на 6 страницах:
 * p03_executive__cont2, p07_ru_summary__cont2, p09_ru_serp_table,
 * p09_ru_serp_table__cont2, p10_ru_serp_visual__why3». По этой строке нельзя
 * понять **что** чинить: сами коды лежат в `assembly-validation-report.json` и
 * до человека не доходят. Строка, по которой нельзя действовать, останавливает
 * платный прогон на последнем шаге и ничего не сообщает.
 *
 * Там же видно второе: страниц шесть, названо пять, и о том, что перечень
 * обрезан, строка молчит.
 */

import { describe, expect, it } from "vitest";
import {
  blockingIssues,
  validateAssembly,
} from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";

const SLIDES = [
  "p03_executive__cont2",
  "p07_ru_summary__cont2",
  "p09_ru_serp_table",
  "p09_ru_serp_table__cont2",
  "p10_ru_serp_visual__why3",
  "p26_uae_serp_table",
];

describe("сообщение об остановке сборки", () => {
  it("называет коды, а не только страницы", () => {
    const [line] = blockingIssues({
      quoteDefectSlides: new Set(),
      codeSlides: new Set(SLIDES),
      codes: new Set(["NOT_SUPPORTED", "umar_kremlev"]),
    });
    expect(line).toContain("NOT_SUPPORTED");
    expect(line).toContain("umar_kremlev");
  });

  it("объявляет, что перечень страниц обрезан", () => {
    const [line] = blockingIssues({
      quoteDefectSlides: new Set(),
      codeSlides: new Set(SLIDES),
      codes: new Set(["NOT_SUPPORTED"]),
    });
    expect(line).toContain("и ещё 1");
    // Полный перечень из пяти обрезанным не объявляется.
    const [short] = blockingIssues({
      quoteDefectSlides: new Set(),
      codeSlides: new Set(SLIDES.slice(0, 5)),
      codes: new Set(["NOT_SUPPORTED"]),
    });
    expect(short).not.toContain("и ещё");
  });

  it("без кодов строка остаётся прежней", () => {
    // Ворота цитат кодов не приносят: приписывать им пустой перечень нечестно.
    const [line] = blockingIssues({
      quoteDefectSlides: new Set(SLIDES.slice(0, 3)),
      codeSlides: new Set(),
    });
    expect(line).toContain("цитаты разорваны на 3 страницах");
    expect(line).not.toContain("коды:");
  });
});

describe("проводка от валидатора до сообщения", () => {
  /*
   * Проверка формата ещё не значит, что коды до сообщения доезжают: между
   * `validateAssembly` и `blockingIssues` есть строка, которую легко забыть.
   * Здесь ворота гоняются целиком.
   */
  function slide(slotId: string, i: number, total: number, text: string): RendererSlide {
    return {
      slideKey: slotId,
      sectionKey: "RU_PROFILE",
      template: "orion_golden_prose",
      title: `Страница ${i + 1}`,
      pageNumber: i + 1,
      totalPageCount: total,
      baseSlotId: slotId,
      isContinuation: false,
      bullets: [text],
      evidenceRefs: [],
      findingIds: [],
      metrics: {},
      visualAssetRefs: [],
      staticBlocks: [],
    } as unknown as RendererSlide;
  }

  it("код из клиентского текста доезжает до строки отказа", () => {
    const slots = ["p03_executive__cont2", "p07_ru_summary__cont2", "p09_ru_serp_table"];
    const rendererSlides = slots.map((id, i) =>
      slide(id, i, slots.length, `Найдено на странице: YANDEX · imageSearch: NOT_SUPPORTED.`)
    );
    const report = validateAssembly({
      manifest: { sectionOrder: [], entries: [] },
      deckManifest: {
        caseId: "case-1",
        sourceDatasetId: "dataset-1",
        pageCount: rendererSlides.length,
        baseSlotCoverage: 36,
        sectionPageRanges: [],
        toc: [],
        nonCanonicalPages: [],
        slides: slots.map((id, i) => ({
          slideId: id,
          baseSlotId: id,
          templateId: "orion_golden_prose",
          pageNumber: i + 1,
          isContinuation: false,
          pageKind: "canonical_base",
        })),
      },
      rendererSlides,
      packs: [],
      bundle: { findings: [] },
      baseObservationCountBefore: 0,
      baseObservationCountAfter: 0,
    } as unknown as Parameters<typeof validateAssembly>[0]);

    const line = report.blocking.find((b) => b.startsWith("внутренние коды"));
    expect(line).toBeDefined();
    expect(line!).toContain("NOT_SUPPORTED");
    expect(report.checks.noInternalCodesInClientText).toBe(false);
  });
});
