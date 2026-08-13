import { describe, expect, it } from "vitest";
import {
  dropDuplicateRanks,
  normalizeSerpEngine,
  pickSerpTableQuery,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";

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
