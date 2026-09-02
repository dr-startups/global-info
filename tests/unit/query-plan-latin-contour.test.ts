import { describe, expect, it } from "vitest";
import { buildOrionQueryPlanDetailed } from "@/modules/digital-profile/search-surfaces/orion-query-plan";

const SUBJECT = {
  fullName: "Киркоров Филипп Бедросович",
  aliases: [],
  targetRegions: ["RU", "UAE"],
  location: "Москва",
};

function queriesOf(plan: ReturnType<typeof buildOrionQueryPlanDetailed>, region: string) {
  return plan.plan.filter((q) => q.region === region).map((q) => q.query);
}

const CYRILLIC = /[Ѐ-ӿ]/u;

/** Набор запросов аудита в том виде, в каком его принимает построитель плана. */
const planned = (...queries: string[]) => queries.map((query) => ({ query }));

describe("зарубежный контур ищет латиницей", () => {
  it("кириллический набор запросов в контур ОАЭ не уходит", () => {
    const plan = buildOrionQueryPlanDetailed(SUBJECT, {
      primaryQueriesByRegion: {
        RU: planned("Киркоров Филипп Бедросович", "киркоров филипп бедросович дети"),
        UAE: planned("киркоров филипп бедросович дети", "Kirkorov Filipp songs"),
      },
    });
    const uae = queriesOf(plan, "UAE");
    expect(uae.some((q) => CYRILLIC.test(q))).toBe(false);
    expect(uae).toContain("Kirkorov Filipp songs");
    expect(plan.warnings).toContain("cyrillic_queries_dropped_in_latin_region");
  });

  it("российский контур свои кириллические запросы сохраняет", () => {
    const plan = buildOrionQueryPlanDetailed(SUBJECT, {
      primaryQueriesByRegion: {
        RU: planned("Киркоров Филипп Бедросович", "киркоров филипп бедросович дети"),
        UAE: planned("Kirkorov Filipp Bedrosovich"),
      },
    });
    expect(queriesOf(plan, "RU")).toContain("киркоров филипп бедросович дети");
  });

  it("если латинских запросов не осталось, берутся написания имени, а не пустота", () => {
    const plan = buildOrionQueryPlanDetailed(SUBJECT, {
      primaryQueriesByRegion: { UAE: planned("киркоров дети", "киркоров суд") },
    });
    const uae = queriesOf(plan, "UAE");
    expect(uae.length).toBeGreaterThan(0);
    expect(uae.some((q) => CYRILLIC.test(q))).toBe(false);
    expect(uae.some((q) => /Kirkorov/i.test(q))).toBe(true);
  });

  it("отчество не уходит в зарубежный контур отдельным сочетанием", () => {
    const plan = buildOrionQueryPlanDetailed({
      fullName: "Дуров Павел Валерьевич",
      aliases: [],
      targetRegions: ["UAE"],
    });
    const uae = queriesOf(plan, "UAE");
    // «Durov Valerevich» и «Valerevich Durov Pavel» человек не набирает.
    expect(uae.some((q) => /^Valerevich/u.test(q))).toBe(false);
    expect(uae).not.toContain("Durov Valerevich");
    expect(uae).toContain("Pavel Durov");
  });

  it("географическая подсказка на кириллице в латинский запрос не подставляется", () => {
    const plan = buildOrionQueryPlanDetailed(SUBJECT, {
      primaryQueriesByRegion: { UAE: planned("Kirkorov Filipp Bedrosovich") },
    });
    expect(queriesOf(plan, "UAE").some((q) => q.includes("Москва"))).toBe(false);
  });
});
