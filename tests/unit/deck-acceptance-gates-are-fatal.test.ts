/**
 * Непройденные приёмочные ворота останавливают сборку эталонной деки.
 *
 * Ворота считались, писались в `acceptance-report.json` и печатались в лог — а
 * прогон завершался нулём при любом их значении. `geometryClean: false`
 * держался так с начала переработки: сводка честно говорила «не пройдено», и
 * никто на это не смотрел, потому что смотреть было незачем — код возврата
 * оставался прежним.
 *
 * Это та же форма, что и «0 дефектов на 0 проверенных страниц»: отчёт есть,
 * последствий нет.
 *
 * Свойство: непройденное ворот́о называется по имени и валит прогон, а пустой
 * набор ворот успехом не считается.
 */

import { describe, expect, it } from "vitest";
import { failedAcceptanceGates } from "../../scripts/run-orion-deck-sections-report72";

describe("приёмочные ворота сборки деки", () => {
  it("все пройдены — отказов нет", () => {
    expect(failedAcceptanceGates({ a: true, b: true })).toEqual([]);
  });

  it("непройденное называется по имени", () => {
    // Ровно тот случай, что держался всю переработку.
    expect(failedAcceptanceGates({ sectionQa: true, geometryClean: false })).toEqual([
      "geometryClean",
    ]);
  });

  it("не-булево значение засчитывается как непройденное", () => {
    // `undefined` приходит, когда проверка не выполнялась вовсе; выдавать это
    // за успех — то же самое, что зелёный прогон без проверок.
    const gates = { a: undefined, b: null, c: true } as unknown as Record<string, boolean>;
    expect(failedAcceptanceGates(gates).sort()).toEqual(["a", "b"]);
  });

  it("пустой набор ворот успехом не считается", () => {
    expect(failedAcceptanceGates({})).toHaveLength(1);
  });
});
