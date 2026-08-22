/**
 * Заголовок темы не повторяется на соседних буллетах одной страницы.
 *
 * Длинная тема нарезается на части, и каждая часть после первой получает
 * заголовок «<тема> (продолжение)». Он нужен, когда часть оторвана от начала
 * темы: без него читатель не поймёт, о чём блок. Но две части, попавшие на одну
 * страницу подряд, печатают его дважды.
 *
 * На живых отчётах это видно на обоих: стр. 5 отчёта по Ким —
 * «Удары по складам Wildberries и риски для бизнеса (продолжение).» дважды,
 * стр. 5 отчёта по Кремлёву — «Руководство боксерскими организациями и
 * конфликты вокруг IBA (продолжение).» дважды (пункт CX).
 *
 * Тот же класс, что повтор рекомендации Википедии: заголовок принадлежит блоку,
 * а печатается на каждом куске.
 */

import { describe, expect, it } from "vitest";
import { paginateComposedClientSummary } from "@/modules/digital-profile/orion-golden/deck-sections/semantic-summary-pagination";
import type { ComposedClientSummary } from "@/modules/digital-profile/orion-golden/contracts/composed-client-summary";

const HEADING = "Руководство организациями и конфликты вокруг ассоциации";

/** Тело, заведомо не влезающее в один буллет: предложения по ~120 знаков. */
const LONG_BODY = Array.from({ length: 40 }, (_, i) =>
  `Публикация ${i + 1} описывает эпизод спора вокруг ассоциации и приводит позиции сторон со ссылкой на первоисточник.`
).join(" ");

function summary(): ComposedClientSummary {
  return {
    schemaVersion: "composed-client-summary-v1",
    caseId: "case-1",
    datasetId: "ds-1",
    subjectId: "Тестов Иван",
    sourceHashes: ["sha256:test"],
    evidenceRefs: ["inventory:obs-1"],
    fullText: "",
    continuationThemeIds: [],
    gates: {},
    sections: {
      scope: "Исследованы результаты поиска в ТОП-20.",
      overallAssessment: "Итоговая оценка: высокий риск.",
      auditShortHeading: "Коротко по итогам аудита",
      themes: [
        {
          themeId: "t1",
          heading: HEADING,
          body: LONG_BODY,
          evidenceRefs: ["inventory:obs-1"],
          articleTitles: [],
          articleDomains: [],
        },
      ],
      isolatedItems: "",
      internationalDatabases: "",
      changesSinceBaseline: "",
      nextSteps: "",
    },
  } as unknown as ComposedClientSummary;
}

/** Заголовки блоков страницы в том виде, в каком их получит дека. */
function headingsOf(page: ReadonlyArray<{ heading?: string }>): string[] {
  return page.map((b) => b.heading ?? "");
}

describe("страница-продолжение", () => {
  it("нарезает длинную тему на несколько частей", () => {
    const plan = paginateComposedClientSummary(summary(), { leadThemeCount: 3 });
    const parts = [...plan.overviewBlocks, ...plan.continuationPages.flat()].filter(
      (b) => b.themeId === "t1"
    );
    expect(parts.length).toBeGreaterThan(1);
  });

  it("не печатает один заголовок дважды подряд на одной странице", () => {
    const plan = paginateComposedClientSummary(summary(), { leadThemeCount: 3 });
    for (const page of [plan.overviewBlocks, ...plan.continuationPages]) {
      const heads = headingsOf(page).filter(Boolean);
      const dupes = heads.filter((h, i) => i > 0 && h === heads[i - 1]);
      expect(dupes).toEqual([]);
    }
  });

  it("первая часть на странице заголовок несёт", () => {
    // Снимать его у всех значило бы оторвать блок от темы: читатель
    // страницы-продолжения не видит, где тема началась.
    const plan = paginateComposedClientSummary(summary(), { leadThemeCount: 3 });
    for (const page of plan.continuationPages) {
      const themeBlocks = page.filter((b) => b.kind === "theme");
      if (themeBlocks.length === 0) continue;
      expect(themeBlocks[0]!.heading).toBeTruthy();
    }
  });
});
