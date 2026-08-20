/**
 * Словарь риска в контуре модели — три слова, но приём остаётся широким.
 *
 * Модель эхом возвращает слова своего входа, поэтому словарь полезной нагрузки
 * и промпта становится словарём отчёта: пока в нём стояло «критический», оно
 * приезжало в клиентский текст. Промпты предлагают три ступени.
 *
 * Сузить при этом словарь **приёма** нельзя: модель, по привычке ответившая
 * «критический», уронила бы валидацию — и секция молча потеряла бы GPT-копию.
 * Схема принимает старое слово и нормализует его.
 */

import { describe, expect, it } from "vitest";
import { riskLevelRu } from "@/modules/digital-profile/orion-golden/gpt/client-payload-labels";
import {
  CASE_ANALYSIS_SYSTEM_PROMPT,
  caseAnalysisSystemPrompt,
  finalizeGptCaseAnalysis,
} from "@/modules/digital-profile/orion-golden/gpt/gpt-case-analysis";
import {
  GPT_STAGE1_MAP_SYSTEM_PROMPT,
  GPT_STAGE1_REDUCE_SYSTEM_PROMPT,
} from "@/modules/digital-profile/orion-golden/gpt/gpt-case-analysis-mapreduce";
import { withDeterministicRiskLevel } from "@/modules/digital-profile/orion-golden/gpt/case-verdict";

const MODEL_ANSWER = {
  overallRiskLevel: "критический",
  executiveConclusion: "Профиль широко узнаваем, тон проверке задают судебные публикации.",
  keyRisks: [
    {
      theme: "Судебные материалы",
      severity: "критический",
      explanation: "Публикации о предъявленных обвинениях требуют сверки первоисточников.",
      advice: "Запросить процессуальные документы и позицию защиты.",
    },
  ],
  positiveSignals: ["Подтверждённая деловая биография."],
  recommendations: ["Сверить первоисточники по судебной теме."],
};

describe("полезная нагрузка модели", () => {
  it("уровень находки называется одной из трёх ступеней", () => {
    expect(riskLevelRu("critical")).toBe("высокий");
    expect(riskLevelRu("high")).toBe("высокий");
    expect(riskLevelRu("medium")).toBe("средний");
    expect(riskLevelRu("low")).toBe("низкий");
    expect(riskLevelRu("none")).toBe("низкий");
  });

  it("сырое эхо enum ступенью не становится", () => {
    expect(riskLevelRu("HIGH")).toBe("требует уточнения");
    expect(riskLevelRu("adverse")).toBe("требует уточнения");
  });
});

describe("ответ модели со старым словом", () => {
  it("проходит схему и нормализуется — секция не отбрасывается", () => {
    const reasons: string[] = [];
    const parsed = finalizeGptCaseAnalysis(MODEL_ANSWER, (r) => reasons.push(r));
    expect(reasons).toEqual([]);
    expect(parsed).not.toBeNull();
    expect(parsed!.keyRisks).toHaveLength(1);
    expect(parsed!.keyRisks[0]!.severity).toBe("высокий");
    expect(parsed!.overallRiskLevel).toBe("высокий");
  });

  it("вердикт аналитики навязывает слово только из трёх", () => {
    expect(withDeterministicRiskLevel({ overallRiskLevel: "критический" }, "CRITICAL")).toEqual({
      overallRiskLevel: "высокий",
    });
    expect(withDeterministicRiskLevel({ overallRiskLevel: "низкий" }, "MIXED")).toEqual({
      overallRiskLevel: "средний",
    });
  });
});

describe("промпты предлагают три ступени", () => {
  it("одиночный анализ", () => {
    expect(CASE_ANALYSIS_SYSTEM_PROMPT).not.toMatch(/критическ/i);
    expect(CASE_ANALYSIS_SYSTEM_PROMPT).toContain("низкий|средний|высокий");
  });

  it("строка вычисленного уровня", () => {
    expect(caseAnalysisSystemPrompt("CRITICAL")).not.toMatch(/критическ/i);
    expect(caseAnalysisSystemPrompt("CRITICAL")).toContain("«высокий»");
  });

  it("map и reduce", () => {
    expect(GPT_STAGE1_MAP_SYSTEM_PROMPT).not.toMatch(/критическ/i);
    expect(GPT_STAGE1_REDUCE_SYSTEM_PROMPT).not.toMatch(/критическ/i);
  });
});
