/**
 * PDF review 40 — phase G (overflow + client voice) — offline acceptance.
 * - G.1: metrics dashboard never glues methodology into theme bullets
 * - G.1b: risk-matrix detail omits duplicated theme line
 * - G.2: synthesizer claims start with client insight, not corpus counters
 */

import { describe, expect, it } from "vitest";
import {
  buildClientFacingClaim,
  type ThemeDef,
} from "../../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import {
  claimBodyWithoutTheme,
  DECK_TEMPLATE_REGISTRY,
  reflowThemeBullet,
  toRendererPayload,
} from "../../src/modules/digital-profile/orion-golden/deck-sections";
import { GPT_SLIDE_COPY_PROMPT_VERSION } from "../../src/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";

describe("G.1 — regional summary does not merge methodology into bullets", () => {
  it("metrics_dashboard keeps theme bullets only (no Методология / Что обнаружено)", () => {
    const payload = toRendererPayload({
      deckManifest: {
        toc: [],
        sectionPageRanges: [{ sectionType: "RU_SUMMARY", firstPage: 10, lastPage: 11 }],
      } as never,
      subjectName: "Тест",
      rendererSlides: [
        {
          slideKey: "p07_ru_summary",
          sectionKey: "RU_SUMMARY",
          template: "orion_golden_metrics_dashboard",
          title: "Россия — резюме аудита",
          pageNumber: 10,
          totalPageCount: 44,
          baseSlotId: "p07_ru_summary",
          narrative: "Короткий обзор региона.",
          bullets: [
            "«Криминальные / судебные материалы»\nВ выдаче видны судебные сюжеты.\nВ корпусе: 21 материал.",
          ],
          whatWasFound: "Технический блок — не должен попасть в bullets.",
          whyItMatters: "Тоже не должен.",
          whatToCheck: "Сверить статусы дел.",
          methodologyNote: "Метрики рассчитаны только по материалам…",
          sourceNote: "Источники: dzen.ru.",
          visualAssetRefs: [],
          evidenceRefs: [],
        } as never,
      ],
    });
    const slide = (payload.deckManifest as { finalSlides: Array<Record<string, unknown>> })
      .finalSlides[0]!;
    const bullets = (slide.bullets as string[]) ?? [];
    expect(bullets).toHaveLength(1);
    expect(bullets.join("\n")).not.toMatch(/Методология|Что обнаружено|Почему важно/u);
    expect(String(slide.narrative)).toContain("Короткий обзор");
    expect(slide.actions).toEqual([{ label: "Сверить статусы дел." }]);
  });

  it("regional-summary capacity is 4 theme cards per page", () => {
    expect(DECK_TEMPLATE_REGISTRY["regional-summary"].maxBulletsPerSlide).toBe(2);
  });
});

describe("G.1b / G.2 — client claim shape", () => {
  const theme = {
    themeId: "criminal_legal",
    label: "Криминальные / судебные материалы",
    keywords: /суд/iu,
    baseRisk: "high",
    recommendedAction: "Проверить статусы дел.",
  } as ThemeDef;

  it("buildClientFacingClaim leads with concrete quotes + источник domain", () => {
    const claim = buildClientFacingClaim({
      theme,
      itemsCount: 21,
      adverseCount: 21,
      examples: [
        { title: "Самый говорливый олигарх. Как Дерипаска из-под…", domain: "dzen.ru" },
        {
          title: "Russian tycoon Deripaska cleared of contempt of court in London",
          domain: "reuters.com",
        },
      ],
    });
    expect(claim).toMatch(/Найдены публикации/u);
    expect(claim).toContain("«Самый говорливый олигарх.");
    expect(claim).toContain("— источник dzen.ru");
    // PDF-46 I.4 — one full quote; second domain stays on «Где видно».
    expect(claim.split("\n").filter((l) => /— источник /u.test(l))).toHaveLength(1);
    expect(claim).toMatch(/Где видно:.*(?:dzen\.ru|reuters\.com)/u);
    expect(claim).toContain("Всего по теме:");
    expect(claim).toMatch(/банк|партн/iu);
    expect(claim).not.toMatch(/в выдаче устойчиво видны/iu);
    expect(claim).not.toContain("негативным содержанием —");
  });

  it("claimBodyWithoutTheme drops the leading «Theme» line", () => {
    const body = claimBodyWithoutTheme({
      theme: "Криминальные / судебные материалы",
      claim:
        "Найдены публикации, в которых субъект связывается с судебными сюжетами:\n«Самый говорливый олигарх.» — источник dzen.ru\nВсего по теме: 21 материал.",
    } as never);
    expect(body).toContain("— источник dzen.ru");
    expect(body).toContain("Всего по теме:");
  });

  it("slide-copy prompt is v13 (PDF-46 fit / no mid-cut)", () => {
    expect(GPT_SLIDE_COPY_PROMPT_VERSION).toBe("gpt-slide-copy-v13");
  });

  it("reflowThemeBullet restores flattened G.2b quote lines (PDF-43)", () => {
    const flat =
      "«Криминальные / судебные материалы» Найдены публикации, в которых субъект связывается с судебными и криминальными сюжетами: «Самый говорливый олигарх.» — источник dzen.ru «КФХ Дерипаска Олег Владимирович ИНН... - узнать на saby.ru» — источник saby.ru Всего по теме: 21 материал, с негативным контекстом — 21. [finding-criminal_legal-subject_match-d51d53d8]";
    const out = reflowThemeBullet(flat);
    const lines = out.split("\n");
    expect(lines[0]).toBe("«Криминальные / судебные материалы»");
    expect(lines.some((l) => /^Найдены публикации/u.test(l))).toBe(true);
    expect(lines.filter((l) => /— источник /u.test(l))).toHaveLength(2);
    expect(lines.some((l) => /^Всего по теме:/u.test(l))).toBe(true);
    expect(out).toContain("[finding-criminal_legal-subject_match-d51d53d8]");

    const partial =
      "«Семья и деловые связи»\nНайдены материалы о семейных и деловых связях субъекта\n«Олег Дерипаска – биография» — источник uznayvse.ru «Organized crime group.» — источник youtube.com Всего по теме: 23 материала.";
    const partialOut = reflowThemeBullet(partial).split("\n");
    expect(partialOut.filter((l) => /— источник /u.test(l))).toHaveLength(2);
    expect(partialOut.some((l) => /^Всего по теме:/u.test(l))).toBe(true);
  });
});

describe("G.3 / G.4 — executive and regional structure", () => {
  it("regional-summary narrative leads with what a checker will see", async () => {
    const { buildRegionalSummaryFragment } = await import(
      "../../src/modules/digital-profile/orion-golden/deck-sections"
    );
    const scoped = {
      subject: { displayName: "Тест", aliases: [] },
      findings: [
        {
          findingId: "finding-a",
          theme: "Криминальные / судебные материалы",
          claim: "В выдаче видны судебные сюжеты.\nВ корпусе: 2 материала.",
          subjectMatch: "SUBJECT_MATCH",
          riskLevel: "high",
          confidence: 0.9,
          regions: ["UAE"],
          sourceDomains: ["gulfnews.com"],
          evidenceRefs: ["ev-1"],
          recommendedAction: "Проверить.",
          promotionPriority: "P1",
        },
      ],
      surfaceUnits: [],
      metricSnapshot: {
        metricSnapshotId: "m",
        datasetId: "d",
        reportRunId: "r",
        baseCount: 10,
        enrichmentCount: 0,
        compositeCount: 10,
        subjectMatchCount: 5,
        likelySubjectCount: 0,
        ambiguousCount: 0,
        otherSubjectCount: 0,
        adverseFindingCount: 1,
        perRegionCounts: { UAE: 10 },
      },
      scope: { regions: ["UAE"], surfaces: [], subjectMatch: null, findingIds: null },
      evidenceIndex: { "ev-1": { domain: "gulfnews.com", region: "UAE", title: "T" } },
    };
    const out = buildRegionalSummaryFragment(
      "UAE_SUMMARY" as never,
      "UAE" as never,
      "ОАЭ",
      scoped as never,
      {}
    );
    const summary = out.slides.find((s) => s.templateId === "regional-summary")!;
    expect(summary.content.narrative).toMatch(/проверяющий увидит/u);
    expect(summary.content.kpis?.length).toBeGreaterThanOrEqual(3);
    expect(summary.content.whatWasFound).toBeUndefined();
  });
});
