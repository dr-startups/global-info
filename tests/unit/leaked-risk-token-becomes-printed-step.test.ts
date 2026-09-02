/**
 * Утёкший в текст токен уровня гуманизируется в печатную ступень.
 *
 * Санитайзер — последняя граница клиентского текста: он переводит сырые
 * `critical`/`high` в человеческие слова. Пока у него был собственный словарь,
 * он производил «Критический уровень» — четвёртую ступень, которой в отчёте
 * больше нет. Словарь берётся из клиентской шкалы, и «Критический» не
 * производит ни одна ветка.
 */

import { describe, expect, it } from "vitest";
import {
  humanizeRiskLevel,
  sanitizeOrionGoldenClientText,
} from "@/modules/digital-profile/orion-golden/client/client-text-sanitizer";

describe("гуманизация уровня риска", () => {
  it("critical и high дают одну и ту же ступень", () => {
    expect(humanizeRiskLevel("critical")).toBe("Высокий уровень");
    expect(humanizeRiskLevel("high")).toBe("Высокий уровень");
    expect(humanizeRiskLevel("критический")).toBe("Высокий уровень");
  });

  it("остальные ступени на месте", () => {
    expect(humanizeRiskLevel("medium")).toBe("Средний уровень");
    expect(humanizeRiskLevel("low")).toBe("Низкий уровень");
  });

  it("«Критический уровень» не производит ни одна ветка", () => {
    const produced = [
      "critical",
      "CRITICAL",
      "критический",
      "крит",
      "крайне высокий",
      "high",
      "medium",
      "low",
      "unknown",
      "",
    ].map(humanizeRiskLevel);
    expect(produced.join(" ")).not.toMatch(/критическ/i);
  });

  it("токен в свободном тексте заменяется печатной ступенью", () => {
    const out = sanitizeOrionGoldenClientText("Оценка темы: critical по итогам сверки.");
    expect(out).toContain("Высокий уровень");
    expect(out).not.toMatch(/критическ/i);
  });
});
