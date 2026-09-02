import { describe, expect, it } from "vitest";
import {
  buildSerpFragment,
  dropDuplicateRanks,
  normalizeSerpEngine,
  pickSerpTableQuery,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

describe("normalizeSerpEngine", () => {
  it("узнаёт оба поисковика и их псевдонимы", () => {
    expect(normalizeSerpEngine("YANDEX")).toBe("YANDEX");
    expect(normalizeSerpEngine("GOOGLE")).toBe("GOOGLE");
    expect(normalizeSerpEngine("serper")).toBe("GOOGLE");
  });

  it("не выдумывает поисковик там, где его не назвали", () => {
    // Так приходили строки органики Arsenkin до починки атрибуции: имя
    // поставщика данных вместо имени источника.
    expect(normalizeSerpEngine("ARSENKIN")).toBeNull();
    expect(normalizeSerpEngine(undefined)).toBeNull();
    expect(normalizeSerpEngine("")).toBeNull();
  });
});

describe("pickSerpTableQuery", () => {
  it("выбирает запрос по имени субъекта, даже если материала по нему меньше", () => {
    const q = pickSerpTableQuery([
      { query: "иванов компромат", queryPurpose: "adverse_lookup" },
      { query: "иванов компромат", queryPurpose: "adverse_lookup" },
      { query: "иванов иван", queryPurpose: "subject_lookup" },
    ]);
    expect(q).toBe("иванов иван");
  });

  it("при равенстве назначений берёт запрос с бо́льшим материалом", () => {
    const q = pickSerpTableQuery([
      { query: "иванов иван биография" },
      { query: "иванов иван" },
      { query: "иванов иван" },
    ]);
    expect(q).toBe("иванов иван");
  });

  it("на совсем равных выбирает воспроизводимо", () => {
    const first = pickSerpTableQuery([{ query: "бета" }, { query: "альфа" }]);
    const second = pickSerpTableQuery([{ query: "альфа" }, { query: "бета" }]);
    expect(first).toBe("альфа");
    expect(second).toBe("альфа");
  });

  it("без запросов не выдумывает подпись колонке", () => {
    expect(pickSerpTableQuery([])).toBeNull();
    expect(pickSerpTableQuery([{ query: "  " }])).toBeNull();
  });
});


describe("dropDuplicateRanks", () => {
  it("оставляет один материал на позицию", () => {
    // Дефект живого отчёта: на странице стояли две первых позиции и четыре
    // вторых — материал, найденный несколькими запросами, брал подпись одного
    // запроса и номер из другого.
    const rows = [
      { rank: 1, domain: "wikipedia" },
      { rank: 1, domain: "interros" },
      { rank: 2, domain: "rbc" },
      { rank: 2, domain: "yandex" },
    ];
    expect(dropDuplicateRanks(rows).map((r) => r.domain)).toEqual(["wikipedia", "rbc"]);
  });

  it("сохраняет порядок и не трогает уникальные позиции", () => {
    const rows = [{ rank: 3 }, { rank: 1 }, { rank: 7 }];
    expect(dropDuplicateRanks(rows).map((r) => r.rank)).toEqual([3, 1, 7]);
  });
});

describe("материал, найденный несколькими запросами", () => {
  /**
   * Дефект живого отчёта: страница «ОАЭ — Google, ТОП-20» показывала семь
   * строк из двадцати. Материал в выдаче виден по нескольким запросам сразу,
   * сведение оставляло за ним запрос первого наблюдения — и из двадцати
   * материалов первой двадцатки по «suleyman kerimov» этот запрос числился
   * первым ровно у одного.
   */
  function scopedWithSharedMaterials(): ScopedFragmentInput {
    const evidenceIndex: Record<string, unknown> = {};
    const refs: string[] = [];
    const row = (ref: string, rank: number, query: string, n: number) => {
      evidenceIndex[ref] = {
        title: `Материал ${n}`,
        url: `https://example.org/material-${n}`,
        domain: "example.org",
        engine: "GOOGLE",
        region: "UAE",
        rank,
        query,
        queryPurpose: "subject_lookup",
      };
    };
    for (let n = 1; n <= 12; n += 1) {
      // Один и тот же материал виден по двум запросам и стоит у них на разных
      // местах. Порядок наблюдений чередуется — так они и приходят от
      // поставщика, и именно на «первое наблюдение» опиралась потерянная
      // атрибуция.
      const a = `inventory:m${n}a`;
      const b = `inventory:m${n}b`;
      row(a, n, "kerimov suleyman", n);
      row(b, 13 - n, "suleyman kerimov", n);
      refs.push(...(n % 2 === 0 ? [b, a] : [a, b]));
    }
    return {
      findings: [],
      surfaceUnits: [
        {
          surface: "organic",
          region: "UAE",
          engine: "GOOGLE",
          claims: [],
          metrics: [],
          evidenceRefs: refs,
        },
      ],
      evidenceIndex,
      scope: {},
      metricSnapshot: {},
    } as unknown as ScopedFragmentInput;
  }

  it("попадает в таблицу выбранного запроса, а не теряется вместе с ним", () => {
    const { slides } = buildSerpFragment(
      "UAE_SERP",
      "UAE_PROFILE",
      "ОАЭ",
      scopedWithSharedMaterials()
    );
    const rows = slides.flatMap((s) => s.content.table?.rows ?? []);
    expect(rows.length).toBe(12);
    // Позиции — из выбранного запроса, без повторов и без выдуманных мест.
    const positions = rows.map((r) => Number(r[0])).sort((a, b) => a - b);
    expect(new Set(positions).size).toBe(positions.length);
    expect(positions.every((p) => p >= 1 && p <= 20)).toBe(true);
  });
});
