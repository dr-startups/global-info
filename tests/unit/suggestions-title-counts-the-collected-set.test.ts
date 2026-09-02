/**
 * Вывод листа подсказок делается о собранном наборе, а не о том, что влезло
 * на картинку.
 *
 * Прогон 91, стр. 46: заголовок «Россия — подсказки Яндекса: негативных
 * формулировок нет» — при том, что в собранных 50 подсказках есть «умар
 * назарович кремлёв судимости», «кремлёв умар назарович биография криминал» и
 * «кремлёв умар назарович казино». Лист метрик того же отчёта (стр. 21) печатал
 * «Яндекс · Поисковые подсказки · 50 · негативных: 1». Два листа одного отчёта
 * отвечали на один вопрос по-разному.
 *
 * Панель показывает десять самых коротких строк набора, и все они нейтральны.
 * Решение владельца от 31.08.2026: **заголовок считает по набору**, а текст под
 * панелью отдельно говорит, что среди показанных негативной нет, — иначе
 * читатель ищет на картинке то, чего там нет.
 */

import { describe, expect, it } from "vitest";
import {
  panelCompositionLine,
  panelStatusLine,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { panelVerdictTitle } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/suggestions";

const NOUNS = { nounOne: "подсказка", nounFew: "подсказки", nounMany: "подсказок" } as const;
const TEN_NEUTRAL = { shown: 10, subject: 4, likely: 6, other: 0, unresolved: 0, adverse: 0, adverseOther: 0 };

describe("заголовок листа подсказок", () => {
  it("считает негатив по собранному набору, а не по панели", () => {
    // Форма прогона 91: панель нейтральна, в наборе одна негативная строка.
    expect(
      panelVerdictTitle({
        title: "Россия — подсказки Яндекса",
        shownCount: 10,
        shownAdverse: 0,
        collectedAdverse: 1,
      })
    ).toBe("Россия — подсказки Яндекса: 1 негативная формулировка");
  });

  it("чистый набор остаётся чистым заголовком", () => {
    expect(
      panelVerdictTitle({
        title: "Россия — подсказки Google",
        shownCount: 10,
        shownAdverse: 0,
        collectedAdverse: 0,
      })
    ).toBe("Россия — подсказки Google: негативных формулировок нет");
  });

  it("без единой показанной строки заголовок вывода не делает", () => {
    expect(
      panelVerdictTitle({ title: "Россия — подсказки", shownCount: 0, shownAdverse: 0, collectedAdverse: 1 })
    ).toBeUndefined();
  });
});

describe("текст под панелью не спорит с заголовком", () => {
  it("вывод о показанных строках называет и собранный набор", () => {
    const line = panelCompositionLine({
      composition: TEN_NEUTRAL as never,
      collected: 50,
      collectedAdverse: 1,
      ...NOUNS,
    });
    expect(line).toContain("среди показанных");
    expect(line).toContain("в собранном наборе — 1");
    // Голого «Негативных формулировок нет» на листе с негативом в наборе быть
    // не должно: заголовок говорит «1», и текст обязан объяснить, где она.
    expect(line).not.toMatch(/Негативных формулировок нет\.$/u);
  });

  it("чистый набор говорит прямо, без оговорок", () => {
    const line = panelCompositionLine({
      composition: TEN_NEUTRAL as never,
      collected: 50,
      collectedAdverse: 0,
      ...NOUNS,
    });
    expect(line).toContain("Негативных формулировок нет.");
    expect(line).not.toContain("в собранном наборе");
  });

  it("один факт печатается один раз: статусная строка набор не повторяет", () => {
    /*
     * Про собранный набор говорит `whatWasFound` — первый блок панели, который
     * есть на листе всегда. `statusNote` склеивается в блок, который узкая
     * панель выбрасывает первым (прогон 91, стр. 46), и повтор одного факта
     * тремя предложениями подряд читается как халтура.
     */
    const status = panelStatusLine({ shownAdverse: 0, collectedAdverse: 1, ...NOUNS });
    expect(status).toBe("Среди показанных строк негативных формулировок нет.");
    expect(status).not.toContain("в собранном наборе");
  });

  it("разрыв между заголовком и панелью объясняется и когда негатив на панели есть", () => {
    // Живая форма: часть негатива попала на панель, часть нет. Заголовок
    // считает пять, панель показывает два — и это обязано быть объяснено.
    const line = panelCompositionLine({
      composition: { ...TEN_NEUTRAL, adverse: 2 } as never,
      collected: 50,
      collectedAdverse: 5,
      ...NOUNS,
    });
    expect(line).toContain("С негативной формулировкой — 2.");
    expect(line).toContain("В собранном наборе — 5.");
  });

  it("когда весь негатив на панели, лишней оговорки нет", () => {
    const line = panelCompositionLine({
      composition: { ...TEN_NEUTRAL, adverse: 2 } as never,
      collected: 50,
      collectedAdverse: 2,
      ...NOUNS,
    });
    expect(line).toContain("С негативной формулировкой — 2.");
    expect(line).not.toContain("В собранном наборе");
  });
});
