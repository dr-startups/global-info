/**
 * Нарушения клиентского текста останавливают сборку (шаг 0144).
 *
 * Ворота 0139 видели нарушения и записывали их, но в список блокирующих не
 * входили: на прогоне Алекперова 21.09.2026 отчёт с шестью нарушениями ушёл
 * клиенту как есть, а `passed: false` остался строчкой в артефакте. Это ровно
 * та «лампочка вместо ворот», ради ухода от которой `blocking` и заведён.
 *
 * Порог тот же, что у остальных дефектов текста: один спорный блок — вопрос к
 * формулировке, три страницы и больше — вопрос к механизму.
 */

import { describe, expect, it } from "vitest";
import { blockingIssues } from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";

const empty = new Set<string>();

describe("порог системности для клиентского текста", () => {
  it("Б1: три задетые страницы останавливают сборку", () => {
    const out = blockingIssues({
      quoteDefectSlides: empty,
      codeSlides: empty,
      clientTextSlides: new Set(["p03_executive", "p05_dashboard", "p07_ru_summary"]),
    });
    expect(out.join(" ")).toMatch(/инварианты клиентского текста нарушены на 3 страницах/u);
  });

  it("Б2: две страницы записываются, но не блокируют", () => {
    const out = blockingIssues({
      quoteDefectSlides: empty,
      codeSlides: empty,
      clientTextSlides: new Set(["p03_executive", "p05_dashboard"]),
    });
    expect(out.join(" ")).not.toMatch(/инварианты клиентского текста/u);
  });

  it("Б3: без нарушений список блокирующих пуст", () => {
    expect(blockingIssues({ quoteDefectSlides: empty, codeSlides: empty })).toEqual([]);
  });
});
