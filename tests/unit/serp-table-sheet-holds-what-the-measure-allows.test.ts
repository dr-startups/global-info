/**
 * Лист таблицы выдачи держит столько строк, сколько влезло **по мере**.
 *
 * Реестровые три строки на лист выведены из худшей законной строки (адрес 165
 * знаков самым широким знаком 9 pt, семь нарисованных строк, 1 036 320 EMU).
 * Такая строка почти не встречается: на прогоне 91 медиана строки таблицы
 * выдачи — 350 520 EMU, максимум 624 840, на эталоне-72 максимум 762 000. Лист
 * в 3 510 000 EMU держал три строки и оставался пустым больше чем наполовину,
 * а двадцать позиций ТОП-20 занимали девять листов.
 *
 * Раскрой теперь приходит мерой рендерера — той же функцией, которой ячейка
 * рисуется, — и режет по-прежнему построитель: у каждого листа свои опоры,
 * свои находки и своя фраза с номерами строк.
 */

import { describe, expect, it } from "vitest";
import { buildSerpFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import {
  EXTRA_QUERIES_TABLE,
  cutRowsByHeight,
  cutTableRows,
  tableCutKey,
  type TableCutPlan,
} from "@/modules/digital-profile/orion-golden/deck-sections/measured-table-fit";
import {
  DECK_TEMPLATE_REGISTRY,
  SERP_TABLE_ROW_BUDGET_EMU,
} from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const QUERY = "Кремлев Умар Назарович";
const EXTRA_QUERY = "Умар Кремлев IBA";
const SEED = DECK_TEMPLATE_REGISTRY["serp-table"].maxTableRowsPerSlide;

/** Медианная строка таблицы выдачи прогона 91 — по ней и меряем. */
const MEDIAN_ROW_EMU = 350_520;

function scopedOf(count: number, extra = 0): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  for (let rank = 1; rank <= count; rank += 1) {
    const ref = `i${rank}`;
    evidenceIndex[ref] = {
      title: `Материал ${rank}`,
      url: `https://example-${rank}.ru/umar-kremlev`,
      domain: `example-${rank}.ru`,
      region: "RU",
      engine: "YANDEX",
      rank,
      rankSource: "yandex",
      query: QUERY,
      queryPurpose: "subject_lookup",
      subjectNameQuery: true,
      subjectDecision: "SUBJECT_MATCH",
    };
    refs.push(ref);
  }
  // Материалы, найденные другим запросом прогона: в таблицу по имени они не
  // идут и печатаются второй таблицей — у неё свой раскрой и свой ключ.
  for (let n = 1; n <= extra; n += 1) {
    const ref = `e${n}`;
    evidenceIndex[ref] = {
      title: `Материал по дополнительному запросу ${n}`,
      url: `https://extra-${n}.ru/umar-kremlev`,
      domain: `extra-${n}.ru`,
      region: "RU",
      engine: "YANDEX",
      rank: n,
      rankSource: "yandex",
      query: EXTRA_QUERY,
      queryPurpose: "subject_lookup",
      subjectDecision: "SUBJECT_MATCH",
    };
    refs.push(ref);
  }
  return {
    findings: [],
    surfaceUnits: [
      { surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function slidesOf(
  count: number,
  tableCut?: TableCutPlan,
  extra = 0
): SlideContentContract[] {
  return buildSerpFragment(
    "RU_SERP",
    "RU_PROFILE",
    "Россия",
    scopedOf(count, extra),
    tableCut ? ({ tableCut } as FragmentExtras) : undefined
  ).slides;
}

const tableA = (slides: SlideContentContract[]): SlideContentContract[] =>
  slides.filter((s) => s.metrics?.serpPositional === 1 && s.metrics?.serpExtraQueries !== 1);

/** Ключ цепочки таблицы А: слот раздела плюс движок. */
function cutFor(counts: number[]): TableCutPlan {
  const baseSlotId = tableA(slidesOf(1))[0]!.slideId;
  return new Map([[tableCutKey(baseSlotId, "YANDEX"), counts]]);
}

describe("раскрой листа берётся у меры, а не у худшего случая", () => {
  it("шестнадцать медианных строк ложатся на два листа, а не на шесть", () => {
    const heights = Array.from({ length: 16 }, () => MEDIAN_ROW_EMU);
    expect(cutRowsByHeight(heights, SERP_TABLE_ROW_BUDGET_EMU)).toEqual([10, 6]);
  });

  it("строки ростом в 300 000 дают одиннадцать на лист", () => {
    const heights = Array.from({ length: 16 }, () => 300_000);
    expect(cutRowsByHeight(heights, SERP_TABLE_ROW_BUDGET_EMU)).toEqual([11, 5]);
  });

  it("строка выше бюджета целиком ложится на свой лист одна, а не режется", () => {
    const heights = [300_000, SERP_TABLE_ROW_BUDGET_EMU + 1, 300_000];
    expect(cutRowsByHeight(heights, SERP_TABLE_ROW_BUDGET_EMU)).toEqual([1, 1, 1]);
  });

  it("ни одна строка не теряется и порядок не меняется", () => {
    const heights = [200_000, 900_000, 2_400_000, 300_000, 4_000_000, 100_000];
    const counts = cutRowsByHeight(heights, SERP_TABLE_ROW_BUDGET_EMU);
    expect(counts.reduce((n, x) => n + x, 0)).toBe(heights.length);
    const rows = heights.map((_, i) => `строка ${i + 1}`);
    expect(cutTableRows(rows, counts, SEED).flat()).toEqual(rows);
  });
});

describe("режет по-прежнему построитель, и раскрой приезжает к нему", () => {
  it("шестнадцать строк выдачи ложатся на два листа вместо шести", () => {
    const pages = tableA(slidesOf(16, cutFor([11, 5])));
    expect(pages.map((s) => s.content.table?.rows.length)).toEqual([11, 5]);
  });

  it("опоры листа — это опоры его собственных строк", () => {
    const pages = tableA(slidesOf(16, cutFor([11, 5])));
    const numbers = (s: SlideContentContract): string[] =>
      (s.content.table?.rows ?? []).map((r) => r[0]!);
    expect(numbers(pages[0]!)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
    expect(numbers(pages[1]!)).toEqual(["12", "13", "14", "15", "16"]);
    expect(pages[0]!.evidenceRefs).toEqual(
      Array.from({ length: 11 }, (_, i) => `i${i + 1}`)
    );
    expect(pages[1]!.evidenceRefs).toEqual(
      Array.from({ length: 5 }, (_, i) => `i${i + 12}`)
    );
    expect(pages.map((s) => s.metrics?.displayedCount)).toEqual([11, 5]);
    expect(pages.map((s) => s.metrics?.pageIndex)).toEqual([1, 2]);
    expect(pages.map((s) => s.metrics?.pageCount)).toEqual([2, 2]);
    expect(pages.map((s) => s.title)).toEqual([
      "Россия — Яндекс, позиции 1–16 из ТОП-20 (1/2)",
      "Россия — Яндекс, позиции 1–16 из ТОП-20 (2/2)",
    ]);
  });

  it("без меры остаётся раскладка сида — три строки на лист", () => {
    const pages = tableA(slidesOf(16));
    expect(SEED).toBe(3);
    expect(pages.map((s) => s.content.table?.rows.length)).toEqual([3, 3, 3, 3, 3, 1]);
  });

  it("вторая таблица режется своим раскроем, а не раскроем первой", () => {
    const baseSlotId = tableA(slidesOf(1))[0]!.slideId;
    const seed = slidesOf(3, undefined, 8).filter((s) => s.metrics?.serpExtraQueries === 1);
    expect(seed.map((s) => s.content.table?.rows.length)).toEqual([3, 3, 2]);
    const pages = slidesOf(
      3,
      new Map([[tableCutKey(baseSlotId, EXTRA_QUERIES_TABLE), [5, 3]]]),
      8
    ).filter((s) => s.metrics?.serpExtraQueries === 1);
    expect(pages.map((s) => s.content.table?.rows.length)).toEqual([5, 3]);
    expect(pages.map((s) => s.metrics?.pageCount)).toEqual([2, 2]);
  });

  it("план, посчитанный не про эти строки, отвергается целиком", () => {
    // Сумма плана не сходится с числом строк — значит, мерили другую таблицу.
    // Взять такой план значит потерять строки; раскрой возвращается к сиду.
    const pages = tableA(slidesOf(16, cutFor([9, 4])));
    expect(pages.map((s) => s.content.table?.rows.length)).toEqual([3, 3, 3, 3, 3, 1]);
  });
});
