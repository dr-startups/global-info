/**
 * Перекладка назад: продолжения заполняются по мере, а не по сиду (шаг 0102).
 *
 * Прежде блоки ехали только вперёд: лист, на который блок не влез, отдавал
 * его дальше, а лист, на котором осталось место, назад ничего не брал. Сид
 * продолжения — три блока, и половина продолжений золотого кейса была
 * заполнена на 24–45 %. У существующего листа и остаток, и блоки измерены той
 * же функцией, которая рисует, — уплотнять его по этим числам не допущение.
 *
 * Границы уплотнения — данные, а не желание: на лист без единого блока ничего
 * не возвращается (носителем списка он не доказан — основа страницы снимка
 * список в пейлоаде не несёт вовсе), запечатанный лист (там мера уже видела
 * потерю) не заполняется, блок не покидает цепочку, мультимножество буллетов
 * не меняется.
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
import { continuationNumberInTitle } from "@/modules/digital-profile/orion-golden/deck-sections/continuation-slide";

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

function cont(base: string, index: number, total: number, over: Partial<SlideContentContract> = {}) {
  return slide({
    slideId: `${base}__cont${index}`,
    baseSlotId: base,
    isContinuation: true,
    continuationOf: base,
    continuationIndex: index,
    title: `Россия: материалы повышенного внимания (продолжение ${index + 1}/${total})`,
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
    columnWidth: 10_000_000,
    ...over,
  };
}

function verdict(pages: BulletMeasurePage[]): BulletMeasureVerdict {
  return { version: "orion-bullet-measure-v1", pages };
}

function chainOf(base: string, counts: number[]) {
  return {
    baseSlotId: base,
    pages: counts.map((bulletCount, i) => ({
      slideId: i === 0 ? base : `${base}__cont${i}`,
      bulletCount,
      fold: { leading: 0, trailing: 0 },
    })),
  };
}

function bulletsOf(slides: SlideContentContract[]): string[] {
  return slides.flatMap((s) => s.content.bullets ?? []);
}

const H = 600_000;

describe("перекладка назад по мере рендерера", () => {
  it("Н1: место на первом листе забирает блок продолжения, опустевший лист снимается", () => {
    const slides = [
      slide({ slideId: "p07", content: { narrative: "Итог", bullets: ["A", "B", "C"] } }),
      cont("p07", 1, 2, { content: { bullets: ["D"] } }),
    ];
    const plan = planBulletRecut({
      chains: [chainOf("p07", [3, 1])],
      verdict: verdict([
        page({ slideKey: "p07", availableHeight: 4 * H, itemHeights: [H, H, H], keptItems: 3 }),
        page({ slideKey: "p07__cont1", availableHeight: 4 * H, itemHeights: [H], keptItems: 1 }),
      ]),
    });
    expect(plan.get("p07")).toEqual([4]);
    const after = applyBulletRecut(slides, plan);
    expect(bulletsOf(after)).toEqual(["A", "B", "C", "D"]);
    expect(after).toHaveLength(1);
    expect(after[0]!.content.narrative).toBe("Итог");
    expect(after[0]!.title).toBe("Россия: материалы повышенного внимания");
  });

  it("Н2: на лист без блоков ничего не возвращается — продолжения уплотняются между собой", () => {
    // Основа страницы снимка: список в пейлоаде она не несёт, блок на ней
    // исчез бы до рендерера. Мера при этом отдаёт ей «свободный» лист.
    const plan = planBulletRecut({
      chains: [chainOf("p10", [0, 2, 2])],
      verdict: verdict([
        page({ slideKey: "p10", availableHeight: 6 * H, itemHeights: [] }),
        page({ slideKey: "p10__cont1", availableHeight: 6 * H, itemHeights: [H, H], keptItems: 2 }),
        page({ slideKey: "p10__cont2", availableHeight: 6 * H, itemHeights: [H, H], keptItems: 2 }),
      ]),
    });
    expect(plan.get("p10")).toEqual([0, 4]);
  });

  it("Н3: запечатанный лист не заполняется", () => {
    const plan = planBulletRecut({
      chains: [chainOf("p07", [2, 2])],
      verdict: verdict([
        page({ slideKey: "p07", availableHeight: 6 * H, itemHeights: [H, H], keptItems: 2 }),
        page({ slideKey: "p07__cont1", availableHeight: 6 * H, itemHeights: [H, H], keptItems: 2 }),
      ]),
      sealed: new Set(["p07"]),
    });
    expect(plan.get("p07")).toBeUndefined();
  });

  it("Н4: потеря на первом листе и место на втором — оба движения в одном плане", () => {
    // Первый лист теряет один блок (мера выше арифметики), второму хватает
    // места и на уехавший, и на блок третьего листа.
    const plan = planBulletRecut({
      chains: [chainOf("p07", [3, 1, 1])],
      verdict: verdict([
        page({
          slideKey: "p07",
          availableHeight: 3 * H,
          itemHeights: [H, H, H],
          keptItems: 2,
          droppedBullets: 1,
        }),
        page({ slideKey: "p07__cont1", availableHeight: 4 * H, itemHeights: [H], keptItems: 1 }),
        page({ slideKey: "p07__cont2", availableHeight: 4 * H, itemHeights: [H], keptItems: 1 }),
      ]),
      sealed: new Set(["p07"]),
    });
    expect(plan.get("p07")).toEqual([2, 3]);
  });

  it("Н5: слоты держат уплотнение так же, как высота", () => {
    const plan = planBulletRecut({
      chains: [chainOf("p07", [2, 2])],
      verdict: verdict([
        page({ slideKey: "p07", availableHeight: 9 * H, maxItems: 3, itemHeights: [H, H], keptItems: 2 }),
        page({ slideKey: "p07__cont1", availableHeight: 9 * H, maxItems: 3, itemHeights: [H, H], keptItems: 2 }),
      ]),
    });
    expect(plan.get("p07")).toEqual([3, 1]);
  });

  it("Н6: три продолжения становятся двумя, подписи перенумерованы; одно продолжение — без номера", () => {
    const three = [
      slide({ slideId: "p07", content: { bullets: ["A"] } }),
      cont("p07", 1, 3, { content: { bullets: ["B", "C"] } }),
      cont("p07", 2, 3, { content: { bullets: ["D", "E"] } }),
      cont("p07", 3, 3, { content: { bullets: ["F"] } }),
    ];
    const plan = planBulletRecut({
      chains: [chainOf("p07", [1, 2, 2, 1])],
      verdict: verdict([
        page({ slideKey: "p07", availableHeight: H, itemHeights: [H], keptItems: 1 }),
        page({ slideKey: "p07__cont1", availableHeight: 3 * H, itemHeights: [H, H], keptItems: 2 }),
        page({ slideKey: "p07__cont2", availableHeight: 3 * H, itemHeights: [H, H], keptItems: 2 }),
        page({ slideKey: "p07__cont3", availableHeight: 3 * H, itemHeights: [H], keptItems: 1 }),
      ]),
    });
    expect(plan.get("p07")).toEqual([1, 3, 2]);
    const after = applyBulletRecut(three, plan);
    expect(bulletsOf(after)).toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(after.map((s) => s.title)).toEqual([
      "Россия: материалы повышенного внимания",
      "Россия: материалы повышенного внимания (продолжение 2/3)",
      "Россия: материалы повышенного внимания (продолжение 3/3)",
    ]);

    const two = [
      slide({ slideId: "p08", content: { bullets: ["A"] } }),
      cont("p08", 1, 2, { content: { bullets: ["B"] } }),
      cont("p08", 2, 2, { content: { bullets: ["C"] } }),
    ];
    const merged = planBulletRecut({
      chains: [chainOf("p08", [1, 1, 1])],
      verdict: verdict([
        page({ slideKey: "p08", availableHeight: H, itemHeights: [H], keptItems: 1 }),
        page({ slideKey: "p08__cont1", availableHeight: 3 * H, itemHeights: [H], keptItems: 1 }),
        page({ slideKey: "p08__cont2", availableHeight: 3 * H, itemHeights: [H], keptItems: 1 }),
      ]),
    });
    expect(merged.get("p08")).toEqual([1, 2]);
    const single = applyBulletRecut(two, merged);
    expect(single).toHaveLength(2);
    // Счёт «основа — первая страница» (2/N): единственное продолжение — 2/2,
    // как его и печатают построители региональных сводок.
    expect(single[1]!.title).toBe("Россия: материалы повышенного внимания (продолжение 2/2)");

    // Счёт «только продолжения» (1/N) — стиль резюме: одно продолжение
    // печатается без номера, как у построителя.
    const resume = [
      slide({ slideId: "p03", title: "Резюме", content: { bullets: ["A"] } }),
      cont("p03", 1, 2, { title: "Резюме (продолжение 1/2)", content: { bullets: ["B"] } }),
      cont("p03", 2, 2, { title: "Резюме (продолжение 2/2)", content: { bullets: ["C"] } }),
    ];
    const resumePlan = planBulletRecut({
      chains: [chainOf("p03", [1, 1, 1])],
      verdict: verdict([
        page({ slideKey: "p03", availableHeight: H, itemHeights: [H], keptItems: 1 }),
        page({ slideKey: "p03__cont1", availableHeight: 3 * H, itemHeights: [H], keptItems: 1 }),
        page({ slideKey: "p03__cont2", availableHeight: 3 * H, itemHeights: [H], keptItems: 1 }),
      ]),
    });
    const resumed = applyBulletRecut(resume, resumePlan);
    expect(resumed).toHaveLength(2);
    expect(resumed[1]!.title).toBe("Резюме");
    expect(continuationNumberInTitle(resumed[1]!.title)).toBeUndefined();
  });

  it("Н11: заметка, повторённая на каждом листе, при слиянии печатается один раз — план и пул согласны", () => {
    // Разреженное резюме кладёт строку предмета аудита и на основу, и на
    // продолжение. Слились — второй экземпляр не нужен; а следующий план,
    // посчитанный по напечатанному (два блока), обязан лечь на пул без
    // падения инварианта.
    const note = "Предмет аудита — результаты поиска ТОП-20 и международные базы: 2 материала.";
    const slides = [
      slide({ slideId: "p03", content: { bullets: ["A", note] } }),
      cont("p03", 1, 2, { content: { bullets: [note] } }),
    ];
    const chain = {
      baseSlotId: "p03",
      pages: [
        { slideId: "p03", bulletCount: 2, fold: { leading: 0, trailing: 0 }, bullets: ["A", note] },
        { slideId: "p03__cont1", bulletCount: 1, fold: { leading: 0, trailing: 0 }, bullets: [note] },
      ],
    };
    const plan = planBulletRecut({
      chains: [chain],
      verdict: verdict([
        page({ slideKey: "p03", availableHeight: 6 * H, itemHeights: [H, H], keptItems: 2 }),
        page({ slideKey: "p03__cont1", availableHeight: 6 * H, itemHeights: [H], keptItems: 1 }),
      ]),
    });
    expect(plan.get("p03")).toEqual([2]);
    const merged = applyBulletRecut(slides, plan);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.content.bullets).toEqual(["A", note]);

    // Потеря на слившейся странице: план по напечатанному — [1, 1] — ложится на пул из двух.
    const forward = planBulletRecut({
      chains: [
        {
          baseSlotId: "p03",
          pages: [{ slideId: "p03", bulletCount: 2, fold: { leading: 0, trailing: 0 }, bullets: ["A", note] }],
        },
      ],
      verdict: verdict([
        page({ slideKey: "p03", availableHeight: 2 * H, itemHeights: [H, H], keptItems: 1, droppedBullets: 1 }),
      ]),
    });
    expect(forward.get("p03")).toEqual([1, 1]);
    const split = applyBulletRecut(slides, forward);
    expect(bulletsOf(split)).toEqual(["A", note]);
    expect(split).toHaveLength(2);
  });

  it("Н12: на лист другой ширины блок не возвращается, без ширины — тоже", () => {
    // Основа с боковой панелью: колонка уже, высота блока там другая. Реплей
    // золотого кейса без этого правила гонял блок между листами пять итераций.
    const narrowBase = planBulletRecut({
      chains: [chainOf("p31", [3, 1])],
      verdict: verdict([
        page({ slideKey: "p31", availableHeight: 9 * H, itemHeights: [H, H, H], keptItems: 3, columnWidth: 6_000_000 }),
        page({ slideKey: "p31__cont1", availableHeight: 9 * H, itemHeights: [H], keptItems: 1 }),
      ]),
    });
    expect(narrowBase.size).toBe(0);
    const unknown = planBulletRecut({
      chains: [chainOf("p31", [3, 1])],
      verdict: verdict([
        page({ slideKey: "p31", availableHeight: 9 * H, itemHeights: [H, H, H], keptItems: 3, columnWidth: undefined }),
        page({ slideKey: "p31__cont1", availableHeight: 9 * H, itemHeights: [H], keptItems: 1 }),
      ]),
    });
    expect(unknown.size).toBe(0);
  });

  it("Н7: блок не пересекает границу цепочки при уплотнении", () => {
    const plan = planBulletRecut({
      chains: [chainOf("p07", [1]), chainOf("p24", [2, 1])],
      verdict: verdict([
        page({ slideKey: "p07", availableHeight: 9 * H, itemHeights: [H], keptItems: 1 }),
        page({ slideKey: "p24", availableHeight: 2 * H, itemHeights: [H, H], keptItems: 2 }),
        page({ slideKey: "p24__cont1", availableHeight: 9 * H, itemHeights: [H], keptItems: 1 }),
      ]),
    });
    // На p07 есть место, но блок p24 туда не едет; у p24 места нет — план пуст.
    expect(plan.size).toBe(0);
  });
});
