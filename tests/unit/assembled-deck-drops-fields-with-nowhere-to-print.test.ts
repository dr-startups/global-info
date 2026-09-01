/**
 * Слайд деки не несёт поля, которому на его макете негде напечататься.
 *
 * Ответ про носитель один и живёт в реестре — там же, где объявлена ёмкость
 * списка (`maxBulletsPerSlide: 0` означает «списка на странице нет»). Применяет
 * его ассемблер: это единственное место, где содержимое пакета становится
 * слайдом рендерера. Пока применения не было, построитель клал строку
 * «Источники» на все страницы, а маппинг нагрузки молча ронял её у таблицы
 * выдачи и у дашбордов — 21 сноска из 42 на эталоне-72 и восемь статусных
 * строк, и прибора у этой потери не было ни одного.
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
} from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const CASE_ID = "case-carrier";
const RUN_ID = "run-carrier";
const DATASET_ID = "composite-carrier";

const SOURCE_NOTE = "Источники — forbes.ru, tass.ru и rbc.ru.";
const STATUS_NOTE = "Тема подтверждена, уровень внимания — высокий; оценка достоверна.";

function packWith(templateId: string, slideId: string): SectionPackV2 {
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
    contentHash: "hash-carrier",
    inputHash: "input-carrier",
    generatedAt: "2026-09-01T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: [],
    inputs: { findingIds: [], evidenceRefs: [], metricSnapshotId: "snapshot" },
    slides: [
      {
        schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
        slideId,
        baseSlotId: slideId,
        sectionId: "RU_PROFILE",
        isContinuation: false,
        continuationOf: null,
        continuationIndex: null,
        templateId,
        title: "Россия — страница проверки носителя",
        content: {
          narrative: "Абзац страницы, который печатается всегда.",
          sourceNote: SOURCE_NOTE,
          statusNote: STATUS_NOTE,
        },
        evidenceRefs: [],
        findingIds: [],
        metrics: {},
        visualAssetRefs: [],
      },
    ],
    metrics: {
      datasetCount: 1,
      displayedCount: 1,
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
  generatedAt: "2026-09-01T00:00:00.000Z",
  sectionOrder: ["RU_PROFILE"],
  entries: [
    {
      order: 1,
      sectionType: "RU_PROFILE",
      fragmentKey: "RU_SERP",
      artifactPath: "section-packs/ru-serp.json",
      required: true,
      status: "READY",
      contentHash: "hash-carrier",
      slideCount: 1,
      validationPassed: true,
    },
  ],
  requiredSectionsFailed: [],
  buildBlocked: false,
};

function slideOf(templateId: string, slideId: string): Record<string, unknown> {
  const result = assembleDeck({
    manifest: MANIFEST,
    packs: [packWith(templateId, slideId)],
    expectedCaseId: CASE_ID,
    expectedReportRunId: RUN_ID,
    expectedDatasetId: DATASET_ID,
  });
  expect(result.errors, "дека собралась").toEqual([]);
  expect(result.rendererSlides.length, "слайд доехал до модели рендерера").toBe(1);
  return result.rendererSlides[0] as unknown as Record<string, unknown>;
}

describe("собранная дека и поля без печатного носителя", () => {
  it("страница выдачи не несёт ни сноски, ни статусной строки", () => {
    const slide = slideOf("serp-table", "p09_ru_serp_table");
    expect(slide.template).toBe("orion_golden_search_table");
    expect(slide.sourceNote).toBeUndefined();
    expect(slide.statusNote).toBeUndefined();
  });

  it("дашборд метрик не несёт сноски, но статусную строку несёт", () => {
    // У дашборда «список» рисуется плитками и карточками тем — строки
    // источников среди них нет; статусную строку он печатает своим полем.
    const slide = slideOf("regional-summary", "p07_ru_summary");
    expect(slide.template).toBe("orion_golden_metrics_dashboard");
    expect(slide.sourceNote).toBeUndefined();
    expect(slide.statusNote).toBe(STATUS_NOTE);
  });

  it("сводный дашборд не несёт ни сноски, ни статусной строки", () => {
    /*
     * У сводного дашборда «список» — это карточки находок (`keyFindings`), а
     * потока буллетов нет вовсе; собственного поля под статусную строку у него
     * тоже нет — оно объявлено только у дашборда метрик. Пока статусную строку
     * снимал предикат «есть ли у макета список», она проезжала сюда по
     * `maxBulletsPerSlide: 8` и роняла сборку сторожем носителя.
     */
    const slide = slideOf("executive-summary", "p03_executive");
    expect(slide.template).toBe("orion_golden_executive_dashboard");
    expect(slide.sourceNote).toBeUndefined();
    expect(slide.statusNote).toBeUndefined();
  });

  it("страница со списком несёт оба поля", () => {
    const slide = slideOf("ai-overview", "p19_ru_knowledge_2");
    expect(slide.sourceNote).toBe(SOURCE_NOTE);
    expect(slide.statusNote).toBe(STATUS_NOTE);
  });
});
