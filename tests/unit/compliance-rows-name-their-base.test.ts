/**
 * Строка сводной комплаенс-таблицы называет свою базу — и не выдумывает статус.
 *
 * Наблюдавшийся случай — прогон 72. В нём три записи: DOW_JONES, LEXISNEXIS,
 * WORLD_CHECK (`composite-serp-observations.json`, `surface: "compliance_hit"`).
 * Провайдер лежит в наблюдении полем `engine`, но загрузчик клал его только в
 * `engine` записи индекса, а построитель читал `providerLabel`, который
 * приходит из `analytics/compliance-inventory.json` — файла, которого в
 * замороженных артефактах нет. Ключ дедупликации у всех трёх выходил
 * одинаковым, три базы схлопывались в одну безымянную строку
 * «База данных | — | — | —», а страницы Dow Jones и LexisNexis печатали
 * «Проверка выполнена: записей о субъекте не зафиксировано» — при фактическом
 * наличии записей в этих базах.
 *
 * Статус проверки прогона 72 в артефактах не зафиксирован и восстановлению не
 * подлежит: его печатаем как незафиксированный, а не как PENDING — это имя
 * конкретного статуса, которого в данных нет.
 */

import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { buildComplianceFragment } from "@/modules/digital-profile/orion-golden/deck-sections";
import { loadDeckInputsFromAnalyticsDir } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const ANALYTICS_DIR = join(process.cwd(), "baselines/report-72/artifacts/analytics");

/** Записи прогона 72 в том виде, в каком они приходят из наблюдений: без метаданных. */
const RUN_72_HITS = {
  "inventory:db-1": {
    kind: "compliance_hit",
    providerLabel: "DOW_JONES",
    title: "Глинка Сергей Михайлович",
  },
  "inventory:db-2": {
    kind: "compliance_hit",
    providerLabel: "LEXISNEXIS",
    title: "Глинка Сергей Михайлович",
  },
  "inventory:db-3": {
    kind: "compliance_hit",
    providerLabel: "WORLD_CHECK",
    title: "Глинка Сергей Михайлович",
  },
};

const METRIC_SNAPSHOT = {
  metricSnapshotId: "m-1",
  datasetId: "d-1",
  reportRunId: "r-1",
  baseCount: 100,
  enrichmentCount: 0,
  compositeCount: 100,
  subjectMatchCount: 30,
  likelySubjectCount: 0,
  ambiguousCount: 0,
  otherSubjectCount: 0,
  adverseFindingCount: 1,
  perRegionCounts: { RU: 60, UAE: 40 },
};

function buildWith(evidenceIndex: Record<string, unknown>): SlideContentContract[] {
  const scoped = {
    subject: { displayName: "Сергей Глинка", aliases: [] },
    findings: [],
    surfaceUnits: [
      {
        surface: "compliance",
        region: "GLOBAL",
        metrics: [{ key: "totalCount", value: 90 }],
        claims: [],
        evidenceRefs: ["c-1"],
      },
    ],
    metricSnapshot: METRIC_SNAPSHOT,
    scope: { regions: null, surfaces: ["compliance"], subjectMatch: null, findingIds: null },
    evidenceIndex,
  };
  return buildComplianceFragment("COMPLIANCE" as never, scoped as never, {} as never).slides;
}

function slideOf(slides: SlideContentContract[], slotId: string): SlideContentContract {
  const found = slides.find((s) => s.slideId === slotId);
  if (!found) throw new Error(`нет слайда ${slotId}`);
  return found;
}

describe("сводная таблица комплаенса называет базы", () => {
  const slides = buildWith(RUN_72_HITS);
  const summaryRows = slideOf(slides, "p33_compliance_toc").content.table?.rows ?? [];

  it("три записи трёх баз дают три строки, а не одну", () => {
    expect(summaryRows.map((r) => r[0])).toEqual(["Dow Jones", "LexisNexis", "World-Check"]);
  });

  it("плейсхолдер «База данных» не печатается значением ячейки", () => {
    expect(summaryRows.flat()).not.toContain("База данных");
  });

  it("статус, не зафиксированный в артефактах, не выдаётся за PENDING", () => {
    for (const row of summaryRows) {
      expect(row[3]).toBe("Не подтверждено (статус в артефактах прогона не зафиксирован)");
    }
    expect(summaryRows.flat()).not.toContain("Требует ручной проверки");
  });

  it("страницы Dow Jones и LexisNexis не заявляют «записей не зафиксировано» при записях", () => {
    for (const slotId of ["p34_dow_jones", "p35_lexis_visual"]) {
      const page = slideOf(slides, slotId);
      expect(page.content.narrative ?? "").not.toMatch(/записей о субъекте не зафиксировано/u);
      expect(page.content.table?.rows.length ?? 0).toBeGreaterThan(0);
      expect(page.templateId).not.toBe("coverage-empty-state");
    }
  });
});

describe("провайдер записи приходит из наблюдения", () => {
  it("замороженные артефакты прогона 72 дают имя базы без обогащения", () => {
    const index = loadDeckInputsFromAnalyticsDir(ANALYTICS_DIR).evidenceIndex;
    const hits = Object.entries(index).filter(([, e]) => e.kind === "compliance_hit");
    expect(hits.length).toBe(3);
    expect(hits.map(([, e]) => e.providerLabel).sort()).toEqual([
      "DOW_JONES",
      "LEXISNEXIS",
      "WORLD_CHECK",
    ]);
  });
});
