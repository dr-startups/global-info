/**
 * Offline smoke: First36 CEO mode — no commercial, composite media only, readiness helpers.
 *
 * Run: npm run smoke:classic-first36
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { composeOrionClassicAuditDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-audit-deck-composer";
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
      displayName: "Тест",
      reportTitle: "Аудит",
      asOfDate: "2026-07-10",
    },
    globalToc: [{ title: "Резюме", sectionId: "01_executive_summary" }],
    registrySections: [
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
              narrative: "Тест",
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
              bullets: ["#1 example"],
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

  const assets: ReportAssetV1[] = [
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
  ];

  const withCommercial = composeOrionClassicAuditDeck(minimalSpec(), assets);
  const without = composeOrionClassicAuditDeck(minimalSpec(), assets, { includeCommercial: false });
  check(
    "default deck still has commercial",
    withCommercial.finalSlides.some((s) => s.sectionKey === "offer")
  );
  check(
    "first36 deck has no commercial",
    !without.finalSlides.some((s) =>
      ["offer", "product_overview", "about"].includes(s.sectionKey)
    )
  );
  check(
    "first36 keeps composite video only",
    without.finalSlides.filter((s) => s.template === "orion_golden_video_cards").length === 1
  );
  check(
    "first36 drops URL-only r10-vid",
    !without.finalSlides.some((s) => (s.assetRefs ?? []).includes("r10-vid-9"))
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
    const qa = inspectClassicOrionAuditQuality({
      deckManifest: without,
      reportSpec: minimalSpec(),
      inventory,
      outputRoot: ".",
      first36CeoMode: true,
      clientProductionFinalize: false,
    });
    check("first36 INTERNAL_PREVIEW when not finalize", qa.readiness === "INTERNAL_PREVIEW");
    check("first36 ceoReady false without finalize", qa.ceoReady === false);
    check(
      "commercial-absent check present",
      qa.checks.some((c) => c.id === "commercial-absent" && c.passed)
    );
    check("exact-36 check recorded", qa.checks.some((c) => c.id === "exact-36-pages"));
  } else {
    console.log("[SKIP] QA readiness checks — inventory artifact missing");
  }

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

main();
