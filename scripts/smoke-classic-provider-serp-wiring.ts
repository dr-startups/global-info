/**
 * Offline smoke: classic provider-SERP wiring (gate, slots, policy).
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
} from "../src/modules/digital-profile/orion-golden/classic/orion-classic-provider-serp-assets";
import { evaluateClientSerpPolicy } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-live-serp-assets";
import { composeOrionClassicAuditDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-audit-deck-composer";
import { SYNTHETIC_API_SERP_CAPTION } from "../src/modules/digital-profile/serp-observation";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

function main() {
  console.log("Smoke: classic provider-SERP wiring\n");

  const slots = buildDefaultProviderSerpSlots({
    subjectName: "Глинка Сергей Михайлович",
    ruQueries: ["Глинка Сергей санкции"],
    uaeQueries: ["Glinka sanctions"],
  });
  check(
    "slots include RU subject Google",
    slots.some((s) => s.region === "RU" && s.query === "Глинка Сергей Михайлович")
  );
  check(
    "slots include UAE subject Google",
    slots.some((s) => s.region === "UAE" && s.query === "Глинка Сергей Михайлович")
  );

  const providerRu: ReportAssetV1 = {
    assetRef: "ru_provider_serp_google_a",
    kind: "synthetic_serp",
    title: "Google — Глинка Сергей Михайлович",
    caption: SYNTHETIC_API_SERP_CAPTION,
    imageData: "abc",
    evidenceRefs: ["serp_observation:obs-ru"],
    status: "ready",
  };
  const providerUae: ReportAssetV1 = {
    assetRef: "uae_provider_serp_google_b",
    kind: "synthetic_serp",
    title: "Google — Глинка Сергей Михайлович",
    caption: SYNTHETIC_API_SERP_CAPTION,
    imageData: "abc",
    evidenceRefs: ["serp_observation:obs-uae"],
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
    ],
    offer: emptyCommercial,
    productOverview: emptyCommercial,
    solutionDigitalProfile: emptyCommercial,
    solutionComplianceDatabases: emptyCommercial,
    solutionWikipedia: emptyCommercial,
    about: emptyCommercial,
    qaMetadata: { warnings: [] },
  } as unknown as OrionClassicAuditReportSpec;

  const deck = composeOrionClassicAuditDeck(minimalSpec, [providerRu, providerUae]);
  const serpSlides = deck.finalSlides.filter(
    (s) => s.template === "orion_golden_serp_screenshot"
  );
  check("deck inserts provider SERP slides", serpSlides.length >= 1);
  check(
    "SERP slides have assetRefs",
    serpSlides.every((s) => (s.assetRefs?.length ?? 0) > 0)
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
      deckUsesProvider: serpSlides.length >= 1,
    },
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(outDir, "qa-result.json"), JSON.stringify(qa, null, 2), "utf-8");
  check("QA result written", true);

  console.log(failures ? `\nFAILED (${failures})` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
}

main();
