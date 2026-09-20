/**
 * Стадия текста переписывает поле черновика, а не заводит своё (шаг 0126).
 *
 * Стр. 12 отчёта Абрамовича 20.09.2026 печатала два абзаца подряд об одном:
 * «Региональный срез охватывает 636 материалов, из которых 449 вошли в обзор
 * первых 20 позиций выдачи. Подтверждены 4 темы…» и следом «Из 636 собранных
 * по России материалов 449 относятся к обзору первых 20 позиций. Подтверждены
 * 4 темы…».
 *
 * Второй абзац — поле `whatWasFound`, которого у черновика нет: построитель
 * региональной сводки его **намеренно** не кладёт («page stays итог → темы →
 * действие, not a second technical essay»). Стадия текста дописала поле поверх
 * отсутствия, и решение построителя было отменено молча.
 *
 * Правило продукта: модель переписывает уже собранное и не добавляет своего.
 * Значит, поля у черновика нет — переписывать нечего, и ответ модели по нему
 * отклоняется с названной причиной.
 */

import { describe, expect, it } from "vitest";
import { enhanceSectionPacksWithGptCopy } from "@/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import { SECTION_PACK_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { SectionPackV2, SlideBody } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { VerifiedFindingBundle } from "@/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";

const BUNDLE = {
  schemaVersion: "verified-finding-bundle-v1",
  caseId: "c1",
  datasetId: "d1",
  reportRunId: "r1",
  generatedAt: "2026-09-20T00:00:00.000Z",
  sourceHashes: [],
  kpiEligibleSubjectMatches: ["SUBJECT_MATCH"],
  findings: [],
  excludedFindingIds: [],
  exclusionReasons: {},
} as unknown as VerifiedFindingBundle;

/** Лид региональной сводки — дословно с живого прогона. */
const DRAFT_NARRATIVE =
  "Региональный срез охватывает 636 материалов, из которых 449 вошли в обзор первых 20 позиций выдачи. " +
  "Подтверждены 4 темы, одна из них требует повышенного внимания.";

/** Второй абзац, который дописала модель: те же числа другими словами. */
const INVENTED_WHAT_WAS_FOUND =
  "Из 636 собранных по России материалов 449 относятся к обзору первых 20 позиций. Подтверждены 4 темы.";

function summaryPack(content: SlideBody): SectionPackV2 {
  return {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: "RU_PROFILE",
    sectionType: "RU_PROFILE",
    fragmentKey: "RU_SUMMARY",
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    sourceDatasetId: "d1",
    contentVersion: "deck-sections-v210",
    promptVersion: "regional-summary-v1",
    contentHash: "sha256:x",
    inputHash: "h1",
    generatedAt: "2026-09-20T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: [],
    inputs: { findingIds: [], evidenceRefs: [], metricSnapshotId: "m1" },
    slides: [
      {
        schemaVersion: "slide-content-v1",
        slideId: "p07_ru_summary",
        baseSlotId: "p07_ru_summary",
        sectionId: "RU_PROFILE",
        fragmentKey: "RU_SUMMARY",
        templateId: "regional-summary",
        title: "Россия: в выдаче есть материалы повышенного внимания",
        findingIds: [],
        evidenceRefs: [],
        isContinuation: false,
        continuationOf: null,
        continuationIndex: null,
        visualAssetRefs: [],
        metrics: {},
        content,
      },
    ],
    metrics: {},
    provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: [] },
    validation: { passed: true, issues: [] },
  } as unknown as SectionPackV2;
}

async function runStage2(pack: SectionPackV2, reply: Record<string, unknown>) {
  const out = await enhanceSectionPacksWithGptCopy({
    packs: [pack],
    subject: { displayName: "Абрамович Роман Аркадьевич", aliases: [] },
    caller: async () => reply,
    caseAnalysis: null,
    bundle: BUNDLE,
    evidenceIndex: {} as never,
    validatePack: () => ({ passed: true, issues: [] }),
  });
  return {
    slide: out.packs[0]!.slides[0]!,
    report: out.report.fragments.find((f) => f.fragmentKey === "RU_SUMMARY")!,
  };
}

describe("стадия текста не заводит поле, которого нет у черновика", () => {
  it("П1: whatWasFound поверх отсутствия не применяется и назван отказом", async () => {
    const { slide, report } = await runStage2(
      summaryPack({ narrative: DRAFT_NARRATIVE } as SlideBody),
      {
        slides: [
          { slideId: "p07_ru_summary", whatWasFound: INVENTED_WHAT_WAS_FOUND },
        ],
      }
    );
    expect(slide.content.whatWasFound).toBeUndefined();
    expect(report.rejectedFields.join("|")).toContain("p07_ru_summary.whatWasFound");
  });

  it("П2: то же поле у черновика переписывается по-прежнему", async () => {
    const draft = {
      narrative: DRAFT_NARRATIVE,
      whatWasFound: "Найдено 4 темы по 636 материалам региона.",
    } as SlideBody;
    const rewritten = "По 636 материалам региона подтверждены 4 темы.";
    const { slide, report } = await runStage2(summaryPack(draft), {
      slides: [{ slideId: "p07_ru_summary", whatWasFound: rewritten }],
    });
    expect(slide.content.whatWasFound).toBe(rewritten);
    expect(report.rejectedFields).toEqual([]);
  });
});
