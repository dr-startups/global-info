/**
 * Страница выдачи говорит, что адреса у строк нет (шаг 0132).
 *
 * Стр. 20 отчёта Мордашова 20.09.2026, строка 1:
 * `ru.wikipedia.org/wiki/Мордашов,_Алексей_Александрович` — «Нежелательный».
 * Стр. 22, строка 1: `ru.wikipedia.org` — «Нейтральный». Читатель видит одну
 * Википедию с двумя оценками.
 *
 * Причина у обеих половин одна и та же, что и у шага 0129: Topvisor по Google
 * не отдаёт адрес страницы. «Нейтральный» такая строка получала потому, что
 * витрину сайта **прочитали** — после 0129 её не читают, и оценка становится
 * «Не проверено» сама. Здесь это закрепляется тестом и объясняется читателю:
 * молча показывать домен вместо адреса нельзя, он подумает на нас.
 */

import { describe, expect, it } from "vitest";
import {
  serpTablePageProse,
  serpVerdictLabel,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";

describe("строка без адреса страницы", () => {
  it("О1: непрочитанная строка не бывает «Нейтральной»", () => {
    expect(
      serpVerdictLabel({
        other: false,
        adverse: false,
        likely: false,
        verified: false,
        unconfirmed: false,
        confirmed: false,
      })
    ).toBe("Не проверено");
  });

  it("О2: страница называет, что адрес не отдан, и что в колонке домен", () => {
    const prose = serpTablePageProse({
      engineLabel: "Google",
      query: "Мордашов Алексей Александрович",
      printedRanks: [1, 2, 3],
      collectedRanks: [1, 2, 3],
      positional: true,
      freshness: null,
      addresslessRows: 3,
      printedRows: 3,
    } as never);
    expect(prose.head).toMatch(/адрес/iu);
    expect(prose.head).toContain("домен");
  });

  it("О3: когда адреса есть у всех строк, оговорки нет", () => {
    const prose = serpTablePageProse({
      engineLabel: "Яндекса",
      query: "Мордашов Алексей Александрович",
      printedRanks: [1, 2, 3],
      collectedRanks: [1, 2, 3],
      positional: true,
      freshness: null,
      addresslessRows: 0,
      printedRows: 3,
    } as never);
    expect(prose.head).not.toMatch(/адрес страницы/iu);
  });
});
