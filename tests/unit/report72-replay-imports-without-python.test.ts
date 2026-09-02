/**
 * Модуль приёмочного реплея импортируется на машине без Python.
 *
 * `npm run ci` обязан проходить без сети, без базы и **без рендерера**, а
 * Python — это контур рендерера. Реплей его зовёт по делу, но девять офлайн-
 * юнитов импортируют тот же модуль ради `loadReport72DeckInputs` и
 * `failedAcceptanceGates`, и вычисление интерпретатора на верхнем уровне
 * роняет их все ещё до первого теста — на чистой машине, а не на нашей.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../scripts/lib/python", () => ({
  findPythonInterpreter: () => null,
  pythonInterpreter: () => {
    throw new Error("интерпретатор Python не найден (проверены $PYTHON, python3, python)");
  },
  resetPythonInterpreterCache: () => undefined,
}));

describe("реплей приёмки на машине без Python", () => {
  it("импортируется и отдаёт свои офлайновые части", async () => {
    const mod = await import("../../scripts/run-orion-deck-sections-report72");
    expect(typeof mod.failedAcceptanceGates).toBe("function");
    expect(mod.failedAcceptanceGates({})).toEqual(["<ворота не вычислены>"]);
  });
});
