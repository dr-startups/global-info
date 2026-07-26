import { describe, it, expect } from "vitest";
import {
  buildSectionAnalysisPayload,
  truncateText,
  SECTION_PAYLOAD_LIMITS,
} from "../../src/modules/digital-profile/orion-golden/gpt/section-analysis-payload";
import type {
  EvidenceDecisionRecord,
  SectionEvidencePack,
} from "../../src/modules/digital-profile/orion-golden/types";

/**
 * Шаг 05.1 плана.
 *
 * До исправления модель получала только title/domain/relevance/humanReason —
 * сниппеты, URL, регион и риск-сигналы лежали в EvidenceDecisionRecord и
 * отбрасывались, поэтому писать конкретику было не из чего.
 */

function record(over: Partial<EvidenceDecisionRecord> = {}): EvidenceDecisionRecord {
  return {
    inventoryId: "obs-secret-internal-id",
    normalizedTitle: "Заголовок материала",
    normalizedSnippet: "Компания привлекла 10 млн долларов от фонда в Дубае.",
    domain: "example.com",
    canonicalUrl: "https://example.com/a",
    language: "ru",
    region: "RU",
    evidenceType: "ORGANIC",
    entityMatchScore: 0.874,
    relevanceClass: "strong_relevant",
    riskTheme: "offshore_financial_transparency",
    riskLevel: "medium",
    confidence: 0.8,
    includeInClientReport: true,
    includeInAppendix: false,
    humanReason: "Материал прямо называет проверяемое лицо.",
    ...over,
  };
}

function pack(records: EvidenceDecisionRecord[], over: Partial<SectionEvidencePack> = {}) {
  return {
    sectionKey: "ru_search_results",
    totalInSection: records.length,
    selectedCount: records.length,
    excludedCount: 0,
    displayBudget: 10,
    selectedForDisplay: records,
    selectedForAnalysis: records,
    excluded: [],
    metrics: { total: records.length },
    warnings: [],
    ...over,
  } as unknown as SectionEvidencePack;
}

const build = (p: SectionEvidencePack | undefined) =>
  buildSectionAnalysisPayload({
    sectionKey: "ru_search_results",
    clientTitle: "Россия — результаты поиска",
    subjectName: "Иван Петров",
    pack: p,
  });

describe("section analysis payload", () => {
  it("передаёт модели сниппет, URL, регион и риск-сигналы", () => {
    const [item] = build(pack([record()])).selectedEvidence;
    expect(item.snippet).toBe("Компания привлекла 10 млн долларов от фонда в Дубае.");
    expect(item.url).toBe("https://example.com/a");
    expect(item.domain).toBe("example.com");
    expect(item.region).toBe("RU");
    expect(item.sourceType).toBe("ORGANIC");
    expect(item.riskTheme).toBe("offshore_financial_transparency");
    expect(item.riskLevel).toBe("medium");
    expect(item.relevance).toBe("strong_relevant");
  });

  it("округляет score совпадения и не тащит внутренние идентификаторы", () => {
    const payload = build(pack([record()]));
    const [item] = payload.selectedEvidence;
    expect(item.entityMatchScore).toBe(0.87);
    expect(item.ref).toBe("e1");
    expect(JSON.stringify(payload)).not.toContain("obs-secret-internal-id");
    expect(JSON.stringify(payload)).not.toContain("inventoryId");
  });

  it("обрезает длинный сниппет и помечает обрезку", () => {
    const long = "слово ".repeat(400);
    const [item] = build(pack([record({ normalizedSnippet: long })])).selectedEvidence;
    expect(item.snippet!.length).toBeLessThanOrEqual(SECTION_PAYLOAD_LIMITS.snippetChars + 1);
    expect(item.snippetTruncated).toBe(true);
    expect(item.snippet!.endsWith("…")).toBe(true);
  });

  it("не выставляет флаг обрезки для короткого сниппета", () => {
    const [item] = build(pack([record({ normalizedSnippet: "Короткий текст." })])).selectedEvidence;
    expect(item.snippetTruncated).toBeUndefined();
  });

  it("опускает пустые поля вместо передачи пустых строк", () => {
    const [item] = build(
      pack([record({ normalizedSnippet: "   ", domain: "", canonicalUrl: undefined, riskTheme: "" })])
    ).selectedEvidence;
    expect(item).not.toHaveProperty("snippet");
    expect(item).not.toHaveProperty("domain");
    expect(item).not.toHaveProperty("url");
    expect(item).not.toHaveProperty("riskTheme");
  });

  it("соблюдает символьный бюджет, отбрасывая слабые материалы первыми", () => {
    const filler = "текст ".repeat(80);
    const strong = record({
      normalizedTitle: "СИЛЬНЫЙ",
      normalizedSnippet: filler,
      relevanceClass: "strong_relevant",
      entityMatchScore: 0.95,
    });
    const weak = record({
      normalizedTitle: "СЛАБЫЙ",
      normalizedSnippet: filler,
      relevanceClass: "weak_match",
      riskTheme: undefined,
      entityMatchScore: 0.1,
    });
    const records = [...Array(20).fill(weak), ...Array(20).fill(strong)];

    const payload = build(pack(records));
    const serialised = JSON.stringify(payload.selectedEvidence).length;

    expect(serialised).toBeLessThanOrEqual(SECTION_PAYLOAD_LIMITS.totalEvidenceChars);
    expect(payload.evidenceOmitted).toBeGreaterThan(0);
    const kept = payload.selectedEvidence.map((e) => e.title);
    expect(kept.filter((t) => t === "СИЛЬНЫЙ").length).toBeGreaterThan(
      kept.filter((t) => t === "СЛАБЫЙ").length
    );
  });

  it("не выставляет evidenceOmitted, когда всё поместилось", () => {
    expect(build(pack([record()])).evidenceOmitted).toBeUndefined();
  });

  it("ограничивает число анализируемых и исключённых материалов", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      record({ normalizedTitle: `T${i}`, normalizedSnippet: "коротко" })
    );
    const payload = build(pack(many, { excluded: many, excludedCount: many.length }));
    expect(payload.selectedEvidence.length).toBeLessThanOrEqual(SECTION_PAYLOAD_LIMITS.maxSelected);
    expect(payload.excludedSummary.length).toBe(SECTION_PAYLOAD_LIMITS.maxExcluded);
  });

  it("переживает отсутствующий pack — секция без данных всё равно анализируется", () => {
    const payload = build(undefined);
    expect(payload.selectedEvidence).toEqual([]);
    expect(payload.excludedSummary).toEqual([]);
    expect(payload.metrics).toEqual({});
    expect(payload.subjectName).toBe("Иван Петров");
  });

  it("сохраняет причину исключения для отброшенных материалов", () => {
    const excluded = record({ normalizedTitle: "Шум", exclusionReason: "другой субъект" });
    const payload = build(pack([], { excluded: [excluded], excludedCount: 1 }));
    expect(payload.excludedSummary).toEqual([{ title: "Шум", reason: "другой субъект" }]);
  });
});

describe("truncateText", () => {
  it("не трогает текст в пределах лимита", () => {
    expect(truncateText("коротко", 50)).toEqual({ text: "коротко", truncated: false });
  });

  it("схлопывает пробельные последовательности", () => {
    expect(truncateText("а  \n б", 50).text).toBe("а б");
  });

  it("режет по границе слова, когда она в пределах последних 15% бюджета", () => {
    // Пробел на позиции 18 из бюджета 20 — это 90%, границу соблюдаем.
    const { text, truncated } = truncateText("аааааааааааааааааа бб", 20);
    expect(truncated).toBe(true);
    expect(text).toBe("аааааааааааааааааа…");
  });

  it("режет жёстко, когда ближайшая граница слова слишком далеко", () => {
    // Пробел на позиции 4 из бюджета 20 — обрезка по нему съела бы 80% текста.
    const { text } = truncateText("аааа ббббббббббббббббббббб", 20);
    expect(text).toBe("аааа ббббббббббббббб…");
  });

  it("режет текст без пробелов ровно по бюджету", () => {
    const { text } = truncateText("а".repeat(50), 10);
    expect(text).toBe(`${"а".repeat(10)}…`);
  });
});
