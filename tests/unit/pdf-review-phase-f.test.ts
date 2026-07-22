/**
 * PDF review 38 — phase F (hierarchy + summary capacity + GPT schema).
 * - F.1: theme claims are multi-line (theme / stats / sources / examples)
 * - F.2: regional-summary paginates at 5 bullets so themes are not dropped
 * - F.3: parseFragmentCopyResponse tolerates null / empty arrays (report 38)
 */

import { describe, expect, it } from "vitest";
import {
  DECK_TEMPLATE_REGISTRY,
  localizedThemedClaim,
  parseFragmentCopyResponse,
  structureThemeClaimText,
  themedClaim,
  withContinuations,
} from "../../src/modules/digital-profile/orion-golden/deck-sections";
import { getClientTextFieldBudgets } from "../../src/modules/digital-profile/orion-golden/client/load-client-text-contract";

const FINDING = {
  findingId: "finding-crime-subject_match-aaaa1111",
  theme: "Криминальные / судебные материалы",
      claim:
        "Найдены публикации, в которых субъект связывается с судебными сюжетами:\n«Биография предпринимателя» — источник dzen.ru\n«Личная жизнь» — источник secrets.tbank.ru\nВсего по теме: 21 материал, с негативным контекстом — 21.",
  subjectMatch: "SUBJECT_MATCH",
  riskLevel: "high",
  confidence: 0.9,
  regions: ["RU"],
  sourceDomains: ["dzen.ru", "secrets.tbank.ru"],
  evidenceRefs: ["ev-1"],
  recommendedAction: "Проверить первоисточники.",
  promotionPriority: "P1",
};

describe("F.1 — structured theme claim hierarchy", () => {
  it("structureThemeClaimText splits a one-line claim into scan lines", () => {
    const out = structureThemeClaimText(
      "«Деловой профиль» — 3 публикации, негативного содержания не зафиксировано. Источники: gulfnews.com. Примеры заголовков: Business profile"
    );
    expect(out.split("\n")).toEqual([
      "«Деловой профиль»",
      "3 публикации, негативного содержания не зафиксировано.",
      "Источники: gulfnews.com.",
      "Примеры: Business profile",
    ]);
  });

  it("themedClaim puts the theme on its own line above the claim body", () => {
    const out = themedClaim(FINDING as never);
    const lines = out.split("\n");
    expect(lines[0]).toBe("«Криминальные / судебные материалы»");
    expect(lines.some((l) => /— источник /u.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith("Всего по теме:"))).toBe(true);
  });

  it("bullet field budget fits a structured multi-line theme claim", () => {
    expect(getClientTextFieldBudgets().bullet).toBeGreaterThanOrEqual(520);
  });
});

describe("F.2 — regional summary does not silently drop themes", () => {
  it("regional-summary paginates at 4 bullets per slide (G.1 capacity)", () => {
    expect(DECK_TEMPLATE_REGISTRY["regional-summary"].maxBulletsPerSlide).toBe(4);
  });

  it("withContinuations carries overflow themes to a continuation slide", () => {
    const bullets = Array.from({ length: 8 }, (_, i) => `«Тема ${i + 1}»\n${i + 1} публикаций.`);
    const slides = withContinuations(
      {
        slideId: "p07_ru_summary",
        templateId: "regional-summary",
        title: "Россия — резюме",
        content: { bullets, narrative: "Обзор." },
      } as never,
      "regional-summary"
    );
    expect(slides).toHaveLength(2);
    expect(slides[0]!.content.bullets).toHaveLength(4);
    expect(slides[1]!.content.bullets).toHaveLength(4);
    expect(slides[1]!.isContinuation).toBe(true);
  });

  it("localizedThemedClaim keeps multi-line sources for cross-regional findings", () => {
    const scoped = {
      subject: { displayName: "Тест", aliases: [] },
      findings: [],
      surfaceUnits: [],
      metricSnapshot: {
        metricSnapshotId: "m",
        datasetId: "d",
        reportRunId: "r",
        baseCount: 1,
        enrichmentCount: 0,
        compositeCount: 1,
        subjectMatchCount: 1,
        likelySubjectCount: 0,
        ambiguousCount: 0,
        otherSubjectCount: 0,
        adverseFindingCount: 0,
        perRegionCounts: { RU: 1, UAE: 1 },
      },
      scope: { regions: ["UAE"], surfaces: [], subjectMatch: null, findingIds: null },
      evidenceIndex: {
        "ev-ru": { domain: "dzen.ru", region: "RU", title: "RU title" },
        "ev-uae": { domain: "gulfnews.com", region: "UAE", title: "UAE title" },
      },
    };
    const finding = {
      ...FINDING,
      regions: ["RU", "UAE"],
      evidenceRefs: ["ev-ru", "ev-uae"],
      claim:
        "Найдены публикации по теме:\n«RU title» — источник dzen.ru\n«UAE title» — источник gulfnews.com\nВсего по теме: 21 материал, с негативным контекстом — 21.",
    };
    const out = localizedThemedClaim(finding as never, scoped as never);
    expect(out).toContain("\n");
    expect(out).toContain("— источник gulfnews.com");
    expect(out).not.toContain("dzen.ru");
  });
});

describe("F.3 — GPT stage-2 lenient schema", () => {
  it("parseFragmentCopyResponse accepts null / empty arrays without failing the payload", () => {
    const parsed = parseFragmentCopyResponse({
      slides: [
        {
          slideId: "p07_ru_summary",
          narrative: "Переписанный обзор региона.",
          bullets: [],
          whatWasFound: null,
          whyItMatters: "",
        },
        { slideId: "p08", narrative: null, bullets: ["", null, "«Тема»\n1 публикация."] },
        { notASlide: true },
      ],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.droppedSlides).toBe(1);
    expect(parsed!.slides).toHaveLength(2);
    expect(parsed!.slides[0]!.narrative).toBe("Переписанный обзор региона.");
    expect(parsed!.slides[0]!.bullets).toBeUndefined();
    expect(parsed!.slides[1]!.bullets).toEqual(["«Тема»\n1 публикация."]);
  });

  it("parseFragmentCopyResponse returns null only for unrecognizable payloads", () => {
    expect(parseFragmentCopyResponse({ totally: "wrong" })).toBeNull();
  });
});
