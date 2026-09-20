/**
 * Инварианты клиентского текста проверяются на собранной деке (шаг 0139).
 *
 * Владелец 21.09.2026: «мне нужны системные правки, а не костыли. Почему так
 * много ошибок?»
 *
 * Дефекты не разного вида — они одного вида в новых местах. Ответ на вопрос
 * «как печатается чужой текст в кавычках» есть с начала (`quoteBody`), но
 * зовут его не все: шаг 0131 добавил его в список признаков, 0137 — в
 * основание рамки, а на стр. 6–7 отчёта Фридмана нашлось третье место.
 * Предикаты цитаты полностью зовёт только `resolveExampleQuote`; сюжет чтения
 * зовёт один из шести. Поверхность — двенадцать построителей на шесть полей,
 * и починка места её не уменьшает.
 *
 * Поэтому проверка смотрит не на построитель, а на **готовый документ**: по
 * каждому напечатанному полю каждого слайда. Построитель, забывший дверь,
 * падает здесь, а не доезжает до клиента.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientTextIssues } from "@/modules/digital-profile/orion-golden/deck-sections/client-text-invariants";

const DECK = join(
  process.cwd(),
  "baselines/report-72/artifacts/deck-sections/assembled-deck.json"
);

function slides(): unknown[] {
  return JSON.parse(readFileSync(DECK, "utf8")).slides ?? [];
}

describe("инварианты клиентского текста на собранной деке", () => {
  it("И1: эталон-72 их не нарушает", () => {
    expect(clientTextIssues(slides() as never)).toEqual([]);
  });

  it("И2: кавычка в кавычке ловится в любом поле", () => {
    const issues = clientTextIssues([
      { slideKey: "p03", title: "Кого проверяли", narrative: "признаки: ««Северсталь»»." },
    ] as never);
    expect(issues.join(" ")).toMatch(/p03/u);
    expect(issues.join(" ")).toMatch(/кавыч/iu);
  });

  it("И3: пробел внутри кавычек ловится", () => {
    const issues = clientTextIssues([
      { slideKey: "p26", bullets: ["«Президент клуба « Краснодар »» — источник (ru.wikipedia.org)"] },
    ] as never);
    expect(issues.join(" ")).toMatch(/p26/u);
  });

  it("И4: цитата, не являющаяся целой фразой, ловится", () => {
    const issues = clientTextIssues([
      { slideKey: "p06", bullets: ["«Абрамович Роман Аркадьевич» — источник (1sn.ru)"] },
    ] as never);
    expect(issues.join(" ")).toMatch(/p06/u);
    expect(issues.join(" ")).toMatch(/фраз/iu);
  });

  it("И5: блок темы без своих чисел ловится", () => {
    const issues = clientTextIssues([
      {
        slideKey: "p14",
        bullets: [
          "«Семья и деловые связи»\nНайдены материалы о семейных и деловых связях субъекта:\n«Фридман продал доли партнёру, чтобы выйти из-под санкций.» — источник (frankmedia.ru/193959)",
        ],
      },
    ] as never);
    expect(issues.join(" ")).toMatch(/p14/u);
    expect(issues.join(" ")).toMatch(/счёт|Всего по теме/iu);
  });

  it("И6: блок темы со строкой счёта не ловится", () => {
    const issues = clientTextIssues([
      {
        slideKey: "p17",
        bullets: [
          "«Семья и деловые связи»\nНайдены материалы о семейных и деловых связях субъекта:\n«Фридман продал доли партнёру, чтобы выйти из-под санкций.» — источник (frankmedia.ru/193959)\nВсего по теме: 6 материалов по России, с негативным контекстом — 4.",
        ],
      },
    ] as never);
    expect(issues).toEqual([]);
  });
});
