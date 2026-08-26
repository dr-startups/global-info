/**
 * Заголовок страницы выдачи называет глубину одним утверждением.
 *
 * «Россия — Google, ТОП-20: позиции 1–8» называет два числа и спорит сам с
 * собой: ТОП-20 обещает двадцать строк, а таблица показывает восемь, и клиент
 * читает недостающие двенадцать как пустые места выдачи, то есть как факт о
 * субъекте. Знаменатель при этом нужен: «позиции 1–8» без него неотличимы от
 * полной выдачи из восьми строк. Поэтому утверждение одно — «позиции 1–8 из
 * ТОП-20», — а причину пропусков объясняет строка под таблицей.
 *
 * Формулировку не исполняет ни один эталон: у золотого кейса таблицы полные,
 * у `report-72` — непозиционные. Сторожей два: этот юнит держит саму функцию,
 * а `serp-table-caption-tells-collected-range.test.ts` — проводку через
 * `buildSerpFragment`; у веток без метки движка второго нет.
 */

import { describe, expect, it } from "vitest";
import {
  SERP_TABLE_TOP_N,
  missingSerpRanks,
  serpTablePageTitle,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import {
  continuationNumberInTitle,
  continuationTitle,
  stripContinuationSuffix,
} from "@/modules/digital-profile/orion-golden/deck-sections/continuation-slide";

/** Позиционная таблица с собранными номерами: `missing` считает тот же помощник, что и построитель. */
function positionalTitle(
  ranks: number[],
  extra: { engineLabel?: string | null; suffix?: string } = {}
): string {
  return serpTablePageTitle({
    region: "Россия",
    engineLabel: extra.engineLabel === undefined ? "Google" : extra.engineLabel,
    positional: true,
    printedRanks: ranks,
    missing: missingSerpRanks(ranks),
    suffix: extra.suffix ?? "",
  });
}

/** Выдача без единой своей позиции: номера строк — порядок сбора, а не места. */
function unrankedTitle(extra: { engineLabel?: string | null; suffix?: string } = {}): string {
  return serpTablePageTitle({
    region: "Россия",
    engineLabel: extra.engineLabel === undefined ? "Google" : extra.engineLabel,
    positional: false,
    printedRanks: [],
    missing: "",
    suffix: extra.suffix ?? "",
  });
}

const FULL = Array.from({ length: SERP_TABLE_TOP_N }, (_, i) => i + 1);

describe("заголовок таблицы выдачи называет глубину один раз", () => {
  it("неполная таблица печатает диапазон со знаменателем", () => {
    const title = positionalTitle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(title).toBe("Россия — Google, позиции 1–10 из ТОП-20");
    // Прежняя склейка называла два числа подряд — этого в заголовке быть не должно.
    expect(title).not.toContain("ТОП-20: позиции");
  });

  it("полная двадцатка подписана глубиной и без слова «позиции»", () => {
    const title = positionalTitle(FULL);
    expect(title).toBe("Россия — Google, ТОП-20");
    expect(title).not.toContain("позиции");
  });

  it("печатается вычисленный диапазон, а не количество строк", () => {
    // Россия прогона 76: собраны 4, 6, 7, 8, 9, 10 — шесть строк, но диапазон 4–10.
    expect(positionalTitle([4, 6, 7, 8, 9, 10])).toBe("Россия — Google, позиции 4–10 из ТОП-20");
  });

  it("непозиционная таблица не получает ни глубины, ни диапазона", () => {
    const title = unrankedTitle();
    expect(title).toBe("Россия — Google: собранная выдача");
    expect(title).not.toContain("ТОП-");
    expect(title).not.toContain("позиции");
  });
});

describe("подпись страницы цепочки не меняется", () => {
  it("номер листа стоит в конце любой из трёх форм", () => {
    expect(positionalTitle([1, 2, 3, 4], { suffix: " (1/2)" })).toBe(
      "Россия — Google, позиции 1–4 из ТОП-20 (1/2)"
    );
    expect(positionalTitle(FULL, { suffix: " (1/5)" })).toBe("Россия — Google, ТОП-20 (1/5)");
    expect(unrankedTitle({ suffix: " (1/5)" })).toBe("Россия — Google: собранная выдача (1/5)");
  });

  it("новая форма проходит машинерию продолжений нетронутой", () => {
    /*
     * «(1/2)» — собственное имя страницы выдачи, а не номер в цепочке: его
     * перенумеровывать нечем. Проверка двусторонняя, иначе она проходила бы на
     * любой строке без слова «продолжение», включая пустую, и не утверждала бы
     * о заголовке ничего.
     */
    const title = positionalTitle([1, 2, 3, 4], { suffix: " (1/2)" });
    expect(continuationNumberInTitle(title)).toBeUndefined();
    expect(stripContinuationSuffix(title)).toBe(title);
    // Настоящую подпись цепочки поверх того же заголовка машинерия читает и снимает.
    const continued = continuationTitle(title, 2, 3);
    expect(continuationNumberInTitle(continued)).toBe(2);
    expect(stripContinuationSuffix(continued)).toBe(title);
  });
});

describe("таблица без названия поисковика", () => {
  it("подставляет слово «выдача» на место движка", () => {
    expect(positionalTitle([1, 2, 3, 4, 5, 6, 7, 8], { engineLabel: null })).toBe(
      "Россия — выдача, позиции 1–8 из ТОП-20"
    );
  });

  it("не повторяет это слово дважды на непозиционной таблице", () => {
    // «Россия — выдача: собранная выдача» — повтор, а не уточнение.
    expect(unrankedTitle({ engineLabel: null })).toBe("Россия — выдача");
  });

  it("пустая метка читается так же, как её отсутствие", () => {
    /*
     * «Движок назван?» — один вопрос, и ответ на него обязан быть один. Пока
     * подстановка слова «выдача» проверяла метку на nullish, а хвост
     * непозиционной таблицы — на истинность, пустая строка расходилась между
     * ними и печаталась «Россия — , позиции 1–8 из ТОП-20»: региона и тире
     * без подлежащего.
     */
    expect(positionalTitle([1, 2, 3, 4, 5, 6, 7, 8], { engineLabel: "" })).toBe(
      "Россия — выдача, позиции 1–8 из ТОП-20"
    );
    expect(positionalTitle(FULL, { engineLabel: "" })).toBe("Россия — выдача, ТОП-20");
    expect(unrankedTitle({ engineLabel: "" })).toBe("Россия — выдача");
  });
});
