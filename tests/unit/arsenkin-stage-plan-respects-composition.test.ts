/**
 * Стадия Arsenkin по умолчанию не планирует инструмент вне состава.
 *
 * Дыра, найденная при проверке T3: `stageHasEnabledTools` пропускает стадию,
 * если включён **хоть один** её инструмент. В режиме `topvisor` включён `paa`,
 * значит стадия `FIRST36_STAGE1` запускается — и её список по умолчанию
 * (`check-top`, `suggest`, `paa`) уходил в план целиком. Ручной путь вкладки
 * Arsenkin заказал бы платные подсказки и позиции, которые уже собирает
 * Topvisor: ровно та двойная оплата, которую владелец запретил 03.09.2026.
 *
 * Явный запрос инструмента (`toolsOverride`) фильтром не трогается — там
 * пустой план означает ошибку вызывающего, и это уже было выяснено раньше.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildArsenkinExecutionPlan } from "@/modules/digital-profile/orion-golden/classic/arsenkin-execution-plan";

const base = {
  caseId: "case-1",
  reportRunId: "orion-arsenkin-first36-full-1",
  queriesRu: ["Кремлёв Умар Назарович"],
  queriesUae: ["Umar Kremlev"],
  maxNewTasks: 20,
  maxEstimatedLimits: 20,
  existingTasks: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("состав инструментов и план стадии", () => {
  it("в режиме topvisor стадия планирует подсказки Google и «люди также спрашивают»", () => {
    vi.stubEnv("SERP_COLLECTION_PROVIDER", "topvisor");

    const plan = buildArsenkinExecutionPlan({ ...base, stage: "FIRST36_STAGE1" });

    // Позиции и подсказки Яндекса — Topvisor; подсказки Google Topvisor не
    // отдаёт, они остаются за Arsenkin (решение владельца 03.09.2026, В4).
    expect(plan.tools).toEqual(["suggest", "paa"]);
    expect(plan.requests.map((r) => r.tool)).not.toContain("check-top");
    const suggest = plan.requests.filter((r) => r.tool === "suggest");
    expect(suggest.length).toBeGreaterThan(0);
    expect(suggest.every((r) => r.engine === "GOOGLE")).toBe(true);
  });

  it("в прежнем режиме состав стадии прежний", () => {
    vi.stubEnv("SERP_COLLECTION_PROVIDER", "legacy");

    const plan = buildArsenkinExecutionPlan({ ...base, stage: "FIRST36_STAGE1" });

    expect(plan.tools).toEqual(["check-top", "suggest", "paa"]);
    expect(plan.requests.some((r) => r.tool === "suggest")).toBe(true);
  });

  it("явно запрошенный инструмент планируется, даже если он вне состава", () => {
    // Пустой план на явный запрос — ошибка вызывающего, а не «нечего делать».
    vi.stubEnv("SERP_COLLECTION_PROVIDER", "topvisor");

    const plan = buildArsenkinExecutionPlan({
      ...base,
      stage: "FIRST36_STAGE1",
      toolsOverride: ["suggest"],
    });

    expect(plan.tools).toEqual(["suggest"]);
    expect(plan.requests.some((r) => r.tool === "suggest")).toBe(true);
  });
});
