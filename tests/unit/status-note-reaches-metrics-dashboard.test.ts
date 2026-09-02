/**
 * Строка о чтении доезжает до рендерера — и только до того шаблона, который
 * умеет её напечатать.
 *
 * `content.statusNote` существовал в контракте и проходил ассемблер, но в
 * полезной нагрузке рендерера оставался только внутри боковой панели
 * визуальных страниц. Страница региона (`orion_golden_metrics_dashboard`) его
 * не получала вовсе — то есть носитель, выбранный за неуязвимость к переписке
 * и подгонке по высоте, просто не доходил до листа.
 *
 * Молча включать печать поля на остальных шаблонах нельзя: они его не рисуют,
 * и «переданное, но не нарисованное» — ровно тот класс потерь, который здесь
 * закрывается.
 */

import { describe, expect, it } from "vitest";
import { toRendererPayload } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import { extractClientText } from "../../scripts/lib/client-text-snapshot";

const READ_SHARE =
  "Негатив среди прочитанных страниц региона: 15 из 50 (30%); прочитано 50 из 86 отобранных.";

function slide(overrides: Partial<RendererSlide>): RendererSlide {
  return {
    slideKey: "p07_ru_summary",
    sectionKey: "RU_PROFILE",
    template: "orion_golden_metrics_dashboard",
    title: "Россия: в выдаче есть материалы повышенного внимания",
    pageNumber: 7,
    totalPageCount: 48,
    baseSlotId: "p07_ru_summary",
    isContinuation: false,
    narrative: "Предмет аудита по региону «Россия» — ТОП-20 выдачи: 20 материалов.",
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    staticBlocks: [],
    ...overrides,
  } as RendererSlide;
}

function payloadSlides(slides: RendererSlide[]): Array<Record<string, unknown>> {
  const payload = toRendererPayload({
    deckManifest: {
      pageCount: slides.length,
      toc: [],
      sectionPageRanges: [],
      slides: [],
    } as never,
    rendererSlides: slides,
    subjectName: "Тестов Иван",
  });
  const manifest = payload.deckManifest as { finalSlides: Array<Record<string, unknown>> };
  // Через JSON — рендерер получает файл, а не объект: ключ со значением
  // `undefined` до него не доезжает, и «поля нет» проверяется там же, где это
  // и означает отсутствие.
  return JSON.parse(JSON.stringify(manifest.finalSlides)) as Array<Record<string, unknown>>;
}

describe("statusNote страницы региона в полезной нагрузке", () => {
  it("страница метрик получает строку о чтении", () => {
    const [out] = payloadSlides([slide({ statusNote: READ_SHARE })]);
    expect(out!.statusNote).toBe(READ_SHARE);
  });

  it("без строки поля нет вовсе — не пустая строка", () => {
    const [out] = payloadSlides([slide({})]);
    expect("statusNote" in out!).toBe(false);
  });

  it("снимок клиентского текста её видит", () => {
    const snapshot = extractClientText({ slides: payloadSlides([slide({ statusNote: READ_SHARE })]) });
    expect(snapshot.slides[0]!.text.statusNote).toBe(READ_SHARE);
  });

  it("на шаблоне, который её не рисует, слайд деки её и не несёт", () => {
    // Ответ переехал на уровень выше: строку снимает ассемблер, там же, где
    // разрешается макет рендерера. Слайд деки, всё-таки принёсший её на лист
    // без списка, — это дефект построителя, и сборка о нём говорит вслух:
    // «переданное, но не нарисованное» больше не проходит молча.
    expect(() =>
      payloadSlides([
        slide({
          slideKey: "p09_ru_serp_table",
          template: "orion_golden_search_table",
          statusNote: READ_SHARE,
          table: { headers: ["№", "Ссылка"], rows: [["1", "news.example"]] },
        }),
      ])
    ).toThrow(/p09_ru_serp_table · statusNote/u);
  });
});
