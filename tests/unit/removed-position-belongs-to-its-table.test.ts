/**
 * Подпись таблицы называет снятые позиции только своей таблицы.
 *
 * Таблица выдачи — одна система и один запрос: это страница, которую видит
 * человек. Снятый материал оставляет незанятым номер **в той таблице, где он
 * стоял**, и ни в какой другой. Пока номера снятых складывались по региону,
 * подпись под таблицей Яндекса на прогоне DPA-2026-0002 объявляла «Позиции 1, 6
 * в таблице не показаны» о материале, которого в Яндексе не было вовсе, а
 * подпись Google называла позицию 1 запроса, таблицы которого в отчёте нет.
 *
 * Правило то же, что у номера напечатанной строки (`rankInQuery`): при названном
 * запросе считается только чтение по этому запросу, без запроса — любое чтение
 * своей системы. Второй линейки для снятых строк нет.
 */

import { describe, expect, it } from "vitest";
import { removedRanksForTable } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";

const MAIN = "Тиньков Олег Юрьевич";
const rows = [
  { region: "RU", engine: "GOOGLE", query: MAIN, rank: 6 },
  { region: "RU", engine: "GOOGLE", query: null, rank: 6 },
  { region: "RU", engine: "GOOGLE", query: "тиньков олег юрьевич иноагент или нет", rank: 1 },
  { region: "UAE", engine: "GOOGLE", query: "Oleg Tinkov", rank: 18 },
];

describe("снятые позиции таблицы выдачи", () => {
  it("таблица Яндекса молчит о материале, снятом из Google", () => {
    expect(removedRanksForTable(rows, { region: "RU", engine: "YANDEX", query: MAIN })).toEqual([]);
  });

  it("таблица Google основного запроса называет только свой номер", () => {
    expect(removedRanksForTable(rows, { region: "RU", engine: "GOOGLE", query: MAIN })).toEqual([6]);
  });

  it("таблица другого региона называет свой", () => {
    expect(
      removedRanksForTable(rows, { region: "UAE", engine: "GOOGLE", query: "Oleg Tinkov" })
    ).toEqual([18]);
  });

  it("таблица без запроса считает все чтения своей системы", () => {
    expect(removedRanksForTable(rows, { region: "RU", engine: "GOOGLE", query: null })).toEqual([
      1, 6,
    ]);
  });

  it("написание запроса — не другой запрос", () => {
    expect(
      removedRanksForTable(rows, { region: "RU", engine: "google", query: "тиньков олег юрьевич" })
    ).toEqual([6]);
  });
});
