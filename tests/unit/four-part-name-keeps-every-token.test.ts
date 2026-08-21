/**
 * Имя из четырёх и более частей не теряет токен в платном запросе.
 *
 * `permutationsOfName` строила перестановку «Имя Отчество Фамилия» как
 * `parts[1] parts[2] parts[0]` — то есть ровно из трёх частей. У имени
 * «Иванов Иван Иванович Оглы» второй строкой уходило «Иван Иванович Иванов»:
 * имя **другого человека**, «Оглы» молча отброшено. Прежний `reverse()` хотя
 * бы сохранял все токены. Вход редкий, но запрос платный (пункт BF, найдено
 * ревью шага 0017).
 */

import { describe, expect, it } from "vitest";
import { buildArsenkinSubjectQueryPlan } from "@/modules/digital-profile/orion-golden/classic/arsenkin-subject-query-plan";

function tokensOf(q: string): string[] {
  return q.split(/\s+/).filter(Boolean).sort();
}

describe("перестановки имени", () => {
  it("из четырёх частей не теряют ни одной", () => {
    const full = "Иванов Иван Иванович Оглы";
    const plan = buildArsenkinSubjectQueryPlan({ fullName: full, aliases: [] });
    const all = tokensOf(full);
    const long = plan.queriesRu.filter((q) => q.split(/\s+/).length >= 3);
    expect(long.length).toBeGreaterThan(1);
    for (const q of long) {
      // Длинная форма обязана нести те же токены: короткая «Имя Фамилия» —
      // законное сокращение, а трёхсловный огрызок четырёхсловного имени —
      // другой человек.
      expect(tokensOf(q)).toEqual(all);
    }
  });

  it("«Имя Отчество Фамилия» сохраняет порядок частей", () => {
    const plan = buildArsenkinSubjectQueryPlan({
      fullName: "Иванов Иван Иванович Оглы",
      aliases: [],
    });
    expect(plan.queriesRu).toContain("Иван Иванович Оглы Иванов");
  });

  it("трёхсловное ФИО не меняется", () => {
    const plan = buildArsenkinSubjectQueryPlan({
      fullName: "Рашников Виктор Филиппович",
      aliases: [],
    });
    expect(plan.queriesRu).toEqual([
      "Рашников Виктор Филиппович",
      "Виктор Филиппович Рашников",
      "Виктор Рашников",
    ]);
  });

  it("двухсловное имя не меняется", () => {
    const plan = buildArsenkinSubjectQueryPlan({ fullName: "Иванов Иван", aliases: [] });
    expect(plan.queriesRu).toEqual(["Иванов Иван", "Иван Иванов"]);
  });
});
