import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { themeRows, type ResultJson } from "@/modules/site/check/result-view";

/**
 * Тема результата раскрывается сразу, а размытый заголовок не обрезан.
 *
 * Замечания владельца после живого прогона 23.09.2026. Раскрытая тема сначала
 * стояла пустой 2–3 с: строки материалов проявлялись с задержкой по сквозному
 * номеру строки через все темы, а класс появления не снимался, и задержка
 * срабатывала при каждом раскрытии. Размытие резалось у каждой строки сверху и
 * снизу и у раскрытой темы — по бокам.
 *
 * Разметку vitest проекта не собирает: снятие класса по щелчку проверяется в
 * браузере, здесь — проекция, которая решает, кто участвует в появлении, и
 * правила `site.css`, которые дают размытию место.
 */

const result = (count: number[]): ResultJson => ({
  verdict: "NEGATIVE_FOUND",
  riskLevel: "high",
  materialsFound: count.reduce((a, b) => a + b, 0),
  findingsTotal: count.length,
  themes: count.map((n, i) => ({ id: `t${i}`, label: `Тема ${i}`, count: n, level: "high" as const })),
  partial: false,
  sourcesChecked: ["search", "surfaces", "open_sources", "sanctions"],
  checkedAt: "2026-09-23T18:00:00.000Z",
});

describe("кто участвует в появлении результата", () => {
  it("раскрыта при загрузке ровно первая тема", () => {
    const rows = themeRows(result([8, 8, 8, 3, 2]));
    expect(rows.map((r) => r.openAtLoad)).toEqual([true, false, false, false, false]);
  });

  it("строки первой темы нумеруются с нуля, у закрытых тем номеров нет", () => {
    const rows = themeRows(result([3, 8, 8, 2]));
    expect(rows[0]!.revealLines).toEqual([0, 1, 2]);
    expect(rows.slice(1).map((r) => r.revealLines)).toEqual([null, null, null]);
  });

  it("номер строки в появлении не зависит от соседних тем", () => {
    expect(themeRows(result([2, 8, 8]))[0]!.revealLines).toEqual(themeRows(result([2]))[0]!.revealLines);
  });
});

const CSS = readFileSync(join(process.cwd(), "src/app/(site)/site.css"), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");

/** Тела всех правил, селектор которых содержит строку целиком. */
function rules(selectorPart: string): string[] {
  return [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/gu)]
    .filter((m) => m[1]!.split(",").some((s) => s.trim().includes(selectorPart)))
    .map((m) => `${m[1]!.trim()} { ${m[2]!.trim()} }`);
}

describe("site.css даёт размытию место", () => {
  it("проявление строк материалов — только у строк, участвующих в появлении", () => {
    const animated = rules(".is-revealing").filter((r) => r.includes(".site-finding__list") && /animation/u.test(r));
    expect(animated.length).toBeGreaterThan(0);
    for (const rule of animated) expect(rule).toContain(".is-staged");
  });

  it("строка скрытого заголовка не режет размытие сверху и снизу", () => {
    const row = rules(".site-finding__list li").filter((r) => r.startsWith(".site-finding__list li {"));
    expect(row).toHaveLength(1);
    expect(row[0]).not.toMatch(/overflow\s*:\s*hidden/u);
    expect(row[0]).toMatch(/overflow-x\s*:\s*clip/u);
    expect(row[0]).toMatch(/padding-inline\s*:\s*var\(--site-blur-bleed\)/u);
  });

  it("раскрытая тема оставляет строке то же поле по бокам", () => {
    const content = rules(".site-theme::details-content").filter((r) => r.startsWith(".site-theme::details-content {"));
    expect(content).toHaveLength(1);
    expect(content[0]).toMatch(/padding-inline\s*:\s*var\(--site-blur-bleed\)/u);
    expect(content[0]).toMatch(/margin-inline\s*:\s*calc\(-1 \* var\(--site-blur-bleed\)\)/u);
  });
});
