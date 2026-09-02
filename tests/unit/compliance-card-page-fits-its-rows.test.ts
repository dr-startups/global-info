/**
 * Ёмкость страницы карточек комплаенса считается в строках, а не в записях.
 *
 * Карточка записи — это от трёх до восьми строк таблицы: имя, категория,
 * статус, алиасы, страны, даты рождения, сводка и адрес карточки. Пока на лист
 * ставили «две записи» независимо от их размера, две полные записи давали
 * восемнадцать строк с двумя полосами-заголовками и шапкой — и рендерер
 * обрезал последнюю строку на полуслове (стр. 69 живого отчёта,
 * `requiredHeight 4 627 880` против `availableHeight 4 602 385`).
 *
 * Разрезать саму запись нельзя: карточка — печатный носитель правила
 * «совпадение уходит аналитику целиком». Поэтому страница набирается по
 * бюджету строк, а запись, которая в остаток не влезла, уезжает на следующий
 * лист целиком.
 */

import { describe, expect, it } from "vitest";
import {
  complianceSlides,
  fullRecord,
  minimalRecord,
  pagesOfSlot,
} from "../fixtures/compliance-fragment";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

/** Все листы Dow Jones: у этой базы справка раздела в две строки. */
const dowJonesPages = (records: Array<Record<string, unknown>>): SlideContentContract[] =>
  pagesOfSlot(complianceSlides(records), "p34_dow_jones");

const full = (n: number): Record<string, unknown> => fullRecord("DOW_JONES", n);
const minimal = (n: number): Record<string, unknown> => minimalRecord("DOW_JONES", n);

/** Сколько строк карточек несёт лист и скольким записям они принадлежат. */
function pageShape(slide: SlideContentContract): { rows: number; records: number } {
  const table = slide.content.table;
  return {
    rows: table?.rows.length ?? 0,
    records: (table?.groups ?? []).filter((g) => /^Запись /u.test(String(g.qTag ?? ""))).length,
  };
}

describe("страница карточек комплаенса набирается по бюджету строк", () => {
  it("две записи предельного размера на один лист не ставятся", () => {
    const pages = dowJonesPages([full(1), full(2)]);
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => pageShape(p).records)).toEqual([1, 1]);
  });

  it("номер записи на продолжениях считает записи, а не листы", () => {
    // Подпись полосы — клиентский текст. Пока номер считался от номера листа
    // («лист × две записи»), три записи по одной на лист читались как «Запись 1
    // из 3», «Запись 3 из 3», «Запись 5 из 3».
    const pages = dowJonesPages([full(1), full(2), full(3)]);
    const tags = pages.flatMap((p) =>
      (p.content.table?.groups ?? [])
        .map((g) => String(g.qTag ?? ""))
        .filter((t) => /^Запись /u.test(t))
    );
    expect(tags).toEqual(["Запись 1 из 3", "Запись 2 из 3", "Запись 3 из 3"]);
  });

  it("короткие записи по-прежнему делят лист", () => {
    // Три обязательных строки плюс полоса-заголовок — две таких записи в
    // бюджет помещаются, и делить их по листам значило бы плодить страницы.
    const pages = dowJonesPages([minimal(1), minimal(2)]);
    expect(pages).toHaveLength(1);
    expect(pageShape(pages[0]!).records).toBe(2);
  });

  it("ни одна запись не теряется при разбивке", () => {
    const pages = dowJonesPages([full(1), minimal(2), full(3), minimal(4)]);
    const printed = pages
      .flatMap((p) => p.content.table?.rows ?? [])
      .filter((r) => r[0] === "Совпадение по имени")
      .map((r) => r[1]);
    expect(printed).toEqual([
      "Йохан Хольмстрём 1",
      "Кирилл Кулебакин 2",
      "Йохан Хольмстрём 3",
      "Кирилл Кулебакин 4",
    ]);
  });
});
