/**
 * Ворота приёмки «сводка называет свои базы» читают все листы сводки.
 *
 * Ворота сверяют напечатанные строки с наблюдениями артефактов, а не с выходом
 * построителя: проверка, меряющая тем же индексом, зелена вакуумно. После того
 * как сводная таблица получила потолок строк, первый её лист несёт не все
 * записи — и ворота, смотревшие только на него, стали бы ложно красными на
 * первом же корпусе больше пяти записей.
 *
 * На эталоне 72 записей три, они умещаются на один лист, и старый код от
 * нового там неотличим — то есть в приёмке эта правка не покрыта ничем. Отсюда
 * юнит: разбивку по листам держат эти четыре случая, а не эталон.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { complianceRowsNameTheirBases } from "../../scripts/run-orion-deck-sections-report72";

/** Каталог аналитики с наблюдениями комплаенса — вход, по которому судят ворота. */
function analyticsDirWith(titles: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "compliance-gate-"));
  writeFileSync(
    join(dir, "composite-serp-observations.json"),
    JSON.stringify({
      observations: [
        // Наблюдение другой поверхности в счёт не идёт.
        { surface: "organic", engine: "YANDEX", title: "Кулебакин — интервью" },
        ...titles.map((title) => ({ surface: "compliance_hit", engine: "OPEN_SANCTIONS", title })),
      ],
    }),
    "utf8"
  );
  return dir;
}

const HEADERS = ["База данных", "Тип совпадения", "Совпадение по имени", "Статус проверки"];

/** Лист сводной таблицы: те же колонки, что печатает построитель. */
function summaryPage(rows: string[][], isContinuation = false): Record<string, unknown> {
  return {
    baseSlotId: "p33_compliance_toc",
    isContinuation,
    table: { headers: HEADERS, rows },
  };
}

/** Лист карточек на том же слоте — в счёт строк сводки не идёт. */
function cardPage(): Record<string, unknown> {
  return {
    baseSlotId: "p33_compliance_toc",
    isContinuation: true,
    table: {
      headers: ["Параметр", "Значение"],
      rows: [["Совпадение по имени", "Кулебакин Кирилл"]],
    },
  };
}

const row = (n: number): string[] => [
  "OpenSanctions",
  "Санкционные списки",
  `Кулебакин Кирилл ${n}`,
  "Требует ручной проверки",
];

const titles = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `Кулебакин Кирилл ${i + 1}`);

describe("ворота сводки комплаенса читают все её листы", () => {
  it("многолистовая сводка проходит", () => {
    const slides = [
      summaryPage([1, 2, 3, 4, 5].map(row)),
      summaryPage([6, 7, 8, 9, 10].map(row), true),
      summaryPage([11, 12].map(row), true),
      cardPage(),
    ];
    expect(complianceRowsNameTheirBases(slides, analyticsDirWith(titles(12)))).toBe(true);
  });

  it("потерянная на продолжении запись ловится", () => {
    const slides = [
      summaryPage([1, 2, 3, 4, 5].map(row)),
      summaryPage([6, 7, 8, 9, 10].map(row), true),
      summaryPage([11].map(row), true),
    ];
    expect(complianceRowsNameTheirBases(slides, analyticsDirWith(titles(12)))).toBe(false);
  });

  it("безымянная база на продолжении ловится", () => {
    // «База данных» в ячейке — это подпись колонки, попавшая в данные: базу не
    // назвали. Ворота обязаны видеть это на любом листе, а не только на первом.
    const broken = [...row(12)];
    broken[0] = "База данных";
    const slides = [
      summaryPage([1, 2, 3, 4, 5].map(row)),
      summaryPage([6, 7, 8, 9, 10].map(row), true),
      summaryPage([row(11), broken], true),
    ];
    expect(complianceRowsNameTheirBases(slides, analyticsDirWith(titles(12)))).toBe(false);
  });

  it("корпус в один лист судится как раньше", () => {
    expect(
      complianceRowsNameTheirBases([summaryPage([1, 2, 3].map(row))], analyticsDirWith(titles(3)))
    ).toBe(true);
    expect(
      complianceRowsNameTheirBases([summaryPage([1, 2].map(row))], analyticsDirWith(titles(3)))
    ).toBe(false);
  });

  it("без файла наблюдений ворота отказывают, а не пропускают", () => {
    const empty = mkdtempSync(join(tmpdir(), "compliance-gate-nodata-"));
    expect(complianceRowsNameTheirBases([summaryPage([row(1)])], empty)).toBe(false);
  });
});
