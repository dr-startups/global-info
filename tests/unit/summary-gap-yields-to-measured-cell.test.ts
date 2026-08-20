import { describe, expect, it } from "vitest";
import { coverageDataGaps } from "@/modules/digital-profile/orion-golden/analytics/run-analytics-pipeline";

/**
 * Шаг AO. Сводка и слайды обязаны говорить одно.
 *
 * Замер живого прогона (Мордашов, 2026-08-19): `executive-summary.json`
 * печатал «ответы ИИ-поиска (RU/UAE): поверхность не собрана», при том что
 * слайд 55 показывал один собранный ответ ОАЭ. Причина — пробел печатался по
 * каждой ячейке NOT_COLLECTED без сверки с измеренными ячейками той же пары
 * «регион + поверхность-группа», а измеренная ячейка ОАЭ несла поверхность
 * `knowledge_block`, которую группировка к `ai_answers` не приводила.
 */

const cell = (region: string, surface: string, sampleStatus: "MEASURED" | "NOT_COLLECTED") => ({
  region,
  surface,
  sampleStatus,
});

describe("пробел покрытия в сводке гасится измеренной ячейкой", () => {
  it("измеренный ai_answer того же региона снимает пробел «ответы ИИ-поиска»", () => {
    const gaps = coverageDataGaps([
      cell("RU", "ai_answers", "NOT_COLLECTED"),
      cell("RU", "ai_answer", "MEASURED"),
    ]);
    expect(gaps).toEqual([]);
  });

  it("измеренный knowledge_block ОАЭ считается той же поверхностью, что ai_answers", () => {
    const gaps = coverageDataGaps([
      cell("UAE", "ai_answers", "NOT_COLLECTED"),
      cell("UAE", "knowledge_block", "MEASURED"),
    ]);
    expect(gaps).toEqual([]);
  });

  it("без измеренной ячейки пробел остаётся и назван клиентскими словами", () => {
    const gaps = coverageDataGaps([cell("RU", "ai_answers", "NOT_COLLECTED")]);
    expect(gaps).toEqual([
      { area: "ответы ИИ-поиска (RU)", detail: "поверхность не собрана в текущем прогоне" },
    ]);
  });

  it("измерение в другом регионе чужой пробел не гасит", () => {
    const gaps = coverageDataGaps([
      cell("RU", "ai_answers", "NOT_COLLECTED"),
      cell("UAE", "ai_answer", "MEASURED"),
    ]);
    expect(gaps.map((g) => g.area)).toEqual(["ответы ИИ-поиска (RU)"]);
  });

  it("одна поверхность региона называется один раз, сколько бы движков ни было", () => {
    const gaps = coverageDataGaps([
      cell("RU", "ai_answers", "NOT_COLLECTED"),
      cell("RU", "ai_answers", "NOT_COLLECTED"),
      cell("RU", "suggestions", "NOT_COLLECTED"),
    ]);
    expect(gaps.map((g) => g.area)).toEqual([
      "ответы ИИ-поиска (RU)",
      "поисковые подсказки (RU)",
    ]);
  });

  it("внутренний токен поверхности клиенту не печатается", () => {
    const gaps = coverageDataGaps([cell("MIXED", "ai_answer", "NOT_COLLECTED")]);
    expect(gaps).toEqual([
      { area: "ответы ИИ-поиска", detail: "поверхность не собрана в текущем прогоне" },
    ]);
  });
});
