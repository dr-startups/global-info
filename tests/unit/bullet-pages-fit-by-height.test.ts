/**
 * Страница буллетов нарезается по высоте, а не только по счёту блоков.
 *
 * На эталонной деке рендерер выбросил содержимое:
 *
 *     стр.11  CONTENT_DROPPED_BY_RENDERER  блоков=1  требовалось 2937723 при 1563360
 *     стр.29  CONTENT_DROPPED_BY_RENDERER  блоков=1+строка
 *
 * При этом оба предела соблюдались: блоков 2 при пределе 2, знаков 893 при
 * пределе 2×860. Мерилось количество и знаки, печаталась высота — а высота
 * тематического блока определяется числом строк: «Заголовок / Найдены
 * публикации по теме: / цитата / источник» даёт строк много при малом числе
 * знаков.
 *
 * Свойство: ни одна страница не получает больше строк, чем на ней помещается.
 */

import { describe, expect, it } from "vitest";
import {
  estimateRenderedLines,
  packBulletPages,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { DECK_TEMPLATE_REGISTRY } from "../../src/modules/digital-profile/orion-golden/deck-sections/template-registry";

const TPL = DECK_TEMPLATE_REGISTRY["regional-summary"];

/** Форма блоков со страницы 11 эталона: длины структурных строк те же. */
const PAGE_11 = [
  ["«Криминальные / судебные материалы»", "Найдены публикации по теме:", "x".repeat(214), "y".repeat(77)].join("\n"),
  [
    "«Внимание по линии безопасности / оборонный контур»",
    "Найдены публикации по теме:",
    "x".repeat(184),
    "y".repeat(185),
    "z".repeat(86),
  ].join("\n"),
];

function lineModel() {
  const charsPerLine = TPL.layout.charsPerRenderedLine!;
  return {
    first: TPL.maxBulletLinesPerSlide!,
    cont: TPL.maxBulletLinesPerContinuation ?? TPL.maxBulletLinesPerSlide!,
    charsPerLine,
  };
}

function linesOf(page: readonly string[], charsPerLine: number): number {
  return page.reduce((n, b) => n + estimateRenderedLines(b, charsPerLine), 0);
}

describe("нарезка буллетов по высоте страницы", () => {
  it("у регионального резюме объявлена ёмкость в строках", () => {
    // Без неё нарезка снова считала бы только блоки и знаки.
    expect(TPL.maxBulletLinesPerSlide).toBeGreaterThan(0);
    expect(TPL.layout.charsPerRenderedLine).toBeGreaterThan(0);
  });

  it("структурные строки считаются, а не только знаки", () => {
    const multiline = ["Заголовок", "Подзаголовок", "Тело"].join("\n");
    const flat = "Заголовок Подзаголовок Тело";
    expect(estimateRenderedLines(multiline, 85)).toBeGreaterThan(
      estimateRenderedLines(flat, 85)
    );
    // Длинная строка переносится по ширине.
    expect(estimateRenderedLines("x".repeat(214), 85)).toBe(3);
  });

  it("наблюдавшийся случай: два блока не остаются на одной странице", () => {
    const m = lineModel();
    // Оба прежних предела соблюдены — именно поэтому дефект и проходил.
    expect(PAGE_11.length).toBeLessThanOrEqual(TPL.maxBulletsPerSlide);
    expect(PAGE_11.join("").length).toBeLessThanOrEqual(
      TPL.maxBulletsPerSlide * TPL.layout.itemCharBudget
    );

    const pages = packBulletPages(
      PAGE_11,
      TPL.maxBulletsPerSlide,
      TPL.maxBulletsPerContinuation ?? TPL.maxBulletsPerSlide,
      TPL.layout.itemCharBudget,
      m
    );
    expect(pages.length).toBeGreaterThan(1);
    expect(linesOf(pages[0]!, m.charsPerLine)).toBeLessThanOrEqual(m.first);
  });

  it("ни одна страница не превышает свою ёмкость в строках", () => {
    const m = lineModel();
    const many = [...PAGE_11, ...PAGE_11, ...PAGE_11];
    const pages = packBulletPages(
      many,
      TPL.maxBulletsPerSlide,
      TPL.maxBulletsPerContinuation ?? TPL.maxBulletsPerSlide,
      TPL.layout.itemCharBudget,
      m
    );
    pages.forEach((page, i) => {
      const cap = i === 0 ? m.first : m.cont;
      // Одинокий блок выше ёмкости остаётся на своей странице — резать блок
      // пополам нельзя, а терять его тем более.
      if (page.length > 1) {
        expect(linesOf(page, m.charsPerLine)).toBeLessThanOrEqual(cap);
      }
    });
    // Ни один блок не потерян.
    expect(pages.flat()).toEqual(many);
  });

  it("без объявленной ёмкости в строках поведение прежнее", () => {
    const pages = packBulletPages(PAGE_11, 2, 3, 860);
    expect(pages).toEqual([PAGE_11]);
  });
});
