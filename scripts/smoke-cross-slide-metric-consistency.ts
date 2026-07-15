/**
 * Cross-slide KPI vs slide content consistency (spec §9).
 */

import assert from "node:assert/strict";
import { inspectCrossSlideMetricConsistency } from "../src/modules/digital-profile/orion-golden/classic/cross-slide-metric-consistency";
import type { OrionThemeSet } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-theme-set";
import type { OrionGoldenDeckSlide } from "../src/modules/digital-profile/orion-golden/composer/orion-deck-composer";

function baseKpis(): OrionThemeSet["ru"] {
  const metric = (status: "MEASURED" | "NOT_COLLECTED" | "NOT_APPLICABLE", observed: number, adverse = 0) => ({
    status,
    observedCount: observed,
    adverseCount: adverse,
    neutralCount: Math.max(0, observed - adverse),
    wrongSubjectCount: 0,
    evidenceRefs: [],
    sourceReportRunIds: [],
  });
  return {
    region: "RU",
    linksTotal: 12,
    linksAdverse: 3,
    linksAdversePct: 25,
    sampleStatus: "MEASURED",
    suggestionsTotal: 0,
    suggestionsAdverse: 0,
    suggestionsExplicitAdverse: 0,
    suggestionsContextualRisk: 0,
    suggestionsIdentityRisk: 0,
    relatedTotal: 0,
    relatedAdverse: 0,
    wikipediaPresent: false,
    wikipediaStatus: "ABSENT",
    imagesTotal: 30,
    imagesAdverse: 7,
    videosTotal: 0,
    knowledgeTotal: 0,
    knowledgeAdverse: 0,
    searchVisibilityBadge: "Смешанный",
    overallRiskBadge: "Смешанный",
    dataQualityBadge: "COLLECTED",
    overallBadge: "Смешанный",
    organicMetric: metric("MEASURED", 12, 3),
    suggestionsMetric: metric("NOT_COLLECTED", 0, 0),
    relatedMetric: metric("NOT_COLLECTED", 0, 0),
    imagesMetric: metric("MEASURED", 30, 7),
  };
}

function theme(overrides: Partial<OrionThemeSet["ru"]> = {}): OrionThemeSet {
  const ru = { ...baseKpis(), ...overrides } as OrionThemeSet["ru"];
  return {
    version: "r10-12-orion-theme-set-v1",
    caseId: "c1",
    subjectName: "Тест",
    asOfDate: "2026-07-15",
    themes: [],
    ru,
    uae: { ...ru, region: "UAE", linksTotal: 8, linksAdverse: 1 },
    complianceSignals: [],
    scopeSentence: "",
    executiveNarrative: "",
    executiveBullets: [],
    nextStep: "",
  };
}

function main() {
  let pass = 0;
  const run = (name: string, fn: () => void) => {
    try {
      fn();
      console.log(`PASS ${name}`);
      pass += 1;
    } catch (e) {
      console.error(`FAIL ${name}`, e);
      process.exitCode = 1;
    }
  };

  run("flags SUGGEST_DATA_WITH_ZERO_KPI", () => {
    const issues = inspectCrossSlideMetricConsistency({
      themeSet: theme(),
      slides: [
        {
          pageNumber: 11,
          slotId: "p11_ru_suggestions_yandex",
          slideKey: "p11",
          sectionKey: "14_ru_suggestions",
          title: "Россия — подсказки Яндекс",
          bullets: ["запрос 1", "запрос 2", "запрос 3"],
        } as OrionGoldenDeckSlide,
      ],
    });
    assert.ok(issues.some((i) => i.code === "SUGGEST_DATA_WITH_ZERO_KPI"));
  });

  run("flags RELATED_DATA_WITH_ZERO_KPI", () => {
    const issues = inspectCrossSlideMetricConsistency({
      themeSet: theme(),
      slides: [
        {
          pageNumber: 20,
          slotId: "p20_ru_related_1",
          slideKey: "p20",
          sectionKey: "15_ru_related",
          title: "Россия — связанные",
          bullets: ["связанный запрос"],
        } as OrionGoldenDeckSlide,
      ],
    });
    assert.ok(issues.some((i) => i.code === "RELATED_DATA_WITH_ZERO_KPI"));
  });

  run("flags IMAGE_EVIDENCE_COUNT_MISMATCH", () => {
    const issues = inspectCrossSlideMetricConsistency({
      themeSet: theme({ imagesAdverse: 7 }),
      slides: [
        {
          pageNumber: 14,
          slotId: "p14_ru_images_1",
          slideKey: "p14",
          sectionKey: "ru_images",
          title: "Россия — изображения",
          visualAnalysis: {
            highlightExplanations: [{ clientReason: "a" }, { clientReason: "b" }],
          },
        } as OrionGoldenDeckSlide,
      ],
    });
    assert.ok(issues.some((i) => i.code === "IMAGE_EVIDENCE_COUNT_MISMATCH"));
  });

  run("clean when KPI matches content", () => {
    const issues = inspectCrossSlideMetricConsistency({
      themeSet: theme({
        suggestionsTotal: 3,
        suggestionsAdverse: 1,
        suggestionsMetric: {
          status: "MEASURED",
          observedCount: 3,
          adverseCount: 1,
          neutralCount: 2,
          wrongSubjectCount: 0,
          evidenceRefs: [],
          sourceReportRunIds: [],
        },
      }),
      slides: [
        {
          pageNumber: 11,
          slotId: "p11_ru_suggestions_yandex",
          slideKey: "p11",
          sectionKey: "14_ru_suggestions",
          title: "Россия — подсказки",
          bullets: ["a", "b", "c"],
        } as OrionGoldenDeckSlide,
      ],
    });
    assert.equal(issues.filter((i) => i.code === "SUGGEST_DATA_WITH_ZERO_KPI").length, 0);
  });

  console.log(`cross-slide-metric-consistency ${pass}/4`);
}

main();
