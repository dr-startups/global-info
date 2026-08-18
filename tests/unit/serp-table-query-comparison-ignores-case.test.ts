/**
 * Запросы сравниваются регистронезависимо, и в одном месте.
 *
 * Регистр — свойство написания, а не запроса: поисковику он безразличен.
 * На прогоне 76 регистрозависимое `===` дало два противоположных исхода одного
 * дефекта. В ОАЭ выбранный запрос «viktor rashnikov» совпал со строкой
 * обогатителя посимвольно — и его нумерация вошла в таблицу. В России
 * «Рашников Виктор Филиппович» не совпал с «рашников виктор филиппович» — и
 * материалы того же запроса в таблицу не вошли, оставив шесть строк с дырами.
 */

import { describe, expect, it } from "vitest";
import {
  buildSerpFragment,
  pickSerpTableQuery,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import { subjectQueriesLine } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

type Row = { ref: string; rank: number; title: string; url: string; query: string };

function scopedFrom(rows: Row[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  for (const r of rows) {
    evidenceIndex[r.ref] = {
      title: r.title,
      url: r.url,
      domain: new URL(r.url).hostname,
      region: "RU",
      engine: "GOOGLE",
      rank: r.rank,
      rankSource: "serper",
      query: r.query,
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
        evidenceRefs: rows.map((r) => r.ref),
      },
    ],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function tableRows(scoped: ScopedFragmentInput): string[][] {
  const { slides } = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped);
  return slides.flatMap((s) => s.content.table?.rows ?? []);
}

describe("выбор запроса таблицы", () => {
  it("складывает варианты написания в один запрос", () => {
    const q = pickSerpTableQuery([
      { query: "Рашников Виктор Филиппович", queryPurpose: "subject_lookup" },
      { query: "рашников виктор филиппович", queryPurpose: "subject_lookup" },
      { query: "рашников виктор филиппович", queryPurpose: "subject_lookup" },
      { query: "рашников состояние", queryPurpose: "adverse_lookup" },
      { query: "рашников состояние", queryPurpose: "adverse_lookup" },
      { query: "рашников состояние", queryPurpose: "adverse_lookup" },
    ]);
    // Запрос об имени субъекта сильнее объёма материала, а печатная форма —
    // самое частое написание.
    expect(q).toBe("рашников виктор филиппович");
  });

  it("печатную форму выбирает воспроизводимо", () => {
    const first = pickSerpTableQuery([
      { query: "Рашников Виктор" },
      { query: "рашников виктор" },
    ]);
    const second = pickSerpTableQuery([
      { query: "рашников виктор" },
      { query: "Рашников Виктор" },
    ]);
    expect(first).toBe(second);
  });

  it("лишние пробелы не делают из запроса второй", () => {
    expect(
      pickSerpTableQuery([{ query: "рашников  виктор" }, { query: "рашников виктор" }])
    ).toBe("рашников виктор");
  });
});

describe("таблица собирается по запросу, а не по его написанию", () => {
  it("строки в другом регистре входят в ту же таблицу", () => {
    const rows = tableRows(
      scopedFrom([
        { ref: "i1", rank: 1, title: "Первый", url: "https://a.ru/1", query: "Рашников Виктор Филиппович" },
        { ref: "i2", rank: 2, title: "Второй", url: "https://b.ru/2", query: "рашников виктор филиппович" },
        { ref: "i3", rank: 3, title: "Третий", url: "https://c.ru/3", query: "Рашников Виктор Филиппович" },
      ])
    );
    expect(rows.map((r) => r[0])).toEqual(["1", "2", "3"]);
  });

  it("материал другого запроса в таблицу по-прежнему не попадает", () => {
    const rows = tableRows(
      scopedFrom([
        { ref: "i1", rank: 1, title: "Первый", url: "https://a.ru/1", query: "Рашников Виктор Филиппович" },
        { ref: "i2", rank: 2, title: "Второй", url: "https://b.ru/2", query: "рашников виктор филиппович" },
        { ref: "i3", rank: 3, title: "Чужой", url: "https://d.ru/3", query: "рашников яхта" },
      ])
    );
    expect(rows.map((r) => r[2])).toEqual(["Первый", "Второй"]);
  });
});

describe("строка о наборе запросов", () => {
  it("не печатает один запрос дважды в разном регистре", () => {
    const scoped = scopedFrom([
      { ref: "i1", rank: 1, title: "Первый", url: "https://a.ru/1", query: "Рашников Виктор Филиппович" },
      { ref: "i2", rank: 2, title: "Второй", url: "https://b.ru/2", query: "рашников виктор филиппович" },
    ]);
    const line = subjectQueriesLine(scoped);
    expect(line).toBe("Выдача проверена по 1 запросу: «рашников виктор филиппович».");
  });
});
