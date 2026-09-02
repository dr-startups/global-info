/**
 * Фраза о пропуске номера принадлежит области своего предиката.
 *
 * Стр. 22 прогона 92: «Позиции 9, 11, 19 не вернул ни один источник выдачи в
 * этом прогоне» — позицию 9 вернул. В бандле лежит наблюдение
 * `GOOGLE|RU|organic|www.rusprofile.ru/person/kremlyov-…` с `rank: 9`,
 * `ranksByProvider: {"serper": 9}` и **пустым запросом**; тот же адрес
 * напечатан на этом же листе строкой 8. Предикат «занято» фильтровал
 * наблюдения строго по запросу листа, а `sameSerpQuery` отдаёт `false` при
 * пустом левом запросе — безымянное чтение не попадало в «занято» никогда.
 *
 * Правок две, и они разные:
 *
 * - безымянное чтение **допускается** в «занято»: утверждение остаётся о нашей
 *   таблице («материал напечатан выше под другим номером»), и это верно без
 *   запроса. Чтение с **другим названным** запросом по-прежнему не в счёт —
 *   решение 0042 не отменяется;
 * - вторая ветка называет свою область: «по этому запросу». Набор без запроса
 *   (эталон-72) фильтра не знает вовсе, и прежняя фраза там верна дословно.
 */

import { describe, expect, it } from "vitest";
import {
  SERP_TABLE_HEADERS,
  buildSerpFragment,
  serpRankGapSentences,
  serpTablePageProse,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const QUERY = "Кремлев Умар Назарович";
const OTHER_QUERY = "Кремлев бокс";

/** Наблюдение корпуса: чей запрос, какая позиция и что о ней знают чтения. */
type Obs = {
  host: string;
  rank: number;
  /** `null` — запрос у наблюдения не записан (агентский сборщик). */
  query: string | null;
  /** `null` — поле не доехало вовсе: набор о втором чтении не знает. */
  ranksByProvider?: Record<string, number> | null;
};

function scopedOf(rows: Obs[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  rows.forEach((row, i) => {
    const ref = `inventory:s${i}`;
    refs.push(ref);
    evidenceIndex[ref] = {
      title: `Материал ${row.host}`,
      url: `https://${row.host}/kremlev`,
      domain: row.host,
      region: "RU",
      engine: "GOOGLE",
      rank: row.rank,
      rankSource: "serper",
      ...(row.ranksByProvider === null
        ? {}
        : { ranksByProvider: row.ranksByProvider ?? { serper: row.rank } }),
      ...(row.query === null ? {} : { query: row.query, queryPurpose: "subject_lookup" }),
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

/** Восемь напечатанных материалов; девятый номер — у восьмого материала. */
function eightPrinted(): Obs[] {
  return ["a", "b", "c", "d", "e", "f", "g", "h"].map((h, i) => ({
    host: `m-${h}.example.org`,
    rank: i + 1,
    query: QUERY,
  }));
}

/** Второе чтение того же материала: тот же адрес, другой номер. */
const secondReadingOfLastRow = (query: string | null): Obs => ({
  host: "m-h.example.org",
  rank: 9,
  query,
  ranksByProvider: { serper: 9 },
});

function leadOf(rows: Obs[]): string {
  const sheets: SlideContentContract[] = buildSerpFragment(
    "RU_SERP",
    "RU_PROFILE",
    "Россия",
    scopedOf(rows)
  ).slides.filter((s) => (s.content.table?.headers ?? [])[0] === SERP_TABLE_HEADERS[0]);
  return sheets.map((s) => String(s.content.narrative ?? "")).join(" ");
}

describe("пропущенный номер, который дало безымянное чтение", () => {
  it("объявляется занятым напечатанным выше материалом", () => {
    const lead = leadOf([...eightPrinted(), secondReadingOfLastRow(null)]);
    expect(lead).toContain("Позиция 9 занята материалом, показанным выше под другим номером.");
  });

  it("не объявляется невозвращённым", () => {
    const lead = leadOf([...eightPrinted(), secondReadingOfLastRow(null)]);
    expect(lead).not.toMatch(/Позици[юи] 9[^0-9]/u);
    expect(lead).toContain("Позиции 10–20 по этому запросу не вернул ни один источник");
  });
});

describe("пропущенный номер, который дало чтение другого названного запроса", () => {
  it("остаётся невозвращённым: решение 0042 не отменено", () => {
    const lead = leadOf([...eightPrinted(), secondReadingOfLastRow(OTHER_QUERY)]);
    expect(lead).not.toContain("занята материалом");
    expect(lead).toContain("Позиции 9–20 по этому запросу не вернул ни один источник");
  });
});

describe("вторая ветка называет свою область", () => {
  const gaps = {
    printed: [1, 2, 3],
    collected: [1, 2, 3],
    occupied: [] as number[],
    datasetKnowsSecondReading: true,
    positional: true,
    topN: 4,
  };

  it("у таблицы есть запрос — оговорка «по этому запросу» стоит", () => {
    expect(serpRankGapSentences({ ...gaps, queryNamed: true })).toEqual([
      "Позицию 4 по этому запросу не вернул ни один источник выдачи в этом прогоне.",
    ]);
  });

  it("у таблицы запроса нет — фраза прежняя, без оговорки", () => {
    expect(serpRankGapSentences({ ...gaps, queryNamed: false })).toEqual([
      "Позицию 4 не вернул ни один источник выдачи в этом прогоне.",
    ]);
  });

  it("несколько номеров — та же область", () => {
    // Форма стр. 22 прогона 92: пропуски идут не подряд («9, 11, 19»), и
    // перечень остаётся перечнем, а не диапазоном.
    expect(
      serpRankGapSentences({ ...gaps, printed: [1, 3], collected: [1, 3], queryNamed: true })
    ).toEqual(["Позиции 2, 4 по этому запросу не вернул ни один источник выдачи в этом прогоне."]);
  });
});

describe("набор, не знающий о втором чтении", () => {
  const depth = {
    printed: [1, 2, 3],
    collected: [1, 2, 3],
    occupied: [] as number[],
    datasetKnowsSecondReading: false,
    positional: true,
    topN: 4,
  };

  it("печатает только измеренную глубину и ни одной из двух веток", () => {
    expect(serpRankGapSentences({ ...depth, queryNamed: true })).toEqual([
      "Поисковик вернул по этому запросу 3 позиции из 4; остальных в выдаче на дату сбора не было.",
    ]);
  });

  it("у таблицы без запроса глубина названа без оговорки", () => {
    // Третья ветка меряет ту же полосу, что и вторая, и обязана называть ту же
    // область. Лист набора без запроса говорил подряд «запрос, по которому она
    // собрана, в наборе не записан» и «Поисковик вернул по этому запросу N
    // позиций» — две соседние фразы, спорящие друг с другом.
    expect(serpRankGapSentences({ ...depth, queryNamed: false })).toEqual([
      "Поисковик вернул 3 позиции из 4; остальных в выдаче на дату сбора не было.",
    ]);
  });
});

/**
 * Оговорку назначает таблица, а не ветка.
 *
 * Признак `queryNamed` заводится в лиде (`serpTablePageProse`) из запроса
 * таблицы. Пока это не было закреплено поведением, подмена признака на `true`
 * наглухо краснила один лишь сторож отпечатка построителей: лист набора **без**
 * запроса напечатал бы клиенту оговорку «по этому запросу» о запросе, которого
 * нет.
 */
describe("оговорка приходит от таблицы, а не от ветки", () => {
  const table = {
    engineLabel: "Яндекса",
    positional: true,
    printedRanks: [1, 2, 3],
    collectedRanks: [1, 2, 3],
    occupiedRanks: [] as number[],
    datasetKnowsSecondReading: true,
  };

  it("таблица без запроса не говорит «по этому запросу» ни в одной ветке", () => {
    expect(serpTablePageProse({ ...table, query: null }).head).not.toMatch(/по этому запросу/u);
    expect(
      serpTablePageProse({ ...table, query: null, datasetKnowsSecondReading: false }).head
    ).not.toMatch(/по этому запросу/u);
  });

  it("таблица с запросом оговорку несёт", () => {
    expect(serpTablePageProse({ ...table, query: QUERY }).head).toContain(
      "по этому запросу не вернул ни один источник"
    );
    expect(
      serpTablePageProse({ ...table, query: QUERY, datasetKnowsSecondReading: false }).head
    ).toContain("Поисковик вернул по этому запросу 3 позиции");
  });
});

/**
 * Глубина в лиде считается по той же полосе, что и `datasetCount`.
 *
 * Следствие единой линейки `refInQuery` (закрытие находки 1 круга 2), названное
 * вслух и здесь, и в `docs/ENGINEERING.md`: в число «вернул по этому запросу N
 * позиций» входят и безымянные чтения, то есть позиции, которых этому запросу
 * не приписывал никто. Размен тот же, что у «занято»: вторая половина фразы —
 * утверждение об отсутствии («остальных в выдаче не было»), и чтение, которое
 * позицию видело, делает её более верной.
 *
 * Кадры пинят **существующее** поведение (красной фазы у них нет): они нужны,
 * чтобы возврат `collectedRanks` на строгую линейку не прошёл молча — он менял
 * бы напечатанное клиенту число.
 */
describe("глубина в лиде считает и безымянные чтения", () => {
  /** Набор без второго чтения: `ranksByProvider` не доехал ни у одной строки. */
  const named: Obs[] = [1, 2, 3].map((rank) => ({
    host: `m-${rank}.example.org`,
    rank,
    query: QUERY,
    ranksByProvider: null,
  }));
  const anonymous = (ranks: number[]): Obs[] =>
    ranks.map((rank) => ({
      host: `anon-${rank}.example.org`,
      rank,
      query: null,
      ranksByProvider: null,
    }));

  it("безымянные позиции входят в число, названное «по этому запросу»", () => {
    // Три названных позиции 1–3 плюс безымянные чтения 7 и 8: строгая линейка
    // дала бы «3 позиции из 20».
    expect(leadOf([...named, ...anonymous([7, 8])])).toContain(
      "Поисковик вернул по этому запросу 5 позиций из 20"
    );
  });

  it("безымянные чтения, добравшие глубину до двадцати, снимают фразу о пропуске", () => {
    const ranks = Array.from({ length: 17 }, (_, i) => i + 4);
    const lead = leadOf([...named, ...anonymous(ranks)]);
    expect(lead).not.toMatch(/Поисковик вернул/u);
    expect(lead).not.toMatch(/не вернул ни один источник/u);
  });
});
