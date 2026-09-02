/**
 * Рендерер узнаёт сводную таблицу комплаенса по заголовку, который печатает
 * построитель, — и связь между ними держится только этим тестом.
 *
 * `visual.py` выбирает ширины колонок ветвями `elif` по словам заголовков.
 * Переименование третьей колонки («Оценка совпадения» → «Совпадение по имени»)
 * не сломало ни один тип, ни одни ворота и ни растровую проверку: таблица молча
 * ушла в общую четырёхколоночную ветку, где статусу достаётся 18 % ширины и
 * самая длинная законная ячейка просит три строки вместо двух. Признак ветки
 * переведён на первую колонку, но сам по себе он такая же строка-двойник:
 * заголовок живёт в TypeScript, регулярка — в Python, и связать их может только
 * проверка, которая читает оба файла.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMPLIANCE_SUMMARY_HEADERS } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/compliance";

const VISUAL_PY = join(process.cwd(), "renderer/orion_golden_render/visual.py");

/** Регулярка ветки комплаенс-сводки — из самого рендерера, а не копией здесь. */
function complianceBranchPattern(): RegExp {
  const source = readFileSync(VISUAL_PY, "utf8");
  const branch = /elif cols == 4 and re\.search\(\s*r"([^"]+)"\s*,\s*str\(headers\[0\]\)/u.exec(
    source
  );
  if (!branch) {
    throw new Error(
      `в ${VISUAL_PY} не найдена ветка ширин комплаенс-сводки по headers[0] — ` +
        "если признак ветки поменялся, этот тест обязан поменяться вместе с ним"
    );
  }
  return new RegExp(branch[1]!, "iu");
}

describe("ветка ширин комплаенс-сводки в рендерере", () => {
  it("узнаёт первую колонку, которую печатает построитель", () => {
    expect(complianceBranchPattern().test(COMPLIANCE_SUMMARY_HEADERS[0])).toBe(true);
  });

  it("не срабатывает на заголовках других таблиц отчёта", () => {
    const pattern = complianceBranchPattern();
    // Первые колонки остальных четырёхколоночных таблиц деки.
    for (const header of ["№", "Поз.", "Система", "Тема", "Параметр"]) {
      expect(pattern.test(header), header).toBe(false);
    }
  });

  it("доли этой ветки посчитаны на четыре колонки", () => {
    expect(COMPLIANCE_SUMMARY_HEADERS).toHaveLength(4);
    const source = readFileSync(VISUAL_PY, "utf8");
    expect(source).toMatch(/prop = \[0\.14, 0\.26, 0\.26, 0\.34\]/u);
  });
});
