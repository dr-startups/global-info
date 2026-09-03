/**
 * «Какими инструментами работает Arsenkin» — один ответ, `arsenkinTools()`.
 *
 * Ответов было три: состав агентов, бюджет стадии (`arsenkinBudgetForStage`) и
 * кнопка целевого повтора подсказок, где список был прибит строкой
 * `["suggest"]`. В режиме `topvisor` подсказки собирает Topvisor, и нажатие
 * кнопки заказало бы **второй платный** источник того же самого — ровно то,
 * что владелец запретил 03.09.2026.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { arsenkinSuggestEngines, arsenkinTools } from "@/modules/digital-profile/providers/arsenkin/flags";
import { planArsenkinExactTasks } from "@/modules/digital-profile/orion-golden/classic/plan-arsenkin-exact-tasks";
import { arsenkinBudgetForStage } from "@/modules/digital-profile/services/arsenkin-ui-orchestration/shared";
import { retryUnifiedEnrichmentSuggestionsTask } from "@/modules/digital-profile/services/unified-enrichment-targeted-retry";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("состав инструментов спрашивается в одном месте", () => {
  it("бюджет стадии не обещает инструментов вне состава", () => {
    vi.stubEnv("SERP_COLLECTION_PROVIDER", "topvisor");

    const budget = arsenkinBudgetForStage("FIRST36_STAGE1");

    // Подсказки Google остаются за Arsenkin и в режиме Topvisor: Topvisor их по
    // российским регионам не отдаёт, а по Дубаю вернул ноль (решение владельца
    // 03.09.2026, В4). Подсказки Яндекса — Topvisor.
    expect(arsenkinTools()).toEqual(["suggest", "paa"]);
    expect(arsenkinSuggestEngines()).toEqual(["GOOGLE"]);
    expect(budget.tools).toEqual(["suggest", "paa"]);
  });

  it("в прежнем режиме подсказки обеих систем — за Arsenkin", () => {
    vi.stubEnv("SERP_COLLECTION_PROVIDER", "legacy");
    expect(arsenkinSuggestEngines()).toEqual(["YANDEX", "GOOGLE"]);
  });

  it("в режиме topvisor план подсказок не содержит Яндекса", () => {
    const tasks = planArsenkinExactTasks({
      queriesRu: ["Кремлёв Умар Назарович"],
      queriesUae: ["Umar Kremlev"],
      tools: ["suggest"],
      suggestEngines: ["GOOGLE"],
    });
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.tool === "suggest" && t.engine === "GOOGLE")).toBe(true);
    expect(tasks.map((t) => t.region).sort()).toEqual(["RU", "UAE"]);
  });

  it("в прежнем режиме состав стадии прежний", () => {
    vi.stubEnv("SERP_COLLECTION_PROVIDER", "legacy");
    expect(arsenkinBudgetForStage("FIRST36_STAGE1").tools).toEqual(["check-top", "suggest", "paa"]);
  });

  it("канареечная стадия вне состава ничего не обещает", () => {
    vi.stubEnv("SERP_COLLECTION_PROVIDER", "topvisor");
    // Канарейка — подсказки Яндекса; в режиме Topvisor их собирает не Arsenkin.
    expect(arsenkinBudgetForStage("SUGGEST_RU_CANARY").tools).toEqual([]);
  });
});

describe("целевой повтор подсказок Arsenkin", () => {
  it("без подсказок в составе отказывает и называет причину — до всякой оплаты", async () => {
    vi.stubEnv("ARSENKIN_TOOLS", "paa");
    vi.stubEnv("SERP_COLLECTION_PROVIDER", "topvisor");
    vi.stubEnv("TOPVISOR_API_KEY", "k");
    vi.stubEnv("TOPVISOR_USER_ID", "100001");

    await expect(
      retryUnifiedEnrichmentSuggestionsTask({
        caseId: "case-1",
        jobId: "job-1",
        enrichmentRunId: "arsenkin-enrich-2",
        agentName: "ARSENKIN_SUGGESTIONS_REAL",
        confirmPaidEnrichmentRetry: true,
        actorId: "operator",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "SUGGEST_NOT_IN_ARSENKIN_TOOLS" },
    });
  });
});
