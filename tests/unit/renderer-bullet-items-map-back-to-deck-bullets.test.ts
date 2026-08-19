/**
 * Разрез «элемент списка рендерера ↔ буллет деки» и маппинг без срезов.
 *
 * Мера приходит от рендерера по элементам списка, которые он получил, а
 * перекладывать надо буллеты деки. Между ними лежит склейка страницы: вводный
 * абзац становится первым элементом списка, ссылка на источник — последним. Не
 * зная разреза, перекладка сдвинула бы блок на единицу — он не потерялся бы, но
 * уехал не туда.
 *
 * Второе свойство — сам маппинг ничего не режет. На стр. 3 живого прогона
 * `keyFindings = (s.bullets ?? []).slice(0, 2)` выбросил третью тему **мимо
 * телеметрии**: потеря случилась до рендерера, и ворота её не видели.
 */

import { describe, expect, it } from "vitest";
import {
  bulletItemFoldOf,
  rendererBulletItemsOf,
  toRendererPayload,
} from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import type { ReportDeckManifest } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

function slide(over: Partial<RendererSlide> & { slideKey: string; template: string }): RendererSlide {
  return {
    sectionKey: "RU_PROFILE",
    title: "Страница",
    pageNumber: 1,
    totalPageCount: 1,
    baseSlotId: over.slideKey,
    isContinuation: false,
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    staticBlocks: [],
    ...over,
  } as RendererSlide;
}

const EMPTY_MANIFEST = {
  toc: [],
  sectionPageRanges: [],
} as unknown as ReportDeckManifest;

/** Список, который получит `ctx.bullets` для этой страницы. */
function payloadItemsOf(s: RendererSlide): string[] {
  const payload = toRendererPayload({
    deckManifest: EMPTY_MANIFEST,
    rendererSlides: [s],
    subjectName: "Сергей Глинка",
  }) as { deckManifest: { finalSlides: Array<Record<string, unknown>> } };
  return rendererBulletItemsOf(payload.deckManifest.finalSlides[0]!);
}

function foldOf(s: RendererSlide) {
  return bulletItemFoldOf({
    payloadItems: payloadItemsOf(s),
    deckBullets: s.bullets ?? [],
    sourceNote: s.sourceNote,
  });
}

describe("маппинг деки в пейлоад рендерера", () => {
  it("дашборд резюме отдаёт все темы, а не первые две", () => {
    const s = slide({
      slideKey: "p03_executive",
      template: "orion_golden_executive_dashboard",
      title: "Резюме",
      bullets: [
        "«Санкции и заморозка активов»\nНайдены публикации по теме: 8.",
        "«Офшорные структуры и расследования о связях с властью»\nНайдены публикации по теме: 8.",
        "«Деловая карьера, активы и связанные компании»\nНайдены публикации по теме: 6.",
      ],
    });
    expect(payloadItemsOf(s)).toHaveLength(3);
    expect(foldOf(s)).toEqual({ leading: 0, trailing: 0 });
  });
});

describe("разрез элементов списка рендерера", () => {
  it("страница со вклейкой нарратива и ссылкой на источник", () => {
    const s = slide({
      slideKey: "appendix_main_base",
      template: "orion_golden_executive_card",
      narrative: "Материалы, принадлежность которых не подтверждена.",
      bullets: ["К1", "К2"],
      sourceNote: "Источники — icij.org, kommersant.ru.",
    });
    expect(foldOf(s)).toEqual({ leading: 1, trailing: 1 });
    expect(payloadItemsOf(s)).toHaveLength(4);
  });

  it("страница без ссылки на источник: только вклейка нарратива", () => {
    const s = slide({
      slideKey: "p30_prose",
      template: "orion_golden_prose",
      narrative: "Материалы по теме прочитаны.",
      bullets: ["Тема A"],
    });
    expect(foldOf(s)).toEqual({ leading: 1, trailing: 0 });
    expect(payloadItemsOf(s)).toHaveLength(2);
  });

  it("страница-продолжение без нарратива: только ссылка на источник", () => {
    const s = slide({
      slideKey: "p30_prose__cont1",
      template: "orion_golden_prose",
      isContinuation: true,
      continuationOf: "p30_prose",
      bullets: ["Тема B"],
      sourceNote: "Источники — lenta.ru.",
    });
    expect(foldOf(s)).toEqual({ leading: 0, trailing: 1 });
  });

  it("дашборд метрик подаёт буллеты деки один в один", () => {
    const s = slide({
      slideKey: "p07_ru_summary",
      template: "orion_golden_metrics_dashboard",
      narrative: "Итог по региону",
      bullets: ["Тема A", "Тема B"],
      sourceNote: "Источники — lenta.ru.",
      kpis: [{ label: "Материалов", value: "32" }],
    });
    expect(foldOf(s)).toEqual({ leading: 0, trailing: 0 });
    expect(payloadItemsOf(s)).toEqual(s.bullets);
  });

  it("пустой список элементов — разрез нулевой", () => {
    expect(
      bulletItemFoldOf({ payloadItems: [], deckBullets: [], sourceNote: undefined })
    ).toEqual({ leading: 0, trailing: 0 });
  });

  it("разрез, который не сходится, называет себя, а не гадает", () => {
    // Появился новый вид склейки, о котором инверсия не знает: лучше не
    // перекладывать страницу вовсе, чем сдвинуть блок не туда.
    expect(
      bulletItemFoldOf({
        payloadItems: ["вступление", "ещё вступление", "A"],
        deckBullets: ["A"],
        sourceNote: undefined,
      })
    ).toBeNull();
  });
});
