/**
 * Перечисление источников печатается только тогда, когда есть что перечислять.
 *
 * В деке report-72 на двух страницах стояло:
 *
 *     …негативных заголовков — 0; преобладающие источники: .
 *
 * Двоеточие, пробел и точка — перечисление, из которого не осталось ни одного
 * названия. Условие проверяло `composition.topDomains` **до** отбора, а
 * печатался результат `clientSafeDomains(...)` **после** него: отбор убирает
 * «—» и демо-домены, и список схлопывался в пустую строку уже после того, как
 * решение «писать перечисление» было принято.
 *
 * Тот же класс, что и остальные правки этой ветки: проверяется одно,
 * печатается другое. Проверяем то, что уходит в деку.
 */

import { describe, expect, it } from "vitest";
import {
  pageRowCompositionBlocks,
  type PageRowComposition,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

const VIEW = {
  slideId: "p19_ru_knowledge_2",
  findings: [],
  // Поле вида называется `refs`, и подвал источников спрашивает именно его:
  // страница без единой ссылки и без доменов подвала не печатает вовсе.
  refs: [],
  domains: [],
} as unknown as Parameters<typeof pageRowCompositionBlocks>[1];

function composition(topDomains: string[]): PageRowComposition {
  return {
    shown: 3,
    subjectMatch: 0,
    likelySubject: 0,
    adverseHeadlines: 0,
    topDomains,
  };
}

/** Повисшее перечисление: двоеточие, за которым ничего нет. */
const DANGLING = /:\s*[.;]|:\s*$/u;

describe("перечисление источников печатается, только когда оно непустое", () => {
  it("домены, отсеянные отбором, не оставляют «источники: .»", () => {
    // Ровно наблюдавшийся случай: домены есть, но клиенту их называть нельзя.
    const out = pageRowCompositionBlocks(composition(["—", "demo.example", "mock.test-mock.ru"]), VIEW);
    expect(out.whatWasFound).toBeTruthy();
    expect(out.whatWasFound!).not.toMatch(DANGLING);
    expect(out.whatWasFound!).not.toContain("преобладающие источники");
  });

  it("пустой список доменов тоже не порождает перечисления", () => {
    const out = pageRowCompositionBlocks(composition([]), VIEW);
    expect(out.whatWasFound!).not.toMatch(DANGLING);
    expect(out.whatWasFound!).not.toContain("преобладающие источники");
  });

  it("уцелевшие после отбора домены называются", () => {
    const out = pageRowCompositionBlocks(
      composition(["kommersant.ru", "—", "demo.example"]),
      VIEW
    );
    expect(out.whatWasFound!).toContain("преобладающие источники: kommersant.ru");
    expect(out.whatWasFound!).not.toMatch(DANGLING);
    // Отсеянные не просачиваются в клиентский текст.
    expect(out.whatWasFound!).not.toContain("demo.example");
  });

  it("предложение в любом случае закончено точкой", () => {
    for (const domains of [[], ["—"], ["kommersant.ru"]]) {
      expect(pageRowCompositionBlocks(composition(domains), VIEW).whatWasFound!).toMatch(/\.$/u);
    }
  });
});
