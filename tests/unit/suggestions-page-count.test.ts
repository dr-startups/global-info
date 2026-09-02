import { describe, expect, it } from "vitest";
import { buildSuggestionsFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/suggestions";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

/**
 * Страница подсказок без панели-снимка описывает сама себя текстом. Считать
 * она обязана напечатанные строки: под десятью строками стояло «показано
 * двадцать семь» — счёт шёл по всем ссылкам поверхности.
 */
function scopedWithSuggestions(count: number): ScopedFragmentInput {
  const refs = Array.from({ length: count }, (_, i) => `inventory:s${i}`);
  const evidenceIndex: Record<string, unknown> = {};
  refs.forEach((r, i) => {
    evidenceIndex[r] = {
      title: `подсказка ${i + 1}`,
      domain: "yandex.ru",
      url: `https://yandex.ru/?text=${i}`,
      region: "RU",
    };
  });
  return {
    findings: [],
    surfaceUnits: [
      {
        surface: "suggestions",
        region: "RU",
        engine: "YANDEX",
        claims: [],
        metrics: [],
        evidenceRefs: refs,
      },
    ],
    evidenceIndex,
    scope: {},
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

describe("страница подсказок без снимка панели", () => {
  it("считает напечатанные строки, а не весь набор ссылок", () => {
    const { slides } = buildSuggestionsFragment(
      "RU_SUGGESTIONS",
      "RU_PROFILE",
      "Россия",
      scopedWithSuggestions(27),
      {}
    );
    const page = slides.find((s) => (s.content.bullets ?? []).length > 0);
    expect(page).toBeDefined();
    const shown = page!.content.bullets!.length;
    expect(shown).toBe(10);
    expect(page!.content.whatWasFound).toContain(`Показано ${shown}`);
    expect(page!.content.whatWasFound).not.toContain("27");
  });
});
