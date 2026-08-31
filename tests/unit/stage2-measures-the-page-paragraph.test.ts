/**
 * У вопроса «влезает ли абзац» одна линейка.
 *
 * Прогон 91: восемь фрагментов из четырнадцати получили `FALLBACK_VALIDATION` с
 * одной и той же причиной — `narrative over budget on p14_ru_images_1:
 * 1232>1100`. Причина не в модели: `applyOverrides` мерил **сырое поле**
 * `narrative` против `TEXT_BUDGETS.narrative`, а `validatePack` — **склеенный
 * абзац страницы** (`pageNarrativeOf`) против бюджета шаблона. Числа одинаковы,
 * тексты разные, и поле, прошедшее первую линейку, валило вторую — вместе со
 * всем фрагментом: у RU_IMAGES так выброшены девятнадцать применённых полей.
 *
 * Замер до правки (`premise-r7.log`): нарратив модели 987 знаков — принят,
 * абзац страницы 1221 — отвергнут, фрагмент откачен целиком.
 */

import { describe, expect, it } from "vitest";
import { enhanceSectionPacksWithGptCopy } from "@/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import { reflowNarrativeParagraphs } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { SECTION_PACK_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { SectionPackV2, SlideBody } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import {
  builderNarrativeRoomOn,
  narrativeBudgetOf,
  pageNarrativeOf,
} from "@/modules/digital-profile/orion-golden/deck-sections/page-narrative";
import { DECK_TEMPLATE_REGISTRY } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { DeckTemplateId } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { VerifiedFindingBundle } from "@/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";

const BUNDLE = {
  schemaVersion: "verified-finding-bundle-v1",
  caseId: "c1",
  datasetId: "d1",
  reportRunId: "r1",
  generatedAt: "2026-08-18T00:00:00.000Z",
  sourceHashes: [],
  kpiEligibleSubjectMatches: ["SUBJECT_MATCH"],
  findings: [],
  excludedFindingIds: [],
  exclusionReasons: {},
} as unknown as VerifiedFindingBundle;

const TEMPLATE_ID = "image-grid";
const DRAFT_NARRATIVE = "Показаны изображения из поиска по субъекту. Публичные мероприятия и деловые встречи.";
const WHAT_WAS_FOUND = "Найдено 6 изображений, из них 1 ведёт на негативный источник. ".repeat(3).trim();
const WHY_IT_MATTERS = "Визуальный фон формирует первое впечатление при первичной проверке субъекта. ".repeat(2).trim();
const WHAT_TO_CHECK = "Проверить сайты-источники выделенных изображений и подготовить позицию по каждому материалу.";

/** Переписка модели: в бюджет поля влезает, в абзац страницы — нет. */
const MODEL_NARRATIVE = "Изображения по субъекту показывают публичные мероприятия и деловые встречи. ".repeat(13).trim();
/** Та же переписка, которая влезает и в абзац страницы. */
const MODEL_NARRATIVE_FITS = "Изображения по субъекту показывают публичные мероприятия и деловые встречи. ".repeat(3).trim();

function pack(content: SlideBody): SectionPackV2 {
  return {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: "RU_PROFILE",
    sectionType: "RU_PROFILE",
    fragmentKey: "RU_IMAGES",
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    sourceDatasetId: "d1",
    contentVersion: "deck-sections-v150",
    promptVersion: "images-v1",
    contentHash: "sha256:x",
    inputHash: "h1",
    generatedAt: "2026-08-18T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: [],
    inputs: { findingIds: [], evidenceRefs: [], metricSnapshotId: "m1" },
    slides: [
      {
        schemaVersion: "slide-content-v1",
        slideId: "p14_ru_images_1",
        baseSlotId: "p14_ru_images_1",
        sectionId: "RU_PROFILE",
        fragmentKey: "RU_IMAGES",
        templateId: TEMPLATE_ID,
        title: "Россия — изображения",
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

/** Пакетная сверка — та же линейка, что в проде: абзац страницы против шаблона. */
function narrativeRuler(p: SectionPackV2): { passed: boolean; issues: string[] } {
  const issues: string[] = [];
  for (const s of p.slides) {
    const template = DECK_TEMPLATE_REGISTRY[s.templateId as DeckTemplateId]?.rendererTemplate ?? "";
    const text = pageNarrativeOf(s.content, template) ?? "";
    const budget = narrativeBudgetOf(s.templateId);
    if (text.length > budget) {
      issues.push(`${s.slideId}: narrative over budget on ${s.slideId}: ${text.length}>${budget}`);
    }
  }
  return { passed: issues.length === 0, issues };
}

const DRAFT: SlideBody = {
  narrative: DRAFT_NARRATIVE,
  whatWasFound: WHAT_WAS_FOUND,
  whyItMatters: WHY_IT_MATTERS,
  whatToCheck: WHAT_TO_CHECK,
} as SlideBody;

async function runStage2(
  reply: Record<string, unknown>,
  validatePack: (p: SectionPackV2) => { passed: boolean; issues: string[] } = narrativeRuler
) {
  const payloads: unknown[] = [];
  const out = await enhanceSectionPacksWithGptCopy({
    packs: [pack({ ...DRAFT })],
    subject: { displayName: "Тестов Иван", aliases: [] },
    caller: async ({ userPayload }) => {
      payloads.push(userPayload);
      return reply;
    },
    caseAnalysis: null,
    bundle: BUNDLE,
    evidenceIndex: {} as never,
    validatePack,
  });
  return {
    slide: out.packs[0]!.slides[0]!,
    report: out.report.fragments.find((f) => f.fragmentKey === "RU_IMAGES")!,
    payloads,
  };
}

describe("бюджет абзаца страницы отвергает поле, а не фрагмент", () => {
  it("нарратив, не влезающий в склеенный абзац, отклонён полем", async () => {
    const { slide, report } = await runStage2({
      slides: [
        {
          slideId: "p14_ru_images_1",
          narrative: MODEL_NARRATIVE,
          whatWasFound: WHAT_WAS_FOUND,
          whyItMatters: WHY_IT_MATTERS,
          whatToCheck: WHAT_TO_CHECK,
        },
      ],
    });
    expect(report.status).toBe("APPLIED");
    // Отвергнут ровно один — нарратив; прочие поля фрагмента применены.
    expect(report.rejectedFields.filter((r) => r.includes(".narrative:"))).toHaveLength(1);
    expect(report.rejectedFields.join(" ")).toContain("over-budget");
    expect(slide.content.narrative).toBe(DRAFT_NARRATIVE);
    expect(report.appliedFields).toBeGreaterThan(0);
  });

  it("нарратив, влезающий в абзац страницы, применяется", async () => {
    const { slide, report } = await runStage2({
      slides: [{ slideId: "p14_ru_images_1", narrative: MODEL_NARRATIVE_FITS }],
    });
    expect(report.status).toBe("APPLIED");
    // Стадия 2 разбивает абзац по предложениям — сравниваем с её же формой.
    expect(slide.content.narrative).toBe(reflowNarrativeParagraphs(MODEL_NARRATIVE_FITS));
    expect(report.rejectedFields).toEqual([]);
  });

  it("пакетная сверка остаётся последним сторожем", async () => {
    // Пак, не проходящий сверку по другой причине, откатывается целиком —
    // это поведение не менялось.
    const { slide, report } = await runStage2(
      { slides: [{ slideId: "p14_ru_images_1", narrative: MODEL_NARRATIVE_FITS }] },
      () => ({ passed: false, issues: ["p14_ru_images_1: внутренний код в клиентском тексте"] })
    );
    expect(report.status).toBe("FALLBACK_VALIDATION");
    expect(slide.content.narrative).toBe(DRAFT_NARRATIVE);
  });
});

describe("линейка меряет те буллеты, которые будут применены", () => {
  it("переписанный буллет учтён в абзаце до проверки нарратива", async () => {
    /*
     * `composeFindingProse` вычищает из прозы находки предложения, уже
     * сказанные **в буллетах**. Пока буллеты применялись после нарратива,
     * измеренный абзац собирался из черновых буллетов, а провалидированный —
     * из новых: линейки снова расходились, и `validatePack` валил фрагмент
     * целиком, не назвав виноватого поля.
     */
    const shared =
      "Собранные изображения показывают публичные мероприятия и деловые встречи субъекта в течение отчётного периода.";
    const draft = {
      narrative: "Черновой абзац страницы.",
      whatWasFound: `${shared} Дополнительная строка вывода страницы о составе набора изображений.`,
      whyItMatters: "Визуальный фон формирует первое впечатление при первичной проверке субъекта.",
      whatToCheck: "Проверить сайты-источники выделенных изображений.",
      bullets: [shared],
    } as SlideBody;
    const filler = "Изображения субъекта относятся к публичным мероприятиям. ";
    const budget = narrativeBudgetOf(TEMPLATE_ID);
    const room = budget - (draft.whatWasFound!.length - shared.length) - draft.whyItMatters!.length - draft.whatToCheck!.length - 20;
    const modelNarrative = filler.repeat(Math.floor(room / filler.length)).trim();

    const out = await enhanceSectionPacksWithGptCopy({
      packs: [pack({ ...draft })],
      subject: { displayName: "Тестов Иван", aliases: [] },
      caller: async () => ({
        slides: [
          {
            slideId: "p14_ru_images_1",
            narrative: modelNarrative,
            bullets: ["Отдельный вывод о составе визуального фона субъекта по итогам отбора."],
          },
        ],
      }),
      caseAnalysis: null,
      bundle: BUNDLE,
      evidenceIndex: {} as never,
      validatePack: narrativeRuler,
    });
    const report = out.report.fragments.find((f) => f.fragmentKey === "RU_IMAGES")!;
    // Фрагмент применён, виноватое поле названо, пакетная сверка молчит.
    expect(report.status).toBe("APPLIED");
    expect(report.rejectedFields.join(" ")).toContain("narrative:over-budget");
    expect(out.packs[0]!.slides[0]!.content.bullets).toEqual([
      "Отдельный вывод о составе визуального фона субъекта по итогам отбора.",
    ]);
  });
});

describe("просьба о сжатии называет честный предел", () => {
  it("предел уменьшен на длину приклеиваемой прозы находки", async () => {
    /*
     * Модель, которой сказали «уложись в 1100», уложится в 1100 — и абзац
     * страницы всё равно не влезет: проза находки приклеивается к нему уже
     * после. Второй раунд в таком виде бесполезен по построению.
     */
    const { payloads } = await runStage2({
      slides: [
        {
          slideId: "p14_ru_images_1",
          narrative: MODEL_NARRATIVE,
          whatWasFound: WHAT_WAS_FOUND,
          whyItMatters: WHY_IT_MATTERS,
          whatToCheck: WHAT_TO_CHECK,
        },
      ],
    });
    const repair = payloads
      .flatMap((p) => (p as { items?: Array<{ field: string; maxChars: number }> }).items ?? [])
      .find((i) => i.field === "narrative");
    expect(repair).toBeDefined();
    const template = DECK_TEMPLATE_REGISTRY[TEMPLATE_ID as DeckTemplateId]?.rendererTemplate ?? "";
    // Предел — та же комната, которой пользуется разбивка страниц: она
    // вычитает и разделитель абзаца. Свой расчёт ошибался на один знак, и
    // текст, уложенный ровно в названный предел, всё равно отвергался.
    const room = builderNarrativeRoomOn(DRAFT, TEMPLATE_ID, template);
    expect(room).toBeLessThan(narrativeBudgetOf(TEMPLATE_ID));
    expect(repair!.maxChars).toBeLessThanOrEqual(room);
  });
});
