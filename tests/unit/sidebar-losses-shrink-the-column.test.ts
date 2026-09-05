import { describe, expect, it } from "vitest";
import {
  measureVerdictHasLoss,
  parseBulletMeasureVerdict,
  planSidebarShrink,
  BULLET_MEASURE_VERSION,
} from "@/modules/digital-profile/orion-golden/deck-sections/measured-bullet-fit";
import { assembleDeck } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import { toRendererPayload } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import { SIDEBAR_COLUMN_CHAR_BUDGET } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import {
  REPORT_SECTION_MANIFEST_VERSION,
  SECTION_PACK_SCHEMA_VERSION,
  SLIDE_CONTENT_SCHEMA_VERSION,
} from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type {
  ReportDeckManifest,
  ReportSectionManifest,
  SectionPackV2,
} from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";

/**
 * Потерю сайдбара дека узнаёт мерой рендерера — до выпуска, а не после.
 *
 * Цикл «мера → перекладка → пересборка» знал только буллеты: сайдбар в его
 * вердикте не значился, и страница 62 прогона DPA-2026-0053 дошла до
 * настоящего рендера с сайдбаром, в который не влезли два блока. Теперь мера
 * называет и потери сайдбара, а дека отвечает на них тем же способом, каким
 * отвечает на потери списка: ужимает колонку этой страницы и собирает деку
 * заново — пока рендерер не перестанет терять.
 */

const SIDEBAR_LOSS = {
  page: 62,
  field: "whatIsVisible",
  droppedLines: 1,
  requiredHeight: 1_186_891,
  availableHeight: 0,
};

describe("вердикт меры с потерями сайдбара", () => {
  it("потеря только в сайдбаре — это потеря", () => {
    expect(
      measureVerdictHasLoss({ version: BULLET_MEASURE_VERSION, pages: [], sidebars: [SIDEBAR_LOSS] })
    ).toBe(true);
    expect(measureVerdictHasLoss({ version: BULLET_MEASURE_VERSION, pages: [] })).toBe(false);
  });

  it("разбор ответа рендерера сохраняет потери сайдбара и терпит их отсутствие", () => {
    const withSidebars = parseBulletMeasureVerdict({
      version: BULLET_MEASURE_VERSION,
      pages: [],
      sidebars: [SIDEBAR_LOSS],
    });
    expect(withSidebars.sidebars).toEqual([SIDEBAR_LOSS]);
    expect(parseBulletMeasureVerdict({ version: BULLET_MEASURE_VERSION, pages: [] }).sidebars).toEqual([]);
  });
});

describe("план ужатия колонки", () => {
  const pageSlideKeys = new Map([[62, "p31_uae_knowledge"]]);

  it("страница с потерей получает колонку на четверть уже", () => {
    const plan = planSidebarShrink({
      verdict: { version: BULLET_MEASURE_VERSION, pages: [], sidebars: [SIDEBAR_LOSS] },
      pageSlideKeys,
      previous: new Map(),
    });
    expect(plan.get("p31_uae_knowledge")).toBeCloseTo(0.75);
  });

  it("повторная потеря ужимает дальше, но не ниже четверти", () => {
    const plan = planSidebarShrink({
      verdict: { version: BULLET_MEASURE_VERSION, pages: [], sidebars: [SIDEBAR_LOSS] },
      pageSlideKeys,
      previous: new Map([["p31_uae_knowledge", 0.3]]),
    });
    expect(plan.get("p31_uae_knowledge")).toBeCloseTo(0.25);
    const floor = planSidebarShrink({
      verdict: { version: BULLET_MEASURE_VERSION, pages: [], sidebars: [SIDEBAR_LOSS] },
      pageSlideKeys,
      previous: new Map([["p31_uae_knowledge", 0.25]]),
    });
    // Дальше ужимать некуда: план не меняется, и цикл честно не сходится.
    expect(floor.size).toBe(0);
  });

  it("страницы без потерь план не трогает, чужие масштабы сохраняются", () => {
    const plan = planSidebarShrink({
      verdict: { version: BULLET_MEASURE_VERSION, pages: [], sidebars: [SIDEBAR_LOSS] },
      pageSlideKeys,
      previous: new Map([["p10_ru_serp_visual", 0.75]]),
    });
    expect(plan.get("p10_ru_serp_visual")).toBeCloseTo(0.75);
    expect(plan.get("p31_uae_knowledge")).toBeCloseTo(0.75);
  });
});

const LONG = (seed: string): string =>
  Array.from({ length: 8 }, (_, i) => `${seed}: предложение номер ${i + 1} написано длинным нарочно, чтобы поле уперлось в бюджет колонки.`).join(" ");

function slide(over: Partial<RendererSlide>): RendererSlide {
  return {
    slideKey: "p31_uae_knowledge",
    sectionKey: "UAE_PROFILE",
    template: "orion_golden_surface_panel",
    templateId: "ai-overview",
    title: "ОАЭ — панель знаний",
    pageNumber: 62,
    totalPageCount: 72,
    baseSlotId: "p31_uae_knowledge",
    isContinuation: false,
    whatWasFound: LONG("Вывод"),
    whyItMatters: LONG("Значимость"),
    whatToCheck: LONG("Действие"),
    narrative: LONG("Абзац"),
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: ["uae_ai_answers"],
    staticBlocks: [],
    ...over,
  } as RendererSlide;
}

const ASSET = {
  assetRef: "uae_ai_answers",
  kind: "knowledge_panel",
  title: "ОАЭ — ИИ-ответы",
  imageData: "iVBORw0KGgo=",
};

function sidebarChars(s: RendererSlide): number {
  const payload = toRendererPayload({
    deckManifest: { toc: [], sectionPageRanges: [] } as unknown as ReportDeckManifest,
    rendererSlides: [s],
    subjectName: "Тест",
    assets: [ASSET],
  }) as { deckManifest: { finalSlides: Array<{ visualAnalysis?: Record<string, unknown> }> } };
  const va = payload.deckManifest.finalSlides[0]?.visualAnalysis ?? {};
  return [va.headlineConclusion, va.whatIsVisible, va.clientMeaning, ...((va.recommendedActions as string[]) ?? [])]
    .filter((x): x is string => typeof x === "string")
    .reduce((n, t) => n + t.length, 0);
}

describe("масштаб колонки в полезной нагрузке", () => {
  it("без масштаба сайдбар берёт объявленный бюджет колонки", () => {
    const chars = sidebarChars(slide({}));
    expect(chars).toBeGreaterThan(SIDEBAR_COLUMN_CHAR_BUDGET * 0.6);
    expect(chars).toBeLessThanOrEqual(SIDEBAR_COLUMN_CHAR_BUDGET);
  });

  it("с масштабом 0.5 сайдбар берёт не больше половины бюджета", () => {
    expect(sidebarChars(slide({ sidebarBudgetScale: 0.5 }))).toBeLessThanOrEqual(SIDEBAR_COLUMN_CHAR_BUDGET * 0.5);
  });
});

const CASE_ID = "case-shrink";
const RUN_ID = "run-shrink";
const DATASET_ID = "composite-shrink";

const PACK: SectionPackV2 = {
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
  contentHash: "hash-shrink",
  inputHash: "input-shrink",
  generatedAt: "2026-09-01T00:00:00.000Z",
  required: true,
  status: "READY",
  sourceFindingIds: [],
  evidenceRefs: [],
  inputs: { findingIds: [], evidenceRefs: [], metricSnapshotId: "snapshot" },
  slides: [
    {
      schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
      slideId: "p10_ru_serp_visual",
      baseSlotId: "p10_ru_serp_visual",
      sectionId: "RU_PROFILE",
      isContinuation: false,
      continuationOf: null,
      continuationIndex: null,
      templateId: "serp-screenshot-analysis",
      title: "Россия — снимок выдачи",
      content: { narrative: "Абзац страницы.", whatWasFound: "Вывод." },
      evidenceRefs: [],
      findingIds: [],
      metrics: {},
      visualAssetRefs: ["ru_serp_snapshot"],
    },
  ],
  metrics: { datasetCount: 1, displayedCount: 1, adverseDatasetCount: 0, adverseDisplayedCount: 0 },
  provenance: { providers: ["serper"], reportRunIds: [RUN_ID], evidenceRefs: [] },
  validation: { passed: true, issues: [] },
};

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
      contentHash: "hash-shrink",
      slideCount: 1,
      validationPassed: true,
    },
  ],
  requiredSectionsFailed: [],
  buildBlocked: false,
};

describe("сборка ставит масштаб на слайд", () => {
  it("масштаб из плана доезжает до слайда рендерера и живёт в артефакте сборки", () => {
    const result = assembleDeck({
      manifest: MANIFEST,
      packs: [PACK],
      expectedCaseId: CASE_ID,
      expectedReportRunId: RUN_ID,
      expectedDatasetId: DATASET_ID,
      sidebarScales: new Map([["p10_ru_serp_visual", 0.75]]),
    });
    expect(result.errors).toEqual([]);
    expect(result.rendererSlides[0]?.sidebarBudgetScale).toBeCloseTo(0.75);
  });

  it("без плана поля нет вовсе", () => {
    const result = assembleDeck({
      manifest: MANIFEST,
      packs: [PACK],
      expectedCaseId: CASE_ID,
      expectedReportRunId: RUN_ID,
      expectedDatasetId: DATASET_ID,
    });
    expect(result.rendererSlides[0]?.sidebarBudgetScale).toBeUndefined();
  });
});
