/**
 * Ворот «каждая нарисованная рамка на странице объяснена».
 *
 * Прежняя редакция сравнивала с числом объяснений **число негативных находок
 * слайда** — величину, к рамкам отношения не имеющую. Замер на эталоне 72
 * (`assembled-deck.json` плюс восстановленные `visibleItems`) показал, как
 * далеко они расходятся: у `p15_ru_images_2` и `p16_ru_images_3` рамок нет
 * вовсе при одной негативной находке, у `p17_ru_images_4` находок две при одной
 * рамке. Пять рамок при трёх находках и трёх объяснениях старый ворот
 * пропускал — так рамка без объяснения и доехала до клиента при 26 зелёных
 * воротах.
 *
 * Единица счёта — **различный `ref`**, а не нарисованный прямоугольник:
 * у `p10_ru_serp_visual` два снимка рисуют одни и те же две строки
 * (экземпляров 4, материалов 2, объяснений 2), и счёт по прямоугольникам
 * покраснел бы на здоровом эталоне.
 *
 * Материала, на котором дефект виден, в эталонах нет: на `d7c6f48` рамок и
 * объяснений поровну на каждой из шестнадцати страниц с привязанным ассетом.
 * Поэтому поведение ворот держится сконструированным входом, а эталон
 * доказывает только отсутствие ложного срабатывания.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateAssembly } from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";
import { assetKindDrawsRedFrames } from "@/modules/digital-profile/orion-golden/assets/red-frame-asset-kinds";
import { DECK_ASSET_FIXTURE_PATH } from "../../scripts/deck-asset-fixture-path";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import type { VisualAssetsBySlot } from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";

type Page = {
  slideKey: string;
  /** Шаблон рендерера: снимок выдачи, сетка картинок, панель. */
  template: string;
  baseSlotId?: string;
  isContinuation?: boolean;
  /** Привязанные ассеты страницы. Пусто — страница ворот не касается. */
  visualAssetRefs?: string[];
  /** Находки слайда: величина, которую ворот мерил раньше. */
  findingIds?: string[];
  /** Сколько объяснений напечатала панель рядом. */
  explanations?: number;
};

function rendererSlide(page: Page, i: number, total: number): RendererSlide {
  return {
    slideKey: page.slideKey,
    sectionKey: "RU_PROFILE",
    template: page.template,
    templateId: "serp-screenshot",
    title: `Страница ${i + 1}`,
    pageNumber: i + 1,
    totalPageCount: total,
    baseSlotId: page.baseSlotId ?? page.slideKey,
    isContinuation: page.isContinuation ?? false,
    // Сайдбар заполнен: иначе краснеет соседний ворот, и шум мешает читать
    // отказ этого.
    whatWasFound: "Вывод страницы.",
    whyItMatters: "Почему это важно клиенту.",
    whatToCheck: "Что проверить.",
    bullets: [],
    evidenceRefs: [],
    findingIds: page.findingIds ?? [],
    metrics: {},
    visualAssetRefs: page.visualAssetRefs ?? [],
    staticBlocks: [],
    highlightExplanations: Array.from({ length: page.explanations ?? 0 }, (_, k) => ({
      clientReason: `Почему выделено ${k + 1}.`,
      frameTone: "red" as const,
    })),
  } as unknown as RendererSlide;
}

function reportFor(input: {
  pages: Page[];
  visualAssets?: VisualAssetsBySlot;
  /** Негативные находки прогона: `subjectMatch` + риск не ниже среднего. */
  adverseFindingIds?: string[];
}): ReturnType<typeof validateAssembly> {
  const rendererSlides = input.pages.map((p, i) => rendererSlide(p, i, input.pages.length));
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
        templateId: s.templateId,
        pageNumber: s.pageNumber,
        isContinuation: s.isContinuation,
        continuationOf: s.isContinuation ? s.baseSlotId : undefined,
        pageKind: s.isContinuation ? "continuation" : "canonical_base",
      })),
    },
    rendererSlides,
    packs: [],
    bundle: {
      findings: (input.adverseFindingIds ?? []).map((findingId) => ({
        findingId,
        riskLevel: "high",
        subjectMatch: "SUBJECT_MATCH",
      })),
    },
    baseObservationCountBefore: 0,
    baseObservationCountAfter: 0,
    visualAssets: input.visualAssets,
  } as unknown as Parameters<typeof validateAssembly>[0]);
}

/**
 * Мета ассета: строки, нарисованные на нём. `adverse` — красная рамка.
 *
 * Форма та же, что приезжает с живого пути (`canonical-visual-assets.ts`) и с
 * реконструкции скрипта эталона. Вид по умолчанию — `serp_snapshot`, словарь
 * замороженной фикстуры эталона 72.
 */
function asset(
  assetRef: string,
  rows: Array<{ ref: string; adverse?: boolean }>,
  kind = "serp_snapshot"
) {
  return {
    assetRef,
    kind,
    title: assetRef,
    hasImage: true,
    evidenceRefs: rows.map((r) => r.ref),
    visibleItems: rows.map((r) => ({
      ref: r.ref,
      url: `https://example.com/${r.ref}`,
      domain: "example.com",
      title: `строка ${r.ref}`,
      adverse: r.adverse ?? false,
    })),
  };
}

/** Нарушения именно этого ворота — на синтетике шумят соседние проверки. */
function frameIssues(report: ReturnType<typeof validateAssembly>): string[] {
  return report.issues.filter((i) => /рамок на привязанных ассетах/u.test(i));
}

/** Пропуски именно этого ворота. */
function frameSkips(report: ReturnType<typeof validateAssembly>): string[] {
  return report.skipped.filter((s) => /каждая рамка объяснена/u.test(s));
}

describe("ворот «каждая нарисованная рамка объяснена»", () => {
  it("пять рамок и три объяснения — отказ, хотя негативных находок ровно три", () => {
    // Единственный вход, отличающий новую величину от старой: находок и
    // объяснений поровну, а рамок больше. Прежний ворот его пропускал.
    const report = reportFor({
      pages: [
        {
          slideKey: "p10_ru_serp_visual",
          template: "orion_golden_serp_screenshot",
          visualAssetRefs: ["snap-1"],
          findingIds: ["f1", "f2", "f3"],
          explanations: 3,
        },
      ],
      adverseFindingIds: ["f1", "f2", "f3"],
      visualAssets: {
        p10_ru_serp_visual: [
          asset("snap-1", [
            { ref: "obs-1", adverse: true },
            { ref: "obs-2", adverse: true },
            { ref: "obs-3", adverse: true },
            { ref: "obs-4", adverse: true },
            { ref: "obs-5", adverse: true },
            { ref: "obs-6" },
          ]),
        ],
      },
    });
    expect(report.checks.unexplainedAdverseMarkerCountZero).toBe(false);
    const issue = frameIssues(report)[0];
    expect(issue, report.issues.join(" | ")).toBeDefined();
    expect(issue!).toContain("p10_ru_serp_visual");
    expect(issue!).toContain("5");
    expect(issue!).toContain("3");
  });

  it("сетка изображений с рамкой без объяснения — отказ: раньше такие страницы не смотрели вовсе", () => {
    const report = reportFor({
      pages: [
        {
          slideKey: "p30_uae_images",
          template: "orion_golden_image_grid",
          visualAssetRefs: ["grid-1"],
          explanations: 1,
        },
      ],
      visualAssets: {
        p30_uae_images: [
          asset("grid-1", [
            { ref: "img-1", adverse: true },
            { ref: "img-2", adverse: true },
            { ref: "img-3" },
          ]),
        ],
      },
    });
    expect(report.checks.unexplainedAdverseMarkerCountZero).toBe(false);
    expect(frameIssues(report)[0], report.issues.join(" | ")).toContain("p30_uae_images");
  });

  it("одна строка на двух снимках — одна рамка, а не две", () => {
    // Форма `p10_ru_serp_visual` эталона: два привязанных снимка рисуют одни и
    // те же две строки. Экземпляров четыре, материалов два, объяснений два —
    // счёт по прямоугольникам покраснел бы на здоровом эталоне.
    const rows = [
      { ref: "obs-1", adverse: true },
      { ref: "obs-2", adverse: true },
    ];
    const report = reportFor({
      pages: [
        {
          slideKey: "p10_ru_serp_visual",
          template: "orion_golden_serp_screenshot",
          visualAssetRefs: ["yandex", "google"],
          explanations: 2,
        },
      ],
      visualAssets: {
        p10_ru_serp_visual: [asset("yandex", rows), asset("google", rows)],
      },
    });
    expect(report.checks.unexplainedAdverseMarkerCountZero).toBe(true);
    expect(frameIssues(report)).toEqual([]);
  });

  it("страница-продолжение объяснений не несёт и ворот не роняет", () => {
    // Объяснения принадлежат первой странице блока: спрашивать их с
    // продолжения значит требовать повтора — того самого, который из отчёта
    // убирали.
    const report = reportFor({
      pages: [
        {
          slideKey: "p10_ru_serp_visual",
          template: "orion_golden_serp_screenshot",
          visualAssetRefs: ["snap-1"],
          explanations: 2,
        },
        {
          slideKey: "p10_ru_serp_visual__cont1",
          template: "orion_golden_serp_screenshot",
          baseSlotId: "p10_ru_serp_visual",
          isContinuation: true,
          visualAssetRefs: ["snap-1"],
          explanations: 0,
        },
      ],
      visualAssets: {
        p10_ru_serp_visual: [
          asset("snap-1", [
            { ref: "obs-1", adverse: true },
            { ref: "obs-2", adverse: true },
          ]),
        ],
      },
    });
    expect(report.checks.unexplainedAdverseMarkerCountZero).toBe(true);
    expect(frameIssues(report)).toEqual([]);
  });

  it("объяснений больше, чем рамок, — не отказ", () => {
    const report = reportFor({
      pages: [
        {
          slideKey: "p17_ru_images_4",
          template: "orion_golden_image_grid",
          visualAssetRefs: ["grid-1"],
          explanations: 3,
        },
      ],
      visualAssets: {
        p17_ru_images_4: [asset("grid-1", [{ ref: "img-1", adverse: true }])],
      },
    });
    expect(report.checks.unexplainedAdverseMarkerCountZero).toBe(true);
    expect(frameIssues(report)).toEqual([]);
  });

  it("ассет привязан, а меты во входе нет — ключа в checks нет, пропуск назван строкой", () => {
    // Ветка `gpt-copy` инициализирует `visualAssetsBySlot = {}` и оставляет
    // пустым, если `visual-assets-by-slot.json` не прочитался. Пустой объект
    // истинен: ворот нашёл бы ноль рамок везде и был бы зелёным вакуумно.
    for (const [what, visualAssets] of [
      ["пустой объект", {}],
      ["входа нет вовсе", undefined],
    ] as Array<[string, VisualAssetsBySlot | undefined]>) {
      const report = reportFor({
        pages: [
          {
            slideKey: "p10_ru_serp_visual",
            template: "orion_golden_serp_screenshot",
            visualAssetRefs: ["snap-1"],
            explanations: 0,
          },
        ],
        visualAssets,
      });
      expect(Object.keys(report.checks), what).not.toContain(
        "unexplainedAdverseMarkerCountZero"
      );
      const skip = frameSkips(report)[0];
      expect(skip, `${what}: ${report.skipped.join(" | ")}`).toBeDefined();
      expect(skip!, what).toContain("p10_ru_serp_visual");
    }
  });

  it("в деке нет ни одной страницы с привязанным ассетом — ключа нет, пропуск назван", () => {
    // Ворот без входа выглядит точно так же, как пройденный: ключ читается
    // скриптом приёмки как `?? false`, поэтому молчаливого «зелено» быть не
    // должно.
    const report = reportFor({
      pages: [{ slideKey: "p03_executive", template: "orion_golden_text_bullets" }],
      visualAssets: {},
    });
    expect(Object.keys(report.checks)).not.toContain("unexplainedAdverseMarkerCountZero");
    expect(frameSkips(report)[0], report.skipped.join(" | ")).toBeDefined();
  });

  it("рамок и объяснений поровну на каждой странице — ворот зелёный", () => {
    // Форма эталона 72: снимок с двумя рамками, сетка с пятью, панель без
    // рамок вовсе.
    const report = reportFor({
      pages: [
        {
          slideKey: "p10_ru_serp_visual",
          template: "orion_golden_serp_screenshot",
          visualAssetRefs: ["snap-1"],
          explanations: 2,
        },
        {
          slideKey: "p30_uae_images",
          template: "orion_golden_image_grid",
          visualAssetRefs: ["grid-1"],
          explanations: 5,
        },
        {
          slideKey: "p20_ru_related_1",
          template: "orion_golden_surface_panel",
          visualAssetRefs: ["panel-1"],
          explanations: 0,
        },
      ],
      visualAssets: {
        p10_ru_serp_visual: [
          asset("snap-1", [
            { ref: "obs-1", adverse: true },
            { ref: "obs-2", adverse: true },
          ]),
        ],
        p30_uae_images: [
          asset(
            "grid-1",
            Array.from({ length: 5 }, (_, k) => ({ ref: `img-${k}`, adverse: true }))
          ),
        ],
        p20_ru_related_1: [asset("panel-1", [{ ref: "q-1" }, { ref: "q-2" }])],
      },
    });
    expect(report.checks.unexplainedAdverseMarkerCountZero).toBe(true);
    expect(frameIssues(report)).toEqual([]);
    expect(frameSkips(report)).toEqual([]);
  });
  it("панель знаний рамок не рисует: негативная строка её меты ворот не роняет", () => {
    // `buildKnowledgePanelSvg` получает только заголовок, сводку и факты — ни
    // одного флага негатива, ни одной рамки (замер: красных упоминаний в SVG
    // ноль). Но `visibleItems` панели считает тот же классификатор, что и
    // остальные поверхности, и на живом прогоне слово словаря негатива в
    // ответе ИИ-поиска — обычное дело. Объяснений построитель панели знаний не
    // пишет никогда, поэтому счёт «рамок 1, объяснений 0» был бы отказом на
    // странице, где ничего не потеряно.
    const report = reportFor({
      pages: [
        {
          slideKey: "p18_ru_knowledge_1",
          template: "orion_golden_knowledge_panel",
          visualAssetRefs: ["knowledge-1"],
          explanations: 0,
        },
      ],
      visualAssets: {
        p18_ru_knowledge_1: [
          asset(
            "knowledge-1",
            [
              { ref: "ai-1", adverse: true },
              { ref: "kb-1", adverse: true },
            ],
            "knowledge_panel"
          ),
        ],
      },
    });
    expect(report.checks.unexplainedAdverseMarkerCountZero).toBe(true);
    expect(frameIssues(report), report.issues.join(" | ")).toEqual([]);
    expect(frameSkips(report), report.skipped.join(" | ")).toEqual([]);
  });

  it("настоящий скриншот рамок не несёт: негативная строка его меты ворот не роняет", () => {
    // У ветки `live_serp` картинка чужая — байты приходят с контура захвата, и
    // рисовать на ней мы ничего не рисуем. `visibleItems` там перечисляют то,
    // что читатель видит на снимке, а не то, что обведено.
    const report = reportFor({
      pages: [
        {
          slideKey: "p10_ru_serp_visual",
          template: "orion_golden_serp_screenshot",
          visualAssetRefs: ["real-1"],
          explanations: 0,
        },
      ],
      visualAssets: {
        p10_ru_serp_visual: [
          asset("real-1", [{ ref: "obs-1", adverse: true }], "live_serp"),
        ],
      },
    });
    expect(report.checks.unexplainedAdverseMarkerCountZero).toBe(true);
    expect(frameIssues(report), report.issues.join(" | ")).toEqual([]);
  });

  it("панель поверхности рамки рисует: негативная строка без объяснения — отказ", () => {
    // Обратная сторона того же ответа: `buildSurfacePanelSvg` обводит красным
    // каждую негативную строку (замер: три красных упоминания в SVG против
    // нуля без негатива). Сузить ворот до одного снимка выдачи значило бы
    // ослепить его на подсказках и связанных запросах.
    const report = reportFor({
      pages: [
        {
          slideKey: "p20_ru_related_1",
          template: "orion_golden_surface_panel",
          visualAssetRefs: ["panel-1"],
          explanations: 0,
        },
      ],
      visualAssets: {
        p20_ru_related_1: [
          asset("panel-1", [{ ref: "q-1", adverse: true }], "surface_panel"),
        ],
      },
    });
    expect(report.checks.unexplainedAdverseMarkerCountZero).toBe(false);
    expect(frameIssues(report)[0], report.issues.join(" | ")).toContain("p20_ru_related_1");
  });

  it("вид ассета, о котором не сказано, рисует ли он рамки, делает проверку невыполнимой", () => {
    // Молчаливый ответ «рамок нет» ослепил бы ворот на новой поверхности, а
    // молчаливое «рамки есть» дало бы ложный отказ. Незнание объявляется
    // словами — тем же приёмом, что и отсутствие меты.
    const report = reportFor({
      pages: [
        {
          slideKey: "p10_ru_serp_visual",
          template: "orion_golden_serp_screenshot",
          visualAssetRefs: ["new-1"],
          explanations: 0,
        },
      ],
      visualAssets: {
        p10_ru_serp_visual: [
          asset("new-1", [{ ref: "obs-1", adverse: true }], "видео_карусель"),
        ],
      },
    });
    expect(Object.keys(report.checks)).not.toContain("unexplainedAdverseMarkerCountZero");
    const skip = frameSkips(report)[0];
    expect(skip, report.skipped.join(" | ")).toBeDefined();
    expect(skip!).toContain("видео_карусель");
  });

  it("виды ассетов фикстуры эталона 72 названы все — иначе приёмка пропустит ворот молча", () => {
    // Фикстура говорит на своём, более старом словаре (`visual`,
    // `serp_snapshot`), и ответ обязан покрывать оба: незнакомый вид уводит
    // ворот в пропуск, а приёмка читает ключ через `?? false` и краснеет.
    const raw = JSON.parse(readFileSync(DECK_ASSET_FIXTURE_PATH, "utf8")) as
      | Array<{ kind?: string }>
      | { assets: Array<{ kind?: string }> };
    const assets = Array.isArray(raw) ? raw : raw.assets;
    expect(assets.length).toBeGreaterThan(0);
    const unknown = [...new Set(assets.map((a) => String(a.kind ?? "visual")))].filter(
      (kind) => assetKindDrawsRedFrames(kind) === null
    );
    expect(unknown).toEqual([]);
  });

  it("мета есть у одной страницы и нет у другой — ключ исчезает, названа вторая", () => {
    // Ворот, измеривший половину деки, снаружи обязан быть неотличим от
    // ворота, не измерившего ничего: иначе приёмка показывает зелёный ключ на
    // деке, половину которой никто не мерил.
    const report = reportFor({
      pages: [
        {
          slideKey: "p10_ru_serp_visual",
          template: "orion_golden_serp_screenshot",
          visualAssetRefs: ["snap-1"],
          explanations: 2,
        },
        {
          slideKey: "p30_uae_images",
          template: "orion_golden_image_grid",
          visualAssetRefs: ["grid-1"],
          explanations: 0,
        },
      ],
      visualAssets: {
        p10_ru_serp_visual: [
          asset("snap-1", [
            { ref: "obs-1", adverse: true },
            { ref: "obs-2", adverse: true },
          ]),
        ],
      },
    });
    expect(Object.keys(report.checks)).not.toContain("unexplainedAdverseMarkerCountZero");
    const skip = frameSkips(report)[0];
    expect(skip, report.skipped.join(" | ")).toBeDefined();
    expect(skip!).toContain("p30_uae_images");
    expect(skip!).not.toContain("p10_ru_serp_visual");
  });

  it("разные материалы на двух снимках — рамок две, а не одна", () => {
    // Колонки Яндекса и Google — два ассета одного слота, и материал у каждой
    // свой. Счёт по первому ассету увидел бы одну рамку и принял страницу с
    // необъяснённой второй.
    const report = reportFor({
      pages: [
        {
          slideKey: "p10_ru_serp_visual",
          template: "orion_golden_serp_screenshot",
          visualAssetRefs: ["yandex", "google"],
          explanations: 1,
        },
      ],
      visualAssets: {
        p10_ru_serp_visual: [
          asset("yandex", [{ ref: "obs-A", adverse: true }]),
          asset("google", [{ ref: "obs-B", adverse: true }]),
        ],
      },
    });
    expect(report.checks.unexplainedAdverseMarkerCountZero).toBe(false);
    const issue = frameIssues(report)[0];
    expect(issue, report.issues.join(" | ")).toBeDefined();
    expect(issue!).toContain("2");
    expect(issue!).toContain("1");
  });

  it("мета ищется по слоту, а не по ключу страницы", () => {
    // `visualAssets` ключуется слотом, и построитель объяснений зовётся от
    // `slot.slotId`. Базовая страница с ключом, отличным от слота, в деке
    // эталона уже есть (`appendix_main_base` при `slot_appendix_main`).
    const report = reportFor({
      pages: [
        {
          slideKey: "p10_ru_serp_visual_base",
          template: "orion_golden_serp_screenshot",
          baseSlotId: "p10_ru_serp_visual",
          visualAssetRefs: ["snap-1"],
          explanations: 0,
        },
      ],
      visualAssets: {
        p10_ru_serp_visual: [asset("snap-1", [{ ref: "obs-1", adverse: true }])],
      },
    });
    expect(report.checks.unexplainedAdverseMarkerCountZero).toBe(false);
    expect(frameIssues(report)[0], report.issues.join(" | ")).toContain(
      "p10_ru_serp_visual_base"
    );
  });
  it("незнакомый вид замечают и тогда, когда он в слоте не первый", () => {
    // Слот несёт несколько ассетов (колонки движков, панель плюс её врезка), и
    // новая поверхность придёт вторым, а не первым. Проверка вида, смотрящая
    // только на первую мету, прочитала бы незнакомое как «рамок нет» — ровно
    // то молчание, которое ветка пропуска и запрещает.
    const report = reportFor({
      pages: [
        {
          slideKey: "p10_ru_serp_visual",
          template: "orion_golden_serp_screenshot",
          visualAssetRefs: ["snap-1", "new-1"],
          explanations: 1,
        },
      ],
      visualAssets: {
        p10_ru_serp_visual: [
          asset("snap-1", [{ ref: "obs-1", adverse: true }]),
          asset("new-1", [{ ref: "obs-2", adverse: true }], "видео_карусель"),
        ],
      },
    });
    expect(Object.keys(report.checks)).not.toContain("unexplainedAdverseMarkerCountZero");
    const skip = frameSkips(report)[0];
    expect(skip, report.skipped.join(" | ")).toBeDefined();
    expect(skip!).toContain("видео_карусель");
  });

  it("перечень страниц без меты объявляет свою неполноту", () => {
    // Читатель отчёта об отказе принимает недоговорённость за полный список:
    // «у страниц A, B, C, D, E привязан ассет» на семи страницах — это
    // сообщение, по которому чинят не то.
    const pages = Array.from({ length: 7 }, (_, k) => ({
      slideKey: `p${10 + k}_visual`,
      template: "orion_golden_surface_panel",
      visualAssetRefs: ["panel-1"],
      explanations: 0,
    }));
    const report = reportFor({ pages, visualAssets: {} });
    const skip = frameSkips(report)[0];
    expect(skip, report.skipped.join(" | ")).toBeDefined();
    expect(skip!).toContain("и ещё 2");
    expect(skip!).not.toContain("p16_visual");
  });
});
