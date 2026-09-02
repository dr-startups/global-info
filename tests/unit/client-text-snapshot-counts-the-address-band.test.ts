/**
 * Счётчик знаков клиентского текста считает и полосу адреса.
 *
 * `totalChars` — грубая мера многословности отчёта; она печатается в сводке
 * приёмки и лежит в эталоне золотого кейса. Пока адрес был колонкой, он
 * попадал в счёт вместе с `rows.flat()`; переехав в полосу, он выпал из него
 * молча — на голден-кейсе это 4 201 незасчитанный знак из 64 309.
 */

import { describe, expect, it } from "vitest";
import { extractClientText } from "../../scripts/lib/client-text-snapshot";

const HEADERS = ["№", "Заголовок", "Тип источника", "Оценка"];
const ROWS = [["1", "Материал", "Новостное СМИ", "Нейтральный"]];
const ADDRESS = "kompromat1.online/articles/364300-byvshij-partner";

describe("totalChars и полоса адреса", () => {
  it("знаки полосы входят в счёт", () => {
    const withBand = extractClientText({
      slides: [
        {
          slideKey: "p09_ru_serp_table",
          table: { headers: HEADERS, rows: ROWS, rowAddresses: [ADDRESS] },
        },
      ],
    });
    const withoutBand = extractClientText({
      slides: [{ slideKey: "p09_ru_serp_table", table: { headers: HEADERS, rows: ROWS } }],
    });
    expect(withBand.totalChars - withoutBand.totalChars).toBe(ADDRESS.length);
  });

  it("сама полоса попадает в снимок — иначе эталон её не сторожит", () => {
    const snapshot = extractClientText({
      slides: [
        {
          slideKey: "p09_ru_serp_table",
          table: { headers: HEADERS, rows: ROWS, rowAddresses: [ADDRESS] },
        },
      ],
    });
    expect(snapshot.slides[0]!.table?.rowAddresses).toEqual([ADDRESS]);
  });
});
