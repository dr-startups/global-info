/**
 * Неполная таблица выдачи подписывается честно, а полная называет свой запрос.
 *
 * Позиции, не записанные при сборе, вернуть нечем: дыры 1, 2, 3, 5 в таблице
 * «Россия — Google» прогона 76 — это строки, которых нет в данных. Молча
 * напечатать их под заголовком «ТОП-20» значит выдать потерю сбора за пустое
 * место в выдаче; поэтому заголовок называет фактический диапазон, а строка
 * под таблицей — причину пропусков.
 *
 * Запрос печатается на странице всегда: читатель должен видеть, чью выдачу он
 * смотрит, — иначе противоречие со снимком соседней страницы необъяснимо.
 */

import { describe, expect, it } from "vitest";
import {
  SERP_TABLE_TOP_N,
  buildSerpFragment,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import { composeFindingProse } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const QUERY = "Рашников Виктор Филиппович";

function scopedWithRanks(ranks: number[], engine: "GOOGLE" | "YANDEX" = "GOOGLE"): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  for (const rank of ranks) {
    evidenceIndex[`i${rank}`] = {
      title: `Материал ${rank}`,
      url: `https://example.ru/${rank}`,
      domain: "example.ru",
      region: "RU",
      engine,
      rank,
      rankSource: engine === "GOOGLE" ? "serper" : "yandex",
      query: QUERY,
      queryPurpose: "subject_lookup",
      subjectDecision: "SUBJECT_MATCH",
    };
  }
  return {
    findings: [],
    surfaceUnits: [
      {
        surface: "organic",
        region: "RU",
        claims: [],
        metrics: [],
        evidenceRefs: ranks.map((r) => `i${r}`),
      },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function slidesOf(ranks: number[]) {
  return buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scopedWithRanks(ranks)).slides;
}

/** Полная двадцатка: подписи о потерях на такой таблице нет. */
const FULL_TABLE = Array.from({ length: SERP_TABLE_TOP_N }, (_, i) => i + 1);

/**
 * Полная таблица плюс материал, найденный другим запросом прогона.
 *
 * В таблицу он не попадает — она показывает выдачу по одному запросу, — но в
 * набор проверенных запросов входит: ровно так выглядит живой прогон, где
 * запросов пять.
 */
function scopedWithSeveralQueries(): ScopedFragmentInput {
  const scoped = scopedWithRanks(FULL_TABLE);
  (scoped.evidenceIndex as Record<string, unknown>)["i-other-query"] = {
    title: "Материал другого запроса",
    url: "https://other.ru/1",
    domain: "other.ru",
    region: "RU",
    engine: "GOOGLE",
    rank: 3,
    rankSource: "serper",
    query: "рашников виктор состояние",
    queryPurpose: "subject_lookup",
    subjectDecision: "SUBJECT_MATCH",
  };
  (scoped.surfaceUnits[0] as { evidenceRefs: string[] }).evidenceRefs.push("i-other-query");
  return scoped;
}

/**
 * Предложения, которые доедут до листа.
 *
 * Правило то же, которым режет шаблон `orion_golden_search_table`
 * (`renderer/orion_golden_render/slides.py`): нарратив страницы — это то, что
 * построитель положил плюс склейка `composeFindingProse`; из него берутся
 * первые два законченных предложения. Считать клип по одному лишь построителю
 * значит мерить не то, что видит клиент.
 */
function printedSentences(slide: SlideContentContract): string[] {
  const content = slide.content;
  const payload = [
    content.narrative,
    composeFindingProse({
      whatWasFound: content.whatWasFound,
      whyItMatters: content.whyItMatters,
      whatToCheck: content.whatToCheck,
      narrative: content.narrative,
      bullets: content.bullets,
    }),
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n");
  const complete = payload
    .split(/(?<=[.!?…])\s+/u)
    .map((x) => x.trim())
    .filter((x) => /[.!?…]$/u.test(x) && !/(?:\bкак|\bи|\bс|\bв|\bпо|,|;|—)\s*$/iu.test(x));
  return complete.slice(0, 2);
}

describe("заголовок таблицы называет собранный диапазон", () => {
  it("полная двадцатка подписана как ТОП-20", () => {
    const ranks = Array.from({ length: SERP_TABLE_TOP_N }, (_, i) => i + 1);
    expect(slidesOf(ranks)[0]!.title).toBe("Россия — Google, ТОП-20 (1/2)");
  });

  it("десять собранных позиций подписаны диапазоном", () => {
    const titles = slidesOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).map((s) => s.title);
    expect(titles[0]).toBe("Россия — Google, ТОП-20: позиции 1–10");
  });

  it("диапазон считается по напечатанным номерам, а не по их числу", () => {
    // Россия прогона 76: собраны 4, 6, 7, 8, 9, 10 — дыры 1, 2, 3, 5.
    expect(slidesOf([4, 6, 7, 8, 9, 10])[0]!.title).toBe(
      "Россия — Google, ТОП-20: позиции 4–10"
    );
  });
});

describe("строка под таблицей объясняет пропуски", () => {
  it("называет отсутствующие номера и причину", () => {
    const narrative = String(slidesOf([4, 6, 7, 8, 9, 10])[0]!.content.narrative ?? "");
    expect(narrative).toContain(
      "Позиции 1–3, 5, 11–20 в собранных данных отсутствуют: эти строки потеряны при сборе, а не пусты в выдаче."
    );
  });

  it("у полной таблицы такой строки нет", () => {
    const ranks = Array.from({ length: SERP_TABLE_TOP_N }, (_, i) => i + 1);
    const narrative = String(slidesOf(ranks)[0]!.content.narrative ?? "");
    expect(narrative).not.toContain("потеряны при сборе");
  });
});

describe("страница называет запрос своей таблицы", () => {
  it("печатает его первым предложением", () => {
    const narrative = String(slidesOf([1, 2, 3])[0]!.content.narrative ?? "");
    expect(narrative.startsWith(`Показана выдача Google по запросу «${QUERY}».`)).toBe(true);
  });

  it("называет поисковик в родительном падеже", () => {
    // «Показана выдача Яндекс» — не по-русски, а текст читает клиент.
    const slide = buildSerpFragment(
      "RU_SERP",
      "RU_PROFILE",
      "Россия",
      scopedWithRanks([1, 2, 3], "YANDEX")
    ).slides[0]!;
    expect(String(slide.content.narrative ?? "")).toContain(
      `Показана выдача Яндекса по запросу «${QUERY}».`
    );
  });

  it("не повторяет тот же запрос второй строкой", () => {
    /*
     * Запрос в прогоне один — перечень дословно повторяет строку выше
     * («Показана выдача Google по запросу «X». Выдача проверена по 1 запросу:
     * «X».») и съедает второе печатное предложение, в котором стоит вывод
     * страницы. Повтор с листа уходит, вывод остаётся.
     */
    const slide = slidesOf(FULL_TABLE)[0]!;
    expect(String(slide.content.narrative ?? "")).not.toContain("Выдача проверена по");
    const printed = printedSentences(slide);
    expect(printed[0]).toBe(`Показана выдача Google по запросу «${QUERY}».`);
    expect(printed[1]).toBe(String(slide.content.whatWasFound ?? "").split(/(?<=[.!?…])\s+/u)[0]);
  });

  it("при нескольких запросах перечень есть, но вывод он не съедает", () => {
    /*
     * Тематическая строка — вывод страницы, перечень запросов — справка;
     * справка идёт после вывода. На живом прогоне запросов пять, и другого
     * места, где клиенту называют набор, в деке нет.
     */
    const slide = buildSerpFragment(
      "RU_SERP",
      "RU_PROFILE",
      "Россия",
      scopedWithSeveralQueries()
    ).slides[0]!;
    const narrative = String(slide.content.narrative ?? "");
    expect(narrative).toContain("Выдача проверена по 2 запросам:");
    const printed = printedSentences(slide);
    expect(printed[0]).toBe(`Показана выдача Google по запросу «${QUERY}».`);
    expect(printed[1]).not.toContain("Выдача проверена по");
    expect(printed[1]).toBe(String(slide.content.whatWasFound ?? "").split(/(?<=[.!?…])\s+/u)[0]);
  });

  it("на неполной таблице второе предложение — причина пропусков", () => {
    // Порядок владельца: честность о потере важнее и вывода, и справки.
    const printed = printedSentences(slidesOf([4, 6, 7, 8, 9, 10])[0]!);
    expect(printed[0]).toBe(`Показана выдача Google по запросу «${QUERY}».`);
    expect(printed[1]).toBe(
      "Позиции 1–3, 5, 11–20 в собранных данных отсутствуют: эти строки потеряны при сборе, а не пусты в выдаче."
    );
  });

  it("записывает движок и запрос данными — их читают ворота", () => {
    const metrics = slidesOf([1, 2, 3])[0]!.metrics;
    expect(metrics.serpEngine).toBe("GOOGLE");
    expect(metrics.serpQuery).toBe(QUERY);
  });

  it("непозиционная таблица объявляет себя таковой", () => {
    // Ни одной своей позиции: номера строк — порядок сбора, и ворота обязаны
    // это видеть данными, а не догадываться по заголовку.
    const scoped = scopedWithRanks([1, 2]);
    for (const ref of ["i1", "i2"]) {
      const entry = scoped.evidenceIndex[ref] as { rank?: number; rankSource?: string };
      entry.rank = undefined;
      entry.rankSource = undefined;
    }
    const slide = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped).slides[0]!;
    expect(slide.title).toContain("собранная выдача");
    expect(slide.metrics.serpPositional).toBe(0);
  });

  it("позиционная таблица помечена позиционной", () => {
    expect(slidesOf([1, 2, 3])[0]!.metrics.serpPositional).toBe(1);
  });

  it("продолжение таблицы несёт те же движок и запрос", () => {
    const ranks = Array.from({ length: SERP_TABLE_TOP_N }, (_, i) => i + 1);
    const slides = slidesOf(ranks);
    expect(slides.length).toBeGreaterThan(1);
    expect(slides[1]!.metrics.serpEngine).toBe("GOOGLE");
    expect(slides[1]!.metrics.serpQuery).toBe(QUERY);
  });
});
