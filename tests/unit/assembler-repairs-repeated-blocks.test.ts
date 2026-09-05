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

/**
 * Повтор блока на странице сборка чинит сама, а не останавливает отчёт.
 *
 * Ворота «страница не печатает один и тот же текст дважды» роняли деку целиком
 * с первой же страницы — прогон DPA-2026-0053 встал на матрице рисков. Ворота
 * правы в том, что дважды напечатанный блок — дефект; неправы в том, что цена
 * дефекта — отчёт, не выданный клиенту. Второй одинаковый блок снимается до
 * проверки и называется в разборе сборки; ворота остаются растяжкой на случай,
 * если починка кого-то не догнала.
 */

const CASE_ID = "case-repeat";
const RUN_ID = "run-repeat";
const DATASET_ID = "composite-repeat";

function packWith(templateId: string, slideId: string, content: SlideBody): SectionPackV2 {
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
    contentHash: "hash-repeat",
    inputHash: "input-repeat",
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
        title: "Россия — страница проверки повтора",
        content,
        evidenceRefs: [],
        findingIds: [],
        metrics: {},
        visualAssetRefs: [],
      },
    ],
    metrics: { datasetCount: 1, displayedCount: 1, adverseDatasetCount: 0, adverseDisplayedCount: 0 },
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
      contentHash: "hash-repeat",
      slideCount: 1,
      validationPassed: true,
    },
  ],
  requiredSectionsFailed: [],
  buildBlocked: false,
};

function assembled(templateId: string, slideId: string, content: SlideBody) {
  const result = assembleDeck({
    manifest: MANIFEST,
    packs: [packWith(templateId, slideId, content)],
    expectedCaseId: CASE_ID,
    expectedReportRunId: RUN_ID,
    expectedDatasetId: DATASET_ID,
  });
  expect(result.errors).toEqual([]);
  return result;
}

const BODY = "Всего по теме: 3 материала. До уточнения идентификации материал не включён в итог.";

describe("повтор блока на странице", () => {
  it("второй одинаковый пункт снимается и назван в разборе сборки", () => {
    const result = assembled("finding-cards", "p40_appendix", {
      narrative: "Абзац страницы.",
      bullets: [BODY, "Другой пункт про иное.", BODY],
    });
    const slide = result.rendererSlides[0]!;
    expect(slide.bullets).toEqual([BODY, "Другой пункт про иное."]);
    expect(result.repeatRepairs).toEqual([
      { slideKey: "p40_appendix", field: "bullets[2]", excerpt: expect.stringContaining("Всего по теме") },
    ]);
  });

  it("пункт, повторяющий абзац, снимается — абзац остаётся", () => {
    const result = assembled("finding-cards", "p40_appendix", {
      narrative: BODY,
      bullets: [BODY, "Другой пункт про иное."],
    });
    const slide = result.rendererSlides[0]!;
    expect(slide.narrative).toBe(BODY);
    expect(slide.bullets).toEqual(["Другой пункт про иное."]);
  });

  it("карточки матрицы с одним телом под разными темами не трогаются", () => {
    const result = assembled("risk-matrix", "p04_risk_dashboard", {
      table: { headers: ["Тема", "Уровень", "Приоритет", "Идентификатор"], rows: [["Деловой профиль", "низкий", "—", "—"], ["Биография", "низкий", "—", "—"]] },
      bullets: [BODY, BODY],
    });
    expect(result.rendererSlides[0]!.bullets).toEqual([BODY, BODY]);
    expect(result.repeatRepairs).toEqual([]);
  });

  it("строки данных провайдера повтором не считаются", () => {
    const result = assembled("suggestions", "p11_ru_suggestions_yandex", {
      bullets: ["егоров алексей судья", "егоров алексей судья"],
    });
    expect(result.rendererSlides[0]!.bullets).toEqual(["егоров алексей судья", "егоров алексей судья"]);
    expect(result.repeatRepairs).toEqual([]);
  });

  it("страница без повторов проходит нетронутой", () => {
    const result = assembled("finding-cards", "p40_appendix", {
      narrative: "Абзац.",
      bullets: ["Первый пункт.", "Второй пункт."],
    });
    expect(result.rendererSlides[0]!.bullets).toEqual(["Первый пункт.", "Второй пункт."]);
    expect(result.repeatRepairs).toEqual([]);
  });
});
