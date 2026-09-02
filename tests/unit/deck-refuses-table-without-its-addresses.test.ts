/**
 * Полоса адреса под строкой снята, и объявить её больше нельзя.
 *
 * Адрес вернулся в колонку таблицы, а ветка рендерера, рисовавшая полосу, снята
 * как мёртвая. Значит `rowAddresses` теперь **никто не рисует**: слайд,
 * объявивший это поле, отдал бы клиенту страницу без части адресов и без
 * единого слова об этом — та самая тихая потеря, ради которой заведён контур.
 * Поэтому сборка на таком слайде останавливается и называет его.
 *
 * Прежняя проверка сравнивала длины двух массивов; вопрос сузился до «объявлено
 * ли поле вообще», потому что рисовать его больше нечем.
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

const HEADERS = ["№", "Ссылка", "Заголовок", "Тип источника", "Оценка"];
const ROWS = [
  ["1", "a.example.org/1", "Первый материал", "Новостное СМИ", "Нейтральный"],
  ["2", "b.example.org/2", "Второй материал", "Новостное СМИ", "Нейтральный"],
  ["3", "c.example.org/3", "Третий материал", "Новостное СМИ", "Нейтральный"],
];

describe("объявленную полосу адреса сборка не пропускает", () => {
  it("любое объявление `rowAddresses` останавливает сборку и называет слайд", () => {
    const result = assemble({
      headers: HEADERS,
      rows: ROWS,
      rowAddresses: ["a.example.org/1", "b.example.org/2", "c.example.org/3"],
    } as unknown as SlideBody["table"]);
    expect(result.errors.join(" | ")).toContain(SLIDE_ID);
    expect(result.errors.join(" | ")).toContain("полос");
    expect(result.deckManifest.pageCount).toBe(0);
  });

  it("пустой массив — тоже объявление, и он тоже отказ", () => {
    const result = assemble({
      headers: HEADERS,
      rows: ROWS,
      rowAddresses: [],
    } as unknown as SlideBody["table"]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("таблица без этого поля собирается как прежде", () => {
    const result = assemble({ headers: HEADERS, rows: ROWS });
    expect(result.errors).toEqual([]);
    expect(result.deckManifest.pageCount).toBe(1);
  });
});
