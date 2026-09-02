import { describe, expect, it } from "vitest";
import {
  dropEmptyContinuations,
  slideHasClientContent,
} from "@/modules/digital-profile/orion-golden/deck-sections/continuation-cleanup";
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
    title: "Заголовок",
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
    title: `Регион: итог (продолжение ${index + 1}/4)`,
    ...over,
  });
}

describe("что считается содержимым страницы", () => {
  it("сноска об источнике страницу не наполняет", () => {
    expect(
      slideHasClientContent(slide({ slideId: "a", content: { sourceNote: "Источники — a.ru" } }))
    ).toBe(false);
  });

  it("таблица, плитки и картинка — содержимое", () => {
    expect(
      slideHasClientContent(
        slide({ slideId: "a", content: { table: { headers: ["A"], rows: [["1"]] } } })
      )
    ).toBe(true);
    expect(
      slideHasClientContent(slide({ slideId: "b", content: { kpis: [{ label: "К", value: "1" }] } }))
    ).toBe(true);
    expect(slideHasClientContent(slide({ slideId: "c", visualAssetRefs: ["asset:1"] }))).toBe(true);
  });

  it("пустые строки перечня содержимым не считаются", () => {
    expect(slideHasClientContent(slide({ slideId: "a", content: { bullets: ["", "  "] } }))).toBe(
      false
    );
  });
});

describe("продолжение без содержимого", () => {
  it("выбрасывается, а уцелевшие перенумеровываются", () => {
    const { slides, dropped } = dropEmptyContinuations([
      slide({ slideId: "p07", content: { narrative: "итог" } }),
      cont("p07", 1, { content: { bullets: ["тема A"] } }),
      cont("p07", 2, { content: { sourceNote: "Источники — a.ru" } }),
      cont("p07", 3, { content: { bullets: ["тема B"] } }),
    ]);
    expect(dropped).toEqual(["p07__cont2"]);
    expect(slides.map((s) => s.slideId)).toEqual(["p07", "p07__cont1", "p07__cont3"]);
    // Подписи не должны читаться как «2/4, 4/4».
    expect(slides[1]!.title).toBe("Регион: итог (продолжение 2/3)");
    expect(slides[2]!.title).toBe("Регион: итог (продолжение 3/3)");
    expect(slides[2]!.continuationIndex).toBe(2);
  });

  it("основу блока не трогает даже пустую: это канонический слот отчёта", () => {
    const { slides, dropped } = dropEmptyContinuations([
      slide({ slideId: "p25", content: { sourceNote: "Источники — a.ru" } }),
    ]);
    expect(dropped).toEqual([]);
    expect(slides.map((s) => s.slideId)).toEqual(["p25"]);
  });

  it("заголовок продолжения со своим названием не переписывается", () => {
    const { slides } = dropEmptyContinuations([
      slide({ slideId: "p09", content: { narrative: "выдача" } }),
      cont("p09", 1, { title: "Россия — Google, ТОП-20 (1/2)", content: { bullets: ["x"] } }),
      cont("p09", 2, { title: "Россия — Google, ТОП-20 (2/2)", content: {} }),
    ]);
    expect(slides.map((s) => s.title)).toEqual([
      "Заголовок",
      "Россия — Google, ТОП-20 (1/2)",
    ]);
  });

  it("счёт блока сохраняется: где нумеровали с единицы, там и остаётся", () => {
    // Резюме нумерует продолжения «1/2», не считая основу первой страницей.
    const { slides } = dropEmptyContinuations([
      slide({ slideId: "p03", content: { narrative: "резюме" } }),
      cont("p03", 1, { title: "Резюме (продолжение 1/3)", content: { bullets: ["a"] } }),
      cont("p03", 2, { title: "Резюме (продолжение 2/3)", content: {} }),
      cont("p03", 3, { title: "Резюме (продолжение 3/3)", content: { bullets: ["b"] } }),
    ]);
    expect(slides.map((s) => s.title)).toEqual([
      "Заголовок",
      "Резюме (продолжение 1/2)",
      "Резюме (продолжение 2/2)",
    ]);
  });

  it("подписи блока, ничего не потерявшего, не переписываются", () => {
    const { slides } = dropEmptyContinuations([
      slide({ slideId: "p03", content: { narrative: "резюме" } }),
      cont("p03", 1, { title: "Резюме (продолжение 1/2)", content: { bullets: ["a"] } }),
      cont("p03", 2, { title: "Резюме (продолжение 2/2)", content: { bullets: ["b"] } }),
      slide({ slideId: "p07", content: { narrative: "итог" } }),
      cont("p07", 1, { content: {} }),
    ]);
    expect(slides.map((s) => s.title)).toEqual([
      "Заголовок",
      "Резюме (продолжение 1/2)",
      "Резюме (продолжение 2/2)",
      "Заголовок",
    ]);
  });

  it("без пустых страниц список возвращается тем же", () => {
    const input = [
      slide({ slideId: "p07", content: { narrative: "итог" } }),
      cont("p07", 1, { content: { bullets: ["тема A"] } }),
    ];
    const { slides, dropped } = dropEmptyContinuations(input);
    expect(dropped).toEqual([]);
    expect(slides).toBe(input);
  });
});
