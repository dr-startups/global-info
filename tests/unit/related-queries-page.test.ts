import { describe, expect, it } from "vitest";
import {
  RELATED_QUERIES_PER_PAGE,
  buildRelatedQueriesFragment,
  fitRelatedRows,
  uniqueRelatedRows,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/related";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

function ref(i: number): string {
  return `inventory:q${i}`;
}

/** Набор связанных запросов поверхности: N штук, каждый k-й — негативный. */
function scopedWith(queries: Array<{ text: string; adverse?: boolean }>): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  queries.forEach((q, i) => {
    evidenceIndex[ref(i)] = {
      title: q.text,
      domain: "yandex.ru",
      url: `https://yandex.ru/search/?text=${i}`,
      region: "RU",
      adverse: q.adverse === true,
    };
  });
  return {
    findings: [],
    surfaceUnits: [
      {
        surface: "paa_related",
        region: "RU",
        engine: "YANDEX",
        claims: [],
        metrics: [],
        evidenceRefs: queries.map((_, i) => ref(i)),
      },
    ],
    evidenceIndex,
    scope: {},
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function build(scoped: ScopedFragmentInput) {
  return buildRelatedQueriesFragment("RU_RELATED", "RU_PROFILE", "Россия", scoped, {});
}

/** Сколько строк названо в описании страницы. */
function statedCount(text: string | undefined): number {
  const m = /(?:на панели|на этой странице) — (\d+)/iu.exec(String(text ?? ""));
  return m ? Number(m[1]) : -1;
}

describe("строки поверхности", () => {
  it("один и тот же запрос от двух систем печатается один раз", () => {
    const rows = uniqueRelatedRows(
      [ref(0), ref(1), ref(2)],
      {
        [ref(0)]: { title: "Киркоров дети" },
        [ref(1)]: { title: "киркоров  дети?" },
        [ref(2)]: { title: "Киркоров суд" },
      } as never,
      new Set()
    );
    expect(rows.map((r) => r.text)).toEqual(["Киркоров дети", "Киркоров суд"]);
  });

  it("строка без текста в отчёт не идёт", () => {
    const rows = uniqueRelatedRows([ref(0), ref(1)], { [ref(0)]: { title: "  " }, [ref(1)]: { title: "Запрос" } } as never, new Set());
    expect(rows).toHaveLength(1);
  });

  it("негативным считается и по разметке, и по ссылке находки, и по формулировке", () => {
    const rows = uniqueRelatedRows(
      [ref(0), ref(1), ref(2)],
      {
        [ref(0)]: { title: "Обычный запрос", adverse: true },
        [ref(1)]: { title: "Нейтральный запрос" },
        [ref(2)]: { title: "Иванов уголовное дело" },
      } as never,
      new Set([ref(1)])
    );
    expect(rows.map((r) => r.adverse)).toEqual([true, true, true]);
  });
});

describe("обрезка по ёмкости раздела", () => {
  it("негативные формулировки остаются, даже если стоят в конце списка", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => ({ ref: ref(i), text: `neutral ${i}`, adverse: false })),
      { ref: ref(9), text: "суд", adverse: true },
    ];
    const fitted = fitRelatedRows(rows, 3);
    expect(fitted.rows.map((r) => r.text)).toEqual(["neutral 0", "neutral 1", "суд"]);
    expect(fitted.dropped).toBe(3);
  });

  it("когда всё помещается, ничего не выбрасывается", () => {
    const rows = [{ ref: ref(0), text: "a", adverse: false }];
    expect(fitRelatedRows(rows, 10)).toEqual({ rows, dropped: 0 });
  });
});

describe("страница связанных запросов", () => {
  it("описание считает ровно те строки, что напечатаны", () => {
    // 14 запросов на три листа: 5/5/4 — числа в описании обязаны совпасть.
    const scoped = scopedWith(
      Array.from({ length: 14 }, (_, i) => ({ text: `запрос ${i + 1}`, adverse: i % 7 === 0 }))
    );
    const { slides } = build(scoped);
    expect(slides).toHaveLength(3);
    for (const slide of slides) {
      const shown = slide.content.bullets?.length ?? 0;
      expect(shown).toBeGreaterThan(0);
      expect(statedCount(slide.content.whatWasFound)).toBe(shown);
    }
    const printed = slides.flatMap((s) => s.content.bullets ?? []);
    expect(printed).toHaveLength(14);
  });

  it("собранное по региону названо отдельным числом, а не подменено показанным", () => {
    const scoped = scopedWith(Array.from({ length: 6 }, (_, i) => ({ text: `запрос ${i + 1}` })));
    const [first] = build(scoped).slides;
    expect(first!.content.whatWasFound).toContain("Собрано 6");
  });

  it("когда собрано больше, чем вмещает раздел, потеря названа вслух", () => {
    const total = 3 * RELATED_QUERIES_PER_PAGE + 7;
    const scoped = scopedWith(
      Array.from({ length: total }, (_, i) => ({ text: `запрос ${i + 1}`, adverse: i === total - 1 }))
    );
    const { slides } = build(scoped);
    const printed = slides.flatMap((s) => s.content.bullets ?? []);
    expect(printed).toHaveLength(3 * RELATED_QUERIES_PER_PAGE);
    expect(slides[0]!.content.whatWasFound).toContain(`Собрано ${total}`);
    expect(statedCount(slides[0]!.content.whatWasFound)).toBe(slides[0]!.content.bullets!.length);
    // Негативная формулировка стояла последней и обязана уцелеть.
    expect(printed).toContain(`запрос ${total}`);
  });

  it("двум запросам не отводится три листа: лист без строк не печатается", () => {
    const scoped = scopedWith([{ text: "запрос 1" }, { text: "запрос 2" }]);
    const { slides } = build(scoped);
    const withRows = slides.filter((s) => (s.content.bullets ?? []).length > 0);
    expect(withRows).toHaveLength(2);
    const rest = slides.filter((s) => (s.content.bullets ?? []).length === 0);
    for (const slide of rest) {
      // Слот остаётся, но говорит правду: собрано и показано выше.
      expect(slide.content.narrative).toContain("показаны на предыдущих страницах");
      expect(slide.emptyStateReason).toBeUndefined();
    }
  });

  it("пустая поверхность занимает одну страницу со статусом сбора", () => {
    const { slides } = build(scopedWith([]));
    expect(slides).toHaveLength(1);
    expect(slides[0]!.emptyStateReason).toBe("no-related");
  });

  it("страница с негативным запросом говорит о нём в статусе", () => {
    const scoped = scopedWith([{ text: "иванов суд", adverse: true }, { text: "иванов интервью" }]);
    const [first] = build(scoped).slides;
    expect(first!.content.statusNote).toContain("1 запрос с негативной формулировкой");
  });
});
