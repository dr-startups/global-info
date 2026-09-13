/**
 * Предложение не режется внутри кавычек.
 *
 * QA MVP 14.09.2026 («Галицкий»): `ASSEMBLY_QA_FAILED: цитаты разорваны на 3
 * страницах: p03_executive__cont1, p03_executive__cont2,
 * appendix_main_base__cont1`. Сюжет цитировал источник, цитата в «ёлочках»
 * состояла из двух предложений, и пагинатор разрезал текст по точке **внутри**
 * кавычек: на одной странице осталось `«…`, на следующей `…»`. Ворота приёмки
 * честно назвали это разорванной цитатой, а повтор ничего не менял.
 *
 * Токенизатор предложений жил двенадцатью копиями по всему модулю — один
 * вопрос, двенадцать ответов, и ни один не знал о кавычках. Теперь ответ один:
 * `splitSentences`, и он не режет внутри «…», „…“ и парных "…". Непарная
 * кавычка правило снимает: иначе одна забытая ёлочка склеила бы весь текст в
 * одно предложение.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { splitSentences } from "@/modules/digital-profile/orion-golden/deck-sections/sentence-split";

const SRC = join(process.cwd(), "src/modules/digital-profile");
const OWN_TOKENIZER = "(?<=[.!?…])\\s+";
const THE_ONE = "orion-golden/deck-sections/sentence-split.ts";

/** Файлы, где до шага стояла своя копия токенизатора. Список — сверка, а не исключения. */
const FORMER_COPIES = [
  "orion-golden/classic/client-language.ts",
  "orion-golden/deck-sections/boilerplate-commentary.ts",
  "orion-golden/deck-sections/run-deck-build.ts",
  "orion-golden/deck-sections/semantic-summary-pagination.ts",
  "orion-golden/deck-sections/text-compare.ts",
  "orion-golden/deck-sections/fragment-builders/shared.ts",
  "orion-golden/analytics/client-summary-composer.ts",
  "orion-golden/analytics/finding-synthesizer.ts",
];

describe("предложение не режется внутри кавычек", () => {
  it("обычный текст режется по концам предложений, как прежде", () => {
    expect(splitSentences("Первое. Второе! Третье? Четвёртое… Пятое.")).toEqual([
      "Первое.",
      "Второе!",
      "Третье?",
      "Четвёртое…",
      "Пятое.",
    ]);
    expect(splitSentences("  ")).toEqual([]);
  });

  it("цитата из двух предложений в «ёлочках» остаётся одним куском", () => {
    const text =
      "По данным источника, «болезнь была диагностирована в 2023 году. Лечение проходило за рубежом» — источник rbc.ru. Дальше — другой сюжет.";
    expect(splitSentences(text)).toEqual([
      "По данным источника, «болезнь была диагностирована в 2023 году. Лечение проходило за рубежом» — источник rbc.ru.",
      "Дальше — другой сюжет.",
    ]);
  });

  it("вложенные ёлочки и „лапки“ считаются по глубине", () => {
    const nested = "Он сказал: «иск подан из-за «политически мотивированных» дел. Суд продолжается». Точка.";
    expect(splitSentences(nested)).toEqual([
      "Он сказал: «иск подан из-за «политически мотивированных» дел. Суд продолжается».",
      "Точка.",
    ]);
    const paws = "Заголовок „Первый. Второй“ вышел утром. Вечером — ответ.";
    expect(splitSentences(paws)).toEqual(["Заголовок „Первый. Второй“ вышел утром.", "Вечером — ответ."]);
    const straight = 'Цитата "раз. два" целиком. И ещё.';
    expect(splitSentences(straight)).toEqual(['Цитата "раз. два" целиком.', "И ещё."]);
  });

  it("непарная кавычка не склеивает текст: правило снимается", () => {
    expect(splitSentences("Открыл «и забыл. Второе предложение. Третье.")).toEqual([
      "Открыл «и забыл.",
      "Второе предложение.",
      "Третье.",
    ]);
  });

  it("собственных копий токенизатора в модуле больше нет — ответ один", () => {
    const copies = FORMER_COPIES.filter((rel) =>
      readFileSync(join(SRC, rel), "utf8").includes(OWN_TOKENIZER)
    );
    expect(copies).toEqual([]);
    expect(readFileSync(join(SRC, THE_ONE), "utf8")).toContain(OWN_TOKENIZER);
  });
});
