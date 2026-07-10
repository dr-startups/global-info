/**
 * Offline smoke: classic provider-SERP wiring (gate, slots, policy, deck embed).
 * No network / DB.
 *
 * Run: npm run smoke:classic-provider-serp-wiring
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildDefaultProviderSerpSlots,
  evaluateClassicProviderSerpGate,
  isProviderApiSerpAsset,
  PROVIDER_SERP_POLICY_VERSION,
} from "../src/modules/digital-profile/orion-golden/classic/orion-classic-provider-serp-assets";
import { CLASSIC_ORION_AUDIT_PAGE_RANGE } from "../src/modules/digital-profile/orion-golden/qa/visual-qa-inspection";
import { evaluateClientSerpPolicy } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-live-serp-assets";
import { composeOrionClassicAuditDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-audit-deck-composer";
import {
  SYNTHETIC_API_SERP_CAPTION,
  serpSyntheticAssetToReportAsset,
} from "../src/modules/digital-profile/serp-observation";
import { transliterateRuToEn } from "../src/modules/digital-profile/search-surfaces/orion-query-plan";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

/** Non-trivial fake PNG payload so deck imageData gate (>=800) passes. */
const FAKE_IMAGE_DATA = "A".repeat(900);

function main() {
  console.log("Smoke: classic provider-SERP wiring\n");

  check(
    "provider SERP policy version set",
    Boolean(PROVIDER_SERP_POLICY_VERSION) && PROVIDER_SERP_POLICY_VERSION.includes("v5")
  );
  check(
    "classic page-range accepts 36-page decks",
    CLASSIC_ORION_AUDIT_PAGE_RANGE.min <= 36 && CLASSIC_ORION_AUDIT_PAGE_RANGE.max >= 36,
    `${CLASSIC_ORION_AUDIT_PAGE_RANGE.min}-${CLASSIC_ORION_AUDIT_PAGE_RANGE.max}`
  );

  const subjectRu = "Глинка Сергей Михайлович";
  const subjectLatin = transliterateRuToEn(subjectRu);
  const slots = buildDefaultProviderSerpSlots({
    subjectName: subjectRu,
    ruQueries: ["Глинка Сергей санкции"],
    uaeQueries: ["Glinka sanctions"],
  });
  check(
    "slots include RU subject Google",
    slots.some((s) => s.region === "RU" && s.query === subjectRu)
  );
  check(
    "slots include UAE Latin subject (not Cyrillic)",
    slots.some((s) => s.region === "UAE" && s.query === subjectLatin) &&
      !slots.some((s) => s.region === "UAE" && s.query === subjectRu),
    `latin=${subjectLatin}`
  );
  check(
    "slots include UAE English risk query",
    slots.some((s) => s.region === "UAE" && s.query === "Glinka sanctions")
  );

  const dualTitle = serpSyntheticAssetToReportAsset({
    assetId: "dual_a",
    queryText: subjectRu,
    pngBase64: FAKE_IMAGE_DATA,
    observationIds: ["obs-ru"],
    engines: "DUAL",
  });
  check(
    "DUAL title prefix",
    dualTitle.title.startsWith("Поисковая выдача —"),
    dualTitle.title
  );

  const providerRu: ReportAssetV1 = {
    ...dualTitle,
    assetRef: "ru_provider_serp_a",
  };
  const providerRuRisk: ReportAssetV1 = {
    assetRef: "ru_provider_serp_a2",
    kind: "synthetic_serp",
    title: "Поисковая выдача — Глинка Сергей санкции",
    caption: SYNTHETIC_API_SERP_CAPTION,
    imageData: FAKE_IMAGE_DATA,
    evidenceRefs: ["serp_observation:obs-ru-2"],
    status: "ready",
  };
  const providerUae: ReportAssetV1 = {
    assetRef: "uae_provider_serp_b",
    kind: "synthetic_serp",
    title: `Google — ${subjectLatin}`,
    caption: SYNTHETIC_API_SERP_CAPTION,
    imageData: FAKE_IMAGE_DATA,
    evidenceRefs: ["serp_observation:obs-uae"],
    status: "ready",
  };
  const tinyBroken: ReportAssetV1 = {
    assetRef: "ru_provider_serp_tiny",
    kind: "synthetic_serp",
    title: "Google — broken",
    caption: SYNTHETIC_API_SERP_CAPTION,
    imageData: "abc",
    evidenceRefs: ["serp_observation:obs-tiny"],
    status: "ready",
  };

  check("isProviderApiSerpAsset", isProviderApiSerpAsset(providerRu));

  const gateOk = evaluateClassicProviderSerpGate({
    assets: [providerRu, providerUae],
    requireRu: true,
    requireUae: true,
  });
  check("gate allows provider RU+UAE", gateOk.allowed);

  const gateBlock = evaluateClassicProviderSerpGate({
    assets: [providerRu],
    requireRu: true,
    requireUae: true,
  });
  check("gate blocks missing UAE", !gateBlock.allowed);
  check(
    "block reason REQUIRED_VISUAL",
    gateBlock.blockedSections.some((b) => b.reason === "REQUIRED_VISUAL_ASSET_MISSING")
  );

  const policy = evaluateClientSerpPolicy([providerRu, providerUae], true);
  check("client policy passes provider assets", policy.passed, policy.blockers.join(","));

  // Deck prefers provider assets and does not invent text-only SERP slides.
  const emptyCommercial = {
    sectionKey: "x",
    title: "x",
    narrative: "",
    bullets: [] as string[],
    slideSpecs: [] as Array<{ slideKey: string; template: string; title: string }>,
  };
  const minimalSpec = {
    version: "orion-classic-audit-v1",
    caseId: "c1",
    reportRunId: "r1",
    subject: { displayName: "Test", reportTitle: "Test" },
    globalToc: [],
    registrySections: [
      {
        sectionId: "12_ru_serp_position_table",
        order: 12,
        block: {
          sectionKey: "12_ru_serp_position_table",
          title: "SERP",
          narrative: "n",
          bullets: [],
          slideSpecs: [
            {
              slideKey: "12-1",
              template: "orion_golden_search_table",
              title: "Позиции",
            },
          ],
        },
      },
      {
        sectionId: "32_uae_serp_position_table",
        order: 32,
        block: {
          sectionKey: "32_uae_serp_position_table",
          title: "UAE SERP",
          narrative: "n",
          bullets: [],
          slideSpecs: [
            {
              slideKey: "32-1",
              template: "orion_golden_search_table",
              title: "Позиции",
            },
          ],
        },
      },
    ],
    offer: emptyCommercial,
    productOverview: emptyCommercial,
    solutionDigitalProfile: emptyCommercial,
    solutionComplianceDatabases: emptyCommercial,
    solutionWikipedia: emptyCommercial,
    about: emptyCommercial,
    qaMetadata: { warnings: [] },
  } as unknown as OrionClassicAuditReportSpec;

  const deck = composeOrionClassicAuditDeck(minimalSpec, [
    providerRu,
    providerRuRisk,
    providerUae,
    tinyBroken,
  ]);
  const serpSlides = deck.finalSlides.filter(
    (s) => s.template === "orion_golden_serp_screenshot"
  );
  const assetByRef = new Map(
    [providerRu, providerRuRisk, providerUae, tinyBroken].map((a) => [a.assetRef, a])
  );
  check("deck inserts provider SERP slides", serpSlides.length >= 2, `count=${serpSlides.length}`);
  check(
    "SERP slides have assetRefs",
    serpSlides.every((s) => (s.assetRefs?.length ?? 0) > 0)
  );
  check(
    "SERP assetRefs resolve to imageData",
    serpSlides.every((s) => {
      const ref = s.assetRefs?.[0];
      const asset = ref ? assetByRef.get(ref) : undefined;
      return Boolean(asset && String(asset.imageData ?? "").length >= 800);
    })
  );
  check(
    "dedupe keeps distinct provider queries (same caption)",
    serpSlides.filter((s) => (s.assetRefs?.[0] ?? "").startsWith("ru_")).length >= 2,
    `ruSlides=${serpSlides.filter((s) => (s.assetRefs?.[0] ?? "").startsWith("ru_")).length}`
  );
  check(
    "UAE SERP screenshot slide present",
    serpSlides.some((s) => (s.assetRefs?.[0] ?? "").startsWith("uae_"))
  );
  check(
    "tiny imageData asset excluded from deck",
    !serpSlides.some((s) => s.assetRefs?.[0] === "ru_provider_serp_tiny")
  );
  check(
    "SERP caption is API synthetic",
    serpSlides.some((s) => (s.bullets ?? []).some((b) => b.includes("сохранённых результатов API")))
  );

  const emptyDeck = composeOrionClassicAuditDeck(minimalSpec, []);
  const emptySerp = emptyDeck.finalSlides.filter(
    (s) => s.template === "orion_golden_serp_screenshot"
  );
  check("no text-only SERP substitute when assets missing", emptySerp.length === 0);

  const outDir = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-classic-provider-serp-wiring"
  );
  mkdirSync(outDir, { recursive: true });
  const qa = {
    stage: "classic-provider-serp-wiring",
    passed: failures === 0,
    failures,
    caption: SYNTHETIC_API_SERP_CAPTION,
    checks: {
      gateBlocksMissingRegion: !gateBlock.allowed,
      providerPolicyOk: policy.passed,
      noTextSubstitute: emptySerp.length === 0,
      deckUsesProvider: serpSlides.length >= 2,
      uaeLatinSlot: slots.some((s) => s.region === "UAE" && s.query === subjectLatin),
      assetRefsResolveImageData: serpSlides.every((s) => {
        const ref = s.assetRefs?.[0];
        const asset = ref ? assetByRef.get(ref) : undefined;
        return Boolean(asset && String(asset.imageData ?? "").length >= 800);
      }),
    },
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "qa-result.json"), JSON.stringify(qa, null, 2), "utf-8");
  check("QA result written", true);

  console.log(failures ? `\nFAILED (${failures})` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}

main();
