/**
 * Слияние не теряет пометку «это основной запрос».
 *
 * Пометка едет от набора запросов до деки шестью швами, и пять из них держали
 * тесты работы 1. Шестой — слияние базовых строк в составное наблюдение — не
 * держало ничто: обе его строки можно было выбросить, и весь набор из 3422
 * проверок оставался зелёным. Он же единственный шов, которого не видит ни один
 * корпус: `report-72` и фикстура золотого кейса собраны до появления пометки и
 * не несут её вовсе, поэтому ни приёмка, ни золотой кейс сюда не смотрят.
 *
 * Цена потери ровно та, ради которой затевалась партия: пометка не доезжает —
 * `mainSerpTableQuery` падает на запасное правило — при пяти равных написаниях
 * ФИО основным снова становится первое по алфавиту, и страница обещает «ТОП-20
 * по запросу», которого никто не выбирал. Молча.
 */

import { describe, expect, it } from "vitest";
import { mergeCompositeSerp } from "@/modules/digital-profile/services/composite-serp-merge";
import type { BaseCollectionManifest } from "@/modules/digital-profile/services/unified-collection-types";

const NAME = "Глинка Сергей Михайлович";
// Домен настоящий: `example.` слияние считает меткой демо-строки и выбрасывает
// такое наблюдение целиком (`MOCK_URL_PATTERN`).
const URL = "https://vedomosti.ru/glinka-sergey";

function manifest(ids: string[]): BaseCollectionManifest {
  return {
    version: "base-collection-manifest-v1",
    unifiedJobId: "unified-mark-1",
    caseId: "case-mark",
    capturedAt: "2026-08-30T00:00:00.000Z",
    baseReportRunId: "run-1",
    searchResultIds: ids,
    searchSurfaceItemIds: [],
    caseCorpusSearchResultIds: [],
    caseCorpusSurfaceItemIds: [],
    baseCount: ids.length,
    actualProviders: [],
    realCollectionSufficient: true,
  } as unknown as BaseCollectionManifest;
}

/**
 * Базовая строка выдачи так, как её пишет сборщик: пометка приходит в
 * `rawMetadata` рядом с запросом (`organicRowMetadata`).
 */
function organicRow(id: string, marked: boolean) {
  return {
    id,
    provider: "YANDEX",
    source: "REAL_YANDEX",
    type: "ORGANIC_RESULT",
    region: "RU",
    title: "Материал о субъекте",
    snippet: "Текст сниппета.",
    url: URL,
    rank: 1,
    rawMetadata: {
      query: NAME,
      orionRegion: "RU",
      queryPurpose: "subject_lookup",
      ...(marked ? { subjectNameQuery: true } : {}),
    },
    createdAt: new Date("2026-08-30T00:00:00.000Z"),
  };
}

async function mergedRows(rows: ReturnType<typeof organicRow>[]) {
  const prisma = {
    searchResult: { findMany: async () => rows },
    searchSurfaceItem: { findMany: async () => [] },
  } as never;
  const out = await mergeCompositeSerp({
    prisma,
    manifest: manifest(rows.map((r) => r.id)),
  });
  return out.observations.filter((o) => o.surface === "organic");
}

describe("пометка основного запроса переживает слияние", () => {
  it("доезжает из rawMetadata базовой строки в составное наблюдение", async () => {
    const [row] = await mergedRows([organicRow("sr-1", true)]);
    expect(row?.query).toBe(NAME);
    expect(row?.subjectNameQuery).toBe(true);
  });

  it("непомеченная строка пометки не приобретает", async () => {
    const [row] = await mergedRows([organicRow("sr-1", false)]);
    expect(row?.query).toBe(NAME);
    expect(row?.subjectNameQuery).toBeUndefined();
  });

  it("слитая строка несёт пометку, в каком бы порядке ни пришли наблюдения", async () => {
    // Один материал по одному запросу приходит двумя строками (два провайдера,
    // повторный сбор). Порядок здесь и решает: без слияния по ИЛИ пометку
    // сохранял бы только тот порядок, где помеченная строка пришла первой.
    const markedFirst = await mergedRows([organicRow("sr-1", true), organicRow("sr-2", false)]);
    const markedLast = await mergedRows([organicRow("sr-1", false), organicRow("sr-2", true)]);
    expect(markedFirst).toHaveLength(1);
    expect(markedLast).toHaveLength(1);
    expect(markedFirst[0]?.subjectNameQuery).toBe(true);
    expect(markedLast[0]?.subjectNameQuery).toBe(true);
  });
});
