import { describe, expect, it } from "vitest";
import { googleAnswerProbeHints } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import type { SurfaceCollectionHint } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import { answerBoxItem } from "@/modules/digital-profile/providers/serper-surfaces";

function organic(region: string, engine: string) {
  return { surface: "organic", region, engine };
}

describe("статус поверхности ИИ-ответов", () => {
  it("регион с выдачей Google получает «проверено, пусто», а не «не собиралось»", () => {
    const hints = googleAnswerProbeHints([organic("RU", "GOOGLE"), organic("RU", "YANDEX")], []);
    expect(hints).toEqual([
      { surface: "ai_answers", region: "RU", status: "NO_RESULTS", errorCode: null, provider: "GOOGLE" },
    ]);
  });

  it("регион, где ИИ-ответ собран, подсказки не получает", () => {
    const hints = googleAnswerProbeHints(
      [organic("UAE", "GOOGLE"), { surface: "ai_answers", region: "UAE", engine: "GOOGLE" }],
      []
    );
    expect(hints).toEqual([]);
  });

  it("регион без выдачи Google остаётся непроверенным", () => {
    // Яндекс готовых ответов через API не отдаёт: заявлять «проверено» нечем.
    expect(googleAnswerProbeHints([organic("RU", "YANDEX")], [])).toEqual([]);
  });

  it("известный отказ сбора сильнее выведенной подсказки", () => {
    const existing: SurfaceCollectionHint[] = [
      { surface: "ai_answers", region: "RU", status: "FAILED", errorCode: "429" },
    ];
    expect(googleAnswerProbeHints([organic("RU", "GOOGLE")], existing)).toEqual([]);
  });

  it("несколько регионов перечисляются в устойчивом порядке", () => {
    const hints = googleAnswerProbeHints(
      [organic("UAE", "GOOGLE"), organic("RU", "SERPER")],
      []
    );
    expect(hints.map((h) => h.region)).toEqual(["RU", "UAE"]);
  });
});

describe("готовый ответ Google", () => {
  const ctx = {
    query: "сулейман керимов",
    region: "RU" as const,
    language: "ru",
    capturedAt: "2026-08-14T10:00:00.000Z",
  };

  it("становится материалом поверхности ИИ-ответов", () => {
    const item = answerBoxItem(
      {
        title: "Сулейман Керимов",
        answer: "Российский предприниматель и политик, сенатор от Дагестана.",
        link: "https://ru.wikipedia.org/wiki/Керимов,_Сулейман_Абусаидович",
      },
      ctx
    );
    expect(item?.kind).toBe("knowledgePanel");
    expect(item?.snippet).toContain("предприниматель");
    expect(item?.domain).toBe("ru.wikipedia.org");
    expect((item?.rawMetadataSafe as Record<string, unknown>).surface).toBe("answerBox");
  });

  it("берёт текст из snippet, когда поля answer нет", () => {
    expect(answerBoxItem({ snippet: "Краткая справка о субъекте." }, ctx)?.snippet).toBe(
      "Краткая справка о субъекте."
    );
  });

  it("пустой блок материалом не становится", () => {
    expect(answerBoxItem({}, ctx)).toBeNull();
    expect(answerBoxItem({ title: "Заголовок без ответа" }, ctx)).toBeNull();
    expect(answerBoxItem(undefined, ctx)).toBeNull();
  });
});
