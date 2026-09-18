/**
 * Переполнение течёт по мере, а не сваливается на следующий лист (шаг 0106).
 *
 * Живой прогон 18.09.2026 (DPA-2026-0062): `CONTENT_DROPPED_BY_RENDERER: перекладка
 * не сошлась за 8 итераций; страницы с потерей: appendix_main_base__cont9`.
 * Правило «мера выше арифметики» снимало с листа потерянные блоки и клало их
 * на следующий лист **без проверки его ёмкости**; мера следующей итерации
 * называла потерю уже там — по одному листу за итерацию, лестницей
 * `cont3 → … → cont9`, пока не кончился предел.
 *
 * Ёмкость листа с потерей — число блоков (`bulletCount − lost`), и оно входит
 * в ход вперёд наравне с высотой: переполнение растекается по следующим и
 * новым листам по измеренным высотам, в один шаг.
 */

import { describe, expect, it } from "vitest";
import {
  planBulletRecut,
  type BulletMeasurePage,
  type BulletMeasureVerdict,
  type SlotChain,
} from "@/modules/digital-profile/orion-golden/deck-sections/measured-bullet-fit";

const H = 300_000;

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

/** Лист ёмкостью `cap` блоков по высоте, несущий `n` своих; ширина колонки у всех одна. */
const sheet = (
  slideKey: string,
  n: number,
  cap: number,
  over: Partial<BulletMeasurePage> = {}
): BulletMeasurePage =>
  page({
    slideKey,
    itemHeights: Array.from({ length: n }, () => H),
    keptItems: n,
    availableHeight: H * cap,
    columnWidth: 10_000_000,
    ...over,
  });

const chain = (base: string, counts: number[]): SlotChain => ({
  baseSlotId: base,
  pages: counts.map((n, i) => ({
    slideId: i === 0 ? base : `${base}__cont${i}`,
    bulletCount: n,
    fold: { leading: 0, trailing: 0 },
  })),
});

describe("переполнение течёт по мере", () => {
  it("П1: лист с потерей отдаёт блоки, и ни один лист плана не переполнен по высотам", () => {
    // Ёмкость каждого листа — три блока, высоты «влезают»; первый лист теряет 2 из 3.
    // Свалка на второй лист дала бы [1, 4, 1]: четыре блока при ёмкости три.
    const plan = planBulletRecut({
      chains: [chain("appendix_main_base", [3, 2, 1])],
      verdict: verdict([
        sheet("appendix_main_base", 3, 3, { keptItems: 1, droppedBullets: 2 }),
        sheet("appendix_main_base__cont1", 2, 3),
        sheet("appendix_main_base__cont2", 1, 3),
      ]),
    });
    expect(plan.get("appendix_main_base")).toEqual([1, 3, 2]);
  });

  it("П2: лестница схлопывается в один шаг — переполнение растекается по листам не выше ёмкости", () => {
    // Семь блоков: первый лист теряет 4 из 5, второй несёт два своих; ёмкость — три.
    const plan = planBulletRecut({
      chains: [chain("appendix_main_base", [5, 2])],
      verdict: verdict([
        sheet("appendix_main_base", 5, 3, { keptItems: 1, droppedBullets: 4 }),
        sheet("appendix_main_base__cont1", 2, 3),
      ]),
    });
    const counts = plan.get("appendix_main_base")!;
    expect(counts.reduce((a, b) => a + b, 0)).toBe(7);
    expect(counts[0]).toBe(1);
    expect(Math.max(...counts)).toBeLessThanOrEqual(3);
    expect(counts).toEqual([1, 3, 3]);
  });

  it("П4: лист, потерявший все блоки, не получает ни одного — первый блок начинает следующий лист", () => {
    // Добавлено после мутации М2 (предел не учтён в проходе «блок не влезает в
    // одиночку»): она оставалась зелёной, пока ёмкость листа с потерей не была нулём.
    const plan = planBulletRecut({
      chains: [chain("p07_ru_summary", [2, 1])],
      verdict: verdict([
        sheet("p07_ru_summary", 2, 3, { keptItems: 0, droppedBullets: 2 }),
        sheet("p07_ru_summary__cont1", 1, 3),
      ]),
    });
    expect(plan.get("p07_ru_summary")).toEqual([0, 3]);
  });

  it("П3: лист с потерей отдаёт не меньше потерянных блоков, даже когда высоты «влезают» (правило 0080)", () => {
    const plan = planBulletRecut({
      chains: [chain("p29_uae_wikipedia", [1, 5, 5])],
      verdict: verdict([
        sheet("p29_uae_wikipedia", 1, 1),
        sheet("p29_uae_wikipedia__cont1", 5, 5),
        sheet("p29_uae_wikipedia__cont2", 5, 5, { keptItems: 4, droppedBullets: 1 }),
      ]),
    });
    expect(plan.get("p29_uae_wikipedia")).toEqual([1, 5, 4, 1]);
  });

  it("П5: ёмкость листа с потерей — сколько блоков на нём осталось, а не bulletCount минус выброшенные элементы", () => {
    // Хвостовая обвязка («Источники — …») — последний элемент листа; рендерер
    // выбрасывает с конца, и она уходит первой. Подано три блока и строка
    // источников, оставлено два блока, выброшены блок и строка: droppedBullets = 2,
    // а блоков потеряно один. Ёмкость — два блока.
    const chain: SlotChain = {
      baseSlotId: "appendix_main_base",
      pages: [
        { slideId: "appendix_main_base", bulletCount: 3, fold: { leading: 0, trailing: 1 } },
        { slideId: "appendix_main_base__cont1", bulletCount: 1, fold: { leading: 0, trailing: 1 } },
      ],
    };
    const plan = planBulletRecut({
      chains: [chain],
      verdict: verdict([
        page({
          slideKey: "appendix_main_base",
          itemHeights: [H, H, H, H / 4],
          keptItems: 2,
          droppedBullets: 2,
          availableHeight: H * 2 + H / 4,
          columnWidth: 10_000_000,
        }),
        page({
          slideKey: "appendix_main_base__cont1",
          itemHeights: [H, H / 4],
          keptItems: 2,
          availableHeight: H * 2 + H / 4,
          columnWidth: 10_000_000,
        }),
      ]),
    });
    expect(plan.get("appendix_main_base")).toEqual([2, 2]);
  });

  it("П6: выброшена только строка источников — лист всё равно отдаёт один блок (правило 0080)", () => {
    // По высотам все три блока и строка источников влезают (3,25H при 4H), а
    // рендерер строку выбросил — «мера выше арифметики»: лист отдаёт блок.
    // Первая редакция фикстуры давала листу 3H, и блок уезжал по высоте сам:
    // мутация «снят предел bulletCount − 1» оставалась зелёной.
    const chain: SlotChain = {
      baseSlotId: "appendix_main_base",
      pages: [
        { slideId: "appendix_main_base", bulletCount: 3, fold: { leading: 0, trailing: 1 } },
        { slideId: "appendix_main_base__cont1", bulletCount: 1, fold: { leading: 0, trailing: 1 } },
      ],
    };
    const plan = planBulletRecut({
      chains: [chain],
      verdict: verdict([
        page({
          slideKey: "appendix_main_base",
          itemHeights: [H, H, H, H / 4],
          keptItems: 3,
          droppedBullets: 1,
          availableHeight: H * 4,
          columnWidth: 10_000_000,
        }),
        page({
          slideKey: "appendix_main_base__cont1",
          itemHeights: [H, H / 4],
          keptItems: 2,
          availableHeight: H * 3,
          columnWidth: 10_000_000,
        }),
      ]),
    });
    expect(plan.get("appendix_main_base")).toEqual([2, 2]);
  });
});
