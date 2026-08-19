/**
 * Страница-продолжение строится одним конструктором и подписывается одним
 * форматом.
 *
 * Подпись «(продолжение i/N)» печатали и разбирали в четырёх местах:
 * `withContinuations`, построитель резюме, построитель комплаенса и
 * перенумерация после вычистки. Пока перекладка по мере рендерера не добавляла
 * и не убирала страницы, расхождение было безвредным; теперь число страниц
 * цепочки меняется на каждой итерации, и формат обязан быть один.
 *
 * Второе свойство конструктора: заголовочные поля блока (KPI, рекомендация,
 * доля прочитанного) принадлежат первой странице слота и на продолжение не
 * едут — иначе «312 / 5 / 6 / 31» стоит пять листов подряд.
 */

import { describe, expect, it } from "vitest";
import {
  continuationNumberInTitle,
  continuationTitle,
  stripContinuationSuffix,
} from "@/modules/digital-profile/orion-golden/deck-sections/continuation-slide";
import { withContinuations } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import {
  applyBulletRecut,
  planBulletRecut,
} from "@/modules/digital-profile/orion-golden/deck-sections/measured-bullet-fit";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

function base(over: Partial<SlideContentContract> = {}): SlideContentContract {
  return {
    schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
    slideId: "p07_ru_summary",
    baseSlotId: "p07_ru_summary",
    sectionId: "RU_PROFILE",
    isContinuation: false,
    continuationOf: null,
    continuationIndex: null,
    templateId: "regional-summary",
    title: "Россия: материалы повышенного внимания",
    content: {
      narrative: "Итог по региону",
      bullets: ["A", "B", "C", "D", "E", "F"],
      kpis: [{ label: "Материалов", value: "32" }],
      whatToCheck: "Сверить первоисточники.",
      statusNote: "Прочитано 32 из 44.",
    },
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    ...over,
  } as SlideContentContract;
}

describe("подпись продолжения — один формат", () => {
  it("печать и разбор договорились между собой", () => {
    const title = continuationTitle("Россия: итог", 2, 3);
    expect(title).toBe("Россия: итог (продолжение 2/3)");
    expect(continuationNumberInTitle(title)).toBe(2);
    expect(stripContinuationSuffix(title)).toBe("Россия: итог");
  });

  it("подпись без суффикса разбирается как отсутствие номера", () => {
    expect(continuationNumberInTitle("Россия — Google, ТОП-20 (2/2)")).toBeUndefined();
    expect(stripContinuationSuffix("Россия — Google, ТОП-20 (2/2)")).toBe(
      "Россия — Google, ТОП-20 (2/2)"
    );
  });
});

describe("конструктор страницы-продолжения", () => {
  it("заголовочные поля блока остаются на первой странице", () => {
    const slides = withContinuations(base(), "regional-summary");
    expect(slides.length).toBeGreaterThan(1);
    for (const cont of slides.slice(1)) {
      expect(cont.isContinuation).toBe(true);
      expect(cont.content.kpis).toBeUndefined();
      expect(cont.content.whatToCheck).toBeUndefined();
      expect(cont.content.statusNote).toBeUndefined();
      expect(continuationNumberInTitle(cont.title)).toBeGreaterThan(1);
    }
    expect(slides[0]!.content.kpis).toHaveLength(1);
  });

  it("страница, добавленная перекладкой, подписана тем же форматом", () => {
    const seed = withContinuations(base(), "regional-summary");
    const chainPages = seed.map((s) => ({
      slideId: s.slideId,
      bulletCount: (s.content.bullets ?? []).length,
      fold: { leading: 0, trailing: 0 },
    }));
    const plan = planBulletRecut({
      chains: [{ baseSlotId: "p07_ru_summary", pages: chainPages }],
      verdict: {
        version: "orion-bullet-measure-v1",
        pages: seed.map((s, i) => ({
          slideKey: s.slideId,
          page: i + 1,
          // Каждая страница принимает ровно один блок — цепочка обязана
          // вырасти до шести листов.
          availableHeight: 500_000,
          maxItems: 9,
          itemHeights: (s.content.bullets ?? []).map(() => 400_000),
          keptItems: 1,
          droppedBullets: Math.max(0, (s.content.bullets ?? []).length - 1),
          droppedLines: 0,
        })),
      },
    });
    const after = applyBulletRecut(seed, plan);
    expect(after.flatMap((s) => s.content.bullets ?? [])).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
    ]);
    const conts = after.filter((s) => s.isContinuation);
    expect(conts.length).toBeGreaterThan(seed.length - 1);
    // Нумерация согласована во всей цепочке: «2/N, 3/N, …», N — число листов.
    const total = after.length;
    expect(conts.map((s) => continuationNumberInTitle(s.title))).toEqual(
      conts.map((_, i) => i + 2)
    );
    for (const cont of conts) {
      expect(cont.title).toBe(
        continuationTitle(
          stripContinuationSuffix(cont.title),
          continuationNumberInTitle(cont.title)!,
          total
        )
      );
      expect(cont.content.kpis).toBeUndefined();
    }
  });
});
