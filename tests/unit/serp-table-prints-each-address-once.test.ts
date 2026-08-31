/**
 * Ни в одной печатной таблице выдачи один адрес не печатается дважды.
 *
 * Единственный сторож работы «ключ материала предпочитает адрес» на уровне
 * напечатанного: юниты ключа видят пары ключей, но не видят таблицу, и возврат
 * заголовочного приоритета вернул бы шесть пар строк «Россия — Яндекс» молча.
 *
 * Единица счёта разная у двух таблиц выдачи, и это не деталь: первая — таблица
 * одного движка одного региона (между движками один адрес законен, у каждой
 * своя выдача), вторая — таблица **региона**, потому что она одна на регион и
 * движком не разделена.
 *
 * Адрес читается из колонки «Ссылка» — оттуда же, откуда его читает клиент.
 * Полосы под строкой больше нет.
 */

import { describe, expect, it } from "vitest";
import {
  printedSerpAddressCount,
  repeatedSerpTableAddresses,
} from "../../scripts/run-orion-deck-sections-report72";
import { SERP_EXTRA_TABLE_HEADERS, SERP_TABLE_HEADERS } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";

type Slide = Parameters<typeof repeatedSerpTableAddresses>[0][number];

/** Лист первой таблицы: адрес стоит второй колонкой, после номера. */
function tableSlide(over: {
  slideKey: string;
  sectionKey?: string;
  engine?: string;
  addresses: string[];
}): Slide {
  return {
    slideKey: over.slideKey,
    sectionKey: over.sectionKey ?? "RU_PROFILE",
    metrics: { serpEngine: over.engine ?? "YANDEX" },
    table: {
      headers: [...SERP_TABLE_HEADERS],
      rows: over.addresses.map((a, i) => [String(i + 1), a, `Заголовок ${i + 1}`, "СМИ", "Нейтральный"]),
    },
  };
}

/**
 * Лист второй таблицы: адрес стоит первой колонкой, номера у неё нет вовсе.
 *
 * Заголовок задаётся **отдельно** от адреса, и это не удобство: пока он
 * выводился из номера строки, «Заголовок 1» повторялся ровно там же, где
 * повторялся бы адрес, и все тринадцать проверок оставались истинными, даже
 * если ворот читал не ту колонку. Разведённые адрес и заголовок — единственное,
 * чем решение «колонка ищется по имени» вообще проверяется.
 */
function extraSlide(over: {
  slideKey: string;
  sectionKey?: string;
  engine?: string;
  addresses: string[];
  titles?: string[];
}): Slide {
  return {
    slideKey: over.slideKey,
    sectionKey: over.sectionKey ?? "RU_PROFILE",
    metrics: { serpExtraQueries: 1, ...(over.engine ? { serpEngine: over.engine } : {}) },
    table: {
      headers: [...SERP_EXTRA_TABLE_HEADERS],
      rows: over.addresses.map((a, i) => [
        a,
        over.titles?.[i] ?? `Заголовок ${over.slideKey} ${i + 1}`,
        "запрос",
        "СМИ",
        "Нейтральный",
      ]),
    },
  };
}

describe("печатная таблица выдачи не повторяет адрес", () => {
  it("один адрес на двух листах одной таблицы — повтор, названный страницей и адресом", () => {
    const repeats = repeatedSerpTableAddresses([
      tableSlide({ slideKey: "p09", addresses: ["klerk.ru/materials/a", "argumenti.ru/1"] }),
      tableSlide({ slideKey: "p09__cont1", addresses: ["forbes.ru/x", "klerk.ru/materials/a"] }),
    ]);
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toContain("p09__cont1");
    expect(repeats[0]).toContain("klerk.ru/materials/a");
  });

  it("два написания одного адреса — тоже повтор: линейка та же, что у ключа", () => {
    const repeats = repeatedSerpTableAddresses([
      tableSlide({ slideKey: "p09", addresses: ["https://www.klerk.ru/materials/a/", "klerk.ru/materials/a"] }),
    ]);
    expect(repeats).toHaveLength(1);
  });

  it("один адрес в таблицах разных движков — не повтор", () => {
    const repeats = repeatedSerpTableAddresses([
      tableSlide({ slideKey: "p09", engine: "YANDEX", addresses: ["forbes.ru/x"] }),
      tableSlide({ slideKey: "p09__cont4", engine: "GOOGLE", addresses: ["forbes.ru/x"] }),
    ]);
    expect(repeats).toHaveLength(0);
  });

  it("один адрес в таблицах разных регионов — не повтор", () => {
    const repeats = repeatedSerpTableAddresses([
      tableSlide({ slideKey: "p09", sectionKey: "RU_PROFILE", addresses: ["tadviser.ru/p"] }),
      tableSlide({ slideKey: "p26", sectionKey: "UAE_PROFILE", addresses: ["tadviser.ru/p"] }),
    ]);
    expect(repeats).toHaveLength(0);
  });

  it("адрес с меткой отслеживания и без — разные адреса (цена решения 3A)", () => {
    const repeats = repeatedSerpTableAddresses([
      tableSlide({ slideKey: "p09", addresses: ["tadviser.ru/p?shem=rimspwouoe,", "tadviser.ru/p"] }),
    ]);
    expect(repeats).toHaveLength(0);
  });

  it("пустые ячейки адреса не считаются повтором друг друга", () => {
    const repeats = repeatedSerpTableAddresses([
      tableSlide({ slideKey: "p09", addresses: ["", "  ", "forbes.ru/x"] }),
    ]);
    expect(repeats).toHaveLength(0);
  });

  it("слайды без таблицы и без колонки адреса молча пропускаются", () => {
    const repeats = repeatedSerpTableAddresses([
      { slideKey: "p01_cover", sectionKey: "FRONT" },
      {
        slideKey: "p33_compliance",
        sectionKey: "COMPLIANCE",
        table: { headers: ["База данных", "Тип совпадения"], rows: [["Dow Jones", "PEP"]] },
      },
      tableSlide({ slideKey: "p09", addresses: ["forbes.ru/x"] }),
    ]);
    expect(repeats).toHaveLength(0);
  });
});

describe("у второй таблицы единица счёта — регион, а не движок", () => {
  it("один адрес на двух её листах одного региона — повтор", () => {
    const repeats = repeatedSerpTableAddresses([
      extraSlide({ slideKey: "p09__extra1", addresses: ["forbes.ru/x"] }),
      extraSlide({ slideKey: "p09__extra2", addresses: ["forbes.ru/x"] }),
    ]);
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toContain("p09__extra2");
  });

  it("метка движка её единицу не дробит: таблица одна на регион", () => {
    // У строк второй таблицы движки разные, но таблица одна — повтор остаётся
    // повтором. Дели её по движку — и один адрес прошёл бы дважды.
    const repeats = repeatedSerpTableAddresses([
      extraSlide({ slideKey: "p09__extra1", engine: "YANDEX", addresses: ["forbes.ru/x"] }),
      extraSlide({ slideKey: "p09__extra2", engine: "GOOGLE", addresses: ["forbes.ru/x"] }),
    ]);
    expect(repeats).toHaveLength(1);
  });

  it("один адрес во второй таблице другого региона — не повтор", () => {
    const repeats = repeatedSerpTableAddresses([
      extraSlide({ slideKey: "p09__extra1", sectionKey: "RU_PROFILE", addresses: ["forbes.ru/x"] }),
      extraSlide({ slideKey: "p26__extra1", sectionKey: "UAE_PROFILE", addresses: ["forbes.ru/x"] }),
    ]);
    expect(repeats).toHaveLength(0);
  });

  it("повтор ловится по адресу, а не по совпавшему заголовку", () => {
    // Заголовки разные, адрес один — повтор обязан быть назван. Читай ворот
    // соседнюю колонку, здесь было бы пусто.
    const repeats = repeatedSerpTableAddresses([
      extraSlide({ slideKey: "p09__extra1", addresses: ["forbes.ru/x"], titles: ["Первый"] }),
      extraSlide({ slideKey: "p09__extra2", addresses: ["forbes.ru/x"], titles: ["Второй"] }),
    ]);
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toContain("forbes.ru/x");
  });

  it("одинаковый заголовок при разных адресах повтором не считается", () => {
    // Два материала законно называются одинаково: сводит их адрес, а не слова.
    const repeats = repeatedSerpTableAddresses([
      extraSlide({ slideKey: "p09__extra1", addresses: ["forbes.ru/x"], titles: ["Одно и то же"] }),
      extraSlide({ slideKey: "p09__extra2", addresses: ["rbc.ru/y"], titles: ["Одно и то же"] }),
    ]);
    expect(repeats).toHaveLength(0);
  });

  it("первая и вторая таблицы одного региона считаются порознь", () => {
    // Материал из А во вторую таблицу не попадает по построению, но ворот
    // сторожит печать, а не построитель: смешав единицы, он объявил бы повтором
    // законную пару.
    const repeats = repeatedSerpTableAddresses([
      tableSlide({ slideKey: "p09", addresses: ["forbes.ru/x"] }),
      extraSlide({ slideKey: "p09__extra1", addresses: ["forbes.ru/x"] }),
    ]);
    expect(repeats).toHaveLength(0);
  });
});

describe("дека без единого напечатанного адреса ворот проваливает", () => {
  it("считает адреса обеих таблиц, а не одной", () => {
    expect(
      printedSerpAddressCount([
        tableSlide({ slideKey: "p09", addresses: ["forbes.ru/x", ""] }),
        extraSlide({ slideKey: "p09__extra1", addresses: ["rbc.ru/y"] }),
      ])
    ).toBe(2);
  });

  it("у деки без таблиц выдачи адресов ноль — и это отказ, а не пропуск", () => {
    expect(printedSerpAddressCount([{ slideKey: "p01_cover", sectionKey: "FRONT" }])).toBe(0);
  });
});
