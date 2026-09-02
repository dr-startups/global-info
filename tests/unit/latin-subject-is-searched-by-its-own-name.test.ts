/**
 * Латинское имя ищется латиницей, а не английским словом «subject».
 *
 * У субъекта с латинским именем и без кириллических алиасов `queriesRu`
 * оставался пуст, и заявка уходила с единственной строкой `"subject"` —
 * платный `check-top` по английскому слову. Блокер `empty-queries-ru` не
 * спасал: план блокируется, только когда пусты **оба** набора (пункт BH,
 * найдено ревью шага 0017 на арабском имени; предсуществующее).
 *
 * Решение владельца 19.08: **искать латинское имя.** Русскоязычные источники
 * часто пишут имя латиницей, риск нулевой — ищем то, что точно существует.
 * Отвергнуты транслитерация в кириллицу (неоднозначна, можем заплатить за
 * написание, которым его никто не называет) и отказ от русского сбора вовсе
 * (теряет русскоязычное покрытие целиком).
 *
 * Порядок частей латинского имени не переставляется: это правило модуля, и
 * оно здесь не меняется — «Mohammed bin Rashid Al Maktoum» дало бы «bin
 * Mohammed», то есть выдуманный запрос.
 */

import { describe, expect, it } from "vitest";
import { buildArsenkinSubjectQueryPlan } from "@/modules/digital-profile/orion-golden/classic/arsenkin-subject-query-plan";
import { planArsenkinExactTasks } from "@/modules/digital-profile/orion-golden/classic/plan-arsenkin-exact-tasks";

const ARABIC_LATIN = "Mohammed bin Rashid Al Maktoum";

describe("латинский субъект и русский контур", () => {
  it("ищется своим именем, а не пустотой", () => {
    const plan = buildArsenkinSubjectQueryPlan({ fullName: ARABIC_LATIN, aliases: [] });
    expect(plan.queriesRu).toContain(ARABIC_LATIN);
    expect(plan.blockers).not.toContain("empty-queries-ru");
    expect(plan.primaryIdentityRu).toBe(ARABIC_LATIN);
  });

  it("порядок частей латинского имени не переставляется", () => {
    const plan = buildArsenkinSubjectQueryPlan({ fullName: ARABIC_LATIN, aliases: [] });
    for (const q of plan.queriesRu) {
      expect(q.startsWith("Mohammed")).toBe(true);
    }
  });

  it("кириллический алиас идёт вместе с ним, а не вместо", () => {
    const plan = buildArsenkinSubjectQueryPlan({
      fullName: ARABIC_LATIN,
      aliases: ["Мохаммед бин Рашид Аль Мактум"],
    });
    expect(plan.queriesRu[0]).toBe(ARABIC_LATIN);
    expect(plan.queriesRu).toContain("Мохаммед бин Рашид Аль Мактум");
  });

  it("кириллический субъект ничего не теряет", () => {
    const plan = buildArsenkinSubjectQueryPlan({
      fullName: "Иванов Иван Иванович",
      aliases: [],
    });
    expect(plan.queriesRu[0]).toBe("Иванов Иван Иванович");
    expect(plan.queriesRu).toContain("Иван Иванович Иванов");
  });
});

describe("платная заявка не покупает английское слово", () => {
  const TOOLS = ["check-top", "suggest", "paa", "ai-serp"];

  it("латинский субъект платит за своё имя", () => {
    const plan = buildArsenkinSubjectQueryPlan({ fullName: ARABIC_LATIN, aliases: [] });
    const tasks = planArsenkinExactTasks({
      queriesRu: plan.queriesRu,
      queriesUae: plan.queriesUae,
      tools: TOOLS,
    });
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(JSON.stringify(t.requestJson)).not.toContain('"subject"');
      expect(t.query).not.toBe("subject");
    }
  });

  it("без единого запроса платных заявок не строится вовсе", () => {
    // Слово «subject» было умолчанием, печатавшим английское слово вместо
    // имени: платить за него нельзя ни при каких входах.
    const tasks = planArsenkinExactTasks({ queriesRu: [], queriesUae: [], tools: TOOLS });
    expect(tasks).toEqual([]);
  });
});
