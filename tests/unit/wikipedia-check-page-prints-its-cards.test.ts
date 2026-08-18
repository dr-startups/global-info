import { describe, expect, it } from "vitest";
import { toRendererPayload } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import {
  DECK_TEMPLATE_REGISTRY,
  type DeckTemplateDef,
  type DeckTemplateId,
} from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import { CANONICAL_BASE_SLOTS } from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import type { ReportDeckManifest } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

/**
 * Страница фактической проверки едет к рендереру полями, а не одним буллетом.
 *
 * На прогоне 76 страница «Россия — Википедия» пришла прозаическим макетом:
 * нарратив вливался в первый буллет (1387 знаков), ножницы рендерера
 * возвращали на нём пустую строку — и метод, дата и ссылка исчезали целиком.
 * Структурный макет держит методологию не удачей длины текста, а полями:
 * карточка статуса, список строк выдачи, карточка рекомендации и футнот.
 */

const NARRATIVE =
  "Наличие статьи о проверяемом лице проверено через официальный поисковый API Википедии " +
  "в русскоязычном разделе (ru.wikipedia.org); запрос: «Рашников Виктор Филиппович», " +
  "проверка выполнена 17.08.2026. Проверка по этому запросу статью не нашла. " +
  "Это итог выполненной проверки, а не пропуск сбора.";
const WHY = "Статья в Википедии — опорный источник «официальной» биографии.";
const ADVICE = "Мы предлагаем рассмотреть создание нейтральной биографической статьи.";
const SOURCE_NOTE = "Источники — ru.wikipedia.org.";
const METHODOLOGY = "Методология страницы — каркасный текст шаблона.";

function wikipediaCheckSlide(): RendererSlide {
  return {
    slideKey: "p13_ru_wikipedia",
    sectionKey: "RU_PROFILE",
    template: "orion_golden_wikipedia_check",
    title: "Россия — Википедия",
    pageNumber: 25,
    totalPageCount: 48,
    baseSlotId: "p13_ru_wikipedia",
    isContinuation: false,
    narrative: NARRATIVE,
    bullets: ["Рашников, Виктор Филиппович — ru.wikipedia.org"],
    evidenceRefs: ["inventory:wiki-1"],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    staticBlocks: [],
    methodologyNote: METHODOLOGY,
    whyItMatters: WHY,
    whatToCheck: ADVICE,
    sourceNote: SOURCE_NOTE,
  };
}

function renderPayloadSlide(slide: RendererSlide): Record<string, unknown> {
  const payload = toRendererPayload({
    deckManifest: { toc: [], sectionPageRanges: [] } as unknown as ReportDeckManifest,
    rendererSlides: [slide],
    subjectName: "Виктор Рашников",
  });
  const manifest = payload.deckManifest as { finalSlides: Array<Record<string, unknown>> };
  return manifest.finalSlides[0]!;
}

describe("реестр шаблонов знает страницу проверки Википедии", () => {
  const template = (DECK_TEMPLATE_REGISTRY as Partial<Record<DeckTemplateId, DeckTemplateDef>>)[
    "wikipedia-check" as DeckTemplateId
  ];

  it("шаблон отдельный, с собственным макетом рендерера", () => {
    expect(template?.rendererTemplate).toBe("orion_golden_wikipedia_check");
    expect(template?.methodologyNote ?? "").not.toBe("");
  });

  it("слоты страниц Википедии переведены на него, панель знаний — нет", () => {
    const byId = new Map(CANONICAL_BASE_SLOTS.map((s) => [s.slotId, s.templateId]));
    expect(byId.get("p13_ru_wikipedia")).toBe("wikipedia-check");
    expect(byId.get("p29_uae_wikipedia")).toBe("wikipedia-check");
    // p18 несёт визуал панели знаний — перепрофилировать его нельзя.
    expect(byId.get("p18_ru_knowledge_1")).toBe("wikipedia-knowledge");
  });
});

describe("страница проверки Википедии в полезной нагрузке рендерера", () => {
  it("нарратив едет карточкой целиком, а не первым буллетом", () => {
    const out = renderPayloadSlide(wikipediaCheckSlide());
    expect(out.template).toBe("orion_golden_wikipedia_check");
    expect(String(out.narrative ?? "")).toContain("официальный поисковый API Википедии");
    expect(String(out.narrative ?? "")).toContain("запрос: «Рашников Виктор Филиппович»");
    expect(String(out.narrative ?? "")).toContain(WHY);
    // Рекомендация печатается своей карточкой — во вклейку она не идёт.
    expect(String(out.narrative ?? "")).not.toContain(ADVICE);
  });

  it("рекомендация, методология и источники — отдельные поля", () => {
    const out = renderPayloadSlide(wikipediaCheckSlide());
    expect(out.actions).toEqual([{ label: ADVICE }]);
    expect(out.methodologyNote).toBe(METHODOLOGY);
    expect(out.sourceNote).toBe(SOURCE_NOTE);
  });

  it("строки выдачи остаются списком: ни нарратива, ни источников в буллетах", () => {
    const out = renderPayloadSlide(wikipediaCheckSlide());
    expect(out.bullets).toEqual(["Рашников, Виктор Филиппович — ru.wikipedia.org"]);
  });

  it("страница без строк выдачи буллетов не заводит", () => {
    const out = renderPayloadSlide({ ...wikipediaCheckSlide(), bullets: [] });
    expect(out.bullets).toBeUndefined();
    expect(String(out.narrative ?? "")).toContain("Проверка по этому запросу статью не нашла");
  });
});
