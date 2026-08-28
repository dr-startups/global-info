/**
 * Вводный абзац разделителя раздела едет в нагрузку только там, где он рисуется.
 *
 * Разделитель рисует абзац одним-единственным вариантом макета — `hero`
 * (`renderer/orion_golden_render/slides.py`, ветка
 * `orion_golden_region_divider`); по умолчанию на тёмном листе стоит только
 * титул. Нагрузка отдавала абзац всегда, и на страницах 10 и 37 эталона фраза
 * «Раздел показывает, что увидит банк…» не встречалась нигде в 56 страницах.
 *
 * Молчаливость здесь полная: ветка отрисовки не исполняется, значит и записи
 * телеметрии о потере нет — ворота потерь рендерера видеть тут нечего. Нашли
 * это приёмочные ворота следа поля на своей странице.
 */

import { describe, expect, it } from "vitest";
import { toRendererPayload } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";

const LEAD =
  "Раздел показывает, что увидит банк, инвестор или контрагент в выдаче по " +
  "региону «Россия»: какие темы формируют риск и что проверить в первую очередь.";

function divider(layoutVariant?: string): RendererSlide {
  return {
    slideKey: "p06_ru_toc",
    sectionKey: "RU_PROFILE",
    // Поле стало обязательным вместе с листом «Кого проверяли»: бюджет абзаца
    // объявлен у реестрового шаблона, а одну раскладку делят шаблоны с разной
    // ёмкостью. Необязательное поле молча отключало бы сторож на слайде без него.
    templateId: "region-divider",
    template: "orion_golden_region_divider",
    layoutVariant,
    title: "Россия: Цифровой профиль",
    pageNumber: 10,
    totalPageCount: 56,
    baseSlotId: "p06_ru_toc",
    isContinuation: false,
    narrative: LEAD,
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    staticBlocks: [],
  } as RendererSlide;
}

/** Через JSON: ключ со значением `undefined` до рендерера не доезжает. */
function payloadSlide(slide: RendererSlide): Record<string, unknown> {
  const payload = toRendererPayload({
    deckManifest: { pageCount: 1, toc: [], sectionPageRanges: [], slides: [] } as never,
    rendererSlides: [slide],
    subjectName: "Сергей Глинка",
  });
  const manifest = payload.deckManifest as { finalSlides: Array<Record<string, unknown>> };
  return JSON.parse(JSON.stringify(manifest.finalSlides))[0] as Record<string, unknown>;
}

describe("вводный абзац разделителя раздела", () => {
  it("вариант hero рисует абзац и получает его", () => {
    expect(payloadSlide(divider("hero")).narrative).toBe(LEAD);
  });

  it("разделитель по умолчанию абзаца не получает вовсе", () => {
    expect("narrative" in payloadSlide(divider())).toBe(false);
  });

  it("титул разделителя едет в обоих вариантах — его рисуют оба", () => {
    expect(payloadSlide(divider()).title).toBe("Россия: Цифровой профиль");
    expect(payloadSlide(divider("hero")).title).toBe("Россия: Цифровой профиль");
  });
});
