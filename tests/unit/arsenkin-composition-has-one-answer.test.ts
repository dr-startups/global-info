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
import { arsenkinTools } from "@/modules/digital-profile/providers/arsenkin/flags";
import { arsenkinBudgetForStage } from "@/modules/digital-profile/services/arsenkin-ui-orchestration/shared";
import { retryUnifiedEnrichmentSuggestionsTask } from "@/modules/digital-profile/services/unified-enrichment-targeted-retry";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("состав инструментов спрашивается в одном месте", () => {
  it("бюджет стадии не обещает инструментов вне состава", () => {
    vi.stubEnv("SERP_COLLECTION_PROVIDER", "topvisor");

    const budget = arsenkinBudgetForStage("FIRST36_STAGE1");

    expect(arsenkinTools()).toEqual(["paa"]);
    expect(budget.tools).toEqual(["paa"]);
  });

  it("в прежнем режиме состав стадии прежний", () => {
    vi.stubEnv("SERP_COLLECTION_PROVIDER", "legacy");
    expect(arsenkinBudgetForStage("FIRST36_STAGE1").tools).toEqual(["check-top", "suggest", "paa"]);
  });

  it("канареечная стадия вне состава ничего не обещает", () => {
    vi.stubEnv("SERP_COLLECTION_PROVIDER", "topvisor");
    expect(arsenkinBudgetForStage("SUGGEST_RU_CANARY").tools).toEqual([]);
  });
});

describe("целевой повтор подсказок Arsenkin", () => {
  it("в режиме topvisor отказывает и называет причину — до всякой оплаты", async () => {
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
