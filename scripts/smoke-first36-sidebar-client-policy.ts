/**
 * Regression: client-facing sidebar must never carry renderer-banned tokens.
 *
 * Reproduces the production p10 SERP slide after composite overlay (synthetic_serp
 * asset) that previously leaked "API" into whatIsVisible and crashed the Python
 * renderer sidebar QA ("p10:sidebar forbidden token in mid"). NETWORK_CALLS=0.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { composeOrionFirst36CeoDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-deck-composer";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import {
  inspectSidebarClientPolicy,
  scanSidebarText,
  SIDEBAR_CLIENT_POLICY_REGEX,
} from "../src/modules/digital-profile/orion-golden/classic/sidebar-client-policy";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";

const FAKE = "A".repeat(900);

function minimalSpec(): OrionClassicAuditReportSpec {
  return {
    version: "r10-classic-orion-audit-report-spec-v1",
    subject: { displayName: "Тест Субъект", reportTitle: "Аудит", asOfDate: "2026-07-10" },
    globalToc: [
      { title: "Резюме", sectionId: "01_executive_summary" },
      { title: "Россия", sectionId: "10_ru_audit_summary" },
    ],
    registrySections: [
      {
        sectionId: "01_executive_summary",
        order: 1,
        block: {
          sectionKey: "01_executive_summary",
          slideSpecs: [
            {
              slideKey: "executive-1",
              template: "orion_golden_executive_card",
              title: "Резюме",
              narrative: "Краткое резюме аудита субъекта для клиента.",
              bullets: ["Тема 1", "Тема 2"],
            },
          ],
        },
      },
    ],
    offer: { sectionKey: "offer", slideSpecs: [{ slideKey: "offer", template: "orion_golden_prose", title: "Оффер" }] },
    productOverview: {
      sectionKey: "productOverview",
      slideSpecs: [{ slideKey: "po", template: "orion_golden_prose", title: "Продукт" }],
    },
    solutionDigitalProfile: {
      sectionKey: "solutionDigitalProfile",
      slideSpecs: [{ slideKey: "sdp", template: "orion_golden_prose", title: "ЦП" }],
    },
    solutionComplianceDatabases: {
      sectionKey: "solutionComplianceDatabases",
      slideSpecs: [{ slideKey: "scd", template: "orion_golden_prose", title: "БД" }],
    },
    solutionWikipedia: {
      sectionKey: "solutionWikipedia",
      slideSpecs: [{ slideKey: "sw", template: "orion_golden_prose", title: "Wiki" }],
    },
    about: { sectionKey: "about", slideSpecs: [{ slideKey: "about", template: "orion_golden_prose", title: "О нас" }] },
  } as OrionClassicAuditReportSpec;
}

function productionLikeAssets(): ReportAssetV1[] {
  return [
    {
      assetRef: "ru_provider_serp_synserp_test",
      kind: "synthetic_serp",
      title: "Яндекс — поисковая выдача",
      caption: "Снимок на основе сохранённых результатов сбора",
      imageData: FAKE,
      evidenceRefs: ["serp_observation:ru-serp-1"],
      status: "ready",
    },
    {
      assetRef: "ru_suggestions_yandex",
      kind: "surface_panel",
      title: "Подсказки Яндекс",
      imageData: FAKE,
      evidenceRefs: ["serp_observation:arsenkin-yandex-1"],
      status: "ready",
      meta: {
        provider: "arsenkin",
        tool: "suggest",
        engine: "YANDEX",
        region: "RU",
        observationCount: 10,
        suggestionRows: ["Тест Субъект биография", "Тест Субъект компания"],
      },
    },
    {
      assetRef: "ru_suggestions_google",
      kind: "surface_panel",
      title: "Подсказки Google",
      imageData: FAKE,
      evidenceRefs: ["serp_observation:arsenkin-google-1"],
      status: "ready",
      meta: {
        provider: "arsenkin",
        tool: "suggest",
        engine: "GOOGLE",
        region: "RU",
        observationCount: 8,
        suggestionRows: ["Тест Субъект LinkedIn"],
      },
    },
  ];
}

describe("first36 sidebar client policy", () => {
  it("p10 SERP slide after composite overlay has no banned token", () => {
    resetArsenkinNetworkCallCount();
    const deck = composeOrionFirst36CeoDeck(minimalSpec(), productionLikeAssets());
    const serp = deck.finalSlides.find((s) => s.slideKey === "p10_ru_serp_visual");
    assert.ok(serp, "p10 SERP slide present");
    assert.equal(scanSidebarText(String(serp?.visualAnalysis?.whatIsVisible ?? "")), null);
    assert.ok(
      !/\bAPI\b|синтетич|реконструкц/i.test(String(serp?.visualAnalysis?.whatIsVisible ?? "")),
      "no synthetic/API leakage in whatIsVisible"
    );
  });

  it("whole deck passes the shared sidebar client policy", () => {
    const deck = composeOrionFirst36CeoDeck(minimalSpec(), productionLikeAssets());
    const violations = inspectSidebarClientPolicy(deck.finalSlides);
    assert.deepEqual(violations, [], JSON.stringify(violations));
  });

  it("p11-12 keep Arsenkin provenance without the banned API token", () => {
    const deck = composeOrionFirst36CeoDeck(minimalSpec(), productionLikeAssets());
    const p11 = deck.finalSlides[10];
    const p12 = deck.finalSlides.find((s) => s.slideKey === "p12_ru_suggestions_google");
    const prov11 = String(p11?.visualAnalysis?.provenanceLabel ?? "");
    const prov12 = String(p12?.visualAnalysis?.provenanceLabel ?? "");
    assert.match(prov11, /Arsenkin Tools/i);
    assert.match(prov12, /Arsenkin Tools/i);
    assert.ok(!/\bAPI\b/.test(prov11) && !/\bAPI\b/.test(prov12), "no API token in provenance");
  });

  it("policy actually catches injected banned tokens", () => {
    for (const bad of [
      "Показан ответ provider на запрос",
      "Синтетическая reconstruction экрана",
      "Данные из API поисковика",
      "Это synthetic snapshot",
      "Другой движок выдачи",
      "Показаны не live результаты",
    ]) {
      assert.ok(SIDEBAR_CLIENT_POLICY_REGEX.test(bad), `must flag: ${bad}`);
      assert.notEqual(scanSidebarText(bad), null, `scan must flag: ${bad}`);
    }
    const violations = inspectSidebarClientPolicy([
      {
        pageNumber: 10,
        visualAnalysis: {
          headlineConclusion: "Ок",
          whatIsVisible: "Ответ provider на запрос",
          whyItMatters: "",
          clientMeaning: "",
          recommendedActions: [],
        },
      },
    ]);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].page, 10);
    assert.equal(violations[0].field, "whatIsVisible");
    assert.equal(violations[0].token.toLowerCase(), "provider");
  });

  it("NETWORK_CALLS=0", () => {
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });
});
