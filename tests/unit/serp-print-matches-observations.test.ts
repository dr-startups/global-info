/**
 * Ворота: печатная таблица выдачи сверяется с артефактом наблюдений.
 *
 * Мерить таблицу тем же индексом доказательств, которым она собрана,
 * бессмысленно — сломанный сбор согласится сам с собой. Поэтому проверка
 * читает наблюдения напрямую и смотрит в обе стороны: каждый напечатанный
 * номер подтверждён наблюдением своего движка по запросу таблицы, и каждое
 * такое наблюдение с позицией не глубже двадцатой напечатано.
 *
 * На печати прогона 76 проверка обязана быть красной с обеих сторон:
 * арсенкинские 11–20 не подтверждаются, серперные 3, 4 и 10 не напечатаны.
 */

import { describe, expect, it } from "vitest";
import {
  serpPrintMatchesObservations,
  validateAssembly,
} from "@/modules/digital-profile/orion-golden/deck-sections/assembly-validation";
import type { RendererSlide } from "@/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import type { SerpObservationRow } from "../fixtures/run76-serp-slice";
import { run76SerperRows, run76ArsenkinRows, UAE_QUERY } from "../fixtures/run76-serp-slice";

/** Страница выдачи: номера строк плюс движок и запрос, записанные данными. */
function serpSlide(input: {
  engine: string;
  query: string;
  ranks: number[];
  links?: Record<number, string>;
  slideKey?: string;
  /** Номера строк — позиции выдачи; иначе это порядок сбора. */
  positional?: boolean;
}): RendererSlide {
  return {
    slideKey: input.slideKey ?? "p09_uae_serp",
    sectionKey: "UAE_PROFILE",
    template: "orion_golden_search_table",
    templateId: "serp-table",
    title: "ОАЭ — Google, ТОП-20",
    pageNumber: 9,
    totalPageCount: 9,
    baseSlotId: "p09_uae_serp",
    isContinuation: false,
    table: {
      // Адрес строки — полоса под ней, а не колонка: ворота читают домен
      // оттуда же, откуда его читает клиент.
      headers: ["№", "Заголовок", "Тип источника", "Оценка"],
      rows: input.ranks.map((rank) => [
        String(rank),
        `Материал ${rank}`,
        "СМИ",
        "Нейтральный",
      ]),
      rowAddresses: input.ranks.map((rank) => input.links?.[rank] ?? `example.org/${rank}`),
    },
    evidenceRefs: [],
    findingIds: [],
    metrics: {
      serpEngine: input.engine,
      serpQuery: input.query,
      serpPositional: input.positional === false ? 0 : 1,
    },
    visualAssetRefs: [],
    staticBlocks: [],
  };
}

function linksOf(rows: SerpObservationRow[]): Record<number, string> {
  return Object.fromEntries(rows.map((r) => [r.rank!, `${r.domain}/viktor-rashnikov`]));
}

describe("печать сверяется с наблюдениями", () => {
  it("чужой ранг в таблице называется строкой", () => {
    const rows = [...run76SerperRows(), ...run76ArsenkinRows()];
    // Печать прогона 76: серперные 1, 2, 5–9 плюс арсенкинские 4, 10 и 11–20.
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: UAE_QUERY,
          ranks: [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
          links: linksOf(run76ArsenkinRows()),
        }),
      ],
      observations: rows,
    });
    expect(result.issues.some((i) => i.includes("11"))).toBe(true);
    expect(result.skipped).toEqual([]);
  });

  it("потерянное наблюдение своего движка называется строкой", () => {
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: UAE_QUERY,
          ranks: [1, 2, 5, 6, 7, 8, 9],
          links: linksOf(run76SerperRows()),
        }),
      ],
      observations: run76SerperRows(),
    });
    // Не напечатаны 3 (opensanctions.org), 4 (bloomberg.com), 10 (wikidata.org).
    expect(result.issues.join(" ")).toContain("opensanctions.org");
    expect(result.issues.length).toBe(3);
  });

  it("честная печать своих позиций проходит", () => {
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: UAE_QUERY,
          ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          links: linksOf(run76SerperRows()),
        }),
      ],
      observations: [...run76SerperRows(), ...run76ArsenkinRows()],
    });
    expect(result.issues).toEqual([]);
  });

  it("строка без своего адреса — отказ, а не молчаливый пропуск", () => {
    /*
     * Домен строки ворота берут из полосы адреса. Полосы нет — сверять нечем,
     * и ворота обязаны сказать это вслух: молчаливый пропуск сделал бы их
     * вакуумно зелёными ровно там, где печать перестала называть источник.
     */
    const slide = serpSlide({
      engine: "GOOGLE",
      query: UAE_QUERY,
      ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      links: linksOf(run76SerperRows()),
    });
    delete (slide.table as unknown as { rowAddresses?: string[] }).rowAddresses;
    const result = serpPrintMatchesObservations({
      rendererSlides: [slide],
      observations: run76SerperRows(),
    });
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.join(" | ")).toContain("без адреса");
  });

  it("регистр написания запроса ворота не смущает", () => {
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: "Viktor Rashnikov",
          ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          links: linksOf(run76SerperRows()),
        }),
      ],
      observations: run76SerperRows(),
    });
    expect(result.issues).toEqual([]);
  });

  it("дубль позиции — допустимая потеря", () => {
    // В выдаче по одному запросу две третьих строки невозможны; когда в
    // наблюдениях они всё же есть, напечатана одна из них — и это не дефект.
    const twin: SerpObservationRow = {
      ...run76SerperRows()[2]!,
      observationKey: "twin",
      url: "https://twin.example/3",
      domain: "twin.example",
      title: "Дубль третьей позиции",
      evidenceRefs: ["inventory:obs-twin"],
    };
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: UAE_QUERY,
          ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          links: linksOf(run76SerperRows()),
        }),
      ],
      observations: [...run76SerperRows(), twin],
    });
    expect(result.issues).toEqual([]);
  });

  it("маркер «ничего не найдено» строкой таблицы быть не обязан", () => {
    const marker: SerpObservationRow = {
      ...run76SerperRows()[0]!,
      observationKey: "marker",
      rank: 11,
      url: undefined,
      domain: undefined,
      title: "Ничего не найдено",
      evidenceRefs: ["inventory:obs-marker"],
    };
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: UAE_QUERY,
          ranks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          links: linksOf(run76SerperRows()),
        }),
      ],
      observations: [...run76SerperRows(), marker],
    });
    expect(result.issues).toEqual([]);
  });

  it("непозиционная таблица воротами не сверяется", () => {
    /*
     * У движка не оказалось ни одной своей позиции — таблица честно
     * вырождается в «собранную выдачу», и её номера это порядок сбора, а не
     * места в выдаче. Прочитанные как позиции, они дали бы «позиция N не
     * подтверждена» на каждой строке и уронили бы приёмку здорового прогона.
     */
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({
          engine: "GOOGLE",
          query: UAE_QUERY,
          ranks: [1, 2, 3],
          positional: false,
        }),
      ],
      observations: run76SerperRows(),
    });
    expect(result.issues).toEqual([]);
    expect(result.skipped.join(" ")).toContain("позиционных таблиц");
  });

  it("набор без источника позиции объявляет пропуск, а не молчит", () => {
    const rows = run76SerperRows().map((r) => ({ ...r, rankSource: undefined }));
    const result = serpPrintMatchesObservations({
      rendererSlides: [
        serpSlide({ engine: "GOOGLE", query: UAE_QUERY, ranks: [1, 2, 3], links: linksOf(rows) }),
      ],
      observations: rows,
    });
    expect(result.issues).toEqual([]);
    expect(result.skipped.join(" ")).toContain("rankSource");
  });
});

describe("отчёт сборки несёт объявленный пропуск", () => {
  it("пропуск виден в отчёте проверки", () => {
    const report = validateAssembly({
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
            slideId: "p09_uae_serp",
            baseSlotId: "p09_uae_serp",
            templateId: "serp-table",
            pageNumber: 1,
            isContinuation: false,
            pageKind: "canonical_base",
          },
        ],
      },
      rendererSlides: [
        serpSlide({ engine: "GOOGLE", query: UAE_QUERY, ranks: [1, 2, 3] }),
      ],
      packs: [],
      bundle: { findings: [] },
      baseObservationCountBefore: 0,
      baseObservationCountAfter: 0,
      serpObservations: run76SerperRows().map((r) => ({ ...r, rankSource: undefined })),
    } as unknown as Parameters<typeof validateAssembly>[0]);
    expect(report.checks.serpTableRanksFromOwnEngine).toBe(true);
    expect(report.skipped.join(" ")).toContain("rankSource");
  });
});
