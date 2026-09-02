import { describe, expect, it } from "vitest";
import {
  riskLevelPromptLine,
  riskWordForVerdict,
  withDeterministicRiskLevel,
} from "../../src/modules/digital-profile/orion-golden/gpt/case-verdict";
import {
  caseAnalysisSystemPrompt,
  finalizeGptCaseAnalysis,
} from "../../src/modules/digital-profile/orion-golden/gpt/gpt-case-analysis";

/**
 * Шаг 07.9 / 07.4.
 *
 * Страница «Резюме» одновременно содержала плашку «Итоговая оценка: Высокий
 * риск» и текст «…но итоговая оценка критическая». Плашку считала аналитика,
 * текст писала модель, которую промпт прямо просил вернуть свой уровень.
 * Клиент видит два вердикта об одном человеке на одном слайде.
 */

const MODEL_ANSWER = {
  overallRiskLevel: "критический",
  executiveConclusion: "Профиль широко узнаваем, тон проверке задают судебные публикации.",
  digitalPortrait: "Публичное лицо технологического сектора.",
  keyRisks: [
    {
      theme: "Судебные материалы",
      severity: "высокий",
      explanation: "Публикации о предъявленных обвинениях требуют сверки первоисточников.",
      advice: "Запросить процессуальные документы и позицию защиты.",
    },
  ],
  positiveSignals: ["Подтверждённая деловая биография."],
  recommendations: ["Сверить первоисточники по судебной теме."],
};

describe("вердикт аналитики — единственный", () => {
  it("вердикты шкалы отображаются в слова уровня", () => {
    expect(riskWordForVerdict("HIGH")).toBe("высокий");
    expect(riskWordForVerdict("critical")).toBe("высокий");
    expect(riskWordForVerdict("ELEVATED")).toBe("высокий");
    expect(riskWordForVerdict("LOW")).toBe("низкий");
  });

  it("смешанный фон — середина шкалы, а не отдельная ступень", () => {
    expect(riskWordForVerdict("MIXED")).toBe("средний");
  });

  it("«недостаточно данных» уровнем риска не становится", () => {
    // Это не «низкий риск», и подменять одно другим значит успокаивать читателя
    // там, где проверка не дала ответа.
    expect(riskWordForVerdict("INSUFFICIENT_DATA")).toBeNull();
    expect(riskWordForVerdict("")).toBeNull();
    expect(riskWordForVerdict(null)).toBeNull();
    expect(riskWordForVerdict("НЕЧТО")).toBeNull();
  });
});

describe("ответ модели приводится к вердикту аналитики", () => {
  it("несогласный уровень заменяется", () => {
    const out = withDeterministicRiskLevel({ overallRiskLevel: "критический" }, "HIGH");
    expect(out.overallRiskLevel).toBe("высокий");
  });

  it("согласный уровень оставляет объект прежним", () => {
    const input = { overallRiskLevel: "высокий" };
    expect(withDeterministicRiskLevel(input, "HIGH")).toBe(input);
  });

  it("без вердикта аналитики ответ модели не трогается", () => {
    const input = { overallRiskLevel: "критический" };
    expect(withDeterministicRiskLevel(input, "INSUFFICIENT_DATA")).toBe(input);
  });

  it("разбор ответа применяет вердикт", () => {
    // Промпт — не гарантия, поэтому проверяется именно результат разбора.
    const parsed = finalizeGptCaseAnalysis(MODEL_ANSWER, undefined, "HIGH");
    expect(parsed?.overallRiskLevel).toBe("высокий");
  });

  it("без вердикта остаётся слово модели, приведённое к печатной шкале", () => {
    expect(finalizeGptCaseAnalysis(MODEL_ANSWER)?.overallRiskLevel).toBe("высокий");
  });
});

describe("промпт сообщает модели готовый уровень", () => {
  it("называет уровень и запрещает его пересматривать", () => {
    const line = riskLevelPromptLine("HIGH");
    expect(line).toContain("«высокий»");
    expect(line).toMatch(/не пересматривай/iu);
  });

  it("без вердикта промпт остаётся прежним", () => {
    expect(riskLevelPromptLine("INSUFFICIENT_DATA")).toBeNull();
    expect(caseAnalysisSystemPrompt(null)).toBe(caseAnalysisSystemPrompt(undefined));
  });

  it("строка добавляется к системному промпту, а не заменяет его", () => {
    const withVerdict = caseAnalysisSystemPrompt("CRITICAL");
    expect(withVerdict).toContain("старший аналитик reputational due diligence");
    expect(withVerdict).toContain("«высокий»");
  });
});
