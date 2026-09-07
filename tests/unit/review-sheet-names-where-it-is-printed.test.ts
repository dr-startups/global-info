/**
 * Лист проверки называет страницы, а не догадывается о них.
 *
 * Аналитик принимает решение о том, что увидит клиент, поэтому у пункта должны
 * стоять настоящие номера страниц. Признаки взяты точные: у таблицы выдачи
 * `evidenceRefs` слайда — это ссылки её напечатанных строк, у снимка и сетки
 * видимые строки перечислены самим визуальным активом.
 *
 * Сводная страница региона несёт 620 ссылок-оснований: материал, попавший в
 * неё числом, на ней не напечатан, и пункта она давать не должна — иначе лист
 * пообещал бы страницу, на которой материала не найти.
 */

import { describe, expect, it } from "vitest";
import { buildReviewSheet } from "@/modules/digital-profile/services/review-sheet";

const CASE_ID = "case-1";

const OBSERVATIONS = [
  {
    url: "https://zakrasnodar.ru/art/villa.html",
    title: "На мысе Агрия в Чёрном море образовалась вилла матери судьи",
    domain: "zakrasnodar.ru",
    evidenceRefs: ["inventory:obs-villa"],
  },
  {
    url: "https://tvkrasnodar.ru/obshchestvo/interview.html",
    title: "Алексей Егоров о жизни с ОВЗ",
    domain: "tvkrasnodar.ru",
    evidenceRefs: ["inventory:obs-tv"],
  },
];

const RESOLUTION = [
  { evidenceRef: "inventory:obs-villa", decision: "AMBIGUOUS", reasonCode: "surname_query_no_anchor" },
  { evidenceRef: "inventory:obs-tv", decision: "OTHER_SUBJECT", reasonCode: "given_name_conflict" },
];

describe("лист проверки: где напечатан пункт", () => {
  it("страницы таблицы выдачи берутся у слайдов таблицы", () => {
    const sheet = buildReviewSheet({
      caseId: CASE_ID,
      slides: [
        {
          slideKey: "p09_ru_serp_table",
          baseSlotId: "p09_ru_serp_table",
          templateId: "serp-table",
          pageNumber: 15,
          title: "Россия — результаты поисковой выдачи",
          evidenceRefs: ["inventory:obs-villa"],
        },
        {
          slideKey: "p09_ru_serp_table__extra1",
          baseSlotId: "p09_ru_serp_table",
          templateId: "serp-extra-queries",
          pageNumber: 21,
          title: "Россия — найдено по дополнительным запросам",
          evidenceRefs: ["inventory:obs-villa"],
        },
      ],
      observations: OBSERVATIONS,
      subjectResolution: RESOLUTION,
    });

    const villa = sheet.items.find((i) => i.url?.includes("zakrasnodar"));
    expect(villa?.pages).toEqual([15, 21]);
    expect(villa?.places.map((p) => p.as)).toEqual([
      "строка таблицы выдачи",
      "строка таблицы выдачи",
    ]);
  });

  it("основание сводной страницы страницей не считается", () => {
    const sheet = buildReviewSheet({
      caseId: CASE_ID,
      slides: [
        {
          slideKey: "p07_ru_summary",
          baseSlotId: "p07_ru_summary",
          templateId: "regional-summary",
          pageNumber: 12,
          title: "Россия: в выдаче есть материалы повышенного внимания",
          // Сводная страница опирается на всю выдачу региона, но ни одной из
          // этих строк не печатает.
          evidenceRefs: ["inventory:obs-villa", "inventory:obs-tv"],
        },
      ],
      observations: OBSERVATIONS,
      subjectResolution: RESOLUTION,
    });
    expect(sheet.items.filter((i) => i.kind === "evidence")).toHaveLength(0);
  });

  it("снимок даёт страницу, на которой нарисован, — но не «почему выделено»", () => {
    const sheet = buildReviewSheet({
      caseId: CASE_ID,
      slides: [
        {
          slideKey: "p10_ru_serp_visual",
          baseSlotId: "p10_ru_serp_visual",
          templateId: "serp-screenshot-analysis",
          pageNumber: 25,
          title: "Россия — снимок выдачи",
          evidenceRefs: [],
          visualAssetRefs: ["ru_serp_snapshot"],
        },
        {
          // Продолжение объясняет только обведённые строки и картинки не несёт.
          slideKey: "p10_ru_serp_visual__why1",
          baseSlotId: "p10_ru_serp_visual",
          templateId: "continuation",
          pageNumber: 26,
          title: "Почему выделено",
          evidenceRefs: [],
          visualAssetRefs: [],
        },
      ],
      observations: OBSERVATIONS,
      subjectResolution: RESOLUTION,
      visualAssets: {
        p10_ru_serp_visual: [
          {
            assetRef: "ru_serp_snapshot",
            kind: "serp_screenshot",
            visibleItems: [
              {
                ref: "inventory:obs-villa",
                url: "https://zakrasnodar.ru/art/villa.html",
                domain: "zakrasnodar.ru",
                title: "На мысе Агрия в Чёрном море образовалась вилла матери судьи",
                adverse: true,
                themeTitle: "Обвинения в коррупции, злоупотреблениях и спорной недвижимости",
              },
            ],
          },
        ],
      },
    });

    const villa = sheet.items.find((i) => i.url?.includes("zakrasnodar"));
    expect(villa?.pages).toEqual([25]);
    expect(villa?.places[0]?.as).toBe("строка на снимке выдачи");
    expect(villa?.framedAs).toBe(
      "Обвинения в коррупции, злоупотреблениях и спорной недвижимости"
    );
    expect(sheet.summary.evidence.framed).toBe(1);
  });

  it("дека без имён активов на слайдах называет весь слот — как раньше", () => {
    const sheet = buildReviewSheet({
      caseId: CASE_ID,
      slides: [
        {
          slideKey: "p31_uae_knowledge",
          baseSlotId: "p31_uae_knowledge",
          templateId: "ai-overview",
          pageNumber: 56,
          title: "ОАЭ — ответы поискового ИИ",
        },
        {
          slideKey: "p31_uae_knowledge__cont1",
          baseSlotId: "p31_uae_knowledge",
          templateId: "ai-overview",
          pageNumber: 57,
          title: "ОАЭ — ответы поискового ИИ (продолжение)",
        },
      ],
      observations: OBSERVATIONS,
      subjectResolution: RESOLUTION,
      visualAssets: {
        p31_uae_knowledge: [
          { kind: "knowledge_panel", visibleItems: [{ ref: "inventory:obs-tv" }] },
        ],
      },
    });
    expect(sheet.items.find((i) => i.kind === "evidence")?.pages).toEqual([56, 57]);
  });

  it("материал, известный только снимку, получает пункт по данным снимка", () => {
    const sheet = buildReviewSheet({
      caseId: CASE_ID,
      slides: [
        {
          slideKey: "p18_ru_knowledge_1",
          baseSlotId: "p18_ru_knowledge_1",
          templateId: "wikipedia-knowledge",
          pageNumber: 36,
          title: "Панель знаний",
          evidenceRefs: [],
        },
      ],
      observations: [],
      subjectResolution: [],
      visualAssets: {
        p18_ru_knowledge_1: [
          {
            kind: "knowledge_panel",
            visibleItems: [
              { ref: "inventory:wiki-1", title: "Wikipedia (ru): статья не найдена" },
            ],
          },
        ],
      },
    });
    const item = sheet.items.find((i) => i.kind === "evidence");
    expect(item?.title).toBe("Wikipedia (ru): статья не найдена");
    expect(item?.pages).toEqual([36]);
    // Решения о принадлежности у такой строки нет — так и сказано.
    expect(item?.state).toContain("решения");
  });
});
