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
    expect(DECK_TEMPLATE_REGISTRY["regional-summary"].maxBulletsPerSlide).toBe(4);
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

  it("buildClientFacingClaim leads with client insight, not «N публикаций…»", () => {
    const claim = buildClientFacingClaim({
      theme,
      itemsCount: 21,
      adverseCount: 21,
      domains: ["dzen.ru", "secrets.tbank.ru"],
      titles: ["Самый говорливый олигарх."],
    });
    expect(claim).toMatch(/банк|партн/iu);
    expect(claim).toContain("В корпусе:");
    expect(claim).toContain("Где видно:");
    expect(claim).not.toMatch(/^21 публикац/u);
    expect(claim).not.toContain("негативным содержанием —");
  });

  it("claimBodyWithoutTheme drops the leading «Theme» line", () => {
    const body = claimBodyWithoutTheme({
      theme: "Криминальные / судебные материалы",
      claim:
        "В открытой выдаче устойчиво поднимаются судебные сюжеты.\nВ корпусе: 21 материал.",
    } as never);
    expect(body).not.toMatch(/^«/u);
    expect(body).toContain("В корпусе:");
  });

  it("slide-copy prompt is v8 (client voice)", () => {
    expect(GPT_SLIDE_COPY_PROMPT_VERSION).toBe("gpt-slide-copy-v8");
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
