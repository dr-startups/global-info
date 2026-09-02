import { describe, expect, it } from "vitest";
import { runSurfaceAnalyzers } from "@/modules/digital-profile/orion-golden/analytics/surface-analyzers";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

/**
 * Шаг AO. Аналитика и страница обязаны мерить «это маркер пустоты?» одной
 * линейкой.
 *
 * Признак маркера сверялся по «заголовок + сниппет», а с этого шага в сниппет
 * впервые едут килобайты прозы. Живой нейро-ответ почти наверняка содержит
 * оборот «в открытых источниках не найдено» — и настоящий ответ выпадал бы из
 * `collected`: страница печатает его (она сверяет только заголовок), а шапка
 * над ним говорит «Показано 0 результатов».
 */

function item(partial: Partial<RawInventoryItem> & { inventoryId: string }): RawInventoryItem {
  return {
    caseId: "case-1",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-08-20T00:00:00.000Z",
    evidenceType: "ai_answer",
    title: "Нейро-ответ Яндекса (официальный API): Тестов Иван",
    snippet: "",
    rawMetadata: { engine: "YANDEX", surface: "ai_answer" },
    ...partial,
  } as RawInventoryItem;
}

/** Настоящий нейро-ответ — это килобайты прозы, и оборот про «не найдено» в них законен. */
const ANSWER_WITH_NEGATIVE_PHRASE = [
  "Тестов Иван Иванович — российский предприниматель и совладелец нескольких производственных активов.",
  "По данным открытых источников, он возглавляет группу компаний с середины двухтысячных годов и входит в советы директоров двух отраслевых объединений.",
  "Сведений о судимости в открытых источниках не найдено.",
  "Упоминаний в санкционных перечнях н/д, по данным поисковой системы.",
  "Деловая пресса связывает предпринимателя с несколькими сделками по покупке региональных активов, детали которых стороны не раскрывали.",
  "Отдельные публикации отмечают его участие в образовательных и благотворительных программах региона.",
  "Часть материалов относится к полному тёзке и к предпринимателю отношения не имеет.",
].join(" ");

function aiUnits(items: RawInventoryItem[]) {
  const out = runSurfaceAnalyzers({
    caseId: "case-1",
    datasetId: "d-1",
    items,
    resolutionLookup: new Map(),
    sourceHashes: [],
  });
  return out.ai_answers.units;
}

describe("длинный ответ не превращается в маркер пустоты словом внутри текста", () => {
  it("ответ со словами «не найдено» в тексте остаётся собранным материалом", () => {
    const [unit] = aiUnits([
      item({ inventoryId: "obs-body", snippet: ANSWER_WITH_NEGATIVE_PHRASE }),
    ]);
    const metric = (key: string) => unit!.metrics.find((m) => m.key === key)?.value;
    expect(metric("totalCount")).toBe(1);
    expect(metric("emptyMarkerCount")).toBe(0);
    expect(unit!.emptyMarkerRefs).toEqual([]);
  });

  it("маркер по заголовку по-прежнему считается измеренной пустотой", () => {
    const [unit] = aiUnits([
      item({
        inventoryId: "obs-marker",
        title: "Нейро-ответ Яндекса: не найден",
        snippet: "Запрос поисковику отправлен, генеративного ответа по нему нет.",
      }),
    ]);
    const metric = (key: string) => unit!.metrics.find((m) => m.key === key)?.value;
    expect(metric("totalCount")).toBe(0);
    expect(metric("emptyMarkerCount")).toBe(1);
    expect(unit!.emptyMarkerRefs).toEqual(["inventory:obs-marker"]);
  });

  it("отказ модели по заголовку — тоже измеренная пустота", () => {
    const [unit] = aiUnits([
      item({
        inventoryId: "obs-rejected",
        title:
          "Нейро-ответ Яндекса: ответ не предоставлен — модель Яндекса отказалась отвечать на запрос (этические ограничения)",
        snippet: "Сработали этические ограничения модели.",
      }),
    ]);
    expect(unit!.metrics.find((m) => m.key === "emptyMarkerCount")?.value).toBe(1);
  });

  it("служебная пометка в сниппете при нейтральном заголовке остаётся маркером", () => {
    // Форма записи проверки Википедии: заголовок «Wikipedia» ни о чём не
    // говорит, признак живёт ровно в короткой служебной фразе.
    const [unit] = aiUnits([
      item({
        inventoryId: "obs-wiki",
        title: "Wikipedia",
        snippet: "Фактическая проверка Wikipedia: статья не найдена.",
      }),
    ]);
    expect(unit!.metrics.find((m) => m.key === "emptyMarkerCount")?.value).toBe(1);
  });

  it("маркер прочих поверхностей, у которых слова стоят в сниппете, считается как прежде", () => {
    // Арсенкинские маркеры несут признак в заголовке, а не в тексте, — правило
    // «сверяем заголовок» их не задевает.
    const [unit] = aiUnits([
      item({
        inventoryId: "obs-arsenkin",
        source: "arsenkin",
        provider: "arsenkin",
        title: "ИИ-ответ (Алиса): не найден",
        snippet: "В выдаче нет блока поискового ИИ по запросу.",
      }),
    ]);
    expect(unit!.metrics.find((m) => m.key === "emptyMarkerCount")?.value).toBe(1);
  });
});
