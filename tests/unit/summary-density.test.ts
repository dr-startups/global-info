import { describe, it, expect } from "vitest";
import { collapseRecommendations } from "../../src/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import {
  paginateComposedClientSummary,
  MAX_BLOCKS_PER_CONTINUATION_PAGE,
  CONTINUATION_PAGE_BUDGET_FACTOR,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/semantic-summary-pagination";
import { getClientTextFieldBudgets } from "../../src/modules/digital-profile/orion-golden/client/load-client-text-contract";

/**
 * Шаг 07 плана (docs/rework/07-slide-density-pagination-empty-states.md).
 *
 * В доставленном отчёте резюме занимало девять страниц-продолжений, на каждой
 * один буллет примерно на шестой части листа, а список «следующих проверок»
 * состоял из восьми копий одного предложения с разной темой.
 */

describe("collapseRecommendations", () => {
  it("схлопывает строки, отличающиеся только названием темы", () => {
    const out = collapseRecommendations([
      "Сверить первоисточники и статус материалов по теме «Деловые связи».",
      "Сверить первоисточники и статус материалов по теме «Криминальные материалы».",
      "Сверить первоисточники и статус материалов по теме «Офшоры».",
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("«Деловые связи»");
    expect(out[0]).toContain("«Криминальные материалы»");
    expect(out[0]).toContain("«Офшоры»");
  });

  it("сохраняет содержательно разные рекомендации", () => {
    const out = collapseRecommendations([
      "Сверить первоисточники по теме «А».",
      "Подготовить пакет документов для KYC.",
      "Сверить первоисточники по теме «Б».",
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]).toBe("Подготовить пакет документов для KYC.");
  });

  it("не дублирует одну и ту же тему", () => {
    const out = collapseRecommendations([
      "Сверить материалы по теме «А».",
      "Сверить материалы по теме «А».",
    ]);
    expect(out).toEqual(["Сверить материалы по теме «А»."]);
  });

  it("сохраняет порядок первого появления", () => {
    const out = collapseRecommendations([
      "Подготовить позицию для банков.",
      "Сверить материалы по теме «А».",
      "Сверить материалы по теме «Б».",
    ]);
    expect(out[0]).toBe("Подготовить позицию для банков.");
  });

  it("игнорирует пустые строки", () => {
    expect(collapseRecommendations(["", "   ", "Реальная рекомендация."])).toEqual([
      "Реальная рекомендация.",
    ]);
  });
});

describe("плотность страниц-продолжений", () => {
  const budgets = getClientTextFieldBudgets();

  /** ComposedClientSummary c N темами заданной длины. */
  function summaryWithThemes(count: number, bodyChars: number) {
    const sentence = "Содержательное предложение о теме этого раздела отчёта. ";
    const body = sentence.repeat(Math.ceil(bodyChars / sentence.length)).slice(0, bodyChars);
    return {
      schemaVersion: "composed-client-summary-v1",
      caseId: "case-d",
      datasetId: "ds-d",
      sourceHashes: ["sha256:d"],
      evidenceRefs: ["inventory:1"],
      subjectId: "Субъект",
      fullText: "Итоговая оценка: высокий риск.",
      sections: {
        scope: "Данные собраны 25.07.2026.",
        overallAssessment: "Итоговая оценка: высокий риск.",
        auditShortHeading: "Коротко по итогам аудита",
        themes: Array.from({ length: count }, (_, i) => ({
          themeId: "criminal_judicial",
          heading: `Тема ${i + 1}`,
          body,
          materialityLevel: "HIGH",
          evidenceRefs: ["inventory:1"],
          articleTitles: [],
          articleDomains: [],
        })),
        isolatedItems: "",
        internationalDatabases: "",
        changesSinceBaseline: "",
        nextSteps: "Следующие проверки.",
      },
      continuationThemeIds: [],
      gates: {
        SUMMARY_MATERIAL_THEME_COVERAGE: 100,
        SUMMARY_CONCRETE_EXAMPLES_PRESENT: true,
        SUMMARY_UNSUPPORTED_ASSERTIONS: 0,
        SUMMARY_TECHNICAL_COPY_TOKENS: 0,
        SUMMARY_INCOMPLETE_SENTENCES: 0,
      },
    } as never;
  }

  it("не отдаёт целую страницу блоку, который помещается рядом с другими", () => {
    // 700 символов — больше прежнего порога 66% бюджета буллета, из-за чего
    // каждый такой блок занимал страницу целиком.
    const plan = paginateComposedClientSummary(summaryWithThemes(6, 700));
    const pages = plan.continuationPages ?? [];
    const singles = pages.filter((p) => p.length === 1).length;
    expect(singles).toBeLessThan(pages.length);
  });

  it("держит суммарный объём страницы в пределах бюджета", () => {
    const plan = paginateComposedClientSummary(summaryWithThemes(9, 700));
    const pageBudget = budgets.bullet * CONTINUATION_PAGE_BUDGET_FACTOR;
    for (const page of plan.continuationPages ?? []) {
      const chars = page.reduce((acc, b) => acc + b.text.length, 0);
      // Одиночный блок может превышать бюджет — рядом с ним всё равно ничего
      // не помещается; для страниц с несколькими блоками бюджет обязателен.
      if (page.length > 1) expect(chars).toBeLessThanOrEqual(pageBudget);
      expect(page.length).toBeLessThanOrEqual(MAX_BLOCKS_PER_CONTINUATION_PAGE);
    }
  });

  it("сокращает число страниц по сравнению с правилом «блок на страницу»", () => {
    const themes = 9;
    const plan = paginateComposedClientSummary(summaryWithThemes(themes, 700));
    const pages = (plan.continuationPages ?? []).length;
    // Прежнее поведение дало бы по странице на каждый блок сверх первой.
    expect(pages).toBeLessThan(themes);
  });

  it("не теряет ни одного блока при уплотнении", () => {
    const plan = paginateComposedClientSummary(summaryWithThemes(7, 700));
    const onPages = (plan.continuationPages ?? []).flat().length;
    const onOverview = plan.overviewBlocks?.length ?? 0;
    expect(onPages + onOverview).toBeGreaterThanOrEqual(7);
  });
});
