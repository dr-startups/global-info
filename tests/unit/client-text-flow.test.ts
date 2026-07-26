/**
 * PDF-31 B.1b/B.1c — client text must stay readable instead of being cut:
 *  - clampClientText (last resort) cuts only at sentence boundaries and never
 *    leaves dangling conjunctions («…владению и.», «требуют ещё.»);
 *  - an over-budget narrative flows to continuation slides as complete
 *    paragraphs (withContinuations) instead of losing its tail.
 */

import { describe, expect, it } from "vitest";
import {
  clampClientText,
  splitClientParagraphs,
  withContinuations,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { getClientTextFieldBudgets } from "../../src/modules/digital-profile/orion-golden/client/load-client-text-contract";
import type { SlideContentContract } from "../../src/modules/digital-profile/orion-golden/deck-sections/contracts";

const NARRATIVE_BUDGET = getClientTextFieldBudgets().narrative;

describe("clampClientText — sentence-safe last resort (B.1c)", () => {
  it("prefers a sentence boundary even when it is early in the budget", () => {
    const text = `Короткий вывод. ${"Дальше идёт очень длинное предложение без внутренних границ которое не помещается в бюджет и раньше обрезалось посреди мысли".repeat(3)}`;
    const out = clampClientText(text, 120);
    expect(out).toBe("Короткий вывод.");
  });

  it("strips dangling conjunctions/prepositions after a word-boundary cut", () => {
    // Report-31 regression: «…корпоративному владению и.» (p28).
    const text =
      "Материалы относятся к санкциям спорам корпоративному владению и разбирательствам по множеству юрисдикций без сентенционных границ вовсе";
    // Budget lands mid-«разбирательствам» → the word cut leaves a dangling «и».
    const out = clampClientText(text, text.indexOf("разбирательствам") + 4);
    expect(out).toMatch(/владению$/u);
    expect(out).not.toMatch(/\s(и|по|к|ещё|а также|для|от|на|с|о|у|же|то)$/iu);

    // «…ещё.» (p17/p26): a dangling «ещё» before the cut is stripped too.
    const text2 =
      "Пользователь Яндекса столкнётся с проблемной ассоциацией ещё раньше чем откроет первую ссылку выдачи";
    const out2 = clampClientText(text2, text2.indexOf("раньше") + 3);
    expect(out2).toMatch(/ассоциацией$/u);
    expect(out2).not.toMatch(/\s(и|ещё|по|к|а также)$/iu);
  });

  it("не дописывает точку к обрубку — оборванная фраза выглядит оборванной", () => {
    // Шаг 13, C7: точка превращала обрубок в «законченную мысль», и в отчёт
    // попадали «Для банка или партнёра такие.», «Деловой фон.», «Всего.».
    const text =
      "Для банка или партнёра такие сюжеты обычно становятся первым поводом для расширенной проверки.";
    expect(clampClientText(text, 30)).toBe("Для банка или партнёра такие");
  });

  it("точка сохраняется, когда резали по границе предложения", () => {
    const text = "Первое предложение. Второе предложение длинное и не помещается.";
    expect(clampClientText(text, 30)).toBe("Первое предложение.");
  });

  it("keeps within-budget text untouched", () => {
    const text = "Полное предложение, которое помещается в бюджет.";
    expect(clampClientText(text, 200)).toBe(text);
  });
});

function baseSlide(overrides: Partial<SlideContentContract> = {}): SlideContentContract {
  return {
    schemaVersion: "slide-content-v1",
    slideId: "p10_ru_serp",
    baseSlotId: "p10_ru_serp",
    sectionId: "RU_PROFILE",
    isContinuation: false,
    continuationOf: null,
    continuationIndex: null,
    templateId: "serp-table",
    title: "Россия — позиции в поисковой выдаче",
    content: {},
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    ...overrides,
  } as SlideContentContract;
}

describe("withContinuations — narrative overflow flows to continuations (B.1b)", () => {
  it("splits an over-budget narrative into complete-sentence paragraphs across slides", () => {
    const sentence =
      "Публикации о налоговом расследовании видны на первой странице выдачи и влияют на решения банков и контрагентов при проверке субъекта. ";
    const narrative = sentence.repeat(
      Math.ceil((NARRATIVE_BUDGET * 2.2) / sentence.length)
    ).trim();
    expect(narrative.length).toBeGreaterThan(NARRATIVE_BUDGET);

    const slides = withContinuations(
      baseSlide({ content: { narrative, bullets: [] } }),
      "serp-table"
    );
    expect(slides.length).toBeGreaterThanOrEqual(2);
    expect(slides[0]!.isContinuation).toBe(false);
    for (const [i, s] of slides.entries()) {
      const n = s.content.narrative ?? "";
      expect(n.length, `slide ${i} narrative over budget`).toBeLessThanOrEqual(
        NARRATIVE_BUDGET
      );
      if (n) expect(n).toMatch(/[.!?…]$/u);
      if (i > 0) {
        expect(s.isContinuation).toBe(true);
        expect(s.continuationOf).toBe("p10_ru_serp");
      }
    }
    // The full meaning is preserved: recombined text covers the source.
    const recombined = slides.map((s) => s.content.narrative ?? "").join(" ");
    expect(recombined.replace(/\s+/gu, " ").length).toBeGreaterThanOrEqual(
      narrative.replace(/\s+/gu, " ").length * 0.95
    );
  });

  it("keeps a within-budget narrative on a single slide (no behavior change)", () => {
    const slides = withContinuations(
      baseSlide({ content: { narrative: "Короткий вывод по странице.", bullets: [] } }),
      "serp-table"
    );
    expect(slides).toHaveLength(1);
    expect(slides[0]!.content.narrative).toBe("Короткий вывод по странице.");
  });

  it("splitClientParagraphs never cuts mid-sentence", () => {
    const text =
      "Первое предложение о рисках. Второе предложение о проверках банков. Третье предложение о рекомендациях для субъекта.";
    const paras = splitClientParagraphs(text, 60, 4);
    for (const p of paras) expect(p).toMatch(/[.!?…]$/u);
  });
});
