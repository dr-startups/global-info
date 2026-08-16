/**
 * Ворота «страница не спорит со своей панелью».
 *
 * Ни одна проверка сборки не сравнивала страницу с её же картинкой: сайдбар
 * заполнен («0 связанных запросов» — тоже текст), ассет привязан, значит
 * «содержимое есть». Так девятнадцать ворот приняли деку, где под снимком
 * панели с четырьмя запросами стояло «0 связанных запросов».
 *
 * Данные здесь синтетические намеренно: проверяется поведение ворот, а не
 * содержимое реального кейса.
 */

import { describe, expect, it } from "vitest";
import {
  validateAssembly,
  SYSTEMIC_DEFECT_PAGES,
} from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import type { VisualAssetsBySlot } from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";

type PanelSlide = {
  slotId: string;
  templateId: string;
  bullets: string[];
};

function rendererSlide(s: PanelSlide, i: number, total: number): RendererSlide {
  return {
    slideKey: s.slotId,
    sectionKey: "RU_PROFILE",
    template: "orion_golden_surface_panel",
    title: `Страница ${i + 1}`,
    pageNumber: i + 1,
    totalPageCount: total,
    baseSlotId: s.slotId,
    isContinuation: false,
    bullets: s.bullets,
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [`${s.slotId}-asset`],
    staticBlocks: [],
  };
}

function gateReport(input: {
  slides: PanelSlide[];
  visualAssets?: VisualAssetsBySlot;
}): ReturnType<typeof validateAssembly> {
  const rendererSlides = input.slides.map((s, i) => rendererSlide(s, i, input.slides.length));
  const deckManifest = {
    caseId: "case-1",
    sourceDatasetId: "dataset-1",
    pageCount: rendererSlides.length,
    baseSlotCoverage: 36,
    sectionPageRanges: [],
    toc: [],
    nonCanonicalPages: [],
    slides: input.slides.map((s, i) => ({
      slideId: s.slotId,
      baseSlotId: s.slotId,
      templateId: s.templateId,
      pageNumber: i + 1,
      isContinuation: false,
      pageKind: "canonical_base",
    })),
  };
  return validateAssembly({
    manifest: { sectionOrder: [], entries: [] },
    deckManifest,
    rendererSlides,
    packs: [],
    bundle: { findings: [] },
    baseObservationCountBefore: 0,
    baseObservationCountAfter: 0,
    visualAssets: input.visualAssets,
  } as unknown as Parameters<typeof validateAssembly>[0]);
}

/** Панель со строками: `titled` строк с текстом из `recorded` записанных ссылок. */
function panel(slotId: string, recorded: number, titled: number): VisualAssetsBySlot[string] {
  return [
    {
      assetRef: `${slotId}-asset`,
      kind: "surface_panel",
      title: slotId,
      hasImage: true,
      evidenceRefs: Array.from({ length: recorded }, (_, i) => `inventory:${slotId}-${i}`),
      visibleItems: Array.from({ length: recorded }, (_, i) => ({
        ref: `inventory:${slotId}-${i}`,
        title: i < titled ? `строка ${i + 1}` : undefined,
      })),
    },
  ];
}

/**
 * Строки без заголовка — законное состояние сетки картинок и панели знаний:
 * их построители (`canonical-visual-assets.ts`) пишут `visibleItems` без
 * отбора по тексту, у картинок заголовок часто пуст, и плитка рисует подпись
 * «Изображение из поиска». Строка при этом либо адресная, либо опознаётся
 * только ссылкой (у картинки может не быть `sourceUrl` — есть `imageUrl`).
 */
function untitledRows(
  slotId: string,
  count: number,
  withUrl: boolean
): VisualAssetsBySlot[string] {
  return [
    {
      assetRef: `${slotId}-asset`,
      kind: withUrl ? "knowledge_panel" : "image_grid",
      title: slotId,
      hasImage: true,
      evidenceRefs: Array.from({ length: count }, (_, i) => `inventory:${slotId}-${i}`),
      visibleItems: Array.from({ length: count }, (_, i) => ({
        ref: `inventory:${slotId}-${i}`,
        ...(withUrl ? { url: `https://example.com/${slotId}/${i}`, domain: "example.com" } : {}),
      })),
    },
  ];
}

describe("ворота panelPagesMatchDrawnRows", () => {
  it("панель записала ссылки, ни одна не разрешилась в видимую строку — отказ", () => {
    // Сегодняшний дефект в чистом виде: джойн «ассет ↔ индекс» мёртв.
    const report = gateReport({
      slides: [{ slotId: "p20_ru_related_1", templateId: "related-queries", bullets: [] }],
      visualAssets: { p20_ru_related_1: panel("p20_ru_related_1", 4, 0) },
    });
    expect(report.checks.panelPagesMatchDrawnRows).toBe(false);
    expect(report.issues.join(" | ")).toMatch(/ни одна не разрешилась/u);
  });

  it("на панели строки есть, а страница напечатала ноль — отказ", () => {
    const report = gateReport({
      slides: [{ slotId: "p11_ru_suggestions_yandex", templateId: "suggestions", bullets: [] }],
      visualAssets: { p11_ru_suggestions_yandex: panel("p11_ru_suggestions_yandex", 10, 10) },
    });
    expect(report.checks.panelPagesMatchDrawnRows).toBe(false);
    expect(report.issues.join(" | ")).toMatch(/p11_ru_suggestions_yandex/u);
  });

  it("строки панели напечатаны на странице — ворота пройдены", () => {
    // Равенства счётов не требуем: это работа построителя, а не второй ответ
    // на тот же вопрос здесь.
    const report = gateReport({
      slides: [
        {
          slotId: "p20_ru_related_1",
          templateId: "related-queries",
          bullets: ["строка 1", "строка 2"],
        },
      ],
      visualAssets: { p20_ru_related_1: panel("p20_ru_related_1", 4, 4) },
    });
    expect(report.checks.panelPagesMatchDrawnRows).toBe(true);
  });

  it("панелей нет вовсе — проверять нечего, ворота пройдены", () => {
    const report = gateReport({
      slides: [{ slotId: "p03_executive", templateId: "executive-summary", bullets: ["текст"] }],
      visualAssets: {},
    });
    expect(report.checks.panelPagesMatchDrawnRows).toBe(true);
  });

  it("вход не передан — ключа в checks нет, молчаливый пропуск невозможен", () => {
    // Скрипт читает ворота как `?? false`: отсутствие входа — отказ, а не пасс.
    const report = gateReport({
      slides: [{ slotId: "p20_ru_related_1", templateId: "related-queries", bullets: [] }],
    });
    expect(Object.keys(report.checks)).not.toContain("panelPagesMatchDrawnRows");
  });

  it("нарушителей от порога системности — сборка блокируется", () => {
    const slots = ["p20_ru_related_1", "p21_ru_related_2", "p22_ru_related_3"];
    expect(slots.length).toBeGreaterThanOrEqual(SYSTEMIC_DEFECT_PAGES);
    const report = gateReport({
      slides: slots.map((slotId) => ({ slotId, templateId: "related-queries", bullets: [] })),
      visualAssets: Object.fromEntries(slots.map((s) => [s, panel(s, 4, 0)])),
    });
    expect(report.blocking.join(" | ")).toMatch(/панел/iu);
  });

  it("сетка картинок с адресными, но нетитулованными строками — ворота пройдены", () => {
    // Здоровый оплаченный прогон: у картинок в выдаче заголовков часто нет,
    // строка опознаётся адресом. Ворота, считающие такую страницу поломкой,
    // роняют прогон на последней стадии.
    const slots = ["p14_ru_images_1", "p15_ru_images_2", "p16_ru_images_3", "p30_uae_images"];
    const report = gateReport({
      slides: slots.map((slotId) => ({ slotId, templateId: "image-grid", bullets: [] })),
      visualAssets: Object.fromEntries(slots.map((s) => [s, untitledRows(s, 6, true)])),
    });
    expect(report.checks.panelPagesMatchDrawnRows).toBe(true);
    expect(report.blocking).toEqual([]);
  });

  it("картинка без заголовка и без адреса — тоже не поломка", () => {
    // У строки изображения бывает только `imageUrl`: в видимой строке тогда ни
    // заголовка, ни адреса. Это состояние данных, а не сломанный джойн.
    const slots = ["p14_ru_images_1", "p15_ru_images_2", "p16_ru_images_3"];
    const report = gateReport({
      slides: slots.map((slotId) => ({ slotId, templateId: "image-grid", bullets: [] })),
      visualAssets: Object.fromEntries(slots.map((s) => [s, untitledRows(s, 6, false)])),
    });
    expect(report.checks.panelPagesMatchDrawnRows).toBe(true);
    expect(report.blocking).toEqual([]);
  });

  it("панель знаний живёт сниппетом — её строки без заголовков не считаются потерянными", () => {
    const report = gateReport({
      slides: [{ slotId: "p31_uae_knowledge", templateId: "ai-overview", bullets: [] }],
      visualAssets: { p31_uae_knowledge: untitledRows("p31_uae_knowledge", 5, true) },
    });
    expect(report.checks.panelPagesMatchDrawnRows).toBe(true);
  });

  it("строка панели запросов, опознанная адресом, — джойн жив", () => {
    // Неразрешённая ссылка — это та, у которой нет ни заголовка, ни адреса
    // (то же определение, что у проверки индекса загрузчика).
    const report = gateReport({
      slides: [{ slotId: "p20_ru_related_1", templateId: "related-queries", bullets: [] }],
      visualAssets: { p20_ru_related_1: untitledRows("p20_ru_related_1", 4, true) },
    });
    expect(report.checks.panelPagesMatchDrawnRows).toBe(true);
  });

  it("единичное нарушение оплаченный прогон не останавливает", () => {
    const report = gateReport({
      slides: [{ slotId: "p20_ru_related_1", templateId: "related-queries", bullets: [] }],
      visualAssets: { p20_ru_related_1: panel("p20_ru_related_1", 4, 0) },
    });
    expect(report.checks.panelPagesMatchDrawnRows).toBe(false);
    expect(report.blocking).toEqual([]);
  });
});
