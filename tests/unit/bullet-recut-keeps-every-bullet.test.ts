/**
 * Перекладка страниц по мере рендерера ничего не теряет и не переставляет.
 *
 * Живой прогон 19.08 (Мордашов) остановлен воротами
 * `CONTENT_DROPPED_BY_RENDERER`: на шести страницах рендерер выбросил блоки,
 * которые построитель считал влезающими. Ёмкость предсказывали числа реестра,
 * а расходовал её рендерер по высоте — и предсказание промахнулось на 0,37 %
 * (стр. 11: требовалось 1 712 455 EMU при 1 706 125 доступных).
 *
 * Перекладка получает вердикт самой отрисовки и раскладывает буллеты по
 * измеренным высотам. Свойство, ради которого она заведена: мультимножество
 * буллетов слота не меняется ни на символ, порядок сохраняется, границу слота
 * блок не пересекает. Неправильный ответ выглядит как исчезнувший буллет,
 * продублированный буллет или буллет, сменивший слот.
 */

import { describe, expect, it } from "vitest";
import {
  applyBulletRecut,
  planBulletRecut,
  type BulletMeasurePage,
  type BulletMeasureVerdict,
} from "@/modules/digital-profile/orion-golden/deck-sections/measured-bullet-fit";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

function slide(
  over: Partial<SlideContentContract> & { slideId: string }
): SlideContentContract {
  return {
    schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
    baseSlotId: over.baseSlotId ?? over.slideId,
    sectionId: "RU_PROFILE",
    isContinuation: false,
    continuationOf: null,
    continuationIndex: null,
    templateId: "regional-summary",
    title: "Россия: материалы повышенного внимания",
    content: {},
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    ...over,
  } as SlideContentContract;
}

function cont(base: string, index: number, over: Partial<SlideContentContract> = {}) {
  return slide({
    slideId: `${base}__cont${index}`,
    baseSlotId: base,
    isContinuation: true,
    continuationOf: base,
    continuationIndex: index,
    title: `Россия: материалы повышенного внимания (продолжение ${index + 1}/2)`,
    ...over,
  });
}

function page(over: Partial<BulletMeasurePage> & { slideKey: string }): BulletMeasurePage {
  return {
    page: 1,
    availableHeight: 4_000_000,
    maxItems: 9,
    itemHeights: [],
    keptItems: 0,
    droppedBullets: 0,
    droppedLines: 0,
    ...over,
  };
}

function verdict(pages: BulletMeasurePage[]): BulletMeasureVerdict {
  return { version: "orion-bullet-measure-v1", pages };
}

/** Буллеты цепочки в порядке страниц — то, что обязано пережить перекладку. */
function bulletsOf(slides: SlideContentContract[]): string[] {
  return slides.flatMap((s) => s.content.bullets ?? []);
}

describe("перекладка буллетов по мере рендерера", () => {
  it("переполненная страница отдаёт хвост продолжению, не теряя ни блока", () => {
    const slides = [
      slide({ slideId: "p07", content: { narrative: "Итог по региону", bullets: ["A", "B", "C"] } }),
      cont("p07", 1, { content: { bullets: ["D", "E"] } }),
    ];
    const plan = planBulletRecut({
      chains: [
        {
          baseSlotId: "p07",
          pages: [
            { slideId: "p07", bulletCount: 3, fold: { leading: 0, trailing: 0 } },
            { slideId: "p07__cont1", bulletCount: 2, fold: { leading: 0, trailing: 0 } },
          ],
        },
      ],
      verdict: verdict([
        page({
          slideKey: "p07",
          availableHeight: 1_000_000,
          itemHeights: [600_000, 600_000, 600_000],
          keptItems: 1,
          droppedBullets: 2,
        }),
        page({
          slideKey: "p07__cont1",
          availableHeight: 4_000_000,
          itemHeights: [600_000, 600_000],
          keptItems: 2,
        }),
      ]),
    });

    expect(plan.get("p07")).toEqual([1, 4]);

    const after = applyBulletRecut(slides, plan);
    expect(bulletsOf(after)).toEqual(["A", "B", "C", "D", "E"]);
    expect(after[0]!.content.bullets).toEqual(["A"]);
    expect(after[1]!.content.bullets).toEqual(["B", "C", "D", "E"]);
    // Обвязка базовой страницы остаётся на ней: уезжают блоки, а не нарратив.
    expect(after[0]!.content.narrative).toBe("Итог по региону");
  });

  it("блок, не влезающий над обвязкой, уезжает на продолжение целиком", () => {
    // Стр. 11 живого прогона: единственный блок, 1 712 455 EMU при 1 706 125
    // доступных, рендерер снял с него последнюю строку («Всего по теме: 4
    // материала, с негативным контекстом — 4.»). Частично влезший блок
    // считается невлезшим.
    const slides = [
      slide({
        slideId: "p05_profile_dashboard",
        content: { narrative: "Пять тем повышенного внимания", bullets: ["Криминальные / судебные материалы"] },
      }),
    ];
    const plan = planBulletRecut({
      chains: [
        {
          baseSlotId: "p05_profile_dashboard",
          pages: [
            {
              slideId: "p05_profile_dashboard",
              bulletCount: 1,
              fold: { leading: 0, trailing: 0 },
            },
          ],
        },
      ],
      verdict: verdict([
        page({
          slideKey: "p05_profile_dashboard",
          availableHeight: 1_706_125,
          itemHeights: [1_712_455],
          keptItems: 1,
          droppedLines: 1,
        }),
      ]),
    });

    expect(plan.get("p05_profile_dashboard")).toEqual([0, 1]);

    const after = applyBulletRecut(slides, plan);
    expect(bulletsOf(after)).toEqual(["Криминальные / судебные материалы"]);
    expect(after).toHaveLength(2);
    expect(after[0]!.content.bullets ?? []).toEqual([]);
    expect(after[0]!.content.narrative).toBe("Пять тем повышенного внимания");
    expect(after[1]!.isContinuation).toBe(true);
    expect(after[1]!.continuationOf).toBe("p05_profile_dashboard");
  });

  it("нулевая ёмкость первой страницы оставляет её без буллетов, но с обвязкой", () => {
    const slides = [
      slide({
        slideId: "p07",
        content: {
          narrative: "Итог по региону",
          kpis: [{ label: "Материалов", value: "26" }],
          bullets: ["A", "B"],
        },
      }),
      cont("p07", 1, { content: { bullets: ["C"] } }),
    ];
    const plan = planBulletRecut({
      chains: [
        {
          baseSlotId: "p07",
          pages: [
            { slideId: "p07", bulletCount: 2, fold: { leading: 0, trailing: 0 } },
            { slideId: "p07__cont1", bulletCount: 1, fold: { leading: 0, trailing: 0 } },
          ],
        },
      ],
      verdict: verdict([
        page({
          slideKey: "p07",
          availableHeight: 0,
          itemHeights: [500_000, 500_000],
          keptItems: 0,
          droppedBullets: 2,
        }),
        page({
          slideKey: "p07__cont1",
          availableHeight: 4_000_000,
          itemHeights: [500_000],
          keptItems: 1,
        }),
      ]),
    });

    const after = applyBulletRecut(slides, plan);
    expect(after[0]!.content.bullets ?? []).toEqual([]);
    expect(after[0]!.content.kpis).toHaveLength(1);
    expect(bulletsOf(after)).toEqual(["A", "B", "C"]);
  });

  it("чистый вердикт даёт пустой план и неизменную сборку", () => {
    const slides = [
      slide({ slideId: "p07", content: { bullets: ["A", "B"] } }),
      cont("p07", 1, { content: { bullets: ["C"] } }),
    ];
    const plan = planBulletRecut({
      chains: [
        {
          baseSlotId: "p07",
          pages: [
            { slideId: "p07", bulletCount: 2, fold: { leading: 0, trailing: 0 } },
            { slideId: "p07__cont1", bulletCount: 1, fold: { leading: 0, trailing: 0 } },
          ],
        },
      ],
      verdict: verdict([
        page({
          slideKey: "p07",
          availableHeight: 4_000_000,
          itemHeights: [500_000, 500_000],
          keptItems: 2,
        }),
        page({
          slideKey: "p07__cont1",
          availableHeight: 4_000_000,
          itemHeights: [500_000],
          keptItems: 1,
        }),
      ]),
    });
    expect(plan.size).toBe(0);
    expect(applyBulletRecut(slides, plan)).toEqual(slides);
  });

  it("ненумерованная цепочка получает нумерацию целиком, а не наполовину", () => {
    // У «почему выделено» единственное продолжение подписи не несёт. Дописать
    // «(продолжение 3/3)» только новому листу значило бы поставить рядом
    // страницу без номера и страницу с номером 3.
    const slides = [
      slide({ slideId: "p10", title: "Россия — Google: как выглядит выдача" }),
      slide({
        slideId: "p10__why1",
        baseSlotId: "p10",
        templateId: "continuation",
        isContinuation: true,
        continuationOf: "p10",
        continuationIndex: 1,
        title: "Россия — Google: как выглядит выдача: почему выделено",
        content: { bullets: ["Ф1", "Ф2"] },
      }),
    ];
    const plan = planBulletRecut({
      chains: [
        {
          baseSlotId: "p10",
          pages: [
            { slideId: "p10", bulletCount: 0, fold: { leading: 0, trailing: 0 } },
            { slideId: "p10__why1", bulletCount: 2, fold: { leading: 0, trailing: 0 } },
          ],
        },
      ],
      verdict: verdict([
        page({
          slideKey: "p10__why1",
          availableHeight: 700_000,
          itemHeights: [600_000, 600_000],
          keptItems: 1,
          droppedBullets: 1,
        }),
      ]),
    });
    const after = applyBulletRecut(slides, plan);
    expect(after.map((s) => s.title)).toEqual([
      "Россия — Google: как выглядит выдача",
      "Россия — Google: как выглядит выдача: почему выделено (продолжение 2/3)",
      "Россия — Google: как выглядит выдача: почему выделено (продолжение 3/3)",
    ]);
  });

  it("буллет не пересекает границу слота", () => {
    const slides = [
      slide({ slideId: "p07", content: { bullets: ["A", "B"] } }),
      slide({ slideId: "p12", title: "ОАЭ", content: { bullets: ["X"] } }),
    ];
    const plan = planBulletRecut({
      chains: [
        {
          baseSlotId: "p07",
          pages: [{ slideId: "p07", bulletCount: 2, fold: { leading: 0, trailing: 0 } }],
        },
        {
          baseSlotId: "p12",
          pages: [{ slideId: "p12", bulletCount: 1, fold: { leading: 0, trailing: 0 } }],
        },
      ],
      verdict: verdict([
        page({
          slideKey: "p07",
          availableHeight: 700_000,
          itemHeights: [600_000, 600_000],
          keptItems: 1,
          droppedBullets: 1,
        }),
        page({
          slideKey: "p12",
          availableHeight: 4_000_000,
          itemHeights: [600_000],
          keptItems: 1,
        }),
      ]),
    });
    const after = applyBulletRecut(slides, plan);
    const bySlot = new Map<string, string[]>();
    for (const s of after) {
      bySlot.set(s.baseSlotId, [...(bySlot.get(s.baseSlotId) ?? []), ...(s.content.bullets ?? [])]);
    }
    expect(bySlot.get("p07")).toEqual(["A", "B"]);
    expect(bySlot.get("p12")).toEqual(["X"]);
  });

  it("новый лист наследует последнее продолжение, а не базу", () => {
    // Цепочка «почему выделено»: база — страница со снимком выдачи, продолжение
    // рисует только фразы. Клонировав базу, перекладка отдала бы новому листу
    // её шаблон и её визуал; в пейлоаде страница с визуалом буллетов не несёт
    // вовсе (`hasVisual` → `bullets: undefined`), и положенный на неё текст
    // исчез бы **до** рендерера — ни в телеметрии, ни в мере. Плюс снимок
    // выдачи напечатался бы дважды.
    const slides = [
      slide({
        slideId: "p10_ru_serp_visual",
        templateId: "serp-screenshot-analysis",
        title: "Россия — Google: как выглядит выдача",
        visualAssetRefs: ["ru_provider_serp_1"],
        content: {
          narrative: "Снимок выдачи",
          highlightExplanations: [{ clientReason: "почему", frameTone: "red" as const }],
        },
      }),
      slide({
        slideId: "p10_ru_serp_visual__why1",
        baseSlotId: "p10_ru_serp_visual",
        templateId: "continuation",
        isContinuation: true,
        continuationOf: "p10_ru_serp_visual",
        continuationIndex: 1,
        title: "Россия — Google: как выглядит выдача: почему выделено",
        visualAssetRefs: [],
        content: { bullets: ["Ф1", "Ф2", "Ф3"] },
      }),
    ];
    const plan = planBulletRecut({
      chains: [
        {
          baseSlotId: "p10_ru_serp_visual",
          pages: [
            { slideId: "p10_ru_serp_visual", bulletCount: 0, fold: { leading: 0, trailing: 0 } },
            {
              slideId: "p10_ru_serp_visual__why1",
              bulletCount: 3,
              fold: { leading: 0, trailing: 0 },
            },
          ],
        },
      ],
      verdict: verdict([
        page({
          slideKey: "p10_ru_serp_visual__why1",
          availableHeight: 1_000_000,
          itemHeights: [600_000, 600_000, 600_000],
          keptItems: 1,
          droppedBullets: 2,
        }),
      ]),
    });
    const after = applyBulletRecut(slides, plan);
    expect(bulletsOf(after)).toEqual(["Ф1", "Ф2", "Ф3"]);
    const added = after.slice(2);
    expect(added.length).toBeGreaterThan(0);
    for (const s of added) {
      expect(s.templateId).toBe("continuation");
      expect(s.visualAssetRefs).toEqual([]);
      expect(s.content.highlightExplanations).toBeUndefined();
      expect(s.content.narrative).toBeUndefined();
    }
  });

  it("вклейка нарратива и ссылки на источник не съедает буллеты при разрезе", () => {
    // Пейлоад страницы приложения — [нарратив, …буллеты, ссылка на источник];
    // высоты приходят по элементам пейлоада, а перекладывать надо буллеты.
    const slides = [
      slide({
        slideId: "appendix_main_base",
        templateId: "finding-cards",
        title: "Приложение: требующие идентификации",
        content: {
          narrative: "Материалы, принадлежность которых не подтверждена.",
          bullets: ["К1", "К2", "К3"],
          sourceNote: "Источники — icij.org, kommersant.ru.",
        },
      }),
    ];
    const plan = planBulletRecut({
      chains: [
        {
          baseSlotId: "appendix_main_base",
          pages: [
            {
              slideId: "appendix_main_base",
              bulletCount: 3,
              fold: { leading: 1, trailing: 1 },
            },
          ],
        },
      ],
      verdict: verdict([
        page({
          slideKey: "appendix_main_base",
          availableHeight: 2_000_000,
          // нарратив 300 000, карточки по 900 000, ссылка 100 000
          itemHeights: [300_000, 900_000, 900_000, 900_000, 100_000],
          keptItems: 2,
          droppedBullets: 2,
        }),
      ]),
    });
    // Обвязка страницы (нарратив + ссылка) занимает 400 000 из 2 000 000, и под
    // карточки остаётся 1 600 000 — то есть одна. Числа выбраны так, что без
    // вычитания вклейки ответ был бы другим (две): иначе проверка не отличила
    // бы вычитание от его отсутствия.
    expect(plan.get("appendix_main_base")).toEqual([1, 2]);
    const after = applyBulletRecut(slides, plan);
    expect(bulletsOf(after)).toEqual(["К1", "К2", "К3"]);
  });
});
