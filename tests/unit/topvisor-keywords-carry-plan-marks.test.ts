/**
 * Ключевые слова Topvisor несут пометки плана запросов.
 *
 * В `dp_search_queries` лежит только текст запроса, а какой из них — само
 * ФИО и с каким назначением, знает план сбора. Загрузчик ключевых слов
 * восстанавливает пометки тем же построителем, что и базовый сбор, без сети:
 * имя субъекта в план кладут первым независимо от подсказок. Это тот же
 * ответ, которым живёт запрос нейро-ответа Яндекса, — второго построителя
 * быть не должно.
 */

import { describe, expect, it } from "vitest";
import { loadTopvisorKeywordsFromDb } from "@/modules/digital-profile/services/topvisor-positions-tick";
import { offlineOrionQueryPlan } from "@/modules/digital-profile/services/orion-search-profile-service";
import { yandexGenAnswerQuery } from "@/modules/digital-profile/services/yandex-gen-answer-collection";
import type { CaseSubjectInfo } from "@/modules/digital-profile/agents/mock/mock-utils";

const SUBJECT: CaseSubjectInfo = {
  caseId: "case-1",
  fullName: "Кремлёв Умар Назарович",
  aliases: ["Umar Kremlev"],
  targetRegions: ["RU", "UAE"],
  location: null,
  dateOfBirth: null,
  nationality: null,
  lawfulBasis: null,
  consentStatus: null,
  isFixture: false,
};

function prismaWith(rows: Array<{ engine: "YANDEX" | "GOOGLE"; queryText: string }>) {
  return {
    searchQuery: {
      findMany: async () => rows,
    },
  } as unknown as Parameters<typeof loadTopvisorKeywordsFromDb>[0];
}

describe("пометки плана у ключевых слов Topvisor", () => {
  it("ФИО в обоих контурах помечено как запрос субъекта, производные — своим назначением", async () => {
    // Ключ плана — «регион|фраза»: «Umar Kremlev» в RU — одно из написаний,
    // в ОАЭ — само имя, и одной записью на фразу их не различить.
    const prisma = prismaWith([
      { engine: "YANDEX", queryText: "Кремлёв Умар Назарович" },
      { engine: "YANDEX", queryText: "Кремлёв Умар Назарович инн" },
      { engine: "GOOGLE", queryText: "Umar Kremlev" },
      { engine: "GOOGLE", queryText: "Umar Kremlev company" },
    ]);
    const keywords = await loadTopvisorKeywordsFromDb(prisma, "case-1", { subject: async () => SUBJECT });
    expect(keywords.ru).toContain("Кремлёв Умар Назарович");
    expect(keywords.uae).toContain("Umar Kremlev");
    expect(keywords.plan?.["RU|кремлёв умар назарович"]).toEqual({
      purpose: "subject_lookup",
      subjectNameQuery: true,
    });
    expect(keywords.plan?.["UAE|umar kremlev"]).toEqual({ purpose: "subject_lookup", subjectNameQuery: true });
    expect(keywords.plan?.["RU|кремлёв умар назарович инн"]?.purpose).toBe("business_lookup");
    expect(keywords.plan?.["RU|кремлёв умар назарович инн"]?.subjectNameQuery).toBeUndefined();
  });

  it("запрос субъекта RU — тот же, что у нейро-ответа Яндекса", () => {
    const plan = offlineOrionQueryPlan(SUBJECT, ["RU"]);
    const fio = plan.find((q) => q.region === "RU" && q.subjectNameQuery);
    expect(fio?.query).toBe(yandexGenAnswerQuery(SUBJECT));
  });
});
