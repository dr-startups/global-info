/**
 * Метрики листа выдачи описывают его собственную таблицу.
 *
 * Заголовок листа считает листы **внутри движка** («(1/2)»), а `pageCount`
 * считал листы всех движков фрагмента подряд: на эталоне-72 четыре российских
 * листа получали `pageCount: 4` при заголовках «(1/2)(2/2)» дважды, на золотом
 * кейсе — четырнадцать при заголовках «(1/7)…(7/7)». `datasetCount` и
 * `uniqueMaterials` при этом описывали **регион**, а печатались на листе одного
 * движка и одного запроса: на прогоне 92 лист Яндекса нёс 403 и 149.
 *
 * `docs/ENGINEERING.md` («Таблица печатает адрес один раз, и единица счёта у
 * таблиц разная») на стороне заголовка: единица — таблица одного движка одного
 * региона. Здесь это закрепляется тем, что пара «номер/всего» у заголовка и у
 * метрики — одна величина, а не два вычисления.
 */

import { describe, expect, it } from "vitest";
import {
  SERP_TABLE_HEADERS,
  buildSerpFragment,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import { DECK_TEMPLATE_REGISTRY } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const QUERY = "Кремлев Умар Назарович";

/** Ёмкость листа объявлена реестром — второго ответа здесь нет. */
const CAP = DECK_TEMPLATE_REGISTRY["serp-table"].maxTableRowsPerSlide;

type Row = { engine: string; rank?: number; host: string; query?: string | null };

function scopedOf(rows: Row[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  rows.forEach((row, i) => {
    const ref = `inventory:s${i}`;
    refs.push(ref);
    evidenceIndex[ref] = {
      title: `Материал ${row.host}`,
      url: `https://${row.host}/umar-kremlev`,
      domain: row.host,
      region: "RU",
      engine: row.engine,
      ...(row.rank ? { rank: row.rank, rankSource: row.engine.toLowerCase() } : {}),
      ...(row.query === null ? {} : { query: row.query ?? QUERY, queryPurpose: "subject_lookup" }),
      subjectDecision: "SUBJECT_MATCH",
    };
  });
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

/** Только листы главной таблицы: у второй свои колонки и свой счёт. */
function mainSheets(rows: Row[]): SlideContentContract[] {
  return buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scopedOf(rows)).slides.filter(
    (s) => (s.content.table?.headers ?? [])[0] === SERP_TABLE_HEADERS[0]
  );
}

/**
 * Два движка одного региона: у Яндекса четыре материала, у Google — пять.
 *
 * Полосы намеренно разные: пока метрика описывала регион, оба движка печатали
 * одно и то же число, и подмену было не отличить от правды.
 */
function twoEngines(): Row[] {
  const yandex: Row[] = ["a", "b", "c", "d"].map((h, i) => ({
    engine: "YANDEX",
    rank: i + 1,
    host: `ya-${h}.example.org`,
  }));
  const google: Row[] = ["a", "b", "c", "d", "e"].map((h, i) => ({
    engine: "GOOGLE",
    rank: i + 1,
    host: `go-${h}.example.org`,
  }));
  return [...yandex, ...google];
}

const suffixOf = (slide: SlideContentContract): string =>
  slide.title.match(/\((\d+)\/(\d+)\)\s*$/u)?.[0] ?? "";

const engineOf = (slide: SlideContentContract): string => String(slide.metrics?.serpEngine ?? "");

describe("лист выдачи считает свою таблицу", () => {
  it("суффикс заголовка и пара pageIndex/pageCount — одна величина", () => {
    for (const slide of mainSheets(twoEngines())) {
      expect(suffixOf(slide)).toBe(`(${slide.metrics?.pageIndex}/${slide.metrics?.pageCount})`);
    }
  });

  it("две таблицы по два листа дают pageCount 2, а не 4", () => {
    const sheets = mainSheets(twoEngines());
    // Яндекс: 4 строки → 3 + 1; Google: 5 строк → 3 + 2. Всего четыре листа.
    expect(sheets).toHaveLength(4);
    expect(sheets.map((s) => s.metrics?.pageCount)).toEqual([2, 2, 2, 2]);
    expect(sheets.map((s) => s.metrics?.pageIndex)).toEqual([1, 2, 1, 2]);
  });

  it("движки с разными полосами несут разные числа, а листы одной таблицы — одинаковые", () => {
    const sheets = mainSheets(twoEngines());
    const ya = sheets.filter((s) => engineOf(s) === "YANDEX");
    const go = sheets.filter((s) => engineOf(s) === "GOOGLE");
    expect(ya.map((s) => s.metrics?.datasetCount)).toEqual([4, 4]);
    expect(ya.map((s) => s.metrics?.uniqueMaterials)).toEqual([4, 4]);
    expect(go.map((s) => s.metrics?.datasetCount)).toEqual([5, 5]);
    expect(go.map((s) => s.metrics?.uniqueMaterials)).toEqual([5, 5]);
  });

  it("ни один лист не печатает число региона", () => {
    // Пакетная метрика остаётся региональной — она отвечает на вопрос
    // фрагмента; лист же спрашивают о его таблице, и девятка региона на нём
    // ответ не на тот вопрос.
    for (const slide of mainSheets(twoEngines())) {
      expect(slide.metrics?.datasetCount).not.toBe(9);
      expect(slide.metrics?.uniqueMaterials).not.toBe(9);
    }
  });

  it("напечатанных строк не больше, чем наблюдений её полосы", () => {
    for (const slide of mainSheets(twoEngines())) {
      expect(Number(slide.metrics?.displayedCount)).toBeLessThanOrEqual(
        Number(slide.metrics?.datasetCount)
      );
      expect(Number(slide.metrics?.displayedCount)).toBeLessThanOrEqual(CAP);
    }
  });
});

describe("непозиционная таблица без запроса", () => {
  /** Кадр эталона-72: позиций набор не несёт, запрос не записан. */
  const unranked: Row[] = ["a", "b", "c", "d"].map((h) => ({
    engine: "YANDEX",
    host: `no-rank-${h}.example.org`,
    query: null,
  }));

  it("полоса равна движку целиком и в ноль не схлопывается", () => {
    const sheets = mainSheets(unranked);
    expect(sheets).toHaveLength(2);
    for (const slide of sheets) {
      expect(slide.metrics?.serpPositional).toBe(0);
      expect(slide.metrics?.datasetCount).toBe(4);
      expect(slide.metrics?.uniqueMaterials).toBe(4);
      expect(Number(slide.metrics?.displayedCount)).toBeLessThanOrEqual(
        Number(slide.metrics?.datasetCount)
      );
    }
  });
});

/**
 * Безымянные наблюдения относятся к таблице одной линейкой.
 *
 * Кадр агентского сборщика: `real-search-agent-base.ts` пишет строки **без**
 * запроса (70 из 1039 наблюдений прогона 92). Материалы такой строки в таблицу
 * попадают — «наблюдение без записанного запроса относим к любому запросу», —
 * а полоса `datasetCount` их не считала, потому что `sameSerpQuery` отдаёт
 * `false` при пустом запросе. Лист сообщал «показано 3» при «данных 1» и
 * «материалов 6»: на один вопрос «относится ли безымянное наблюдение к этой
 * таблице» пара чисел отвечала по-разному.
 */
describe("таблица с запросом и безымянными наблюдениями", () => {
  /** Одно наблюдение с запросом (без позиции) и пять безымянных с позициями. */
  const mixed: Row[] = [
    { engine: "YANDEX", host: "named.example.org" },
    ...["a", "b", "c", "d", "e"].map((h, i) => ({
      engine: "YANDEX",
      rank: i + 1,
      host: `anon-${h}.example.org`,
      query: null,
    })),
  ];

  it("оба числа считают безымянное наблюдение одинаково", () => {
    for (const slide of mainSheets(mixed)) {
      expect(slide.metrics?.uniqueMaterials).toBe(6);
      expect(slide.metrics?.datasetCount).toBe(6);
    }
  });

  it("напечатанных строк не больше, чем наблюдений полосы", () => {
    const sheets = mainSheets(mixed);
    expect(sheets.length).toBeGreaterThan(1);
    for (const slide of sheets) {
      expect(Number(slide.metrics?.displayedCount)).toBeLessThanOrEqual(
        Number(slide.metrics?.datasetCount)
      );
    }
  });
});
