import { describe, it, expect } from "vitest";
import {
  normalizeForQuoteMatch,
  verifyExtractedFact,
  verifyExtractedFacts,
  FACT_QUOTE_MIN_CHARS,
  FACT_QUOTE_MAX_CHARS,
  type ExtractedFact,
  type FactSourceMaterial,
} from "../../src/modules/digital-profile/orion-golden/gpt/fact-extraction";

/**
 * Шаг 05.2(б) плана.
 *
 * Модель формулирует утверждение и обязана подкрепить его дословной цитатой;
 * код находит цитату в материале или отбрасывает утверждение. Атрибуция
 * (домен, ссылка, дата) берётся из наших записей, а не из ответа модели.
 */

const MATERIAL: FactSourceMaterial = {
  ref: "e1",
  evidenceRef: "inventory:obs-1",
  title: "Основатель Telegram задержан во Франции",
  snippet:
    "Павел Дуров был задержан в аэропорту Ле-Бурже 24 августа 2024 года. " +
    "Следствие связывает задержание с модерацией контента в мессенджере.",
  domain: "forbesmiddleeast.com",
  url: "https://forbesmiddleeast.com/x",
  publishedAt: "2024-08-25",
};

function fact(over: Partial<ExtractedFact> = {}): ExtractedFact {
  return {
    statement: "Источник сообщает о задержании основателя Telegram во Франции.",
    quote: "задержан в аэропорту Ле-Бурже 24 августа 2024 года",
    ref: "e1",
    status: "source_allegation",
    ...over,
  };
}

const verifyOne = (f: ExtractedFact, materials: FactSourceMaterial[] = [MATERIAL]) =>
  verifyExtractedFact({
    fact: f,
    materialsByRef: new Map(materials.map((m) => [m.ref, m])),
    seenQuotes: new Set<string>(),
  });

describe("normalizeForQuoteMatch", () => {
  it("сводит типографику к сопоставимому виду", () => {
    expect(normalizeForQuoteMatch("«Текст» — вот")).toBe('"текст" - вот');
    expect(normalizeForQuoteMatch("а  \n\t б")).toBe("а б");
    expect(normalizeForQuoteMatch("не разрывный")).toBe("не разрывный");
    expect(normalizeForQuoteMatch("текст…")).toBe("текст...");
  });

  it("не выбрасывает значащие символы", () => {
    expect(normalizeForQuoteMatch("сумма 10 млн $")).toBe("сумма 10 млн $");
  });
});

describe("верификация цитаты", () => {
  it("принимает утверждение с дословной цитатой", () => {
    const res = verifyOne(fact());
    expect(res.accepted).toBe(true);
    if (!res.accepted) return;
    expect(res.fact.statement).toBe(
      "Источник сообщает о задержании основателя Telegram во Франции."
    );
    expect(res.fact.status).toBe("source_allegation");
  });

  it("подставляет атрибуцию из наших записей, а не из ответа модели", () => {
    const res = verifyOne(fact());
    expect(res.accepted).toBe(true);
    if (!res.accepted) return;
    expect(res.fact.evidenceRef).toBe("inventory:obs-1");
    expect(res.fact.sourceDomain).toBe("forbesmiddleeast.com");
    expect(res.fact.sourceUrl).toBe("https://forbesmiddleeast.com/x");
    expect(res.fact.publishedAt).toBe("2024-08-25");
  });

  it("принимает цитату, отличающуюся только типографикой", () => {
    const res = verifyOne(
      fact({ quote: "задержан  в  аэропорту Ле‑Бурже 24 августа 2024 года" })
    );
    expect(res.accepted).toBe(true);
  });

  it("находит цитату в заголовке, а не только в сниппете", () => {
    const res = verifyOne(fact({ quote: "Основатель Telegram задержан во Франции" }));
    expect(res.accepted).toBe(true);
  });

  it("отбрасывает перефразированную цитату", () => {
    const res = verifyOne(
      fact({ quote: "его задержали в парижском аэропорту в конце августа" })
    );
    expect(res.accepted).toBe(false);
    if (res.accepted) return;
    expect(res.reason).toBe("quote-not-in-material");
  });

  it("отбрасывает цитату, склеенную из разных кусков", () => {
    const res = verifyOne(
      fact({ quote: "задержан в аэропорту Ле-Бурже ... модерацией контента" })
    );
    expect(res.accepted).toBe(false);
    if (res.accepted) return;
    expect(res.reason).toBe("quote-not-in-material");
  });

  it("отбрасывает слишком короткую цитату", () => {
    const res = verifyOne(fact({ quote: "Павел Дуров" }));
    expect(res.accepted).toBe(false);
    if (res.accepted) return;
    expect(res.reason).toBe("quote-too-short");
  });

  it("отбрасывает цитату короче минимума по числу слов", () => {
    // Длиннее FACT_QUOTE_MIN_CHARS, но это одно длинное слово.
    const res = verifyOne(fact({ quote: "а".repeat(FACT_QUOTE_MIN_CHARS + 5) }));
    expect(res.accepted).toBe(false);
    if (res.accepted) return;
    expect(res.reason).toBe("quote-too-short");
  });

  it("отбрасывает цитату, вылезающую за верхний предел", () => {
    const long = `${MATERIAL.snippet} ${"хвост ".repeat(60)}`;
    const res = verifyOne(fact({ quote: long.slice(0, FACT_QUOTE_MAX_CHARS + 10) }));
    expect(res.accepted).toBe(false);
    if (res.accepted) return;
    expect(res.reason).toBe("quote-too-long");
  });

  it("отбрасывает ссылку на несуществующий материал", () => {
    const res = verifyOne(fact({ ref: "e99" }));
    expect(res.accepted).toBe(false);
    if (res.accepted) return;
    expect(res.reason).toBe("unknown-ref");
  });

  it("отбрасывает пустое утверждение", () => {
    const res = verifyOne(fact({ statement: "   " }));
    expect(res.accepted).toBe(false);
    if (res.accepted) return;
    expect(res.reason).toBe("empty-statement");
  });

  it("не принимает цитату из чужого материала", () => {
    const other: FactSourceMaterial = {
      ref: "e2",
      evidenceRef: "inventory:obs-2",
      title: "Совсем другая новость",
      snippet: "Ничего общего с задержанием.",
    };
    const res = verifyOne(fact({ ref: "e2" }), [MATERIAL, other]);
    expect(res.accepted).toBe(false);
    if (res.accepted) return;
    expect(res.reason).toBe("quote-not-in-material");
  });
});

describe("verifyExtractedFacts", () => {
  it("отбрасывает повторную продажу той же цитаты как отдельного вывода", () => {
    const out = verifyExtractedFacts({
      facts: [
        fact(),
        fact({ statement: "Другая формулировка того же самого." }),
      ],
      materials: [MATERIAL],
    });
    expect(out.accepted).toHaveLength(1);
    expect(out.rejected).toHaveLength(1);
    expect(out.rejected[0].reason).toBe("duplicate-quote");
    expect(out.rejectedByReason["duplicate-quote"]).toBe(1);
  });

  it("сохраняет порядок принятых утверждений и считает причины отказов", () => {
    const out = verifyExtractedFacts({
      facts: [
        fact({ statement: "Первое.", quote: "Основатель Telegram задержан во Франции" }),
        fact({ statement: "Мимо.", quote: "выдуманная цитата которой нет в тексте" }),
        fact({ statement: "Второе.", quote: "Следствие связывает задержание с модерацией" }),
      ],
      materials: [MATERIAL],
    });
    expect(out.accepted.map((f) => f.statement)).toEqual(["Первое.", "Второе."]);
    expect(out.rejectedByReason).toEqual({ "quote-not-in-material": 1 });
  });

  it("на пустом входе возвращает пустой результат без ошибок", () => {
    const out = verifyExtractedFacts({ facts: [], materials: [] });
    expect(out).toEqual({ accepted: [], rejected: [], rejectedByReason: {} });
  });
});

describe("тема факта (шаг 06.2)", () => {
  const ALLOWED = new Set(["criminal_judicial", "business_ownership_associates"]);

  const verifyWithThemes = (f: ExtractedFact) =>
    verifyExtractedFact({
      fact: f,
      materialsByRef: new Map([[MATERIAL.ref, MATERIAL]]),
      seenQuotes: new Set<string>(),
      allowedThemes: ALLOWED,
    });

  it("сохраняет тему, выбранную моделью, если она из таксономии", () => {
    const res = verifyWithThemes(fact({ theme: "business_ownership_associates" }));
    expect(res.accepted).toBe(true);
    if (!res.accepted) return;
    expect(res.fact.themeId).toBe("business_ownership_associates");
  });

  it("игнорирует тему вне таксономии, не отбрасывая сам факт", () => {
    const res = verifyWithThemes(fact({ theme: "выдуманная_тема" }));
    expect(res.accepted).toBe(true);
    if (!res.accepted) return;
    expect(res.fact.themeId).toBeUndefined();
  });

  it("не требует темы: факт без неё остаётся валидным", () => {
    const res = verifyWithThemes(fact());
    expect(res.accepted).toBe(true);
    if (!res.accepted) return;
    expect(res.fact.themeId).toBeUndefined();
  });
});
