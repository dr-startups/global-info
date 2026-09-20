/**
 * Вывод панели говорится один раз, и пример предпочитает субъекта (шаг 0143).
 *
 * Стр. 35–36 отчёта Фридмана 20.09.2026: заголовок «Россия — подсказки
 * Яндекса: негативных формулировок нет» и строка состава, которая кончается
 * «Негативных формулировок нет.» Один вывод дважды на одном листе.
 *
 * Стр. 76: примерами «Делового профиля» в приложении выбраны две статьи про
 * **Милтона** Фридмана. Раздел честно помечен «принадлежность не разобрана»,
 * и однофамилец там уместен, но среди кандидатов был и материал, называющий
 * самого субъекта. При равном счёте предпочитается тот, кто совпал с именем
 * полнее.
 */

import { describe, expect, it } from "vitest";
import { panelCompositionLine } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { subjectNameMatchScore } from "@/modules/digital-profile/orion-golden/analytics/theme-quote";

const COMPOSITION = { shown: 5, subject: 1, likely: 0, other: 0, unresolved: 4, adverse: 0, adverseOther: 0 };

describe("вывод панели не повторяется", () => {
  it("П1: заголовок уже назвал вывод — строка состава его не повторяет", () => {
    const line = panelCompositionLine({
      composition: COMPOSITION,
      collected: 68,
      nounOne: "подсказка",
      nounFew: "подсказки",
      nounMany: "подсказок",
      verdictTitle: "Россия — подсказки Яндекса: негативных формулировок нет",
    } as never);
    expect(line).not.toMatch(/Негативных формулировок нет/u);
    expect(line).toMatch(/68/u);
  });

  it("П2: заголовок вывода не несёт — строка состава говорит его сама", () => {
    const line = panelCompositionLine({
      composition: COMPOSITION,
      collected: 68,
      nounOne: "подсказка",
      nounFew: "подсказки",
      nounMany: "подсказок",
    } as never);
    expect(line).toMatch(/Негативных формулировок нет/u);
  });
});

describe("пример предпочитает того, кто совпал с именем полнее", () => {
  it("П3: «Михаил Фридман» совпадает полнее, чем «Милтон Фридман»", () => {
    const stems = ["фридман", "михаил", "маратович"];
    const own = subjectNameMatchScore("Михаил Фридман — биография предпринимателя", stems);
    const namesake = subjectNameMatchScore("Милтон Фридман — биография, книги, отзывы", stems);
    expect(own).toBeGreaterThan(namesake);
  });

  it("П4: текст без имени совпадений не набирает", () => {
    expect(subjectNameMatchScore("Designation — UK Sanctions List", ["фридман"])).toBe(0);
  });
});
