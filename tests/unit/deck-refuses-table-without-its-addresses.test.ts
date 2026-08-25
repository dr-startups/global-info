/**
 * Строка таблицы выдачи без своего адреса — отказ сборки, а не тихая страница.
 *
 * Адрес переехал из колонки в отдельный ряд данных (`rowAddresses`), и теперь
 * соответствие «строка → адрес» держится длиной двух массивов. Разъехались —
 * страница нарисуется без части адресов, и никто об этом не скажет: рендерер
 * просто не найдёт полосу. Такая потеря обязана быть громкой и называть слайд.
 */

import { describe, expect, it } from "vitest";
import { assembleDeck } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import {
  REPORT_SECTION_MANIFEST_VERSION,
  SECTION_PACK_SCHEMA_VERSION,
  SLIDE_CONTENT_SCHEMA_VERSION,
} from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type {
  ReportSectionManifest,
  SectionPackV2,
  SlideBody,
} from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const CASE_ID = "case-address-band";
const RUN_ID = "run-address-band";
const DATASET_ID = "composite-address-band";
const SLIDE_ID = "p09_ru_serp_table";

function packWith(table: SlideBody["table"]): SectionPackV2 {
  return {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: "RU_PROFILE",
    sectionType: "RU_PROFILE",
    fragmentKey: "RU_SERP",
    caseId: CASE_ID,
    datasetId: DATASET_ID,
    reportRunId: RUN_ID,
    sourceDatasetId: DATASET_ID,
    contentVersion: "deck-sections-test",
    promptVersion: "deterministic",
    contentHash: "hash-serp",
    inputHash: "input-serp",
    generatedAt: "2026-08-25T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: [],
    inputs: { findingIds: [], evidenceRefs: [], metricSnapshotId: "snapshot" },
    slides: [
      {
        schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
        slideId: SLIDE_ID,
        baseSlotId: SLIDE_ID,
        sectionId: "RU_PROFILE",
        isContinuation: false,
        continuationOf: null,
        continuationIndex: null,
        templateId: "serp-table",
        title: "Россия — Яндекс, ТОП-20",
        content: { table },
        evidenceRefs: [],
        findingIds: [],
        metrics: {},
        visualAssetRefs: [],
      },
    ],
    metrics: {
      datasetCount: 3,
      displayedCount: 3,
      adverseDatasetCount: 0,
      adverseDisplayedCount: 0,
    },
    provenance: { providers: ["serper"], reportRunIds: [RUN_ID], evidenceRefs: [] },
    validation: { passed: true, issues: [] },
  };
}

const MANIFEST: ReportSectionManifest = {
  schemaVersion: REPORT_SECTION_MANIFEST_VERSION,
  caseId: CASE_ID,
  reportRunId: RUN_ID,
  sourceDatasetId: DATASET_ID,
  generatedAt: "2026-08-25T00:00:00.000Z",
  sectionOrder: ["RU_PROFILE"],
  entries: [
    {
      order: 1,
      sectionType: "RU_PROFILE",
      fragmentKey: "RU_SERP",
      artifactPath: "section-packs/ru-serp.json",
      required: true,
      status: "READY",
      contentHash: "hash-serp",
      slideCount: 1,
      validationPassed: true,
    },
  ],
  requiredSectionsFailed: [],
  buildBlocked: false,
};

function assemble(table: SlideBody["table"]): ReturnType<typeof assembleDeck> {
  return assembleDeck({
    manifest: MANIFEST,
    packs: [packWith(table)],
    expectedCaseId: CASE_ID,
    expectedReportRunId: RUN_ID,
    expectedDatasetId: DATASET_ID,
  });
}

const HEADERS = ["№", "Заголовок", "Тип источника", "Оценка"];
const ROWS = [
  ["1", "Первый материал", "Новостное СМИ", "Нейтральный"],
  ["2", "Второй материал", "Новостное СМИ", "Нейтральный"],
  ["3", "Третий материал", "Новостное СМИ", "Нейтральный"],
];

describe("число адресов равно числу строк", () => {
  it("адресов меньше, чем строк, — сборка останавливается и называет слайд", () => {
    const result = assemble({
      headers: HEADERS,
      rows: ROWS,
      rowAddresses: ["a.example.org/1", "b.example.org/2"],
    } as unknown as SlideBody["table"]);
    expect(result.errors.join(" | ")).toContain(SLIDE_ID);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.deckManifest.pageCount).toBe(0);
  });

  it("адресов столько же, сколько строк, — дека собирается и адреса доезжают", () => {
    const addresses = ["a.example.org/1", "b.example.org/2", "c.example.org/3"];
    const result = assemble({
      headers: HEADERS,
      rows: ROWS,
      rowAddresses: addresses,
    } as unknown as SlideBody["table"]);
    expect(result.errors).toEqual([]);
    expect(result.deckManifest.pageCount).toBe(1);
    const table = result.rendererSlides[0]!.table as unknown as {
      rowAddresses?: string[];
    };
    expect(table.rowAddresses).toEqual(addresses);
  });

  it("таблица без адресов вовсе сборку не роняет — их нет у большинства таблиц", () => {
    const result = assemble({ headers: HEADERS, rows: ROWS });
    expect(result.errors).toEqual([]);
    expect(result.deckManifest.pageCount).toBe(1);
  });
});
