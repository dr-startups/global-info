/**
 * Подтверждённый алиас не вытесняет собственное написание субъекта.
 *
 * При непустых `latinAliases` набор ОАЭ был **ровно** алиасами: ни
 * транслитерация кириллического ФИО, ни латинское `fullName` туда не попадали.
 * Проверено на плане: у субъекта `Mohammed bin Rashid Al Maktoum` с алиасом
 * `Sheikh Mohammed` контур ОАЭ искал только алиас — настоящее имя субъекта в
 * регионе не искалось вовсе. Так было и до шага 0017: в живом корпусе Тинькова
 * есть `oleg tinkov`, `tinkov oleg`, `oleg tinkoff` и ни одной строки
 * `Tinkov Oleg Yurevich` (пункт BI).
 *
 * Решение владельца 19.08: **добавлять собственное написание рядом с алиасом.**
 * Плюс один запрос на прогон; взамен исчезает случай, когда настоящее имя
 * субъекта в регионе не ищется вовсе. Отвергнуто оставить только алиас — дыра в
 * покрытии остаётся и нигде не объявляется.
 *
 * Первым по-прежнему идёт алиас: его подтвердил аналитик, и он же остаётся
 * `primaryIdentityUae`, то есть тем, что печатается клиенту.
 */

import { describe, expect, it } from "vitest";
import { buildArsenkinSubjectQueryPlan } from "@/modules/digital-profile/orion-golden/classic/arsenkin-subject-query-plan";

describe("набор ОАЭ при подтверждённом алиасе", () => {
  it("латинское имя субъекта ищется рядом с алиасом", () => {
    const plan = buildArsenkinSubjectQueryPlan({
      fullName: "Mohammed bin Rashid Al Maktoum",
      aliases: ["Sheikh Mohammed"],
    });
    expect(plan.queriesUae).toContain("Sheikh Mohammed");
    expect(plan.queriesUae).toContain("Mohammed bin Rashid Al Maktoum");
    expect(plan.primaryIdentityUae).toBe("Sheikh Mohammed");
  });

  it("транслитерация своего ФИО ищется рядом с алиасом", () => {
    const plan = buildArsenkinSubjectQueryPlan({
      fullName: "Тиньков Олег Юрьевич",
      aliases: ["Oleg Tinkoff"],
    });
    expect(plan.queriesUae[0]).toBe("Oleg Tinkoff");
    expect(plan.queriesUae.some((q) => /Tinkov/i.test(q))).toBe(true);
  });

  it("предел набора не выбрасывает собственное написание", () => {
    const plan = buildArsenkinSubjectQueryPlan({
      fullName: "Mohammed bin Rashid Al Maktoum",
      aliases: ["Sheikh Mohammed", "Mohammed Al Maktoum", "MBR", "Sheikh MBR", "Ruler of Dubai"],
    });
    expect(plan.queriesUae.length).toBeLessThanOrEqual(4);
    expect(plan.queriesUae).toContain("Mohammed bin Rashid Al Maktoum");
    // Алиас всё равно первый: подтверждение аналитика сильнее.
    expect(plan.queriesUae[0]).toBe("Sheikh Mohammed");
  });

  it("без алиасов набор не меняется", () => {
    const plan = buildArsenkinSubjectQueryPlan({
      fullName: "Рашников Виктор Филиппович",
      aliases: [],
    });
    expect(plan.queriesUae).toEqual(["Rashnikov Viktor Filippovich", "Viktor Rashnikov"]);
  });
});
