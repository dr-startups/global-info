/**
 * Каждый блок резюме укладывается в бюджет **в том виде, в каком печатается**.
 *
 * 7cbad29 закрыл один случай этого класса — заголовок темы, приписываемый к
 * телу. Класс остался: нарезал один участник, печатал другой. Замер на коде до
 * этой правки, все пять случаев смертельны для всего отчёта:
 *
 *     overall/overall_overflow: 1796>900   (перелив нарратива склеивался join(" "))
 *     isolated/isolated:        1500>900   (блок уходил в деку целиком)
 *     databases/databases:      1500>900
 *     changes/changes:          1500>900
 *     next_steps/next_steps:    1500>900
 *
 * Любой из них даёт `bullet over budget on p0N_executive`, обязательная секция
 * EXECUTIVE_SUMMARY получает FAILED — и клиент не получает ничего.
 *
 * Свойство, которое держит этот тест: что уходит в деку, то и меряется, для
 * **любого** вида блока. Переносить — можно, обрезать — нельзя.
 */

import { describe, expect, it } from "vitest";
import {
  assertSemanticSummaryGatesPass,
  paginateComposedClientSummary,
  renderSemanticBlock,
  type SummaryPagePlan,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/semantic-summary-pagination";
import { getClientTextFieldBudgets } from "../../src/modules/digital-profile/orion-golden/client/load-client-text-contract";
import type { ComposedClientSummary } from "../../src/modules/digital-profile/orion-golden/contracts/composed-client-summary";

const BUDGETS = getClientTextFieldBudgets();

/**
 * Ожидаемая печатная форма блока, записанная здесь независимо от кода.
 * Ровно её видит `checkText` в проверке секций: у темы — заголовок с телом,
 * у остальных — тело. Производственный ответ обязан с ней совпадать.
 */
function printedByDeck(block: { kind: string; heading?: string; text: string }): string {
  if (block.heading && block.kind === "theme") {
    return block.text.startsWith(block.heading) ? block.text : `${block.heading}. ${block.text}`;
  }
  return block.text;
}

const SENTENCE =
  "Публикация описывает эпизод с участием проверяемого лица и приводит ссылку на источник. ";

/** Текст заданной длины из целых предложений — как приходит из композитора. */
function longText(chars: number): string {
  return SENTENCE.repeat(Math.ceil(chars / SENTENCE.length) + 1).slice(0, chars);
}

function summaryWith(over: Partial<ComposedClientSummary["sections"]>): ComposedClientSummary {
  return {
    sections: {
      overallAssessment: "Итоговая оценка — высокий риск.",
      scope: "Проверка охватывает два региональных контура.",
      auditShortHeading: "Коротко по итогам аудита",
      themes: [],
      isolatedItems: "",
      internationalDatabases: "",
      changesSinceBaseline: "",
      nextSteps: "",
      ...over,
    },
    evidenceRefs: [],
  } as unknown as ComposedClientSummary;
}

function emittedBlocks(plan: SummaryPagePlan) {
  return [...plan.overviewBlocks, ...plan.continuationPages.flat()];
}

function wordsOf(text: string): string[] {
  return text.split(/\s+/u).filter(Boolean);
}

/** Наблюдавшиеся случаи: длинный текст в каждом из видов блоков. */
const CASES: Array<[string, ComposedClientSummary]> = [
  [
    "перелив нарратива",
    summaryWith({ overallAssessment: longText(2500), scope: longText(2500) }),
  ],
  ["isolatedItems", summaryWith({ isolatedItems: longText(1500) })],
  ["internationalDatabases", summaryWith({ internationalDatabases: longText(1500) })],
  ["changesSinceBaseline", summaryWith({ changesSinceBaseline: longText(1500) })],
  ["nextSteps", summaryWith({ nextSteps: longText(1500) })],
  [
    "тема с заголовком",
    summaryWith({
      themes: [
        {
          themeId: "criminal_judicial",
          heading: "Криминальные / судебные материалы",
          body: longText(1500),
          materialityLevel: "CRITICAL",
          evidenceRefs: ["ev-1"],
          articleTitles: [],
          articleDomains: [],
        },
      ],
    }),
  ],
];

describe("блок резюме меряется в том виде, в каком печатается", () => {
  for (const [name, summary] of CASES) {
    it(`${name}: ни один блок не выходит за бюджет буллета`, () => {
      const plan = paginateComposedClientSummary(summary);
      const blocks = emittedBlocks(plan);
      expect(blocks.length).toBeGreaterThan(0);
      for (const b of blocks) {
        expect(printedByDeck(b).length).toBeLessThanOrEqual(BUDGETS.bullet);
      }
    });

    it(`${name}: перенос, а не обрезка — слова целы`, () => {
      const plan = paginateComposedClientSummary(summary);
      const emittedWords = [
        ...plan.overviewNarrative,
        ...emittedBlocks(plan).map((b) => b.text),
      ].flatMap(wordsOf);
      const sourceWords = [
        summary.sections.overallAssessment,
        summary.sections.scope,
        ...summary.sections.themes.map((t) => t.body),
        summary.sections.isolatedItems,
        summary.sections.internationalDatabases,
        summary.sections.changesSinceBaseline,
        summary.sections.nextSteps,
      ].flatMap(wordsOf);
      for (const w of sourceWords) expect(emittedWords).toContain(w);
    });
  }

  it("печатная форма задана в одном месте — производство совпадает с ожиданием", () => {
    for (const [, summary] of CASES) {
      for (const b of emittedBlocks(paginateComposedClientSummary(summary))) {
        expect(renderSemanticBlock(b)).toBe(printedByDeck(b));
      }
    }
  });

  it("гейт срабатывает до проверки секций и называет виновника", () => {
    const plan = paginateComposedClientSummary(summaryWith({ isolatedItems: longText(200) }));
    expect(() => assertSemanticSummaryGatesPass(plan)).not.toThrow();

    // Блок, проскочивший мимо укладки, обязан остановить сборку по имени, а не
    // дойти до секций безымянным `bullet over budget`.
    const smuggled: SummaryPagePlan = {
      ...plan,
      continuationPages: [
        ...plan.continuationPages,
        [
          {
            kind: "isolated",
            blockId: "smuggled_block",
            text: "x".repeat(BUDGETS.bullet + 1),
            evidenceRefs: [],
            articleTitles: [],
            articleDomains: [],
          },
        ],
      ],
    };
    expect(() => assertSemanticSummaryGatesPass(recount(smuggled))).toThrow(/smuggled_block/u);
  });
});

/** Пересчёт гейтов для собранного вручную плана — считает то же, что и укладка. */
function recount(plan: SummaryPagePlan): SummaryPagePlan {
  const over = [...plan.overviewBlocks, ...plan.continuationPages.flat()].filter(
    (b) => renderSemanticBlock(b).length > BUDGETS.bullet
  );
  return {
    ...plan,
    overBudgetBlocks: over.map((b) => ({
      blockId: b.blockId,
      length: renderSemanticBlock(b).length,
      budget: BUDGETS.bullet,
    })),
    gates: { ...plan.gates, SUMMARY_BLOCK_OVER_BUDGET: over.length },
  };
}
