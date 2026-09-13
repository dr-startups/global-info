/**
 * Мера выше арифметики: страница с потерей не остаётся прежней.
 *
 * QA MVP 14.09.2026 («Абрамович»): `CONTENT_DROPPED_BY_RENDERER: перекладка не
 * сошлась за 2 итераций; страницы с потерей: p29_uae_wikipedia__cont2`. По
 * измеренным высотам все пять блоков продолжения влезали, и планировщик
 * раскладывал их в те же `[1,5,5]`, что были, — «ничего не изменилось», хода
 * нет, цикл сдался на второй итерации из четырёх. При этом рендерер на той
 * же странице терял один блок. Верить надо рендереру: он и есть мера.
 *
 * Правило: страница, на которой мера назвала потерю, отдаёт не меньше
 * потерянных блоков следующей — даже если арифметика высот говорит «влезает».
 * Потеря строк без потери блоков — тоже потеря: уезжает хотя бы последний блок.
 */

import { describe, expect, it } from "vitest";
import {
  planBulletRecut,
  type BulletMeasurePage,
  type BulletMeasureVerdict,
  type SlotChain,
} from "@/modules/digital-profile/orion-golden/deck-sections/measured-bullet-fit";

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

const fits = (n: number): number[] => Array.from({ length: n }, () => 300_000);

/** Цепочка p29_uae_wikipedia прогона: [1, 5, 5]. */
const CHAIN: SlotChain = {
  baseSlotId: "p29_uae_wikipedia",
  pages: [
    { slideId: "p29_uae_wikipedia", bulletCount: 1, fold: { leading: 0, trailing: 0 } },
    { slideId: "p29_uae_wikipedia__cont1", bulletCount: 5, fold: { leading: 0, trailing: 0 } },
    { slideId: "p29_uae_wikipedia__cont2", bulletCount: 5, fold: { leading: 0, trailing: 0 } },
  ],
};

describe("мера выше арифметики", () => {
  it("страница, где рендерер потерял блок, отдаёт его дальше, хотя высоты «влезают»", () => {
    const plan = planBulletRecut({
      chains: [CHAIN],
      verdict: verdict([
        page({ slideKey: "p29_uae_wikipedia", itemHeights: fits(1), keptItems: 1 }),
        page({ slideKey: "p29_uae_wikipedia__cont1", itemHeights: fits(5), keptItems: 5 }),
        page({ slideKey: "p29_uae_wikipedia__cont2", itemHeights: fits(5), keptItems: 4, droppedBullets: 1 }),
      ]),
    });
    expect(plan.get("p29_uae_wikipedia")).toEqual([1, 5, 4, 1]);
  });

  it("потеря строк без потери блоков тоже двигает последний блок", () => {
    const plan = planBulletRecut({
      chains: [CHAIN],
      verdict: verdict([
        page({ slideKey: "p29_uae_wikipedia", itemHeights: fits(1), keptItems: 1 }),
        page({ slideKey: "p29_uae_wikipedia__cont1", itemHeights: fits(5), keptItems: 5, droppedLines: 2 }),
        page({ slideKey: "p29_uae_wikipedia__cont2", itemHeights: fits(5), keptItems: 5 }),
      ]),
    });
    expect(plan.get("p29_uae_wikipedia")).toEqual([1, 4, 6]);
  });

  it("без потери план не меняется — как прежде", () => {
    const plan = planBulletRecut({
      chains: [CHAIN],
      verdict: verdict([
        page({ slideKey: "p29_uae_wikipedia", itemHeights: fits(1), keptItems: 1 }),
        page({ slideKey: "p29_uae_wikipedia__cont1", itemHeights: fits(5), keptItems: 5 }),
        page({ slideKey: "p29_uae_wikipedia__cont2", itemHeights: fits(5), keptItems: 5 }),
      ]),
    });
    expect(plan.size).toBe(0);
  });
});
