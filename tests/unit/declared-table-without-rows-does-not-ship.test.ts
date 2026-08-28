/**
 * Слайд, объявивший таблицу без единой строки, в нагрузку не уезжает.
 *
 * Пустая таблица — не пустая страница, а приглашение рендереру выдумать
 * содержимое: `slides.py` идёт веткой `if not rows and bullets`, ставит
 * заголовки таблицы поиска и разбирает в строки то, что подвернулось. Так
 * страница комплаенса при нуле совпадений печатала клиенту шапку
 * «Поз. / Домен / Заголовок / Риск» над строкой прочерков.
 *
 * Ворот стоит на стороне приложения, а не рендерера: запасная ветка живёт в
 * другой единице деплоя, а дверь закрывают там, где она есть. Утверждение
 * структурное — таблица без строк не бывает законной ни у одного построителя,
 * — поэтому проверка ставится на самом вороте, а не на комплаенсе.
 */

import { describe, expect, it } from "vitest";
import {
  blockingIssues,
  validateAssembly,
} from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";
import { buildComplianceFragment } from "@/modules/digital-profile/orion-golden/deck-sections";
import { DECK_TEMPLATE_REGISTRY } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { DeckTemplateId } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";

function rendererSlide(input: {
  slideKey: string;
  template?: string;
  pageNumber: number;
  totalPageCount: number;
  narrative?: string;
  bullets?: string[];
  table?: RendererSlide["table"];
}): RendererSlide {
  return {
    slideKey: input.slideKey,
    sectionKey: "COMPLIANCE",
    template: input.template ?? "orion_golden_search_table",
    title: `Страница ${input.pageNumber}`,
    pageNumber: input.pageNumber,
    totalPageCount: input.totalPageCount,
    baseSlotId: input.slideKey,
    isContinuation: false,
    narrative: input.narrative,
    bullets: input.bullets ?? [],
    table: input.table,
    evidenceRefs: [],
    findingIds: [],
    metrics: {},
    visualAssetRefs: [],
    staticBlocks: [],
  } as unknown as RendererSlide;
}

function reportFor(rendererSlides: RendererSlide[]): ReturnType<typeof validateAssembly> {
  return validateAssembly({
    manifest: { sectionOrder: [], entries: [] },
    deckManifest: {
      caseId: "case-1",
      sourceDatasetId: "dataset-1",
      pageCount: rendererSlides.length,
      baseSlotCoverage: 36,
      sectionPageRanges: [],
      toc: [],
      nonCanonicalPages: [],
      slides: rendererSlides.map((s) => ({
        slideId: s.slideKey,
        baseSlotId: s.baseSlotId,
        templateId: s.template,
        pageNumber: s.pageNumber,
        isContinuation: false,
        pageKind: "canonical_base",
      })),
    },
    rendererSlides,
    packs: [],
    bundle: { findings: [] },
    baseObservationCountBefore: 0,
    baseObservationCountAfter: 0,
  } as unknown as Parameters<typeof validateAssembly>[0]);
}

describe("ворот пустой таблицы", () => {
  it("краснеет на слайде с объявленной таблицей и нулём строк и называет его", () => {
    const report = reportFor([
      rendererSlide({
        slideKey: "p33_compliance_toc",
        pageNumber: 1,
        totalPageCount: 2,
        narrative: "Совпадений по субъекту не зафиксировано.",
        bullets: ["Источник: комплаенс-базы (существующий контур)."],
        table: { headers: ["База данных", "Тип совпадения"], rows: [] },
      }),
      rendererSlide({
        slideKey: "p34_dow_jones",
        pageNumber: 2,
        totalPageCount: 2,
        narrative: "Проверка по базе Dow Jones не выполнена.",
        table: { headers: ["Параметр", "Значение"], rows: [["Статус", "нет записей"]] },
      }),
    ]);
    expect(report.checks.declaredTablesHaveRows).toBe(false);
    const issue = report.issues.find((i) => i.includes("p33_compliance_toc"));
    expect(issue, report.issues.join(" | ")).toBeDefined();
    expect(issue!).toMatch(/таблиц|table/iu);
    // Таблица без строк — не спорная формулировка, а выдуманное содержимое:
    // одной страницы достаточно, чтобы сборка не уехала клиенту.
    const blocked = report.blocking.find((b) => b.includes("p33_compliance_toc"));
    expect(blocked, report.blocking.join(" | ")).toBeDefined();
    expect(report.passed).toBe(false);
  });

  it("не краснеет на слайде без таблицы и на таблице со строками", () => {
    const report = reportFor([
      rendererSlide({
        slideKey: "p33_compliance_toc",
        template: "orion_golden_no_data_compact",
        pageNumber: 1,
        totalPageCount: 2,
        narrative: "Совпадений по субъекту не зафиксировано.",
        bullets: ["Dow Jones — проверка не выполнена: доступ к базе не настроен."],
      }),
      rendererSlide({
        slideKey: "p09_ru_serp_table",
        pageNumber: 2,
        totalPageCount: 2,
        narrative: "Выдача Google по субъекту.",
        table: { headers: ["Поз.", "Домен"], rows: [["1", "example.com"]] },
      }),
    ]);
    expect(report.checks.declaredTablesHaveRows).toBe(true);
    expect(report.blocking).toHaveLength(0);
  });

  it("строка отказа называет каждую страницу, а обрезанный перечень объявляет", () => {
    const many = Array.from({ length: 7 }, (_, i) => `p${i + 1}_slide`);
    const [line] = blockingIssues({
      quoteDefectSlides: new Set(),
      codeSlides: new Set(),
      emptyTableSlides: new Set(many),
    });
    expect(line).toBeDefined();
    expect(line!).toContain("p1_slide");
    expect(line!).toContain("и ещё 2");
  });
});

describe("построитель комплаенса и ворот вместе", () => {
  /**
   * Проводка: ворот стоит не на выдуманном слайде, а на том, что действительно
   * отдаёт построитель при нуле совпадений. Именно этот случай доехал до
   * клиента и был найден чтением страницы, а не проверкой.
   */
  function toRendererSlides(slides: SlideContentContract[]): RendererSlide[] {
    return slides.map((s, i) =>
      rendererSlide({
        slideKey: s.slideId,
        template:
          DECK_TEMPLATE_REGISTRY[s.templateId as DeckTemplateId]?.rendererTemplate ??
          "orion_golden_search_table",
        pageNumber: i + 1,
        totalPageCount: slides.length,
        narrative: s.content.narrative,
        bullets: s.content.bullets ?? [],
        table: s.content.table,
      })
    );
  }

  it("страницы комплаенса при нуле совпадений проходят ворот", () => {
    const scoped = {
      subject: { displayName: "Сергей Глинка", aliases: [] },
      findings: [],
      surfaceUnits: [
        {
          surface: "compliance",
          region: "GLOBAL",
          metrics: [{ key: "totalCount", value: 0 }],
          claims: [],
          evidenceRefs: [],
        },
      ],
      metricSnapshot: {
        metricSnapshotId: "m-1",
        datasetId: "d-1",
        reportRunId: "r-1",
        baseCount: 40,
        enrichmentCount: 0,
        compositeCount: 40,
        subjectMatchCount: 5,
        likelySubjectCount: 0,
        ambiguousCount: 0,
        otherSubjectCount: 0,
        adverseFindingCount: 0,
        perRegionCounts: { RU: 40 },
      },
      scope: { regions: null, surfaces: ["compliance"], subjectMatch: null, findingIds: null },
      evidenceIndex: {},
    };
    const built = buildComplianceFragment(
      "COMPLIANCE" as never,
      scoped as never,
      {
        complianceScreenings: [
          { provider: "DOW_JONES", status: "SUCCESS", hitCount: 0, finishedAt: null },
        ],
      } as never
    ).slides;
    const report = reportFor(toRendererSlides(built));
    expect(report.checks.declaredTablesHaveRows).toBe(true);
    expect(report.blocking).toHaveLength(0);
  });
});
