import { describe, expect, it } from "vitest";
import { buildArsenkinSubjectQueryPlan } from "@/modules/digital-profile/orion-golden/classic/arsenkin-subject-query-plan";
import { planArsenkinExactTasks } from "@/modules/digital-profile/orion-golden/classic/plan-arsenkin-exact-tasks";

/**
 * Строка плана — это запрос, который набрал бы человек.
 *
 * Перевёрнутый порядок ФИО не написание имени, а мусор: на живом прогоне по
 * строке «юрьевич олег тиньков» была куплена выдача (10 наблюдений с реальными
 * URL), и она же напечаталась клиенту подписью к слайду. Поэтому проверяется
 * состав плана, а не подпись: подпись честно называет то, чем выдача собрана.
 */

const RASHNIKOV = "Рашников Виктор Филиппович";
const REVERSED_RU = "Филиппович Виктор Рашников";
const REVERSED_LAT = "Filippovich Viktor Rashnikov";

describe("план запросов Arsenkin строит только человеческие порядки имени", () => {
  it("RU: полное ФИО, «Имя Отчество Фамилия», «Имя Фамилия» — и ничего с отчества", () => {
    const plan = buildArsenkinSubjectQueryPlan({ fullName: RASHNIKOV });

    expect(plan.queriesRu).toEqual([RASHNIKOV, "Виктор Филиппович Рашников", "Виктор Рашников"]);
    expect(plan.queriesRu).not.toContain(REVERSED_RU);
    expect(plan.queriesRu.filter((q) => q.startsWith("Филиппович"))).toEqual([]);
    expect(plan.primaryIdentityRu).toBe(RASHNIKOV);
    expect(plan.blockers).toEqual([]);
  });

  it("RU: кириллические алиасы остаются в плане после написаний имени", () => {
    const plan = buildArsenkinSubjectQueryPlan({
      fullName: RASHNIKOV,
      aliases: ["Рашников ММК", "Виктор Рашников"],
    });

    expect(plan.queriesRu.slice(0, 3)).toEqual([
      RASHNIKOV,
      "Виктор Филиппович Рашников",
      "Виктор Рашников",
    ]);
    expect(plan.queriesRu).toContain("Рашников ММК");
    expect(plan.queriesRu.length).toBeLessThanOrEqual(5);
    expect(plan.queriesRu).not.toContain(REVERSED_RU);
  });

  it("UAE: полное латинское написание и «Имя Фамилия», без перевёртыша и «Фамилия Имя»", () => {
    const plan = buildArsenkinSubjectQueryPlan({ fullName: RASHNIKOV });

    expect(plan.queriesUae).toEqual(["Rashnikov Viktor Filippovich", "Viktor Rashnikov"]);
    expect(plan.queriesUae).not.toContain(REVERSED_LAT);
    expect(plan.queriesUae).not.toContain("Rashnikov Viktor");
    expect(plan.primaryIdentityUae).toBe("Rashnikov Viktor Filippovich");
  });

  it("UAE: подтверждённый латинский алиас уходит в план как записан", () => {
    // Порядок частей алиаса задал аналитик, и он западный: переставлять его
    // нам не по чему — «Tinkov Oleg» человек не набирает.
    const plan = buildArsenkinSubjectQueryPlan({
      fullName: "Тиньков Олег Юрьевич",
      aliases: ["Oleg Tinkov"],
    });

    // Собственное написание идёт рядом с алиасом, а не вместо него: решение
    // владельца 19.08 (пункт BI). Первым остаётся алиас — его подтвердил
    // аналитик, и он же печатается клиенту.
    expect(plan.queriesUae).toEqual(["Oleg Tinkov", "Tinkov Oleg Yurevich"]);
    expect(plan.primaryIdentityUae).toBe("Oleg Tinkov");
  });

  it("UAE: латинский алиас из трёх частей не переставляется", () => {
    const plan = buildArsenkinSubjectQueryPlan({
      fullName: "Тиньков Олег Юрьевич",
      aliases: ["Oleg Yuryevich Tinkov"],
    });

    expect(plan.queriesUae).toEqual(["Oleg Yuryevich Tinkov", "Tinkov Oleg Yurevich"]);
    // Сам алиас не переставлен — это и проверяется; добавка рядом с ним не
    // перестановка, а собственное написание субъекта (пункт BI).
    expect(plan.queriesUae).not.toContain("Yuryevich Oleg Tinkov");
  });

  it("UAE: латинское имя субъекта без алиасов не переставляется", () => {
    // Порядок частей известен только у собственной транслитерации ФИО. У
    // арабского имени вторая часть — не имя: перестановка дала бы «bin
    // Mohammed», и эта строка ушла бы в платный check-top ОАЭ.
    const plan = buildArsenkinSubjectQueryPlan({ fullName: "Mohammed bin Rashid Al Maktoum" });

    expect(plan.queriesUae).toEqual(["Mohammed bin Rashid Al Maktoum"]);
    expect(plan.primaryIdentityUae).toBe("Mohammed bin Rashid Al Maktoum");
  });

  it("UAE: несколько латинских алиасов сохраняют порядок аналитика", () => {
    const plan = buildArsenkinSubjectQueryPlan({
      fullName: "Тиньков Олег Юрьевич",
      aliases: ["Oleg Tinkov", "Oleg Tinkoff"],
    });

    expect(plan.queriesUae).toEqual(["Oleg Tinkov", "Oleg Tinkoff", "Tinkov Oleg Yurevich"]);
  });

  it("двухчастное имя даёт два порядка, оба человеческие", () => {
    const plan = buildArsenkinSubjectQueryPlan({ fullName: "Дуров Павел" });

    expect(plan.queriesRu).toEqual(["Дуров Павел", "Павел Дуров"]);
    expect(plan.queriesUae).toEqual(["Durov Pavel", "Pavel Durov"]);
  });

  it("имя, взятое из алиаса, не переставляется ни в одном контуре", () => {
    // Когда `fullName` пуст, именем работает алиас: порядок его частей задавали
    // не мы, и перестановка выдумывает запрос — «Юрьевич Тиньков Олег»,
    // «Юрьевич Олег», «Yurevich Oleg» уходили бы в платный check-top.
    const fromPatronymicAlias = buildArsenkinSubjectQueryPlan({
      fullName: null,
      aliases: ["Олег Юрьевич Тиньков"],
    });
    expect(fromPatronymicAlias.queriesRu).toEqual(["Олег Юрьевич Тиньков"]);
    expect(fromPatronymicAlias.queriesUae).toEqual(["Oleg Yurevich Tinkov"]);

    const fromShortAlias = buildArsenkinSubjectQueryPlan({
      fullName: "   ",
      aliases: ["Олег Тиньков"],
    });
    expect(fromShortAlias.queriesRu).toEqual(["Олег Тиньков"]);
    expect(fromShortAlias.queriesUae).toEqual(["Oleg Tinkov"]);
  });

  it("вырожденные случаи: одна часть и пустой субъект", () => {
    expect(buildArsenkinSubjectQueryPlan({ fullName: "Дуров" }).queriesRu).toEqual(["Дуров"]);

    const empty = buildArsenkinSubjectQueryPlan({ fullName: "   " });
    expect(empty.queriesRu).toEqual([]);
    expect(empty.queriesUae).toEqual([]);
    expect(empty.blockers).toEqual(["empty-subject-name"]);
  });

  it("в задачу check-top уходят строки плана и ни одной перевёрнутой", () => {
    const plan = buildArsenkinSubjectQueryPlan({ fullName: RASHNIKOV });
    const tasks = planArsenkinExactTasks({
      queriesRu: plan.queriesRu,
      queriesUae: plan.queriesUae,
      tools: ["check-top"],
    });

    const ru = tasks.find((t) => t.tool === "check-top" && t.region === "RU");
    expect(ru?.data.queries).toEqual(plan.queriesRu);
    expect(ru?.data.queries as string[]).not.toContain(REVERSED_RU);

    const uae = tasks.find((t) => t.tool === "check-top" && t.region === "UAE");
    expect(uae?.data.queries).toEqual(plan.queriesUae);
    expect(uae?.data.queries as string[]).not.toContain(REVERSED_LAT);
  });
});
