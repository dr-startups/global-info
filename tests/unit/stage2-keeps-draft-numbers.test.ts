/**
 * Число и его база, единожды посчитанные, моделью не переписываются.
 *
 * На прогоне 76 стадия 2 приняла переписку нарратива российской страницы
 * региона: детерминированное «Негатив среди прочитанных страниц региона:
 * 15 из 50 (30%); прочитано 50 из 86 отобранных.» превратилось в «Негативный
 * контекст найден в 15 из 50 прочитанных материалов.» — без процента и без
 * базы. Гарды стадии 2 сверяли домены и цитаты; числа не защищало ничто, а
 * `COPY_INSTRUCTIONS` о них не говорил вовсе.
 *
 * Гейт односторонний: блокируется только потеря числа черновика. Двусторонняя
 * проверка резала бы безвредные перечисления, а сочинение чисел ограничено
 * тем же запретом на новые факты, что и раньше.
 */

import { describe, expect, it } from "vitest";
import { enhanceSectionPacksWithGptCopy } from "@/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import { SECTION_PACK_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { SectionPackV2, SlideBody } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { VerifiedFindingBundle } from "@/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";

const DRAFT_NARRATIVE =
  "Предмет аудита по региону «Россия» — ТОП-20 выдачи: 20 материалов. " +
  "Негатив среди прочитанных страниц региона: 15 из 50 (30%); прочитано 50 из 86 отобранных.";

/** Ровно то, что модель вернула на живом прогоне: процент и база потеряны. */
const REWRITE_WITHOUT_BASE =
  "Предмет аудита по региону «Россия» — ТОП-20 выдачи: 20 материалов. " +
  "Негативный контекст найден в 15 из 50 прочитанных материалов.";

/** Та же правка стиля, но все числа черновика на месте. */
const REWRITE_WITH_BASE =
  "Предмет аудита по региону «Россия» — ТОП-20 выдачи: 20 материалов; проверено 4 запроса. " +
  "Негатив встречается на 15 страницах из 50 прочитанных (30%), а всего к чтению отобрано 86.";

const DRAFT_BULLET =
  "«Криминальные / судебные материалы». Найдены публикации о судебных разбирательствах. " +
  "Всего по теме: 7 материалов, из них нежелательных 5.";

/** Второй буллет черновика: свои числа и своя цитата с доменом-источником. */
const DRAFT_BULLET_2 =
  "«Офшоры / корпоративное владение». Найдены публикации о структуре владения. " +
  "«Схема владения активом раскрыта в судебных документах» — источник vedomosti.ru. " +
  "Всего по теме: 3 материала, из них нежелательных 2.";

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
    contentVersion: "deck-sections-v88",
    promptVersion: "regional-summary-v1",
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

type ModelReply = Record<string, unknown>;

async function runStage2(
  pack: SectionPackV2,
  reply: ModelReply | ((systemPrompt: string) => ModelReply)
) {
  const payloads: unknown[] = [];
  const out = await enhanceSectionPacksWithGptCopy({
    packs: [pack],
    subject: { displayName: "Тестов Иван", aliases: [] },
    caller: async ({ systemPrompt, userPayload }) => {
      payloads.push(userPayload);
      return typeof reply === "function" ? reply(systemPrompt) : reply;
    },
    caseAnalysis: null,
    bundle: BUNDLE,
    evidenceIndex: {} as never,
    validatePack: () => ({ passed: true, issues: [] }),
  });
  const slide = out.packs[0]!.slides[0]!;
  const report = out.report.fragments.find((f) => f.fragmentKey === "RU_SUMMARY")!;
  return { slide, report, payloads };
}

describe("гейт чисел стадии 2", () => {
  it("переписка, потерявшая процент и базу черновика, отклоняется полем", async () => {
    const draft = { narrative: DRAFT_NARRATIVE } as SlideBody;
    const { slide, report } = await runStage2(summaryPack(draft), {
      slides: [{ slideId: "p07_ru_summary", narrative: REWRITE_WITHOUT_BASE }],
    });
    expect(slide.content.narrative).toBe(DRAFT_NARRATIVE);
    expect(report.rejectedFields).toContain("p07_ru_summary.narrative:dropped-number:30");
    expect(report.appliedFields).toBe(0);
  });

  it("переписка, сохранившая все числа черновика, применяется", async () => {
    const { slide, report } = await runStage2(
      summaryPack({ narrative: DRAFT_NARRATIVE } as SlideBody),
      { slides: [{ slideId: "p07_ru_summary", narrative: REWRITE_WITH_BASE }] }
    );
    expect(slide.content.narrative).toBe(REWRITE_WITH_BASE);
    expect(report.rejectedFields).toEqual([]);
  });

  it("буллеты проверяются попарно с черновиком", async () => {
    const draft = { narrative: DRAFT_NARRATIVE, bullets: [DRAFT_BULLET] } as SlideBody;
    const lost = await runStage2(summaryPack(draft), {
      slides: [
        {
          slideId: "p07_ru_summary",
          bullets: ["«Криминальные / судебные материалы». Найдены публикации о судебных разбирательствах и корпоративных спорах."],
        },
      ],
    });
    expect(lost.slide.content.bullets).toEqual([DRAFT_BULLET]);
    expect(lost.report.rejectedFields.some((r) => r.includes("bullets:dropped-number:"))).toBe(true);

    const kept = await runStage2(summaryPack(draft), {
      slides: [
        {
          slideId: "p07_ru_summary",
          bullets: [
            "«Криминальные / судебные материалы». Проверяющий увидит публикации о судебных разбирательствах. Всего по теме: 7 материалов, нежелательных — 5.",
          ],
        },
      ],
    });
    expect(kept.slide.content.bullets?.[0]).toContain("Всего по теме: 7");
    expect(kept.report.rejectedFields).toEqual([]);
  });

  it("список короче черновика — числа выброшенного хвоста считаются потерянными", async () => {
    // Проверки шли по буллетам ответа, поэтому хвост черновика не с чем было
    // сверить: модель возвращала один буллет вместо двух, и числа второго
    // исчезали без единого отказа.
    const draft = {
      narrative: DRAFT_NARRATIVE,
      bullets: [DRAFT_BULLET_2, DRAFT_BULLET],
    } as SlideBody;
    const { slide, report } = await runStage2(summaryPack(draft), {
      slides: [{ slideId: "p07_ru_summary", bullets: [DRAFT_BULLET_2] }],
    });
    expect(slide.content.bullets).toEqual([DRAFT_BULLET_2, DRAFT_BULLET]);
    expect(report.rejectedFields).toContain("p07_ru_summary.bullets:dropped-number:7");
  });

  it("выброшенный буллет уносит и свою цитату — сверка та же", async () => {
    const draft = {
      narrative: DRAFT_NARRATIVE,
      bullets: [DRAFT_BULLET, DRAFT_BULLET_2],
    } as SlideBody;
    const { slide, report } = await runStage2(summaryPack(draft), {
      slides: [{ slideId: "p07_ru_summary", bullets: [DRAFT_BULLET] }],
    });
    expect(slide.content.bullets).toEqual([DRAFT_BULLET, DRAFT_BULLET_2]);
    // Хвост регекспа домена (точка в конце предложения) — свойство давнего
    // гарда цитат, а не этой проверки: пинаем причину, а не её огрызок.
    expect(report.rejectedFields[0]).toMatch(
      /^p07_ru_summary\.bullets:dropped-evidence-domain:vedomosti\.ru/u
    );
  });

  it("ремонт-сжатие, съевшее число, отклоняется после слияния ремонта", async () => {
    const overBudget = `${REWRITE_WITH_BASE} ${"Дополнительный разбор материалов выдачи. ".repeat(30)}`;
    expect(overBudget.length).toBeGreaterThan(1100);
    const { slide, report } = await runStage2(
      summaryPack({ narrative: DRAFT_NARRATIVE } as SlideBody),
      (systemPrompt) =>
        /сожми каждый переданный текст/u.test(systemPrompt)
          ? {
              items: [
                {
                  slideId: "p07_ru_summary",
                  field: "narrative",
                  text: REWRITE_WITHOUT_BASE,
                },
              ],
            }
          : { slides: [{ slideId: "p07_ru_summary", narrative: overBudget }] }
    );
    expect(slide.content.narrative).toBe(DRAFT_NARRATIVE);
    expect(report.rejectedFields).toContain("p07_ru_summary.narrative:dropped-number:30");
  });

  it("поле, которого в черновике не было, гейт не проверяет — сравнивать не с чем", async () => {
    const { slide, report } = await runStage2(
      summaryPack({ narrative: DRAFT_NARRATIVE } as SlideBody),
      {
        slides: [
          {
            slideId: "p07_ru_summary",
            narrative: REWRITE_WITH_BASE,
            whatWasFound: "В выдаче видны судебные сюжеты о проверяемом лице.",
          },
        ],
      }
    );
    expect(slide.content.whatWasFound).toBe("В выдаче видны судебные сюжеты о проверяемом лице.");
    expect(report.rejectedFields).toEqual([]);
  });
});

describe("statusNote вне переписки стадии 2", () => {
  it("модель не видит поля и не может его заменить", async () => {
    const draft = {
      narrative: DRAFT_NARRATIVE,
      statusNote:
        "Негатив среди прочитанных страниц региона: 15 из 50 (30%); прочитано 50 из 86 отобранных.",
    } as SlideBody;
    const { slide, payloads } = await runStage2(summaryPack(draft), {
      slides: [
        {
          slideId: "p07_ru_summary",
          narrative: REWRITE_WITH_BASE,
          statusNote: "Данные о чтении страниц уточняются.",
        },
      ],
    });
    expect(slide.content.statusNote).toBe(draft.statusNote);
    expect(JSON.stringify(payloads)).not.toContain("statusNote");
  });
});
