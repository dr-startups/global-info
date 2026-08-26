/**
 * Запрос об имени субъекта без фамилии — это запрос о другом человеке.
 *
 * В живом прогоне по «Умар Назарович Кремлев» четыре из десяти платных запросов
 * об имени субъекта ушли без фамилии («Назарович Умар», «Умар Назарович»,
 * «Nazarovich Umar»), а подсказка «umar nazarovich kim» была куплена с
 * назначением «поиск субъекта» — про постороннего человека. Ворота слабого
 * запроса это пропустили: они сверяют строку с `profile.lastName`, а он был
 * равен «Умар».
 */

import { describe, expect, it } from "vitest";
import { parseSubjectName } from "@/modules/digital-profile/risk-classifier/entity-disambiguation";
import { buildArsenkinSubjectQueryPlan } from "@/modules/digital-profile/orion-golden/classic/arsenkin-subject-query-plan";
import { buildOrionQueryPlanDetailed } from "@/modules/digital-profile/search-surfaces/orion-query-plan";
import { buildSubjectQuerySet } from "@/modules/digital-profile/search-surfaces/subject-query-set";

const RU_NAME = "Умар Назарович Кремлев";
const RU_NAME_FIO = "Кремлев Умар Назарович";
const LAT_NAME = "Umar Nazarovich Kremlev";

/** Фамилия субъекта в любом написании — то, без чего запрос не о нём. */
function carriesSurname(query: string): boolean {
  const q = query.toLowerCase().replace(/ё/gu, "е");
  return q.includes("кремлев") || q.includes("kremlev");
}

/** Строки плана об имени субъекта — то, за что платят как за «поиск субъекта». */
function subjectLookupQueries(built: ReturnType<typeof buildOrionQueryPlanDetailed>): string[] {
  return built.plan.filter((row) => row.purpose === "subject_lookup").map((row) => row.query);
}

/** Набор аудита строится так же, как его строит сбор: от разобранных частей. */
function auditQueries(fullName: string, language: string): string[] {
  const parsed = parseSubjectName(fullName);
  const set = buildSubjectQuerySet({
    profile: {
      fullName,
      firstName: parsed.givenName ?? undefined,
      lastName: parsed.surname ?? undefined,
      patronymic: parsed.patronymic ?? undefined,
    },
    region: language === "ru" ? "RU" : "UAE",
    language,
    capturedAt: "2026-08-26T00:00:00.000Z",
  });
  return set.queries.map((q) => q.query);
}

describe("ни один запрос об имени субъекта не остаётся без фамилии", () => {
  it("набор аудита: оба порядка записи имени дают запросы с фамилией", () => {
    for (const name of [RU_NAME, RU_NAME_FIO]) {
      const queries = auditQueries(name, "ru");
      expect(queries.length).toBeGreaterThan(1);
      expect(queries.filter((q) => !carriesSurname(q))).toEqual([]);
    }
    expect(auditQueries(RU_NAME, "ru")).not.toContain("Назарович Умар");
    expect(auditQueries(LAT_NAME, "en")).not.toContain("Nazarovich Umar");
  });

  it("план Arsenkin: ни в кириллице, ни в латинице", () => {
    for (const name of [RU_NAME, RU_NAME_FIO]) {
      const plan = buildArsenkinSubjectQueryPlan({ fullName: name });
      expect(plan.queriesRu.length).toBeGreaterThan(1);
      expect(plan.queriesRu.filter((q) => !carriesSurname(q))).toEqual([]);
      expect(plan.queriesUae.filter((q) => !carriesSurname(q))).toEqual([]);
      expect(plan.queriesUae).not.toContain("Nazarovich Umar");
    }
  });

  it("план запросов: строк без фамилии нет ни в одном регионе", () => {
    for (const fullName of [RU_NAME, RU_NAME_FIO]) {
      const built = buildOrionQueryPlanDetailed({
        fullName,
        aliases: [],
        targetRegions: ["RU", "UAE"],
        location: "Москва",
      });
      const weak = built.plan.map((row) => row.query).filter((q) => !carriesSurname(q));
      expect(weak).toEqual([]);
    }
  });

  it("латинское написание имени тоже разбирается по отчеству", () => {
    const built = buildOrionQueryPlanDetailed({
      fullName: LAT_NAME,
      aliases: [],
      targetRegions: ["UAE"],
    });
    expect(built.plan.map((row) => row.query).filter((q) => !carriesSurname(q))).toEqual([]);
  });
});

describe("подсказки поисковика проверяются по настоящей фамилии", () => {
  const parsed = parseSubjectName(LAT_NAME);
  const profile = {
    fullName: LAT_NAME,
    firstName: parsed.givenName ?? undefined,
    lastName: parsed.surname ?? undefined,
    patronymic: parsed.patronymic ?? undefined,
  };

  function setWith(text: string, own = profile, language = "en", region = "UAE") {
    return buildSubjectQuerySet({
      profile: own,
      suggestions: [{ text, engine: "GOOGLE", region, rank: 1 }],
      region,
      language,
      capturedAt: "2026-08-26T00:00:00.000Z",
    });
  }

  it("подсказка без фамилии достраивается именем субъекта", () => {
    // «umar nazarovich kim» — подсказка к сломанному имени: в живом прогоне она
    // ушла в платный сбор как есть, запросом о постороннем человеке.
    const set = setWith("umar nazarovich kim");

    expect(set.queries.map((q) => q.query)).not.toContain("umar nazarovich kim");
    expect(set.queries.filter((q) => !carriesSurname(q.query))).toEqual([]);
  });

  it("подсказка с чужим отчеством отклоняется как чужой человек", () => {
    // Профиль задан частями явно: иначе тест держит разбор имени, а не то, что
    // латинское отчество вообще опознаётся отчеством.
    const set = setWith("umar petrovich kremlev", {
      fullName: LAT_NAME,
      firstName: "Umar",
      lastName: "Kremlev",
      patronymic: "Nazarovich",
    });

    expect(set.queries.map((q) => q.query)).not.toContain("umar petrovich kremlev");
    expect(set.rejected).toContainEqual({
      query: "umar petrovich kremlev",
      reason: "foreign_person",
    });
  });

  it("фамилия субъекта на -ович не делает подсказку о нём самом чужой", () => {
    // «roman abramovich sanctions» — запрос о самом субъекте. Общий предикат
    // знает латинские суффиксы, и без исключения собственного имени субъекта
    // его же фамилия читается как чужое отчество.
    const own = parseSubjectName("Roman Arkadyevich Abramovich");
    const set = setWith("roman abramovich sanctions", {
      fullName: "Roman Arkadyevich Abramovich",
      firstName: own.givenName ?? undefined,
      lastName: own.surname ?? undefined,
      patronymic: own.patronymic ?? undefined,
    });

    expect(set.rejected.map((r) => r.reason)).not.toContain("foreign_person");
    expect(set.queries.map((q) => q.query)).toContain("roman abramovich sanctions");
  });

  it("балканская фамилия на -ич в подсказке не считается чужим отчеством", () => {
    // Ровно то, ради чего список суффиксов узкий: с голым «ич» «вучич»
    // становится чужим отчеством, и законный запрос о субъекте выбрасывается.
    const own = parseSubjectName("Иван Петрович Сидоров");
    const set = setWith(
      "сидоров и вучич переговоры",
      {
        fullName: "Иван Петрович Сидоров",
        firstName: own.givenName ?? undefined,
        lastName: own.surname ?? undefined,
        patronymic: own.patronymic ?? undefined,
      },
      "ru",
      "RU"
    );

    expect(set.rejected.map((r) => r.reason)).not.toContain("foreign_person");
    expect(set.queries.map((q) => q.query)).toContain("сидоров и вучич переговоры");
  });

  it("латинский порядок «Фамилия Имя»: чужая подсказка не становится запросом о субъекте", () => {
    // `latinNameOf` предпочитает подтверждённый латинский алиас, а он приходит
    // именно в этом порядке — на нём защита держалась за имя, а не за фамилию.
    const kremlev = parseSubjectName("Kremlev Umar");
    const kimSet = setWith("umar nazarovich kim", {
      fullName: "Kremlev Umar",
      firstName: kremlev.givenName ?? undefined,
      lastName: kremlev.surname ?? undefined,
      patronymic: undefined,
    });
    expect(kimSet.queries.map((q) => q.query)).not.toContain("umar nazarovich kim");
    expect(kimSet.queries.filter((q) => !carriesSurname(q.query))).toEqual([]);

    const tinkov = parseSubjectName("Tinkov Oleg");
    const deripaskaSet = setWith("oleg deripaska sanctions", {
      fullName: "Tinkov Oleg",
      firstName: tinkov.givenName ?? undefined,
      lastName: tinkov.surname ?? undefined,
      patronymic: undefined,
    });
    expect(deripaskaSet.queries.map((q) => q.query)).not.toContain("oleg deripaska sanctions");
    expect(
      deripaskaSet.queries.filter((q) => !q.query.toLowerCase().includes("tinkov"))
    ).toEqual([]);
  });
});

describe("латинские написания имени и оба порядка двухсловного", () => {
  it("в план уходит полное написание и «Имя Фамилия», без перевёрнутого", () => {
    // Закрепляет сам `enBaseVariants`: позиционная нарезка добавляла
    // «Holmström Anders», а у арабского имени — обрубок «Mohammed bin Rashid».
    const western = buildOrionQueryPlanDetailed({ fullName: "Anders Holmström", aliases: [] });
    expect(subjectLookupQueries(western)).toEqual(["Anders Holmström"]);

    const arabic = buildOrionQueryPlanDetailed({
      fullName: "Mohammed bin Rashid Al Maktoum",
      aliases: [],
    });
    expect(subjectLookupQueries(arabic)).not.toContain("Mohammed bin Rashid");
  });

  it("двухсловное имя ищется в обоих порядках, включая «Фамилия Имя»", () => {
    // «tinkov oleg» — форма, встреченная в живом корпусе; покрытие платного
    // контура не сокращается молча.
    const plan = buildArsenkinSubjectQueryPlan({ fullName: "Олег Тиньков" });
    expect(plan.queriesRu).toEqual(["Олег Тиньков", "Тиньков Олег"]);
    expect(plan.queriesUae).toEqual(["Oleg Tinkov", "Tinkov Oleg"]);
  });
});
