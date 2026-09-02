/**
 * Пакетная метрика выдачи отвечает на вопрос фрагмента, а не листа.
 *
 * Единица счёта у листа — его собственная таблица (движок и запрос), и с
 * партии 0045 `datasetCount` слайда описывает именно её. У **пакета** вопрос
 * другой: пакет это фрагмент целиком, его `datasetCount` читает проверка
 * секции (`section-validation`, «displayedCount > datasetCount»), и региональное
 * число там — правильный ответ, а не забытый.
 *
 * Разные объекты, а не два ответа на один вопрос. Держал это свойство один лишь
 * артефакт эталона: сдвинь метрику пакета к полосе движка — и регрессия
 * проявилась бы диффом на ревью, а не красным тестом.
 */

import { describe, expect, it } from "vitest";
import { loadReport72DeckInputs } from "../../scripts/run-orion-deck-sections-report72";
import { buildSectionPackForFragment } from "@/modules/digital-profile/orion-golden/deck-sections/section-builders";
import type { SectionBuildContext } from "@/modules/digital-profile/orion-golden/deck-sections/section-builders";
import { SERP_TABLE_HEADERS } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { ExecutiveSummaryExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

const inputs = loadReport72DeckInputs();

/** Наблюдения российской выдачи эталона-72 — число фрагмента, не движка. */
const RU_REGION_OBSERVATIONS = 143;

const pack = ((): ReturnType<typeof buildSectionPackForFragment> => {
  const ctx: SectionBuildContext = {
    caseId: inputs.caseId,
    reportRunId: inputs.reportRunId,
    sourceDatasetId: inputs.sourceDatasetId,
    contentVersion: "test-content-version",
    subject: { displayName: "Сергей Глинка", aliases: ["Sergey Glinka"] },
    bundle: inputs.mergedBundle,
    surfaceUnits: inputs.surfaceUnits,
    metricSnapshot: inputs.metricSnapshot,
    evidenceIndex: inputs.evidenceIndex,
    extras: {
      executiveSummary: inputs.executiveSummary as unknown as ExecutiveSummaryExtras,
      surfaceCollectionHints: inputs.surfaceCollectionHints,
      visualAssets: {},
    },
    buildLog: [],
  } as unknown as SectionBuildContext;
  return buildSectionPackForFragment("RU_SERP", ctx);
})();

const sheets = pack.slides.filter(
  (s) => (s.content.table?.headers ?? [])[0] === SERP_TABLE_HEADERS[0]
);

describe("пакет выдачи и его листы считают разные объекты", () => {
  it("пакетная метрика осталась региональной", () => {
    expect(pack.metrics.datasetCount).toBe(RU_REGION_OBSERVATIONS);
  });

  it("лист несёт число своей полосы, а не региона", () => {
    expect(sheets.length).toBeGreaterThan(0);
    for (const slide of sheets) {
      const band = Number(slide.metrics?.datasetCount);
      expect(band).toBeGreaterThan(0);
      expect(band).toBeLessThan(RU_REGION_OBSERVATIONS);
    }
  });

  it("инвариант, который читает проверка секции, держится на пакете", () => {
    // `section-validation` жалуется на `displayedCount > datasetCount`: пакетная
    // пара обязана оставаться согласованной сама с собой.
    expect(pack.metrics.displayedCount).toBeLessThanOrEqual(pack.metrics.datasetCount);
  });
});
