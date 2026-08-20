/**
 * Клиентская шкала риска — три ступени, и уровень становится словом в одном месте.
 *
 * В данных уровней четыре (`none/low/medium/high/critical`), клиенту печатаются
 * три: низкий / средний / высокий. Четвёртой ступени в отчёте нет — слово
 * «критический» из клиентского документа уходит. «Требует подтверждения» на
 * шкалу не попадает: это статус идентификации, а не степень риска.
 *
 * Здесь закрепляется сам словарь границы: схлопывание, все словоформы, тон
 * бейджа, плашка вердикта и разбор текстов, собранных до шага.
 */

import { describe, expect, it } from "vitest";
import {
  CLIENT_RISK_LABELS,
  clientRiskStep,
  collapseLegacyRiskWord,
  legacyRiskWordPlate,
  riskLabel,
  riskLevelLabel,
  riskTone,
  riskWord,
  toneForRiskLabel,
  verdictClientLabel,
  verdictRiskWord,
} from "@/modules/digital-profile/orion-golden/client/risk-scale";

describe("схлопывание уровня данных в ступень печати", () => {
  it("критический и высокий печатаются одной ступенью", () => {
    expect(clientRiskStep("critical")).toBe("high");
    expect(clientRiskStep("high")).toBe("high");
    expect(riskLabel("critical")).toBe("Высокий");
    expect(riskLabel("high")).toBe("Высокий");
  });

  it("средний остаётся средним, низкий и «нет» — низким", () => {
    expect(clientRiskStep("medium")).toBe("medium");
    expect(clientRiskStep("low")).toBe("low");
    expect(clientRiskStep("none")).toBe("low");
    expect(riskLabel("medium")).toBe("Средний");
    expect(riskLabel("low")).toBe("Низкий");
    // Слово «Нет» на шкале не печатается: это была бы четвёртая ступень.
    expect(riskLabel("none")).toBe("Низкий");
  });

  it("ступеней ровно три", () => {
    expect(CLIENT_RISK_LABELS).toEqual(["Высокий", "Средний", "Низкий"]);
    expect(new Set(["critical", "high", "medium", "low", "none"].map(riskLabel)).size).toBe(3);
  });

  it("неизвестный уровень не печатается сырым токеном", () => {
    // Сырое эхо enum в клиентском поле — тоже неверный ответ, а не «почти тот же».
    expect(clientRiskStep("HIGH")).toBeNull();
    expect(clientRiskStep("мусор")).toBeNull();
    expect(riskLabel("HIGH")).toBe("Требует уточнения");
    expect(riskWord("мусор")).toBe("требует уточнения");
    expect(riskLevelLabel("")).toBe("Требует уточнения");
  });

  it("строчные формы согласованы с бейджем", () => {
    expect(riskWord("critical")).toBe("высокий");
    expect(riskWord("high")).toBe("высокий");
    expect(riskWord("medium")).toBe("средний");
    expect(riskWord("low")).toBe("низкий");
    expect(riskWord("none")).toBe("низкий");
    for (const level of ["critical", "high", "medium", "low", "none"]) {
      expect(riskLabel(level).toLowerCase()).toBe(riskWord(level));
      expect(riskLevelLabel(level)).toBe(`${riskLabel(level)} уровень`);
    }
  });

  it("тон бейджа задан ступенью", () => {
    expect(riskTone("critical")).toBe("danger");
    expect(riskTone("high")).toBe("danger");
    expect(riskTone("medium")).toBe("warn");
    expect(riskTone("low")).toBe("neutral");
    expect(riskTone("none")).toBe("neutral");
  });

  it("тон по уже напечатанному слову: статус не поднимается выше warn", () => {
    expect(toneForRiskLabel("Высокий")).toBe("danger");
    expect(toneForRiskLabel("Средний")).toBe("warn");
    expect(toneForRiskLabel("Низкий")).toBe("neutral");
    expect(toneForRiskLabel("Требует подтверждения")).toBe("warn");
    expect(toneForRiskLabel("Нет данных")).toBe("warn");
    expect(toneForRiskLabel("Критический")).toBe("warn");
  });
});

describe("плашка вердикта — та же шкала", () => {
  it("HIGH и ELEVATED печатаются одинаково", () => {
    expect(verdictClientLabel("HIGH")).toBe("Высокий риск");
    expect(verdictClientLabel("ELEVATED")).toBe("Высокий риск");
  });

  it("MIXED — «Средний риск», а не четвёртое слово шкалы", () => {
    expect(verdictClientLabel("MIXED")).toBe("Средний риск");
    expect(verdictClientLabel("LOW")).toBe("Низкий риск");
  });

  it("неизвестный вердикт не печатается сырым", () => {
    // То же правило, что для уровня: сырое эхо enum в клиентском поле — не
    // «почти та же ступень», а неверный ответ.
    expect(verdictClientLabel("UNKNOWN")).toBe("Требует уточнения");
    expect(verdictClientLabel("")).toBe("Требует уточнения");
  });

  it("INSUFFICIENT_DATA не превращается в ступень", () => {
    expect(verdictClientLabel("INSUFFICIENT_DATA")).toBe("Недостаточно данных");
    expect(verdictRiskWord("INSUFFICIENT_DATA")).toBeNull();
  });

  it("слово вердикта для модели — из тех же трёх", () => {
    expect(verdictRiskWord("HIGH")).toBe("высокий");
    expect(verdictRiskWord("CRITICAL")).toBe("высокий");
    expect(verdictRiskWord("ELEVATED")).toBe("высокий");
    expect(verdictRiskWord("MIXED")).toBe("средний");
    expect(verdictRiskWord("LOW")).toBe("низкий");
  });

  it("«Повышенный» и «Смешанный фон» шкала больше не производит", () => {
    const printed = ["HIGH", "CRITICAL", "ELEVATED", "MIXED", "MEDIUM", "LOW", "INSUFFICIENT_DATA"].map(
      verdictClientLabel
    );
    expect(printed.join(" ")).not.toMatch(/Повышенн|Смешанн|Критическ/i);
  });
});

describe("тексты, собранные до шага", () => {
  it("«критический» приводится к печатной ступени", () => {
    expect(collapseLegacyRiskWord("критический")).toBe("высокий");
    expect(collapseLegacyRiskWord("Критический")).toBe("высокий");
    expect(collapseLegacyRiskWord("высокий")).toBe("высокий");
    expect(collapseLegacyRiskWord("средний")).toBe("средний");
    expect(collapseLegacyRiskWord("низкий")).toBe("низкий");
  });

  it("плашка по старому слову — та же, что по вердикту", () => {
    expect(legacyRiskWordPlate("критический")).toBe("Высокий риск");
    expect(legacyRiskWordPlate("средний")).toBe("Средний риск");
    expect(legacyRiskWordPlate("нейтральный")).toBeNull();
  });

  it("чужое слово не переписывается", () => {
    expect(collapseLegacyRiskWord("нейтральный")).toBe("нейтральный");
  });
});
