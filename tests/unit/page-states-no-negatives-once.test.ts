/**
 * «Негатива нет» говорится на листе один раз (шаг 0135).
 *
 * Отчёт Мордашова 20.09.2026, стр. 33, 34, 46, 47, 48 и 66 — шесть страниц
 * подряд об одном. На каждой этот факт напечатан трижды разными словами:
 *   * «Собрано 15, на панели — 10 подсказок… Негативных формулировок нет.»
 *   * «Подсказки показывают, что чаще всего ищут о субъекте: негативных
 *     формулировок среди показанных строк нет.»
 *   * «Строк с негативной формулировкой на этой странице нет.»
 *
 * Стр. 66 из-за третьей строки спорит сама с собой: сверху «Отдельная
 * негативная маркировка не проставлена, хотя один из запросов касается изъятия
 * яхты», снизу «Запросов с негативной формулировкой на этой странице нет».
 *
 * Правило: у вопроса «есть ли на листе негатив» один ответ и одно место —
 * строка состава, где стоят числа. Остальные строки говорят о своём.
 */

import { describe, expect, it } from "vitest";
import { relatedCompositionBlocks } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/related";

/** Четыре строки панели: одна о субъекте, три неразобранных, негатива нет. */
const ROWS = [
  { decision: "SUBJECT_MATCH", adverse: false },
  { decision: "UNRESOLVED", adverse: false },
  { decision: "UNRESOLVED", adverse: false },
  { decision: "UNRESOLVED", adverse: false },
] as never[];

/** Те же строки, но две негативные о субъекте. */
const ROWS_ADVERSE = [
  { decision: "SUBJECT_MATCH", adverse: true },
  { decision: "SUBJECT_MATCH", adverse: true },
  { decision: "UNRESOLVED", adverse: false },
  { decision: "UNRESOLVED", adverse: false },
] as never[];

function countNegativeClaims(blocks: Record<string, unknown>): number {
  return Object.values(blocks)
    .filter((v): v is string => typeof v === "string")
    .filter((v) => /негативн[а-яё]*\s+формулировок/iu.test(v)).length;
}

describe("лист без негатива", () => {
  it("С1: факт «негатива нет» напечатан один раз", () => {
    const blocks = relatedCompositionBlocks({
      rows: ROWS,
      collected: 10,
      fromPanel: true,
    } as never);
    expect(countNegativeClaims(blocks as never)).toBe(1);
  });

  it("С2: статусная строка на таком листе пуста и спорить не с чем", () => {
    const blocks = relatedCompositionBlocks({
      rows: ROWS,
      collected: 10,
      fromPanel: true,
    } as never) as Record<string, string>;
    expect(blocks.statusNote ?? "").toBe("");
  });

  it("С3: негатив на листе есть — строка состояния его называет", () => {
    const blocks = relatedCompositionBlocks({
      rows: ROWS_ADVERSE,
      collected: 10,
      fromPanel: true,
    } as never) as Record<string, string>;
    expect(blocks.statusNote).toContain("2");
    expect(blocks.statusNote).toMatch(/негативн/iu);
  });
});
