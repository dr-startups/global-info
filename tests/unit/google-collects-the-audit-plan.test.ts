/**
 * Движок, который собирает позиции, ходит по плану аудита (шаг 0137).
 *
 * Шаг 0136 дал таблице Google настоящие адреса и отнял охват. Прогон
 * Галицкого 20.09.2026: Serper вернул 19 органических строк по одному запросу,
 * позиции 1–9, только по России. Topvisor раньше давал 403 строки по 25
 * запросам в двух контурах. На стр. 19 отчёта встало «Позиции 10–20 не вернул
 * ни один источник выдачи в этом прогоне» — по смыслу неправда, их никто не
 * спрашивал, — а на стр. 47 контур ОАЭ остался без органики вовсе.
 *
 * Причина: базовый сборщик ходит по личному набору (`buildPersonSearchQueries`,
 * не больше трёх запросов, один регион, своя глубина), а Topvisor ходил по
 * плану аудита. План один на продукт, и второго набора запросов для той же
 * выдачи заводить нельзя.
 */

import { describe, expect, it } from "vitest";
import { googleAuditSearchSpecs } from "@/modules/digital-profile/agents/real/real-google-search-agent";
import {
  offlineOrionQueryPlan,
  SERP_AUDIT_DEPTH,
} from "@/modules/digital-profile/search-surfaces/offline-orion-query-plan";

const SUBJECT = {
  fullName: "Галицкий Сергей Николаевич",
  aliases: ["Сергей Галицкий", "Sergey Galitsky"],
  targetRegions: ["RU", "UAE"],
  location: "Краснодар",
};

describe("набор запросов Google — это план аудита", () => {
  it("П1: запросов столько же, сколько в плане, и они те же", () => {
    const plan = offlineOrionQueryPlan(SUBJECT as never);
    const specs = googleAuditSearchSpecs(SUBJECT as never);
    expect(specs).not.toBeNull();
    expect(specs!.length).toBe(plan.length);
    expect(new Set(specs!.map((s) => s.query))).toEqual(new Set(plan.map((q) => q.query)));
  });

  it("П2: собираются оба контура, а не один", () => {
    const specs = googleAuditSearchSpecs(SUBJECT as never)!;
    expect(new Set(specs.map((s) => s.region))).toEqual(new Set(["ru", "ae"]));
  });

  it("П3: глубина — глубина аудита, а не умолчание провайдера", () => {
    const specs = googleAuditSearchSpecs(SUBJECT as never)!;
    for (const s of specs) expect(s.limit).toBe(SERP_AUDIT_DEPTH);
  });

  it("П4: язык берётся у региона — русский для России, английский для ОАЭ", () => {
    const specs = googleAuditSearchSpecs(SUBJECT as never)!;
    expect(specs.find((s) => s.region === "ru")?.language).toBe("ru");
    expect(specs.find((s) => s.region === "ae")?.language).toBe("en");
  });
});
