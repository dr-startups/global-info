/**
 * Страница связанных запросов объясняет свои красные рамки — и отвечает за то,
 * что в этих объяснениях названо.
 *
 * Панель этой страницы рисует обводку `#C0392B` и плашку «нежелательный»
 * (`buildSurfacePanelSvg`), а построитель объяснений не писал вовсе —
 * единственный такой из четырёх построителей визуальных панелей. Рамка без
 * фразы «почему выделено» — это обвинение без основания в документе, который
 * человек читает про себя.
 *
 * Держат это поведение только юниты, и знать об этом надо заранее: в
 * `report-72` ни одна строка панелей связанных запросов не разрешается в
 * `adverse` (объяснений на всех четырёх листах ноль), а в золотом кейсе у этих
 * слотов нет привязанного ассета вовсе — лист падает на прозаическую
 * раскладку, и рисовать рамку не на чем. Пустой дифф эталонов здесь ничего не
 * подтверждает.
 *
 * Вход строится через `extras.visualAssets[slotId].visibleItems`, а не через
 * «негативный связанный запрос»: объяснения читают видимые строки ассета, и
 * проверка на синтезированной негативной строке выдачи была бы зелена
 * вакуумно.
 */

import { describe, expect, it } from "vitest";
import { buildRelatedQueriesFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/related";
import { validateAssembly } from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";

const SLOT = "p20_ru_related_1";

/** Строка поверхности: что написано в записи и на каком она домене. */
type Row = { text: string; domain: string };

const QUERIES: Row[] = [
  { text: "глинка сергей михайлович уголовное дело", domain: "yandex.ru" },
  { text: "глинка сергей михайлович биография", domain: "yandex.ru" },
  { text: "глинка сергей михайлович инвестиции", domain: "yandex.ru" },
];

const urlOf = (rows: readonly Row[], i: number): string =>
  `https://${rows[i]!.domain}/search/?text=${i}`;

function scopedRelated(rows: readonly Row[]): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  rows.forEach((row, i) => {
    evidenceIndex[`inventory:r${i}`] = {
      title: row.text,
      domain: row.domain,
      url: urlOf(rows, i),
      region: "RU",
      subjectDecision: "SUBJECT_MATCH",
    };
  });
  return {
    findings: [],
    surfaceUnits: [
      {
        surface: "paa_related",
        region: "RU",
        engine: "YANDEX",
        claims: [],
        metrics: [],
        evidenceRefs: rows.map((_, i) => `inventory:r${i}`),
      },
    ],
    evidenceIndex,
    scope: {},
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

/** Панель слота: какие строки на ней нарисованы и какие из них обведены красным. */
function extrasWithPanel(
  rows: readonly Row[],
  visible: Array<{ i: number; adverse?: boolean }>
): FragmentExtras {
  return {
    visualAssets: {
      [SLOT]: [
        {
          assetRef: `${SLOT}-panel`,
          kind: "surface_panel",
          // Без картинки слайд уходит в запасную карточку, и рамок на нём нет.
          hasImage: true,
          visibleItems: visible.map((v) => ({
            ref: `inventory:r${v.i}`,
            title: rows[v.i]!.text,
            url: urlOf(rows, v.i),
            domain: rows[v.i]!.domain,
            adverse: v.adverse === true,
          })),
        },
      ],
    },
  } as unknown as FragmentExtras;
}

type BuiltPage = {
  page: SlideContentContract;
  scoped: ScopedFragmentInput;
  extras: FragmentExtras;
};

/**
 * Построенная страница вместе со входом, который её породил: ворота ниже
 * читают ту же мету ассета и тот же индекс доказательств, что и построитель.
 * `visible: null` — слот без привязанного ассета.
 */
function buildRelated(
  visible: Array<{ i: number; adverse?: boolean }> | null,
  rows: readonly Row[] = QUERIES
): BuiltPage {
  const scoped = scopedRelated(rows);
  const extras = visible ? extrasWithPanel(rows, visible) : ({} as FragmentExtras);
  const { slides } = buildRelatedQueriesFragment(
    "RU_RELATED",
    "RU_PROFILE",
    "Россия",
    scoped,
    extras
  );
  return { page: slides.find((s) => s.slideId === SLOT)!, scoped, extras };
}

/** Приёмка сборки на построенной странице: слайд собран из того, что вернул построитель. */
function assemblyReport(built: BuiltPage): ReturnType<typeof validateAssembly> {
  const { page, scoped, extras } = built;
  const slide = {
    slideKey: page.slideId,
    sectionKey: "RU_PROFILE",
    template: "orion_golden_surface_panel",
    templateId: page.templateId,
    title: page.title,
    pageNumber: 1,
    totalPageCount: 1,
    baseSlotId: page.baseSlotId,
    isContinuation: false,
    bullets: page.content.bullets ?? [],
    evidenceRefs: page.evidenceRefs,
    findingIds: page.findingIds,
    metrics: {},
    visualAssetRefs: page.visualAssetRefs,
    staticBlocks: [],
    whatWasFound: page.content.whatWasFound,
    whyItMatters: page.content.whyItMatters,
    whatToCheck: page.content.whatToCheck,
    statusNote: page.content.statusNote,
    sourceNote: page.content.sourceNote,
    highlightExplanations: page.content.highlightExplanations,
  } as unknown as RendererSlide;
  return validateAssembly({
    manifest: { sectionOrder: [], entries: [] },
    deckManifest: {
      caseId: "case-1",
      sourceDatasetId: "dataset-1",
      pageCount: 1,
      baseSlotCoverage: 36,
      sectionPageRanges: [],
      toc: [],
      nonCanonicalPages: [],
      slides: [
        {
          slideId: slide.slideKey,
          baseSlotId: slide.baseSlotId,
          templateId: slide.templateId,
          pageNumber: 1,
          isContinuation: false,
          pageKind: "canonical_base",
        },
      ],
    },
    rendererSlides: [slide],
    packs: [],
    bundle: { findings: [] },
    baseObservationCountBefore: 0,
    baseObservationCountAfter: 0,
    visualAssets: (extras as { visualAssets?: unknown }).visualAssets,
    evidenceIndex: scoped.evidenceIndex,
  } as unknown as Parameters<typeof validateAssembly>[0]);
}

describe("страница связанных запросов объясняет свои рамки", () => {
  it("одна обведённая строка получает ровно одно объяснение", () => {
    const { page } = buildRelated([{ i: 0, adverse: true }, { i: 1 }]);
    const explanations = page.content.highlightExplanations ?? [];
    expect(explanations).toHaveLength(1);
    expect(explanations[0]!.clientReason.trim().length).toBeGreaterThan(0);
    // Фраза объясняет рамку, а не пересказывает строку под ней.
    expect(explanations[0]!.clientReason).not.toBe(QUERIES[0]!.text);
    expect(explanations[0]!.frameTone).toBe("red");
  });

  it("объяснений столько, сколько нарисованных рамок, а не строк на панели", () => {
    // Три строки, две обведены: счёт по находкам или по видимым строкам дал бы
    // не два — ровно тот дефект, который партия чинит у ворот.
    const { page } = buildRelated([
      { i: 0, adverse: true },
      { i: 1 },
      { i: 2, adverse: true },
    ]);
    expect(page.content.highlightExplanations).toHaveLength(2);
  });

  it("строка, попавшая в видимые дважды, — одна рамка и одно объяснение", () => {
    const { page } = buildRelated([
      { i: 0, adverse: true },
      { i: 0, adverse: true },
      { i: 1 },
    ]);
    expect(page.content.highlightExplanations).toHaveLength(1);
  });

  it("панель без негатива поля объяснений не получает вовсе", () => {
    // «Правки нет» и «правка пустая» в этом дереве различаются по `undefined`:
    // безусловное поле сдвинуло бы `contentHash` пакетов там, где содержимое не
    // изменилось.
    const { page } = buildRelated([{ i: 1 }, { i: 2 }]);
    expect(Object.keys(page.content)).not.toContain("highlightExplanations");
  });

  it("страница без привязанного ассета объяснений не печатает", () => {
    // Форма золотого кейса: ассета нет, лист падает на прозаическую раскладку —
    // рамок там нет, и объяснять нечего.
    const { page } = buildRelated(null);
    expect(page.visualAssetRefs).toEqual([]);
    expect(Object.keys(page.content)).not.toContain("highlightExplanations");
    expect(page.content.bullets ?? []).not.toHaveLength(0);
  });

  it("ворот «каждая рамка объяснена» на этой странице зелёный", () => {
    const report = assemblyReport(buildRelated([{ i: 0, adverse: true }, { i: 1 }]));
    expect(report.skipped.join(" ")).not.toContain("каждая рамка объяснена");
    expect(report.checks.unexplainedAdverseMarkerCountZero).toBe(true);
    expect(report.issues.join(" ")).not.toContain(SLOT);
  });
});

describe("страница отвечает за домены, названные в её объяснениях", () => {
  /*
   * Два связанных запроса с одинаковым текстом и разными записями.
   *
   * Строки страницы сводит `panelRows` — **по тексту заголовка**, поэтому в
   * `evidenceRefs` попадает только первая запись. Объяснения строит
   * `adverseVisualSidebar` — **по `ref`**, поэтому фраз получается две, и
   * вторая называет домен, которого в доказательствах страницы нет. Ключи
   * разные, наборы расходятся, и ворот `sourceFooterFromSidebarEvidence`
   * краснеет на здоровом прогоне; клиент при этом читает про домен, который
   * страница назвать не вправе. Поэтому доказательства страницы вбирают ссылки
   * сайдбара — ровно как у трёх соседних построителей.
   *
   * Панель такие строки не сводит: `buildListPanelAsset` отбрасывает только
   * записи без заголовка.
   */
  const SAME_TEXT: Row[] = [
    { text: "глинка сергей михайлович уголовное дело", domain: "yandex.ru" },
    { text: "глинка сергей михайлович уголовное дело", domain: "rucriminal.info" },
  ];

  it("объяснение о втором материале подкреплено доказательством страницы", () => {
    const built = buildRelated([{ i: 0, adverse: true }, { i: 1, adverse: true }], SAME_TEXT);
    // Предпосылка проверки: строк на странице одна, а рамок на панели две.
    expect(built.page.content.bullets).toHaveLength(1);
    expect(built.page.content.highlightExplanations).toHaveLength(2);

    const report = assemblyReport(built);
    expect(report.issues.join(" ")).not.toContain("not derived from its evidence");
    expect(report.checks.sourceFooterFromSidebarEvidence).toBe(true);
    // Область фрагмента не расширяется: ссылки сайдбара уже отфильтрованы по
    // индексу доказательств, и региональная изоляция остаётся зелёной.
    expect(report.checks.regionScopeIsolation).toBe(true);
    // Механизм: доказательства страницы вобрали ссылки сайдбара.
    expect(built.page.evidenceRefs).toEqual(["inventory:r0", "inventory:r1"]);
  });
});
