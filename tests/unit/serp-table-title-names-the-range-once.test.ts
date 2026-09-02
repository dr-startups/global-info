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
 * Вход у глубины один — напечатанные позиции. Пока их было три (`positional`,
 * `missing`, `printedRanks`), рассогласованный кадр печатал «ТОП-20» над
 * таблицей из трёх строк и «позиции Infinity–-Infinity» над пустой.
 *
 * Формулировку не исполняет ни один эталон: у золотого кейса таблицы полные,
 * у `report-72` — непозиционные. Сторожей два: этот юнит держит саму функцию,
 * а `serp-table-caption-tells-collected-range.test.ts` — проводку через
 * `buildSerpFragment`; у веток без метки движка второго нет.
 */

import { describe, expect, it } from "vitest";
import {
  SERP_TABLE_TOP_N,
  serpTablePageTitle,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import {
  continuationNumberInTitle,
  continuationTitle,
  stripContinuationSuffix,
} from "@/modules/digital-profile/orion-golden/deck-sections/continuation-slide";

/** Таблица с собранными номерами: единственный вход — сами напечатанные позиции. */
function positionalTitle(
  ranks: number[],
  extra: { engineLabel?: string | null; suffix?: string } = {}
): string {
  return serpTablePageTitle({
    region: "Россия",
    engineLabel: extra.engineLabel === undefined ? "Google" : extra.engineLabel,
    printedRanks: ranks,
    suffix: extra.suffix ?? "",
  });
}

/**
 * Выдача без единой своей позиции: номера строк — порядок сбора, а не места.
 * Отдельного поля у этого состояния нет — это пустой список позиций.
 */
function unrankedTitle(extra: { engineLabel?: string | null; suffix?: string } = {}): string {
  return positionalTitle([], extra);
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

  it("диапазон считается по краям набора, а не по краям списка", () => {
    /*
     * Позиции приходят в порядке строк таблицы, и он не обязан быть
     * возрастающим: строки сортирует построитель по своим правилам. Пока
     * проверки подавали только упорядоченные наборы, правка «взять первый и
     * последний элемент» проходила зелёной и печатала клиенту «позиции 9–4».
     */
    expect(positionalTitle([9, 4, 7])).toBe("Россия — Google, позиции 4–9 из ТОП-20");
  });

  it("непозиционная таблица не получает ни глубины, ни диапазона", () => {
    const title = unrankedTitle();
    expect(title).toBe("Россия — Google: собранная выдача");
    expect(title).not.toContain("ТОП-");
    expect(title).not.toContain("позиции");
  });
});

describe("глубину решает один вход", () => {
  it("пустой список позиций печатает собранную выдачу, а не Infinity", () => {
    // `Math.min(...[])` — это `Infinity`, и заголовок печатал клиенту
    // «позиции Infinity–-Infinity из ТОП-20».
    const title = positionalTitle([]);
    expect(title).toBe("Россия — Google: собранная выдача");
    expect(title).not.toContain("Infinity");
    expect(title).not.toContain("NaN");
    expect(title).not.toContain("позиции");
  });

  it("поля прежней сигнатуры ответа изменить не могут", () => {
    /*
     * Глубину решали три поля: `printedRanks`, `missing` и `positional`, — и
     * рассогласованный кадр печатал «Россия — Google, ТОП-20» над таблицей из
     * трёх строк либо «позиции Infinity–-Infinity» над пустой. Вход остался
     * один; проверка кладёт старые поля со **спорящим** значением и требует,
     * чтобы ответ шёл за позициями. Вернуть второй вход, не уронив её, нельзя.
     */
    const stale = (extra: Record<string, unknown>, ranks: number[]): string =>
      serpTablePageTitle({
        region: "Россия",
        engineLabel: "Google",
        printedRanks: ranks,
        suffix: "",
        ...extra,
      } as unknown as Parameters<typeof serpTablePageTitle>[0]);
    expect(stale({ positional: true, missing: "" }, [1, 2, 3])).toBe(
      "Россия — Google, позиции 1–3 из ТОП-20"
    );
    expect(stale({ positional: false, missing: "" }, [1, 2, 3])).toBe(
      "Россия — Google, позиции 1–3 из ТОП-20"
    );
    expect(stale({ positional: true, missing: "4–20" }, [])).toBe(
      "Россия — Google: собранная выдача"
    );
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
