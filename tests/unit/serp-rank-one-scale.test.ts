/**
 * Позиция в выдаче считается в одной системе отсчёта.
 *
 * Провайдеры нумеруют одну и ту же выдачу по-разному: Яндекс считает все блоки
 * (плитка картинок занимает место), Arsenkin — только органику. Позиции
 * сливались минимумом, и две системы координат смешивались: материал, второй у
 * Яндекса и первый у Arsenkin, становился первым и сталкивался с чужой первой
 * позицией, а вторая пустела.
 *
 * В отчёте 73 таблица «Россия — Яндекс, ТОП-20» имела дубли на местах 1, 7, 10
 * и дыры на 9, 13, 17: двадцать собранных материалов не смогли занять двадцать
 * мест. Клиент видит пропуски и считает их потерей данных.
 */

import { describe, expect, it } from "vitest";
import { rankInOneScale } from "@/modules/digital-profile/services/composite-serp-merge";

describe("позиция берётся у поисковика, которому принадлежит выдача", () => {
  it("основной поисковик решает, даже когда обогатитель назвал позицию выше", () => {
    expect(
      rankInOneScale({
        primaryProvider: "yandex",
        ranksByProvider: { yandex: 2, arsenkin: 1 },
      })
    ).toBe(2);
  });

  it("обогатитель не задаёт позицию, если поисковик её сообщил", () => {
    expect(
      rankInOneScale({
        primaryProvider: "yandex",
        ranksByProvider: { arsenkin: 1, serper: 7 },
      })
    ).toBe(7);
  });

  it("без основного поисковика берётся любой другой поисковик", () => {
    expect(rankInOneScale({ ranksByProvider: { arsenkin: 3, serper: 11 } })).toBe(11);
  });

  it("набор данных от одного обогатителя таблицу не теряет", () => {
    // Старые прогоны собирались одним Arsenkin: отбросить его позицию значит
    // остаться вовсе без нумерации.
    expect(rankInOneScale({ ranksByProvider: { arsenkin: 4 } })).toBe(4);
  });

  it("без разложенных позиций остаётся то, что было", () => {
    expect(rankInOneScale({ rank: 5 })).toBe(5);
    expect(rankInOneScale({})).toBeUndefined();
  });

  it("двадцать материалов занимают двадцать разных мест", () => {
    // Модель прогона 73: у части материалов обе нумерации, у части — только
    // своя. В одной шкале столкновений быть не должно.
    const rows = Array.from({ length: 20 }, (_, i) => ({
      primaryProvider: "yandex",
      ranksByProvider: { yandex: i + 1, ...(i % 3 === 0 ? { arsenkin: Math.max(1, i) } : {}) },
    }));
    const ranks = rows.map((r) => rankInOneScale(r));
    expect(new Set(ranks).size).toBe(20);
    expect(ranks).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });
});
