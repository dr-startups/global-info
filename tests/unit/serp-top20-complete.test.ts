/**
 * Таблица выдачи показывает обещанные двадцать строк без дыр в нумерации.
 *
 * Прогон 14.08, страница «Россия — Яндекс, ТОП-20»: напечатаны позиции
 * 1, 3, 4, 5, 6, 7, 8, 9, 10, 13…20 — семнадцать строк вместо двадцати.
 * Причин было две, и обе про доверие к таблице:
 *
 *   - позиция бралась у любого наблюдения материала, в том числе у такого, где
 *     запрос не записан. Страница Википедии стояла второй по запросу таблицы,
 *     но имела наблюдение без запроса с позицией 1 — и встала первой, оставив
 *     место 2 пустым;
 *   - строка о другом лице вычёркивалась целиком, и её номер исчезал.
 */

import { describe, expect, it } from "vitest";
import {
  OTHER_SUBJECT_LABEL,
  SERP_TABLE_HEADERS,
  SERP_TABLE_TOP_N,
  buildSerpFragment,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

type Row = {
  rank: number;
  title: string;
  url: string;
  query?: string;
  decision?: string;
};

const QUERY = "тимур ильдарович юнусов дети";

function scopedSerp(rows: Row[], extra: Row[] = []): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  [...rows, ...extra].forEach((r, i) => {
    const ref = `inventory:s${i}`;
    refs.push(ref);
    evidenceIndex[ref] = {
      title: r.title,
      url: r.url,
      domain: new URL(r.url).hostname,
      region: "RU",
      engine: "YANDEX",
      rank: r.rank,
      query: r.query,
      queryPurpose: r.query ? "subject_lookup" : undefined,
      subjectDecision: r.decision ?? "SUBJECT_MATCH",
    };
  });
  return {
    findings: [],
    surfaceUnits: [
      {
        surface: "organic",
        region: "RU",
        engine: "YANDEX",
        claims: [],
        metrics: [],
        evidenceRefs: refs,
      },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: { perRegionCounts: { RU: refs.length } },
  } as unknown as ScopedFragmentInput;
}

function tableRows(scoped: ScopedFragmentInput): string[][] {
  const { slides } = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped);
  return slides.flatMap((s) => s.content.table?.rows ?? []);
}

const RATING = SERP_TABLE_HEADERS.indexOf("Оценка");
/** Колонка заголовка — по имени: адрес уехал из таблицы в полосу, и номера сдвинулись. */
const TITLE = SERP_TABLE_HEADERS.indexOf("Заголовок");

describe("ТОП-20 без дыр в нумерации", () => {
  it("позиция берётся по запросу таблицы, а не по лучшему наблюдению", () => {
    const rows: Row[] = [
      { rank: 1, title: "Дети Тимати", url: "https://a.ru/1", query: QUERY },
      { rank: 2, title: "Тимати — Википедия", url: "https://ru.wikipedia.org/wiki/Тимати", query: QUERY },
      { rank: 3, title: "Бизнес-империя", url: "https://c.ru/3", query: QUERY },
    ];
    // То же наблюдение Википедии по другому запросу — с позицией 1.
    const extra: Row[] = [
      {
        rank: 1,
        title: "Тимати — Википедия",
        url: "https://ru.wikipedia.org/wiki/Тимати",
        query: "тимати",
      },
    ];
    const printed = tableRows(scopedSerp(rows, extra)).map((r) => r[0]);
    expect(printed).toEqual(["1", "2", "3"]);
  });

  it("наблюдение без запроса чужое место не занимает", () => {
    const rows: Row[] = [
      { rank: 1, title: "Первый", url: "https://a.ru/1", query: QUERY },
      { rank: 2, title: "Второй", url: "https://b.ru/2", query: QUERY },
    ];
    const extra: Row[] = [{ rank: 1, title: "Второй", url: "https://b.ru/2" }];
    const printed = tableRows(scopedSerp(rows, extra)).map((r) => r[0]);
    expect(printed).toEqual(["1", "2"]);
  });

  it("материал о другом лице занимает своё место и назван прямо", () => {
    const rows: Row[] = [
      { rank: 1, title: "Первый", url: "https://a.ru/1", query: QUERY },
      {
        rank: 2,
        title: "Тимати (тимур Юнусов) - главные новости",
        url: "https://b.ru/2",
        query: QUERY,
        decision: "OTHER_SUBJECT",
      },
      { rank: 3, title: "Третий", url: "https://c.ru/3", query: QUERY },
    ];
    const printed = tableRows(scopedSerp(rows));
    expect(printed.map((r) => r[0])).toEqual(["1", "2", "3"]);
    expect(printed[1]![RATING]).toBe(OTHER_SUBJECT_LABEL);
    expect(printed[0]![RATING]).not.toBe(OTHER_SUBJECT_LABEL);
  });

  it("набор данных без запросов вовсе таблицу не теряет", () => {
    // Старые прогоны запрос не сохраняли: там позиция — всё, что есть.
    const rows: Row[] = [
      { rank: 1, title: "Первый", url: "https://a.ru/1" },
      { rank: 2, title: "Второй", url: "https://b.ru/2" },
    ];
    expect(tableRows(scopedSerp(rows)).map((r) => r[0])).toEqual(["1", "2"]);
  });

  it("материал, найденный только другим запросом, в эту таблицу не попадает", () => {
    const rows: Row[] = [
      { rank: 1, title: "Первый", url: "https://a.ru/1", query: QUERY },
      { rank: 2, title: "Второй", url: "https://b.ru/2", query: QUERY },
    ];
    const extra: Row[] = [
      { rank: 3, title: "Чужой запрос", url: "https://d.ru/9", query: "тимати" },
    ];
    const printed = tableRows(scopedSerp(rows, extra)).map((r) => r[TITLE]);
    expect(printed).toEqual(["Первый", "Второй"]);
  });
});

describe("оценка строки берётся у прочитанной страницы", () => {
  /**
   * Отчёт 72: из двенадцати строк первой таблицы семь были «Нежелательными», и
   * это биографии. Строка красилась, если ссылка входит в доказательства любой
   * негативной находки, — независимо от того, что показала сама страница. Две
   * страницы модель прямо признала благоприятными, и они всё равно были
   * красными.
   */
  const RATING_COL = SERP_TABLE_HEADERS.indexOf("Оценка");

  function scopedWithTone(tone: string | undefined, title: string): ScopedFragmentInput {
    const scoped = scopedSerp([{ rank: 1, title, url: "https://svpressa.ru/1", query: QUERY }]);
    const e = scoped.evidenceIndex["inventory:s0"] as {
      adverse?: boolean;
      readVerdictTone?: string;
    };
    // Заголовок несёт слово «суд» — словарь красит такую строку сам.
    if (tone) e.readVerdictTone = tone;
    return scoped;
  }

  it("страница, признанная благоприятной, красной не становится", () => {
    const rows = tableRows(scopedWithTone("supportive", "Биография: суд признал дело сфабрикованным"));
    expect(rows[0]![RATING_COL]).not.toBe("Нежелательный");
  });

  it("нейтральная — тоже", () => {
    const rows = tableRows(scopedWithTone("neutral", "Биография: суд признал дело сфабрикованным"));
    expect(rows[0]![RATING_COL]).not.toBe("Нежелательный");
  });

  it("непрочитанная страница по-прежнему судится по заголовку", () => {
    const rows = tableRows(scopedWithTone(undefined, "Суд арестовал активы предпринимателя"));
    expect(rows[0]![RATING_COL]).toBe("Нежелательный");
  });

  it("страница, признанная нежелательной, остаётся красной", () => {
    const rows = tableRows(scopedWithTone("adverse", "Нейтрально звучащий заголовок"));
    expect(rows[0]![RATING_COL]).toBe("Нежелательный");
  });
});

describe("списки ТОП-20 — только из выдачи родного поисковика", () => {
  /**
   * Список Яндекса собирается из выдачи Яндекса, список Google — из Serper.
   * Обогатитель в списках не участвует: его нумерация без спецблоков дырявит
   * таблицу чужими местами. Отчёт 75: «Россия — Google» показала шесть строк
   * с дырами из позиций Arsenkin при ровной нумерации Serper тех же запросов.
   */
  function scopedWithSources(
    rows: Array<Row & { rankSource?: string }>
  ): ScopedFragmentInput {
    const scoped = scopedSerp(rows);
    rows.forEach((r, i) => {
      if (r.rankSource) {
        (scoped.evidenceIndex[`inventory:s${i}`] as { rankSource?: string }).rankSource =
          r.rankSource;
      }
    });
    return scoped;
  }

  it("позиция от обогатителя в таблицу не попадает", () => {
    const rows = [
      { rank: 1, title: "Родной первый", url: "https://a.ru/1", query: QUERY, rankSource: "yandex" },
      { rank: 2, title: "Чужая нумерация", url: "https://b.ru/2", query: QUERY, rankSource: "arsenkin" },
      { rank: 3, title: "Родной третий", url: "https://c.ru/3", query: QUERY, rankSource: "yandex" },
    ];
    const printed = tableRows(scopedWithSources(rows));
    expect(printed.map((r) => r[TITLE])).toEqual(["Родной первый", "Родной третий"]);
  });

  it("старый набор без источника позиции таблицу не теряет", () => {
    const rows = [
      { rank: 1, title: "Первый", url: "https://a.ru/1", query: QUERY },
      { rank: 2, title: "Второй", url: "https://b.ru/2", query: QUERY, rankSource: "unknown" },
    ];
    expect(tableRows(scopedWithSources(rows)).map((r) => r[0])).toEqual(["1", "2"]);
  });
});

describe("глубина аудита одна на сбор и на отчёт", () => {
  it("сбор Serper обязан просить не меньше, чем обещает таблица", async () => {
    const { SERP_AUDIT_DEPTH } = await import(
      "@/modules/digital-profile/services/orion-search-profile-service"
    );
    expect(SERP_AUDIT_DEPTH).toBe(SERP_TABLE_TOP_N);
  });
});
