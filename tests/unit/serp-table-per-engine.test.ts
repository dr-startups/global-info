import { describe, expect, it } from "vitest";
import {
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
