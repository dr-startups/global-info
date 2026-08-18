/**
 * Таблица поисковика печатает позиции своего поисковика — и все свои.
 *
 * Прогон 76, страница «ОАЭ — Google, ТОП-20»: 12 печатных строк из 19 несли
 * нумерацию обогатителя (4 — metalinfo.ru, 10 — ko.ru, весь хвост 11–20), а
 * настоящие позиции Serper — 3 opensanctions.org, 4 bloomberg.com,
 * 10 wikidata.org — в таблицу не попали вовсе. На соседней странице снимок той
 * же выдачи выделял opensanctions.org первым результатом: разворот спорил сам
 * с собой.
 *
 * Проверяется весь тракт среза: наблюдения → загрузчик деки → область
 * фрагмента → построитель таблицы.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeckInputsFromAnalyticsDir } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import { buildScopedInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import { buildSerpFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import {
  UAE_UNCATEGORIZED_REFS,
  run76UaeObservations,
  writeSerpAnalyticsDir,
} from "../fixtures/run76-serp-slice";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** Таблицы деки на срезе прогона 76 — тем же путём, что и у продукта. */
function uaeTableRows(): string[][] {
  const dir = mkdtempSync(join(tmpdir(), "serp-own-ranks-"));
  tempDirs.push(dir);
  writeSerpAnalyticsDir(dir, {
    observations: run76UaeObservations(),
    uncategorizedRefs: UAE_UNCATEGORIZED_REFS,
  });
  const inputs = loadDeckInputsFromAnalyticsDir(dir);
  const scoped = buildScopedInput({
    subject: { displayName: "Виктор Рашников", aliases: ["Viktor Rashnikov"] },
    bundle: inputs.mergedBundle,
    surfaceUnits: inputs.surfaceUnits,
    metricSnapshot: inputs.metricSnapshot,
    scope: { regions: ["UAE"], surfaces: ["organic"], subjectMatch: ["SUBJECT_MATCH"], findingIds: null },
    evidenceIndex: inputs.evidenceIndex,
  });
  const { slides } = buildSerpFragment("UAE_SERP", "UAE_PROFILE", "ОАЭ", scoped);
  return slides.flatMap((s) => s.content.table?.rows ?? []);
}

/** Строка таблицы: номер и адрес — то, что читает клиент. */
function printed(rows: string[][]): Array<{ rank: number; link: string }> {
  return rows.map((r) => ({ rank: Number(r[0]), link: String(r[1]) }));
}

describe("таблица ОАЭ — Google на срезе прогона 76", () => {
  it("не содержит ни одной строки с арсенкинским рангом", () => {
    const rows = printed(uaeTableRows());
    expect(rows.every((r) => r.rank <= 10)).toBe(true);
    expect(rows.some((r) => r.link.includes("metalinfo.ru"))).toBe(false);
    expect(rows.some((r) => r.link.includes("ko.ru"))).toBe(false);
  });

  it("печатает настоящие позиции Serper: 3, 4 и 10", () => {
    const byRank = new Map(printed(uaeTableRows()).map((r) => [r.rank, r.link]));
    const at = (rank: number): string => byRank.get(rank) ?? "<строки нет>";
    expect(at(3)).toContain("opensanctions.org");
    expect(at(4)).toContain("bloomberg.com");
    expect(at(10)).toContain("wikidata.org");
  });

  it("показывает ровно десять собранных позиций подряд", () => {
    expect(printed(uaeTableRows()).map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

/** Индекс доказательств вручную — для случаев, которых в срезе нет. */
function scopedFrom(
  rows: Array<{
    ref: string;
    rank?: number;
    rankSource?: string;
    engine?: string;
    query?: string;
    title: string;
    url: string;
  }>
): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  for (const r of rows) {
    evidenceIndex[r.ref] = {
      title: r.title,
      url: r.url,
      domain: new URL(r.url).hostname,
      region: "RU",
      engine: r.engine,
      rank: r.rank,
      rankSource: r.rankSource,
      query: r.query,
      queryPurpose: r.query ? "subject_lookup" : undefined,
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
        evidenceRefs: rows.map((r) => r.ref),
      },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function tablesOf(scoped: ScopedFragmentInput): Array<{ title: string; rows: string[][] }> {
  const { slides } = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped);
  return slides
    .filter((s) => (s.content.table?.rows.length ?? 0) > 0)
    .map((s) => ({ title: s.title, rows: s.content.table!.rows }));
}

describe("материал, найденный обоими поисковиками", () => {
  it("стоит в обеих таблицах со своим номером", () => {
    // Группа материалов раскладывалась по движку первого наблюдения целиком:
    // страница, найденная и Яндексом, и Google, уезжала в одну таблицу и
    // оставляла в другой дыру. Позиция — свойство пары «движок × запрос».
    const scoped = scopedFrom([
      { ref: "i1", rank: 1, rankSource: "yandex", engine: "YANDEX", query: "рашников", title: "Forbes", url: "https://forbes.ru/rashnikov" },
      { ref: "i2", rank: 5, rankSource: "serper", engine: "GOOGLE", query: "рашников", title: "Forbes", url: "https://forbes.ru/rashnikov" },
      { ref: "i3", rank: 2, rankSource: "yandex", engine: "YANDEX", query: "рашников", title: "РБК", url: "https://rbc.ru/rashnikov" },
      { ref: "i4", rank: 1, rankSource: "serper", engine: "GOOGLE", query: "рашников", title: "ММК", url: "https://mmk.ru/rashnikov" },
    ]);
    const tables = tablesOf(scoped);
    const yandex = tables.find((t) => t.title.includes("Яндекс"))!;
    const google = tables.find((t) => t.title.includes("Google"))!;
    expect(yandex.rows.map((r) => [r[0], r[2]])).toEqual([
      ["1", "Forbes"],
      ["2", "РБК"],
    ]);
    expect(google.rows.map((r) => [r[0], r[2]])).toEqual([
      ["1", "ММК"],
      ["5", "Forbes"],
    ]);
  });
});

describe("датасетная политика неизвестного источника позиции", () => {
  it("набор без источника вовсе таблицу не теряет", () => {
    const scoped = scopedFrom([
      { ref: "i1", rank: 1, engine: "YANDEX", query: "рашников", title: "Первый", url: "https://a.ru/1" },
      { ref: "i2", rank: 2, rankSource: "unknown", engine: "YANDEX", query: "рашников", title: "Второй", url: "https://b.ru/2" },
    ]);
    expect(tablesOf(scoped)[0]!.rows.map((r) => r[0])).toEqual(["1", "2"]);
  });

  it("в смешанном наборе безымянная позиция в таблицу не входит", () => {
    // Построчное «источник не назван — значит, свой» и было той лазейкой,
    // через которой жила потеря признака: смешанный набор проходил целиком.
    const scoped = scopedFrom([
      { ref: "i1", rank: 1, rankSource: "yandex", engine: "YANDEX", query: "рашников", title: "Свой", url: "https://a.ru/1" },
      { ref: "i2", rank: 2, engine: "YANDEX", query: "рашников", title: "Безымянный", url: "https://b.ru/2" },
      { ref: "i3", rank: 3, rankSource: "arsenkin", engine: "YANDEX", query: "рашников", title: "Обогатитель", url: "https://c.ru/3" },
    ]);
    expect(tablesOf(scoped)[0]!.rows.map((r) => r[2])).toEqual(["Свой"]);
  });
});

describe("наблюдение без запроса не получает чужой номер", () => {
  it("безымянная строка не печатается там, где у набора есть запросы", () => {
    /*
     * Прогон 76: печатный «7 lenta.ru» — ранг агентского наблюдения без
     * запроса, а настоящий №7 выбранного запроса был выброшен как дубль.
     *
     * Безымянная строка идёт **раньше** настоящей: так она и стояла в живом
     * наборе, и только в этом порядке видно правило. Поставленная второй, она
     * отбрасывается `dropDuplicateRanks` по порядку индексов, и тест остаётся
     * зелёным даже с прежним фолбэком.
     */
    const scoped = scopedFrom([
      { ref: "i1", rank: 6, rankSource: "serper", engine: "GOOGLE", query: "рашников", title: "Шестой", url: "https://a.ru/6" },
      { ref: "i2", rank: 7, rankSource: "serper", engine: "GOOGLE", title: "Безымянный", url: "https://lenta.ru/7" },
      { ref: "i3", rank: 7, rankSource: "serper", engine: "GOOGLE", query: "рашников", title: "Седьмой", url: "https://tadviser.ru/7" },
    ]);
    const rows = tablesOf(scoped)[0]!.rows;
    expect(rows.map((r) => r[2])).toEqual(["Шестой", "Седьмой"]);
  });

  it("безымянная строка не занимает и свободный номер", () => {
    // Свободное место соблазнительнее занятого: тут дубль ранга правило не
    // подменяет — если фолбэк вернётся, строка встанет девятой.
    const scoped = scopedFrom([
      { ref: "i1", rank: 6, rankSource: "serper", engine: "GOOGLE", query: "рашников", title: "Шестой", url: "https://a.ru/6" },
      { ref: "i2", rank: 9, rankSource: "serper", engine: "GOOGLE", title: "Безымянный", url: "https://lenta.ru/9" },
    ]);
    expect(tablesOf(scoped)[0]!.rows.map((r) => r[2])).toEqual(["Шестой"]);
  });

  it("набор целиком без запросов работает как раньше", () => {
    const scoped = scopedFrom([
      { ref: "i1", rank: 1, rankSource: "serper", engine: "GOOGLE", title: "Первый", url: "https://a.ru/1" },
      { ref: "i2", rank: 2, rankSource: "serper", engine: "GOOGLE", title: "Второй", url: "https://b.ru/2" },
    ]);
    expect(tablesOf(scoped)[0]!.rows.map((r) => r[0])).toEqual(["1", "2"]);
  });
});
