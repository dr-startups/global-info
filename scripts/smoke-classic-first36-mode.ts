/**
 * Offline smoke: First36 CEO registry composer — exact 36, no commercial, visual analysis.
 *
 * Run: npm run smoke:classic-first36
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { composeOrionFirst36CeoDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-deck-composer";
import {
  assertFirst36RegistryIntegrity,
  FIRST36_EXACT_PAGE_COUNT,
  ORION_FIRST36_REGISTRY_V1,
} from "../src/modules/digital-profile/orion-golden/classic/orion-first36-registry.v1";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import { inspectClassicOrionAuditQuality } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-audit-quality-inspection";
import { isFirst36CeoMode } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-live-serp-assets";
import type { FullEvidenceInventory } from "../src/modules/digital-profile/orion-golden/evidence/full-evidence-inventory";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

const FAKE = "A".repeat(900);

function minimalSpec(): OrionClassicAuditReportSpec {
  return {
    version: "r10-classic-orion-audit-report-spec-v1",
    subject: {
      displayName: "Тест Субъект",
      reportTitle: "Аудит",
      asOfDate: "2026-07-10",
    },
    globalToc: [
      { title: "Резюме", sectionId: "01_executive_summary" },
      { title: "Россия", sectionId: "10_ru_audit_summary" },
      { title: "ОАЭ", sectionId: "30_uae_audit_summary" },
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
      {
        sectionId: "10_ru_audit_summary",
        order: 10,
        block: {
          sectionKey: "10_ru_audit_summary",
          slideSpecs: [
            {
              slideKey: "ru-sum",
              template: "orion_golden_prose",
              title: "Россия — резюме",
              narrative: "По России найдены релевантные источники.",
            },
          ],
        },
      },
      {
        sectionId: "12_ru_serp_position_table",
        order: 12,
        block: {
          sectionKey: "12_ru_serp_position_table",
          slideSpecs: [
            {
              slideKey: "ru-serp-table",
              template: "orion_golden_search_table",
              title: "Позиции SERP",
              bullets: ["#1 example.com"],
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

function main() {
  console.log("Smoke: classic first36 CEO mode\n");

  check("isFirst36CeoMode reads env", isFirst36CeoMode({ ORION_FIRST36_CEO_MODE: "1" } as NodeJS.ProcessEnv));
  check("isFirst36CeoMode off by default", !isFirst36CeoMode({} as NodeJS.ProcessEnv));

  try {
    assertFirst36RegistryIntegrity();
    check("registry has exact 36 ordered slots", ORION_FIRST36_REGISTRY_V1.length === FIRST36_EXACT_PAGE_COUNT);
  } catch (err) {
    check("registry integrity", false, String(err));
  }

  const assets: ReportAssetV1[] = [
    {
      assetRef: "ru_provider_serp_synserp_test",
      kind: "synthetic_serp",
      title: "Яндекс — тест",
      caption: "Синтетический снимок на основе сохранённых результатов API",
      imageData: FAKE,
      evidenceRefs: ["serp_observation:1"],
      status: "ready",
    },
    {
      assetRef: "ru_image_grid",
      kind: "image_grid",
      title: "Изображения",
      caption:
        "Красной рамкой отмечены нежелательные изображения (1). rucriminal.info — домен с компрометирующим, криминальным или санкционным контекстом. Остальные кадры — нейтральная/профильная выдача; требуется сверка с субъектом.",
      imageData: FAKE,
      evidenceRefs: ["img-1"],
      status: "ready",
    },
    {
      assetRef: "ru_image_grid_2",
      kind: "image_grid",
      title: "Изображения 2",
      imageData: FAKE,
      evidenceRefs: ["img-2"],
      status: "ready",
    },
    {
      assetRef: "ru_suggestions_yandex",
      kind: "surface_panel",
      title: "Подсказки Яндекс",
      imageData: FAKE,
      evidenceRefs: ["sf-suggest-1"],
      status: "ready",
    },
    {
      assetRef: "ru_suggestions_google",
      kind: "surface_panel",
      title: "Подсказки Google",
      imageData: FAKE,
      evidenceRefs: ["sf-suggest-2"],
      status: "ready",
    },
    {
      assetRef: "ru_related_1",
      kind: "surface_panel",
      title: "Связанные 1",
      imageData: FAKE,
      evidenceRefs: ["sf-related-1"],
      status: "ready",
    },
    {
      assetRef: "ru_video_cards",
      kind: "video_cards",
      title: "Видео",
      imageData: FAKE,
      evidenceRefs: [],
      status: "ready",
    },
    {
      assetRef: "r10-vid-9",
      kind: "video_cards",
      title: "empty",
      imageUrl: "https://example.com/x",
      evidenceRefs: [],
      status: "ready",
    },
    {
      assetRef: "ru_knowledge_panel",
      kind: "knowledge_panel",
      title: "Знания",
      imageData: FAKE,
      evidenceRefs: [],
      status: "ready",
    },
  ];

  const deck = composeOrionFirst36CeoDeck(minimalSpec(), assets);
  check("first36 deck is exact 36", deck.slideCount === 36, `count=${deck.slideCount}`);
  check(
    "first36 has no commercial",
    !deck.finalSlides.some((s) =>
      ["offer", "product_overview", "about"].includes(s.sectionKey)
    )
  );
  check("page numbers are 1..36", deck.finalSlides.every((s, i) => s.pageNumber === i + 1));
  check(
    "drops URL-only r10-vid",
    !deck.finalSlides.some((s) => (s.assetRefs ?? []).includes("r10-vid-9"))
  );
  check(
    "ORION slot map: p11 suggestions yandex",
    deck.finalSlides[10]?.slideKey === "p11_ru_suggestions_yandex",
    deck.finalSlides[10]?.slideKey
  );
  check(
    "ORION slot map: p34 dow jones",
    deck.finalSlides[33]?.slideKey === "p34_dow_jones",
    deck.finalSlides[33]?.slideKey
  );
  check(
    "ORION slot map: p35-36 lexis",
    deck.finalSlides[34]?.slideKey === "p35_lexis_visual" &&
      deck.finalSlides[35]?.slideKey === "p36_lexis_visual_2"
  );
  check(
    "suggestions visual attached when asset present",
    (deck.finalSlides[10]?.assetRefs ?? []).includes("ru_suggestions_yandex"),
    String(deck.finalSlides[10]?.assetRefs)
  );

  const visualWithAnalysis = deck.finalSlides.filter((s) => s.visualAnalysis?.headlineConclusion);
  check("visual slides carry analysis sidebar", visualWithAnalysis.length >= 1, `n=${visualWithAnalysis.length}`);

  const serpSlide = deck.finalSlides.find((s) => s.slideKey === "p10_ru_serp_visual");
  check(
    "SERP slide has API-synthetic ORION prose",
    Boolean(
      serpSlide?.visualAnalysis?.whatIsVisible &&
        /API|реконструкц|синтетич/i.test(serpSlide.visualAnalysis.whatIsVisible)
    ),
    serpSlide?.visualAnalysis?.whatIsVisible?.slice(0, 80)
  );
  check(
    "SERP slide states live screenshot limitation",
    Boolean(serpSlide?.visualAnalysis?.limitations?.some((l) => /live|скриншот|API/i.test(l))),
    String(serpSlide?.visualAnalysis?.limitations?.[0])
  );

  const imageSlide = deck.finalSlides.find((s) => s.slideKey === "p14_ru_images_1");
  check(
    "image slide explains undesirable red frames",
    Boolean(
      imageSlide?.visualAnalysis?.whyItMatters &&
        /красн|нежелательн|компромет|санкц/i.test(imageSlide.visualAnalysis.whyItMatters)
    ),
    imageSlide?.visualAnalysis?.whyItMatters?.slice(0, 100)
  );
  check(
    "image slide whatIsVisible carries highlight reasons from caption",
    Boolean(
      imageSlide?.visualAnalysis?.whatIsVisible &&
        /rucriminal|компромет|нежелательн|рамк/i.test(imageSlide.visualAnalysis.whatIsVisible)
    ),
    imageSlide?.visualAnalysis?.whatIsVisible?.slice(0, 120)
  );

  const inventoryPath = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-r10-7-real-subject-calibration",
    "full-evidence-inventory.json"
  );
  if (existsSync(inventoryPath)) {
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf-8")) as FullEvidenceInventory;
    // Soften inventory media flags so minimalSpec doesn't trip suggestion/serp content gates.
    const softInventory: FullEvidenceInventory = {
      ...inventory,
      mediaAvailability: {
        ...inventory.mediaAvailability,
        suggestions: 0,
        relatedQueries: 0,
      },
      counts: {
        ...inventory.counts,
        searchResults: Math.min(inventory.counts.searchResults ?? 0, 10),
      },
    };
    const qa = inspectClassicOrionAuditQuality({
      deckManifest: deck,
      reportSpec: minimalSpec(),
      inventory: softInventory,
      outputRoot: ".",
      first36CeoMode: true,
      clientProductionFinalize: false,
      assets,
    });
    check("first36 INTERNAL_PREVIEW when not finalize", qa.readiness === "INTERNAL_PREVIEW");
    check("first36 ceoReady false without finalize", qa.ceoReady === false);
    check("exact-36 check passed", qa.checks.some((c) => c.id === "exact-36-pages" && c.passed));
    check("commercial-absent check present", qa.checks.some((c) => c.id === "commercial-absent" && c.passed));
    check("QA passed for first36 deck", qa.passed, qa.issues.slice(0, 4).join("; "));
  } else {
    console.log("[SKIP] QA readiness checks — inventory artifact missing");
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

main();
