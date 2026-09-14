/**
 * Ворота таблицы выдачи знают о решении аналитика и о позиции без адреса.
 *
 * QA MVP 14.09.2026, дело «Усманов»: аналитик нажал «Убрать из отчёта» на
 * материале Яндекса с позиции 4, и пересборка с выпуском перестали
 * проходить — «материал … (позиция 4) не напечатан ни в одной таблице
 * региона». Ворота ждали то, что аналитик снял. Там же наблюдение Google на
 * позиции 10 с адресом-заглушкой `/goto?url=…`: построитель печатает «—»
 * вместо ссылки, ворота ждут материал с пустым адресом и не находят его, а
 * строку «(—)» не подтверждают.
 *
 * Правила: снятая аналитиком позиция не ожидается; наблюдение без печатаемого
 * адреса не ожидается — печатать нечего; строка-заглушка «—» не сверяется —
 * это не утверждение о материале. Не снятый материал без строки по-прежнему
 * замечание: ворота остаются воротами.
 */

import { describe, expect, it } from "vitest";
import { serpPrintMatchesObservations } from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import { SERP_TABLE_HEADERS } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";

const QUERY = "Усманов Алишер Бурханович";

function slide(rows: Array<[number, string, string]>): RendererSlide {
  return {
    slideKey: "p09_ru_serp_table",
    sectionKey: "RU_PROFILE",
    template: "orion_golden_search_table",
    templateId: "serp-table",
    title: "Россия — Яндекс, ТОП-20",
    pageNumber: 9,
    totalPageCount: 9,
    baseSlotId: "p09_ru_serp_table",
    isContinuation: false,
    table: {
      headers: [...SERP_TABLE_HEADERS],
      rows: rows.map(([rank, link, title]) => [String(rank), link, title, "СМИ", "Нейтральный"]),
    },
    evidenceRefs: [],
    findingIds: [],
    metrics: { serpEngine: "YANDEX", serpQuery: QUERY, serpPositional: 1 },
    visualAssetRefs: [],
    staticBlocks: [],
  };
}

/** Наблюдение как в композите: у строки есть домен, у редиректа `/goto?url=…` — нет. */
function observation(rank: number, url: string) {
  const host = url.match(/^https?:\/\/([^/]+)/u)?.[1];
  return { engine: "YANDEX", surface: "organic", region: "RU", query: QUERY, rank, url, ...(host ? { domain: host } : {}), rankSource: "topvisor-yandex" };
}

const TOP = [
  observation(1, "https://forbes.ru/profile/alisher-usmanov"),
  observation(2, "https://ru.wikipedia.org/wiki/Усманов"),
  observation(3, "https://tass.ru/usmanov"),
  observation(4, "https://secrets.tbank.ru/lichnyj-opyt/alisher-usmanov/"),
];
const PRINTED_WITHOUT_4 = slide([
  [1, "forbes.ru/profile/alisher-usmanov", "Алишер Усманов"],
  [2, "ru.wikipedia.org/wiki/Усманов", "Усманов — Википедия"],
  [3, "tass.ru/usmanov", "Усманов — ТАСС"],
]);

describe("ворота таблицы выдачи и решение аналитика", () => {
  it("снятая аналитиком позиция не ожидается", () => {
    const verdict = serpPrintMatchesObservations({
      rendererSlides: [PRINTED_WITHOUT_4],
      observations: TOP,
      removedSerpRows: [{ region: "RU", engine: "YANDEX", query: QUERY, rank: 4 }],
    });
    expect(verdict.issues).toEqual([]);
    expect(verdict.comparedTables).toBe(1);
  });

  it("не снятый материал без строки — по-прежнему замечание", () => {
    const verdict = serpPrintMatchesObservations({
      rendererSlides: [PRINTED_WITHOUT_4],
      observations: TOP,
      removedSerpRows: [],
    });
    expect(verdict.issues.some((i) => i.includes("secrets.tbank.ru/lichnyj-opyt/alisher-usmanov") && i.includes("позиция 4"))).toBe(true);
  });

  it("позиция без печатаемого адреса не ожидается, а её строка-заглушка не сверяется", () => {
    const verdict = serpPrintMatchesObservations({
      rendererSlides: [
        slide([
          [1, "forbes.ru/profile/alisher-usmanov", "Алишер Усманов"],
          [10, "—", "УСМАНОВ: Тайны биографии приближенного к власти ..."],
        ]),
      ],
      observations: [
        observation(1, "https://forbes.ru/profile/alisher-usmanov"),
        observation(10, "/goto?url=CAESYwHrOzAVNkxRn_CbVtAvsPwTNnL9kDzidscuF1"),
      ],
    });
    expect(verdict.issues).toEqual([]);
  });
});
