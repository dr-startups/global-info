import { describe, expect, it } from "vitest";
import {
  OPEN_SANCTIONS_QUERY_ID,
  buildOpenSanctionsMatchBody,
  confidenceFromScore,
  mapOpenSanctionsResponse,
  normalizeBirthDate,
  riskTypesFromTopics,
  summarizeEntity,
} from "../../src/modules/digital-profile/compliance-providers/open-sanctions-mapping";

/**
 * Шаг 04.3.
 *
 * Раздел комплаенса никогда не наполнялся реальными данными: до перехода на
 * `real_only` его заполняли демо-агенты, а «совпадение по санкционным спискам»
 * в документе о реальном человеке нельзя выдумывать ни при каких
 * обстоятельствах. Продуктовое решение — OpenSanctions.
 *
 * Проверяется разбор: у провайдера открытая модель данных, поле может
 * отсутствовать, и отсутствие обязано означать «нет сведений», а не падение
 * прогона и не выдуманное значение.
 */

const ENTITY = {
  id: "NK-1a2b3c",
  caption: "Pavel Valeryevich Durov",
  schema: "Person",
  score: 0.93,
  datasets: ["eu_fsf", "us_ofac_sdn"],
  first_seen: "2024-01-01T00:00:00",
  last_seen: "2026-07-01T00:00:00",
  properties: {
    name: ["Pavel Valeryevich Durov", "Павел Валерьевич Дуров"],
    alias: ["P. Durov"],
    topics: ["sanction", "role.pep"],
    country: ["ru", "ae"],
    birthDate: ["1984-10-10"],
    position: ["Chief Executive Officer"],
  },
};

describe("запрос к провайдеру", () => {
  it("имя и алиасы уходят как значения одного свойства", () => {
    const body = buildOpenSanctionsMatchBody({
      fullName: "Дуров Павел Валерьевич",
      aliases: ["Pavel Durov", "Дуров Павел Валерьевич"],
    });
    const q = body.queries[OPEN_SANCTIONS_QUERY_ID];
    expect(q.schema).toBe("Person");
    // Дубль имени схлопывается: повтор не усиливает совпадение, а раздувает запрос.
    expect(q.properties.name).toEqual(["Дуров Павел Валерьевич", "Pavel Durov"]);
  });

  it("дата рождения и страны попадают в запрос, когда они есть", () => {
    const q = buildOpenSanctionsMatchBody({
      fullName: "Иван Петров",
      dateOfBirth: "1984-10-10T00:00:00.000Z",
      country: "RU",
      nationality: "ae",
    }).queries[OPEN_SANCTIONS_QUERY_ID];
    expect(q.properties.birthDate).toEqual(["1984-10-10"]);
    expect(q.properties.country).toEqual(["ru", "ae"]);
  });

  it("незаполненные признаки в запрос не подставляются", () => {
    const q = buildOpenSanctionsMatchBody({ fullName: "Иван Петров" }).queries[
      OPEN_SANCTIONS_QUERY_ID
    ];
    expect(q.properties).not.toHaveProperty("birthDate");
    expect(q.properties).not.toHaveProperty("country");
  });

  it("неразобранная дата отбрасывается, а не отправляется как есть", () => {
    // Неверный формат провайдер отвергает целиком: один плохо заполненный кейс
    // обнулил бы проверку по санкциям.
    expect(normalizeBirthDate("не указана")).toBe("");
    expect(normalizeBirthDate("1984")).toBe("1984");
    expect(normalizeBirthDate("")).toBe("");
    expect(normalizeBirthDate(null)).toBe("");
  });
});

describe("темы провайдера превращаются в типы риска", () => {
  it("санкции и PEP распознаются", () => {
    expect(riskTypesFromTopics(["sanction"])).toEqual(["SANCTIONS"]);
    expect(riskTypesFromTopics(["role.pep"])).toEqual(["PEP"]);
    expect(riskTypesFromTopics(["role.rca"])).toEqual(["PEP"]);
  });

  it("подтема попадает в раздел своей темы", () => {
    // Иерархия у провайдера растёт: `crime.fraud` не должен уходить в «прочее».
    expect(riskTypesFromTopics(["crime.fraud"])).toEqual(["LAW_ENFORCEMENT"]);
    expect(riskTypesFromTopics(["sanction.linked"])).toEqual(["SANCTIONS"]);
  });

  it("несколько тем дают несколько типов без повторов", () => {
    expect(riskTypesFromTopics(["sanction", "role.pep", "role.rca"]).sort()).toEqual([
      "PEP",
      "SANCTIONS",
    ]);
  });

  it("незнакомая тема не теряется", () => {
    // Запись в базе комплаенса найдена; умолчать о ней нельзя.
    expect(riskTypesFromTopics(["something.new"])).toEqual(["OTHER"]);
    expect(riskTypesFromTopics([])).toEqual(["OTHER"]);
  });
});

describe("уверенность выводится из счёта провайдера", () => {
  it("границы строгие: сомнение уходит аналитику", () => {
    expect(confidenceFromScore(0.95)).toBe("HIGH");
    expect(confidenceFromScore(0.9)).toBe("HIGH");
    expect(confidenceFromScore(0.85)).toBe("MEDIUM");
    expect(confidenceFromScore(0.79)).toBe("LOW");
  });
});

describe("ответ провайдера превращается в совпадения отчёта", () => {
  const map = (payload: unknown, minScore = 0.7) =>
    mapOpenSanctionsResponse({
      subjectName: "Дуров Павел Валерьевич",
      payload,
      minScore,
      webBaseUrl: "https://www.opensanctions.org",
    });

  it("разбирает пакетный ответ", () => {
    const hits = map({ responses: { [OPEN_SANCTIONS_QUERY_ID]: { results: [ENTITY] } } });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      provider: "OPEN_SANCTIONS",
      source: "OFFICIAL_API",
      matchedName: "Pavel Valeryevich Durov",
      matchScore: 93,
      confidence: "HIGH",
      profileId: "NK-1a2b3c",
      profileUrl: "https://www.opensanctions.org/entities/NK-1a2b3c/",
    });
    expect(hits[0].riskTypes.sort()).toEqual(["PEP", "SANCTIONS"]);
    expect(hits[0].countries.sort()).toEqual(["ae", "ru"]);
  });

  it("разбирает ответ поиска — та же функция обслуживает свой yente", () => {
    expect(map({ results: [ENTITY] })).toHaveLength(1);
  });

  it("ни одно совпадение не подтверждается автоматически", () => {
    // Совпадение по имени — повод для проверки, а не факт о человеке.
    expect(map({ results: [ENTITY] })[0].reviewStatus).toBe("PENDING");
  });

  it("слабое совпадение до отчёта не доходит", () => {
    expect(map({ results: [{ ...ENTITY, score: 0.4 }] })).toEqual([]);
  });

  it("сильнейшее совпадение идёт первым", () => {
    const hits = map({
      results: [
        { ...ENTITY, id: "a", score: 0.75 },
        { ...ENTITY, id: "b", score: 0.95 },
      ],
    });
    expect(hits.map((h) => h.profileId)).toEqual(["b", "a"]);
  });

  it("сущность без имени пропускается", () => {
    expect(map({ results: [{ id: "x", score: 0.99 }] })).toEqual([]);
  });

  it("отсутствующие свойства дают пустые списки, а не падение", () => {
    const hits = map({ results: [{ id: "x", caption: "Some Person", score: 0.99 }] });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ aliases: [], countries: [], datesOfBirth: [] });
    expect(hits[0].riskTypes).toEqual(["OTHER"]);
  });

  it("битый и пустой ответ совпадений не даёт", () => {
    expect(map(null)).toEqual([]);
    expect(map({})).toEqual([]);
    expect(map({ responses: {} })).toEqual([]);
    expect(map({ results: "не список" })).toEqual([]);
    expect(map("строка")).toEqual([]);
  });

  it("краткое описание называет списки и роль, а не выдумывает", () => {
    const summary = summarizeEntity(ENTITY);
    expect(summary).toContain("sanction");
    expect(summary).toContain("Chief Executive Officer");
    expect(summary).toContain("us_ofac_sdn");
    expect(summarizeEntity({ id: "x" })).toMatch(/без дополнительных сведений/);
  });
});
