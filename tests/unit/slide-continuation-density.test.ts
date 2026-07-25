import { describe, expect, it } from "vitest";
import { withContinuations } from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { SlideContentContract } from "../../src/modules/digital-profile/orion-golden/deck-sections/contracts";

/**
 * Шаг 13, этап 3 — D3 и D4 (docs/rework/13-regression-run-findings.md).
 *
 * Страницы-продолжения повторяли заголовочные плитки блока («312 / 5 / 6 / 31»
 * пять страниц подряд, треть листа каждый раз) и его рекомендацию, которая на
 * узкой карточке вырождалась в одно слово «Проверить».
 */

function baseSlide(bulletCount: number): SlideContentContract {
  return {
    schemaVersion: "slide-content-v1",
    slideId: "p07_ru_summary",
    baseSlotId: "p07_ru_summary",
    sectionId: "RU",
    isContinuation: false,
    continuationOf: null,
    continuationIndex: null,
    title: "Россия — резюме аудита",
    templateId: "regional-summary",
    evidenceRefs: ["inventory:1"],
    findingIds: [],
    content: {
      bullets: Array.from({ length: bulletCount }, (_, i) => `Тема ${i + 1}. Содержательный текст.`),
      kpis: [
        { label: "Материалов региона", value: "312" },
        { label: "Тем повышенного внимания", value: "5" },
      ],
      whatToCheck: "Проверить актуальные статусы дел по картотекам судов и официальным источникам.",
    },
  } as unknown as SlideContentContract;
}

describe("страницы-продолжения не повторяют шапку блока", () => {
  const slides = withContinuations(baseSlide(12), "regional-summary");

  it("продолжения вообще создаются", () => {
    expect(slides.length).toBeGreaterThan(1);
    expect(slides.slice(1).every((s) => s.isContinuation)).toBe(true);
  });

  it("первая страница блока сохраняет плитки и рекомендацию", () => {
    expect(slides[0]!.content.kpis?.length).toBeGreaterThan(0);
    expect(slides[0]!.content.whatToCheck).toBeTruthy();
  });

  it("продолжения не несут заголовочных плиток", () => {
    // Иначе «312 / 5 / 6 / 31» занимает треть каждой следующей страницы,
    // не сообщая ничего нового.
    for (const s of slides.slice(1)) expect(s.content.kpis).toBeUndefined();
  });

  it("продолжения не повторяют рекомендацию", () => {
    // На узкой карточке она вырождалась в обрубок «Проверить».
    for (const s of slides.slice(1)) expect(s.content.whatToCheck).toBeUndefined();
  });

  it("содержание распределяется по страницам, а не теряется", () => {
    const all = slides.flatMap((s) => s.content.bullets ?? []);
    expect(all).toHaveLength(12);
    expect(new Set(all).size).toBe(12);
  });

  it("продолжения ссылаются на свою базовую страницу", () => {
    for (const s of slides.slice(1)) {
      expect(s.continuationOf).toBe("p07_ru_summary");
      expect(s.title).toMatch(/продолжение \d+\/\d+/u);
    }
  });
});
