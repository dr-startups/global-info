/**
 * Нагрузка рендерера не теряет тела AI-ответов.
 *
 * Отчёт 84: в пакете секций буллеты страницы AI-ответов есть, рендерер новый,
 * а на бумаге текста нет. `toRendererPayload` у любой страницы с картинкой
 * обнулял `bullets` и не передавал `templateId`, по которому рендерер узнаёт
 * страницу ответов. Смок рендерера проверялся нагрузкой, собранной вручную, —
 * в обход этого сборщика; здесь нагрузка настоящая.
 */

import { describe, expect, it } from "vitest";
import { toRendererPayload } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import type { ReportDeckManifest } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { RendererAssetEntry } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";

const ANSWER =
  "Ответ поискового ИИ Яндекса, зафиксированный в выдаче. Запрос: «Кремлёв Умар Назарович». Умар Кремлёв — глава IBA.";

function slide(over: Partial<RendererSlide> & { slideKey: string; templateId: string }): RendererSlide {
  return {
    sectionKey: "RU_PROFILE",
    template: "orion_golden_surface_panel",
    title: "Страница",
    pageNumber: 1,
    totalPageCount: 1,
    baseSlotId: over.slideKey,
    isContinuation: false,
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: ["ru_ai_answers"],
    staticBlocks: [],
    whatWasFound: "Ответов поискового ИИ: 1 — Алиса 1; источников в ответах: 2.",
    ...over,
  } as RendererSlide;
}

const ASSET = {
  assetRef: "ru_ai_answers",
  kind: "knowledge_panel",
  title: "Россия — ИИ-ответы",
  imageData: "iVBORw0KGgo=",
  evidenceRefs: [],
} as unknown as RendererAssetEntry;

function finalSlide(s: RendererSlide) {
  const payload = toRendererPayload({
    deckManifest: { toc: [], sectionPageRanges: [] } as unknown as ReportDeckManifest,
    rendererSlides: [s],
    subjectName: "Кремлёв Умар Назарович",
    assets: [ASSET],
  }) as { deckManifest: { finalSlides: Array<Record<string, unknown>> } };
  return payload.deckManifest.finalSlides[0]!;
}

describe("нагрузка рендерера для страницы AI-ответов", () => {
  it("несёт тела ответов и идентификатор шаблона рядом с картинкой", () => {
    const out = finalSlide(slide({ slideKey: "p19_ru_knowledge_2", templateId: "ai-overview", bullets: [ANSWER, "Источники ответа: tass.ru, ria.ru"] }));
    expect(out.templateId).toBe("ai-overview");
    expect(out.assetRefs).toEqual(["ru_ai_answers"]);
    expect(out.bullets).toEqual([ANSWER, "Источники ответа: tass.ru, ria.ru"]);
  });

  it("продолжение несёт свои тела", () => {
    const out = finalSlide(
      slide({ slideKey: "p19_ru_knowledge_2__cont1", templateId: "ai-overview", isContinuation: true, continuationOf: "p19_ru_knowledge_2", bullets: [ANSWER] })
    );
    expect(out.templateId).toBe("ai-overview");
    expect(out.bullets).toEqual([ANSWER]);
  });

  it("у прочих панелей с картинкой список по-прежнему не едет: его рисует картинка", () => {
    const out = finalSlide(slide({ slideKey: "p11_ru_suggestions_yandex", templateId: "suggestions", bullets: ["кремлев умар назарович биография"] }));
    expect(out.bullets).toBeUndefined();
    expect(out.templateId).toBe("suggestions");
  });
});
