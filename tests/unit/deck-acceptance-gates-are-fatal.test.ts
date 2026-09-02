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
import {
  acceptanceGateSummary,
  failedAcceptanceGates,
} from "../../scripts/run-orion-deck-sections-report72";

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

  it("пропуск отказом не считается — но и проходом тоже", () => {
    // Сверка, которой нечем было мериться, — отдельный исход. Выданная за
    // проход, она делает ворот неотличимым от неработающего.
    expect(failedAcceptanceGates({ a: true, b: "SKIP" })).toEqual([]);
  });
});

describe("сводка приёмки называет пропуски", () => {
  it("пропущенный ворот не попадает в число пройденных и назван по имени", () => {
    const summary = acceptanceGateSummary({
      sectionQa: true,
      geometryClean: true,
      serpTableMatchesObservations: "SKIP",
    });
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(2);
    expect(summary.skipped).toEqual(["serpTableMatchesObservations"]);
    expect(summary.failed).toEqual([]);
    // Строку читает человек: «28 из 28» на пропущенной сверке — то, ради чего
    // раннер смоков когда-то и завели.
    expect(summary.line).toContain("пройдено 2 из 3");
    expect(summary.line).toContain("пропущено 1");
    expect(summary.line).toContain("serpTableMatchesObservations");
  });

  it("без пропусков строка о них не говорит", () => {
    const summary = acceptanceGateSummary({ sectionQa: true, geometryClean: true });
    expect(summary.line).toBe("приёмка: пройдено 2 из 2 ворот");
    expect(summary.skipped).toEqual([]);
  });

  it("провал остаётся провалом и при пропуске рядом", () => {
    const summary = acceptanceGateSummary({
      sectionQa: false,
      serpTableMatchesObservations: "SKIP",
    });
    expect(summary.failed).toEqual(["sectionQa"]);
    expect(summary.passed).toBe(0);
  });
});
