/**
 * Буллет резюме укладывается в бюджет **вместе с заголовком темы**.
 *
 * Прогон заказчика 28.07:
 *
 *     required sections failed: EXECUTIVE/EXECUTIVE_SUMMARY:FAILED
 *     (bullet over budget on p03_executive: 901>900;
 *      bullet over budget on p03_executive: 922>900)
 *
 * Укладка считала бюджет по телу темы, а в деку уходила склейка «Заголовок.
 * Тело» (`themeBlockText`). Мерилось одно, печаталось другое — и одного лишнего
 * знака хватало, чтобы отчёт не собрался вовсе.
 *
 * Проверяем то, что печатается, а не то, что нарезается.
 */

import { describe, expect, it } from "vitest";
import {
  paginateComposedClientSummary,
  bodyBudgetForTheme,
  renderSemanticBlock,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/semantic-summary-pagination";
import { themeBlockText } from "../../src/modules/digital-profile/orion-golden/analytics/client-summary-composer";
import { getClientTextFieldBudgets } from "../../src/modules/digital-profile/orion-golden/client/load-client-text-contract";
import type { ComposedClientSummary } from "../../src/modules/digital-profile/orion-golden/contracts/composed-client-summary";

const BUDGETS = getClientTextFieldBudgets();

/**
 * То, что печатает дека. Своей копии здесь больше нет: она была третьим
 * ответом на вопрос «как выглядит буллет» и могла разойтись с production
 * незаметно для этого же теста.
 */
const emittedBullet = renderSemanticBlock;

function summaryWithTheme(heading: string, body: string): ComposedClientSummary {
  return {
    sections: {
      overallAssessment: "Итоговая оценка — высокий риск.",
      scope: "Проверка охватывает два региональных контура.",
      auditShortHeading: "",
      themes: [
        {
          themeId: "criminal",
          heading,
          body,
          evidenceRefs: [],
          articleTitles: [],
          articleDomains: [],
        },
      ],
      isolatedItems: "",
      internationalDatabases: "",
      changesSinceBaseline: "",
      nextSteps: "",
    },
    evidenceRefs: [],
  } as unknown as ComposedClientSummary;
}

describe("буллет резюме вместе с заголовком", () => {
  it("не превышает бюджет — воспроизведение случая 901>900", () => {
    const heading = "Криминальные / судебные материалы";
    // Тело ровно по прежнему бюджету: с заголовком склейка выходила за него.
    const sentence = "Найдены публикации, в которых субъект связывается с судебными сюжетами. ";
    const body = sentence
      .repeat(Math.ceil(BUDGETS.bullet / sentence.length) + 1)
      .slice(0, BUDGETS.bullet);
    expect(body.length).toBe(BUDGETS.bullet);

    const plan = paginateComposedClientSummary(summaryWithTheme(heading, body));
    const blocks = [...plan.overviewBlocks, ...plan.continuationPages.flat()];
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) {
      expect(emittedBullet(b).length).toBeLessThanOrEqual(BUDGETS.bullet);
    }
  });

  it("длинный заголовок сильнее ужимает тело, но не обнуляет его", () => {
    const long = "Очень длинное название темы повышенного внимания с уточнениями и оговорками";
    expect(bodyBudgetForTheme(long, BUDGETS.bullet)).toBeLessThan(BUDGETS.bullet);
    expect(bodyBudgetForTheme(long, BUDGETS.bullet)).toBeGreaterThan(0);
    // Даже абсурдно длинный заголовок оставляет место под текст.
    expect(bodyBudgetForTheme("x".repeat(5000), BUDGETS.bullet)).toBeGreaterThanOrEqual(80);
  });

  it("без заголовка бюджет не урезается", () => {
    expect(bodyBudgetForTheme(undefined, BUDGETS.bullet)).toBe(BUDGETS.bullet);
    expect(bodyBudgetForTheme("   ", BUDGETS.bullet)).toBe(BUDGETS.bullet);
  });

  it("поправка учитывает пометку «(продолжение)» у частей", () => {
    const heading = "Тема";
    // «Тема (продолжение). » длиннее, чем «Тема. »; поправка берёт больший вариант.
    const budget = bodyBudgetForTheme(heading, 1000);
    const worstCase = themeBlockText(`${heading} (продолжение)`, "x".repeat(budget));
    expect(worstCase.length).toBeLessThanOrEqual(1000);
  });
});
