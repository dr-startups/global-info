/**
 * Решение аналитика — первый источник единственного предиката негативности.
 *
 * Порядок: решение аналитика → вердикт прочитанной страницы → список
 * негативных площадок → словарь. Человек, посмотревший материал и отвечающий
 * за отчёт перед банком, сильнее модели, прочитавшей страницу, и тем более
 * сильнее слов в заголовке. Тот же порядок в проекте уже принят синтезатором
 * находок и разбором поверхностей — четвёртый порядок был бы вторым ответом.
 *
 * Второго предиката при этом не появляется: у существующего ответа
 * (`resolveRowAdverse`) прибавился источник.
 */

import { describe, expect, it } from "vitest";
import { resolveRowAdverse } from "@/modules/digital-profile/serp-observation/resolve-observation-highlights";
import {
  evidenceRowAdverse,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { buildSerpFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const CLEAN_TITLE = "Anders Holmström, CEO of Nordkap Capital AB — fintech investor profile";
const DICTIONARY_TITLE =
  "Anders Holmström, founder of Nordkap Capital, faces tax-fraud probe in Stockholm";

describe("решение аналитика сильнее всего остального", () => {
  it("«нежелательный» доезжает до строки, о которой словарь молчит", () => {
    expect(
      resolveRowAdverse({
        url: "https://finansbladet.se/a",
        domain: "finansbladet.se",
        title: CLEAN_TITLE,
        analystDecision: "ADVERSE",
      })
    ).toBe(true);
  });

  it("«нейтральный» гасит словарную метку", () => {
    expect(
      resolveRowAdverse({
        url: "https://affarsposten.se/a",
        domain: "affarsposten.se",
        title: DICTIONARY_TITLE,
        analystDecision: "NEUTRAL",
      })
    ).toBe(false);
  });

  it("решение сильнее вердикта прочитанной страницы — обе стороны", () => {
    expect(
      resolveRowAdverse(
        { domain: "news.example", title: CLEAN_TITLE, analystDecision: "NEUTRAL" },
        { tone: "adverse", quoted: true, subjectMatch: "subject" }
      )
    ).toBe(false);
    expect(
      resolveRowAdverse(
        { domain: "news.example", title: CLEAN_TITLE, analystDecision: "ADVERSE" },
        { tone: "neutral", quoted: false, subjectMatch: "subject" }
      )
    ).toBe(true);
  });

  it("решение сильнее списка негативных площадок", () => {
    // Снять метку с записи санкционного реестра может только человек.
    expect(
      resolveRowAdverse({
        url: "https://opensanctions.org/entities/NK-1/",
        domain: "opensanctions.org",
        title: "Entity card",
        analystDecision: "NEUTRAL",
      })
    ).toBe(false);
    expect(
      resolveRowAdverse({
        url: "https://opensanctions.org/entities/NK-1/",
        domain: "opensanctions.org",
        title: "Entity card",
      })
    ).toBe(true);
  });

  it("материал без решения аналитика ведёт себя как раньше", () => {
    const rows = [
      { domain: "affarsposten.se", title: DICTIONARY_TITLE },
      { domain: "finansbladet.se", title: CLEAN_TITLE },
      { domain: "opensanctions.org", url: "https://opensanctions.org/e/1", title: "Entity" },
    ];
    expect(rows.map((r) => resolveRowAdverse(r))).toEqual([true, false, true]);
    expect(rows.map((r) => resolveRowAdverse({ ...r, analystDecision: null }))).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("предикат деки берёт решение из записи индекса", () => {
    expect(
      evidenceRowAdverse({ domain: "affarsposten.se", title: DICTIONARY_TITLE })
    ).toBe(true);
    expect(
      evidenceRowAdverse({
        domain: "affarsposten.se",
        title: DICTIONARY_TITLE,
        analystDecision: "NEUTRAL",
      })
    ).toBe(false);
  });
});

describe("оценка строки выдачи следует решению аналитика", () => {
  function serpRows(entries: Record<string, unknown>) {
    const refs = Object.keys(entries);
    const scoped = {
      findings: [],
      surfaceUnits: [
        { surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs },
      ],
      evidenceIndex: entries,
      scope: { regions: ["RU"] },
      metricSnapshot: {},
    } as unknown as ScopedFragmentInput;
    const page = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped).slides.filter(
      (s) => s.templateId === "serp-table"
    )[0]!;
    return (page.content.table?.rows ?? []) as string[][];
  }

  const base = {
    region: "RU",
    engine: "GOOGLE",
    rankSource: "serper",
    query: "Anders Holmström",
    queryPurpose: "subject_lookup",
    subjectDecision: "SUBJECT_MATCH",
  };

  it("помеченная аналитиком строка печатается «Нежелательный»", () => {
    const rows = serpRows({
      "ev-1": {
        ...base,
        rank: 2,
        title: CLEAN_TITLE,
        url: "https://finansbladet.se/a",
        domain: "finansbladet.se",
        analystDecision: "ADVERSE",
      },
    });
    expect(rows[0]![3]).toBe("Нежелательный");
  });

  it("снятая аналитиком метка даёт «Не проверено», а не «Нейтральный»", () => {
    // Страницу никто не открывал: слово «проверено» было бы вторым враньём.
    const rows = serpRows({
      "ev-1": {
        ...base,
        rank: 1,
        title: DICTIONARY_TITLE,
        url: "https://affarsposten.se/a",
        domain: "affarsposten.se",
        analystDecision: "NEUTRAL",
      },
    });
    expect(rows[0]![3]).toBe("Не проверено");
  });
});
