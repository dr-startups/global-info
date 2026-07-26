import { describe, expect, it } from "vitest";
import {
  deterministicGateOf,
  isDeterministicPrepareGate,
  prepareGateAdvice,
  prepareGateFailureMessage,
} from "../../src/modules/digital-profile/services/prepare-gate-advice";

/**
 * Шаг 15, E1 (docs/rework/15-final-regression.md).
 *
 * Подготовка отчёта упала с `MATERIAL_THEME_COVERAGE=87.5`, прогон ушёл в
 * `FAILED_TERMINAL` с полностью собранными данными — и предложил кнопку
 * восстановления. Нажатие запустило бы ту же сборку над тем же набором и
 * получило бы тот же ответ.
 *
 * Кнопка, которая не может помочь, — ровно та жалоба, с которой начиналась
 * переработка.
 */

describe("гейты, которые повтор не лечит", () => {
  it("узнаёт гейт по имени в сообщении", () => {
    expect(deterministicGateOf("MATERIAL_THEME_COVERAGE=87.5")).toBe("MATERIAL_THEME_COVERAGE");
    expect(deterministicGateOf("P1_P2_ACCOUNTED=94")).toBe("P1_P2_ACCOUNTED");
    expect(deterministicGateOf("SEMANTIC_EXCERPT_TRUNCATIONS=3")).toBe(
      "SEMANTIC_EXCERPT_TRUNCATIONS"
    );
  });

  it("сетевые и рендер-отказы к ним не относятся", () => {
    // Их как раз лечит повтор, и кнопку предлагать нужно.
    expect(isDeterministicPrepareGate("RENDER_FAILED: renderer returned 502")).toBe(false);
    expect(isDeterministicPrepareGate("Provider returned HTTP 429")).toBe(false);
    expect(isDeterministicPrepareGate("")).toBe(false);
    expect(isDeterministicPrepareGate(null)).toBe(false);
  });

  it("упоминание имени гейта без значения гейтом не считается", () => {
    // Иначе рассказ об ошибке в тексте письма превратился бы в диагноз.
    expect(isDeterministicPrepareGate("см. описание MATERIAL_THEME_COVERAGE в документации")).toBe(
      false
    );
  });
});

describe("совет вместо приглашения нажать", () => {
  it("покрытие тем: называет действие, меняющее вход", () => {
    const advice = prepareGateAdvice("MATERIAL_THEME_COVERAGE=87.5");
    expect(advice).toMatch(/контекст-слова/u);
    expect(advice).toMatch(/повтор сборки это не изменит/iu);
  });

  it("каждый гейт объясняется своими словами", () => {
    const a = prepareGateAdvice("P1_P2_ACCOUNTED=94");
    const b = prepareGateAdvice("SEMANTIC_EXCERPT_TRUNCATIONS=3");
    expect(a).not.toBe(b);
    expect(a).toMatch(/ручной проверки/u);
    expect(b).toMatch(/цитат/u);
  });

  it("для не-гейта совета нет", () => {
    expect(prepareGateAdvice("RENDER_FAILED")).toBeNull();
  });

  it("сообщение объясняет и сохраняет код для диагностики", () => {
    const msg = prepareGateFailureMessage("MATERIAL_THEME_COVERAGE=87.5");
    expect(msg).toMatch(/^Тема повышенного внимания/u);
    expect(msg).toContain("(MATERIAL_THEME_COVERAGE=87.5)");
  });

  it("сообщение не-гейта остаётся прежним", () => {
    expect(prepareGateFailureMessage("RENDER_FAILED: 502")).toBe("RENDER_FAILED: 502");
  });
});
