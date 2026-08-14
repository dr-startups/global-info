import { describe, expect, it } from "vitest";
import {
  SUBJECT_QUERY_LIMIT,
  buildSubjectQuerySet,
  normalizeSubjectQuery,
  subjectQuerySetClientLine,
} from "@/modules/digital-profile/search-surfaces/subject-query-set";

const PROFILE = {
  fullName: "Глинка Сергей Михайлович",
  firstName: "Сергей",
  lastName: "Глинка",
  patronymic: "Михайлович",
};

const AT = "2026-08-13T10:00:00.000Z";

function suggestion(text: string, rank: number, engine = "YANDEX") {
  return { text, engine, region: "RU", rank };
}

describe("buildSubjectQuerySet", () => {
  it("ставит имя субъекта первым запросом набора", () => {
    const set = buildSubjectQuerySet({
      profile: PROFILE,
      suggestions: [suggestion("бизнесмен биография", 1)],
      region: "RU",
      language: "ru",
      capturedAt: AT,
    });
    expect(set.queries[0]?.query).toBe("Глинка Сергей Михайлович");
    expect(set.queries[0]?.origin.kind).toBe("subject_name");
    expect(set.queries[0]?.setRank).toBe(1);
  });

  it("дописывает имя к хвосту подсказки", () => {
    const set = buildSubjectQuerySet({
      profile: PROFILE,
      suggestions: [suggestion("бизнесмен биография", 1)],
      region: "RU",
      language: "ru",
      capturedAt: AT,
    });
    expect(set.queries[1]?.query).toBe("Глинка Сергей Михайлович бизнесмен биография");
    expect(set.queries[1]?.origin).toMatchObject({ kind: "suggestion", suggestionRank: 1 });
  });

  it("сохраняет подсказку целиком, если в ней уже есть фамилия", () => {
    const set = buildSubjectQuerySet({
      profile: PROFILE,
      suggestions: [suggestion("сергей глинка бизнесмен", 1)],
      region: "RU",
      language: "ru",
      capturedAt: AT,
    });
    expect(set.queries[1]?.query).toBe("сергей глинка бизнесмен");
  });

  it("отбрасывает подсказку про однофамильца с другим именем и отчеством", () => {
    const set = buildSubjectQuerySet({
      profile: PROFILE,
      suggestions: [
        suggestion("михаил иванович глинка прощание с петербургом", 1),
        suggestion("сергей глинка трансмашхолдинг", 2),
      ],
      region: "RU",
      language: "ru",
      capturedAt: AT,
    });
    const texts = set.queries.map((q) => q.query);
    expect(texts).not.toContain("михаил иванович глинка прощание с петербургом");
    expect(texts).toContain("сергей глинка трансмашхолдинг");
    expect(set.rejected.some((r) => r.reason === "foreign_person")).toBe(true);
  });

  it("соблюдает порядок популярности подсказок", () => {
    const set = buildSubjectQuerySet({
      profile: PROFILE,
      suggestions: [suggestion("сергей глинка дети", 5), suggestion("сергей глинка биография", 2)],
      region: "RU",
      language: "ru",
      capturedAt: AT,
    });
    expect(set.queries[1]?.query).toBe("сергей глинка биография");
    expect(set.queries[2]?.query).toBe("сергей глинка дети");
  });

  it("добивает набор перестановками ФИО, когда подсказок нет", () => {
    const set = buildSubjectQuerySet({
      profile: PROFILE,
      region: "RU",
      language: "ru",
      capturedAt: AT,
    });
    expect(set.queries.length).toBeGreaterThan(1);
    expect(set.queries.map((q) => q.query)).toContain("Сергей Глинка");
    expect(set.queries.slice(1).every((q) => q.origin.kind === "name_variant")).toBe(true);
  });

  it("не превышает лимит и называет причину отказа", () => {
    const set = buildSubjectQuerySet({
      profile: PROFILE,
      suggestions: [1, 2, 3, 4, 5, 6, 7].map((i) => suggestion(`сергей глинка тема${i}`, i)),
      region: "RU",
      language: "ru",
      capturedAt: AT,
    });
    expect(set.queries).toHaveLength(SUBJECT_QUERY_LIMIT);
    expect(set.rejected.some((r) => r.reason === "over_limit")).toBe(true);
  });

  it("не пускает один и тот же запрос дважды", () => {
    const set = buildSubjectQuerySet({
      profile: PROFILE,
      suggestions: [suggestion("Глинка Сергей Михайлович", 1), suggestion("глинка  сергей   михайлович", 2)],
      region: "RU",
      language: "ru",
      capturedAt: AT,
    });
    const normalized = set.queries.map((q) => q.normalized);
    expect(new Set(normalized).size).toBe(normalized.length);
    expect(set.rejected.some((r) => r.reason === "duplicate")).toBe(true);
  });

  it("узнаёт фамилию в латинице", () => {
    const set = buildSubjectQuerySet({
      profile: { ...PROFILE, fullName: "Glinka Sergei Mikhailovich" },
      suggestions: [suggestion("sergei glinka biography", 1)],
      region: "UAE",
      language: "en",
      capturedAt: AT,
    });
    expect(set.queries[1]?.query).toBe("sergei glinka biography");
  });

  it("клиентская строка называет запросы и дату", () => {
    const set = buildSubjectQuerySet({
      profile: PROFILE,
      suggestions: [suggestion("сергей глинка биография", 1)],
      region: "RU",
      language: "ru",
      capturedAt: AT,
    });
    const line = subjectQuerySetClientLine(set);
    expect(line).toContain("«Глинка Сергей Михайлович»");
    expect(line).toContain("13.08.2026");
    expect(line).not.toMatch(/suggestion|rank|origin/i);
  });

  it("нормализация схлопывает регистр, кавычки и пробелы", () => {
    expect(normalizeSubjectQuery("  «Глинка,   Сергей» ")).toBe("глинка сергей");
  });
});

describe("письменность контура", () => {
  const LATIN = {
    fullName: "Glinka Sergei Mikhailovich",
    firstName: "Sergei",
    lastName: "Glinka",
    patronymic: "Mikhailovich",
  };

  it("в зарубежный контур кириллическая подсказка не попадает", () => {
    const set = buildSubjectQuerySet({
      profile: LATIN,
      suggestions: [
        suggestion("глинка сергей дети", 1, "GOOGLE"),
        suggestion("sergei glinka biography", 2, "GOOGLE"),
      ],
      region: "UAE",
      language: "en",
      capturedAt: AT,
    });
    expect(set.queries.map((q) => q.query)).not.toContain("глинка сергей дети");
    expect(set.queries.some((q) => q.query === "sergei glinka biography")).toBe(true);
    expect(set.rejected).toContainEqual({ query: "глинка сергей дети", reason: "wrong_script" });
  });

  it("хвост подсказки на кириллице не дописывается к латинскому имени", () => {
    const set = buildSubjectQuerySet({
      profile: LATIN,
      suggestions: [suggestion("биография", 1, "GOOGLE")],
      region: "UAE",
      language: "en",
      capturedAt: AT,
    });
    expect(set.queries.every((q) => !/[Ѐ-ӿ]/u.test(q.query))).toBe(true);
  });

  it("в российском контуре латинский запрос законен и остаётся", () => {
    const set = buildSubjectQuerySet({
      profile: PROFILE,
      suggestions: [suggestion("глинка сергей instagram", 1)],
      region: "RU",
      language: "ru",
      capturedAt: AT,
    });
    expect(set.queries.some((q) => q.query === "глинка сергей instagram")).toBe(true);
    expect(set.rejected.some((r) => r.reason === "wrong_script")).toBe(false);
  });

  it("письменность можно задать явно, не полагаясь на язык", () => {
    const set = buildSubjectQuerySet({
      profile: PROFILE,
      suggestions: [suggestion("глинка сергей дети", 1)],
      region: "RU",
      language: "ru",
      script: "latin",
      capturedAt: AT,
    });
    expect(set.queries).toHaveLength(0);
    expect(set.rejected.every((r) => r.reason === "wrong_script")).toBe(true);
  });
});
