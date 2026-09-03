/**
 * Сниппет выдачи доезжает до индекса улик деки.
 *
 * Отчёт 84, стр. 37: у непрочитанной страницы dzen.ru цитата слов выдачи не
 * напечаталась — в наборе analytics сниппет ехал только у тел AI-ответов, а
 * у строк выдачи терялся, и окно цитаты искать было не в чем. Сниппет — то
 * наблюдение, до которого прослеживается тема непрочитанной страницы.
 */

import { describe, expect, it } from "vitest";
import { compositeObservationsToInventory } from "@/modules/digital-profile/services/canonical-report-prepare";
import { buildAnalyticsCompositeDataset } from "@/modules/digital-profile/orion-golden/analytics/composite-dataset-builder";
import { CompositeObservationRowSchema } from "@/modules/digital-profile/orion-golden/contracts/composite-dataset";
import type { CompositeObservation } from "@/modules/digital-profile/services/composite-serp-merge";

const SNIPPET = "Статья автора «Компромат» в Дзене: «Что связывает бывшего под следствием сенатора и судимого боксёра…»";

const obs = {
  key: "кремлев умар назарович ип|GOOGLE|RU|organic|dzen.ru/a/x",
  kind: "organic",
  surface: "organic",
  region: "RU",
  engine: "GOOGLE",
  query: "Кремлев Умар Назарович ип",
  url: "https://dzen.ru/a/Xn1M9yEqTziYbcMY",
  title: "Умар Назарович Лутфуллоев, он же Кремлев",
  snippet: SNIPPET,
  rank: 3,
  rankSource: "topvisor-google",
  providers: ["topvisor-google"],
  primaryProvider: "topvisor-google",
  evidenceRefs: [],
} as unknown as CompositeObservation;

describe("сниппет строки выдачи", () => {
  it("живёт в строке набора analytics и проходит контракт", () => {
    const built = buildAnalyticsCompositeDataset({
      datasetId: "composite-unified-snippet",
      caseId: "case-1",
      baseItems: [],
      enrichmentItems: compositeObservationsToInventory({ caseId: "case-1", baseReportRunId: "run-base", enrichmentRunId: "topvisor-positions-1", observations: [obs] }),
      binding: null,
      coverageRows: [],
      baseReportRunId: "run-base",
    });
    const row = built.dataset.observations[0]!;
    expect(row.snippet).toBe(SNIPPET);
    expect(CompositeObservationRowSchema.parse(row).snippet).toBe(SNIPPET);
  });
});
