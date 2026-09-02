/**
 * Счётчик обрезок обязан уметь дать не-ноль.
 *
 * `CLIENT_TEXT_TRUNCATIONS` — единственные ворота, отвечающие на вопрос «дошёл
 * ли текст резюме до клиента целиком», и `assertSemanticSummaryGatesPass`
 * останавливает по ним сборку. Все тесты вокруг проверяли только `=== 0`:
 * подмена счётчика на константу ноль оставляла зелёными все 1526 тестов. Это то
 * же, о чём проект говорит про растровую проверку — проверка, которая на
 * исправном входе даёт ноль, но не умеет дать не-ноль, гейтом не является.
 *
 * Здесь метрика проверяется в обе стороны: на целом плане — ноль, на плане с
 * потерей (выброшенный блок, выброшенная страница, обрезанный хвост) — больше
 * нуля. Укладка сама текста не теряет, поэтому потерю вносит тест: сравнение
 * должно её видеть независимо от того, кто её произвёл.
 */

import { describe, expect, it } from "vitest";
import {
  countClientTextTruncations,
  paginateComposedClientSummary,
} from "@/modules/digital-profile/orion-golden/deck-sections/semantic-summary-pagination";
import type { ComposedClientSummary } from "@/modules/digital-profile/orion-golden/contracts/composed-client-summary";

/** Различимые предложения: потерю одного видно, повтор одинаковых — нет. */
function sentences(prefix: string, count: number): string {
  return Array.from(
    { length: count },
    (_, i) => `${prefix} номер ${i + 1} с собственным содержанием и отдельным смыслом.`
  ).join(" ");
}

function summaryWith(themeBodies: string[]): ComposedClientSummary {
  return {
    schemaVersion: "composed-client-summary-v2",
    caseId: "case-trunc",
    datasetId: "ds-trunc",
    sourceHashes: ["sha256:t"],
    evidenceRefs: ["inventory:obs-1"],
    subjectId: "Субъект",
    fullText: "Итоговая оценка: высокий риск.",
    sections: {
      scope: sentences("Предложение области", 2),
      overallAssessment: "Итоговая оценка: высокий риск.",
      auditShortHeading: "Коротко по итогам аудита",
      themes: themeBodies.map((body, i) => ({
        themeId: `theme-${i + 1}`,
        kind: "claims" as const,
        heading: `Тема ${i + 1}`,
        body,
        evidenceRefs: ["inventory:obs-1"],
        articleTitles: [],
        articleDomains: [],
      })),
      isolatedItems: sentences("Единичный материал", 2),
      internationalDatabases: sentences("Запись базы", 2),
      changesSinceBaseline: sentences("Изменение", 2),
      nextSteps: sentences("Проверка", 2),
    },
    continuationThemeIds: [],
    gates: {
      SUMMARY_MATERIAL_THEME_COVERAGE: 100,
      SUMMARY_CONCRETE_EXAMPLES_PRESENT: true,
      SUMMARY_UNSUPPORTED_ASSERTIONS: 0,
      SUMMARY_TECHNICAL_COPY_TOKENS: 0,
      SUMMARY_INCOMPLETE_SENTENCES: 0,
    },
  } as ComposedClientSummary;
}

const SUMMARY = summaryWith([
  sentences("Утверждение первой темы", 6),
  sentences("Утверждение второй темы", 6),
  sentences("Утверждение третьей темы", 6),
  sentences("Утверждение четвёртой темы", 6),
]);

describe("метрика обрезок видит потерю", () => {
  it("на целом плане — ноль, и ворота показывают именно её", () => {
    const plan = paginateComposedClientSummary(SUMMARY);
    expect(countClientTextTruncations(SUMMARY, plan)).toBe(0);
    // Проводка закреплена отдельно от самого сравнения: сломается укладка —
    // ворота обязаны показать то же число, что и счётчик, а не свою константу.
    expect(plan.gates.CLIENT_TEXT_TRUNCATIONS).toBe(countClientTextTruncations(SUMMARY, plan));
  });

  it("выброшенный блок считается потерей", () => {
    const plan = paginateComposedClientSummary(SUMMARY);
    const lossy = { ...plan, overviewBlocks: plan.overviewBlocks.slice(1) };
    expect(countClientTextTruncations(SUMMARY, lossy)).toBeGreaterThan(0);
  });

  it("выброшенная страница продолжения считается потерей", () => {
    const plan = paginateComposedClientSummary(SUMMARY);
    expect(plan.continuationPages.length).toBeGreaterThan(0);
    const lossy = { ...plan, continuationPages: plan.continuationPages.slice(0, -1) };
    expect(countClientTextTruncations(SUMMARY, lossy)).toBeGreaterThan(0);
  });

  it("обрезанный хвост блока считается потерей — по предложению за каждое", () => {
    const plan = paginateComposedClientSummary(SUMMARY);
    const first = plan.overviewBlocks[0]!;
    const kept = first.text.split(" ").slice(0, 6).join(" ");
    const lossy = {
      ...plan,
      overviewBlocks: [{ ...first, text: kept }, ...plan.overviewBlocks.slice(1)],
    };
    expect(countClientTextTruncations(SUMMARY, lossy)).toBeGreaterThan(0);
  });

  it("потерянный нарратив считается потерей", () => {
    const plan = paginateComposedClientSummary(SUMMARY);
    const lossy = { ...plan, overviewNarrative: [] };
    expect(countClientTextTruncations(SUMMARY, lossy)).toBeGreaterThan(0);
  });

  it("перенос предложения на соседний блок потерей не считается", () => {
    // Ровно тот случай, ради которого сравнение склеивает части блока: длинное
    // предложение разложено по частям, ни одно слово не пропало.
    const long = `Источники: ${Array.from({ length: 60 }, (_, i) => `nordic-review-${i}.se`).join(", ")}.`;
    const summary = summaryWith([long]);
    const plan = paginateComposedClientSummary(summary);
    const blocks = [...plan.overviewBlocks, ...plan.continuationPages.flat()].filter(
      (b) => b.themeId === "theme-1"
    );
    expect(blocks.length).toBeGreaterThan(1);
    expect(countClientTextTruncations(summary, plan)).toBe(0);
    expect(plan.gates.CLIENT_TEXT_TRUNCATIONS).toBe(
      countClientTextTruncations(summary, plan)
    );
  });
});
