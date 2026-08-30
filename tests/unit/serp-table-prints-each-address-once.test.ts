/**
 * Ни в одной печатной таблице выдачи один адрес не печатается дважды.
 *
 * Единственный сторож работы «ключ материала предпочитает адрес» на уровне
 * напечатанного: юниты ключа видят пары ключей, но не видят таблицу, и возврат
 * заголовочного приоритета вернул бы шесть пар строк «Россия — Яндекс» молча.
 * Единица — таблица одного движка одного региона: между движками и между
 * регионами один адрес законен (у каждой таблицы своя выдача).
 */

import { describe, expect, it } from "vitest";
import { repeatedSerpTableAddresses } from "../../scripts/run-orion-deck-sections-report72";

type Slide = Parameters<typeof repeatedSerpTableAddresses>[0][number];

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
      rows: over.addresses.map((a, i) => [String(i + 1), `Заголовок ${i + 1}`]),
      rowAddresses: over.addresses,
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

  it("пустые полосы адреса не считаются повтором друг друга", () => {
    const repeats = repeatedSerpTableAddresses([
      tableSlide({ slideKey: "p09", addresses: ["", "  ", "forbes.ru/x"] }),
    ]);
    expect(repeats).toHaveLength(0);
  });

  it("слайды без таблицы и без полос адресов молча пропускаются", () => {
    const repeats = repeatedSerpTableAddresses([
      { slideKey: "p01_cover", sectionKey: "FRONT" },
      tableSlide({ slideKey: "p09", addresses: ["forbes.ru/x"] }),
    ]);
    expect(repeats).toHaveLength(0);
  });
});
