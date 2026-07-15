/**
 * Offline smoke: approved Dow Jones / World-Check compliance visuals.
 *
 * Run: npm run smoke:classic-compliance-visuals
 */

import {
  buildApprovedComplianceVisualMeta,
  buildComplianceVisualAssets,
  parseComplianceVisualMeta,
} from "../src/modules/digital-profile/orion-golden/classic/orion-compliance-visual-assets";
import { composeOrionClassicAuditDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-audit-deck-composer";
import { composeOrionFirst36CeoDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-deck-composer";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import type { OrionRealCaseContext } from "../src/modules/digital-profile/orion-section-pipeline/real-case-data-adapter";

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
      displayName: "Test Subject",
      reportTitle: "Audit",
      asOfDate: "2026-07-10",
    },
    globalToc: [{ title: "Compliance", sectionId: "40_compliance_database_summary" }],
    registrySections: [
      {
        sectionId: "42_dow_jones_profile",
        order: 42,
        block: {
          sectionKey: "42_dow_jones_profile",
          sectionTitle: "Dow Jones",
          metrics: {},
          narrative: "Dow Jones status narrative",
          tables: [],
          evidenceCards: [],
          visualAssets: [],
          sourceRefs: [],
          qaMetadata: { sectionKey: "42_dow_jones_profile" },
          slideSpecs: [
            {
              slideKey: "dj-1",
              template: "orion_golden_prose",
              title: "Dow Jones",
              narrative: "Потенциальное совпадение требует проверки.",
              bullets: ["Статус: требует проверки"],
            },
          ],
        },
      },
      {
        sectionId: "43_world_check_profile",
        order: 43,
        block: {
          sectionKey: "43_world_check_profile",
          sectionTitle: "World-Check",
          metrics: {},
          narrative: "World-Check status",
          tables: [],
          evidenceCards: [],
          visualAssets: [],
          sourceRefs: [],
          qaMetadata: { sectionKey: "43_world_check_profile" },
          slideSpecs: [
            {
              slideKey: "wc-1",
              template: "orion_golden_prose",
              title: "World-Check",
              narrative: "Совпадений не подтверждено.",
              bullets: ["Статус: не подтверждено"],
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

async function main() {
  console.log("Smoke: classic compliance visuals (DJ/WC)\n");

  const meta = buildApprovedComplianceVisualMeta({
    provider: "DOW_JONES",
    pages: [{ pageNumber: 1, imageBase64: FAKE, caption: "DJ page 1" }],
    approvedBy: "qa",
  });
  check("approved meta has approved=true", meta.approved === true);
  check("parseComplianceVisualMeta roundtrip", parseComplianceVisualMeta({ complianceVisual: meta })?.approved === true);

  const adminStyle = buildApprovedComplianceVisualMeta({
    provider: "WORLD_CHECK",
    pages: [{ pageNumber: 1, storageKey: "cases/demo/evidence/wc1/world-check-visual-page-001.png" }],
    approvedBy: "admin",
  });
  check("admin upload meta uses storageKey", Boolean(adminStyle.renderedPages[0]?.storageKey));
  check("admin upload meta omits inline base64", !adminStyle.renderedPages[0]?.imageBase64);
  check("admin upload kind is world_check_report", adminStyle.kind === "world_check_report");
  check(
    "admin upload parse keeps storageKey",
    parseComplianceVisualMeta({ complianceVisual: adminStyle })?.renderedPages[0]?.storageKey?.includes(
      "world-check-visual-page"
    ) === true
  );

  const unapproved = parseComplianceVisualMeta({
    complianceVisual: { ...meta, approved: false },
  });
  check("unapproved meta parsed as false", unapproved?.approved === false);

  const ctx = {
    caseId: "test",
    databaseProfiles: [
      {
        id: "dj1",
        provider: "DOW_JONES",
        importMethod: "MANUAL_IMPORT",
        hitSource: null,
        matchedName: "Test",
        matchType: null,
        matchScore: null,
        reviewStatus: "MATCH_CONFIRMED",
        riskTypes: [],
        summary: "hit",
        rawMetadataSafe: { complianceVisual: meta },
        profileUrl: null,
        evidenceRefs: [],
        importedAt: new Date(),
      },
      {
        id: "wc1",
        provider: "WORLD_CHECK",
        importMethod: "MANUAL_IMPORT",
        hitSource: null,
        matchedName: "Test",
        matchType: null,
        matchScore: null,
        reviewStatus: "POTENTIAL_MATCH",
        riskTypes: [],
        summary: "maybe",
        rawMetadataSafe: {
          complianceVisual: buildApprovedComplianceVisualMeta({
            provider: "WORLD_CHECK",
            pages: [{ pageNumber: 1, imageBase64: FAKE }],
          }),
        },
        profileUrl: null,
        evidenceRefs: [],
        importedAt: new Date(),
      },
      {
        id: "dj-unapproved",
        provider: "DOW_JONES",
        importMethod: "MANUAL_IMPORT",
        hitSource: null,
        matchedName: "No",
        matchType: null,
        matchScore: null,
        reviewStatus: "NEEDS_REVIEW",
        riskTypes: [],
        summary: "x",
        rawMetadataSafe: {
          complianceVisual: { ...meta, approved: false, renderedPages: [{ pageNumber: 1, imageBase64: FAKE }] },
        },
        profileUrl: null,
        evidenceRefs: [],
        importedAt: new Date(),
      },
    ],
  } as unknown as OrionRealCaseContext;

  const built = await buildComplianceVisualAssets(ctx);
  check("builds dow_jones_visual_page", built.some((a) => a.assetRef.startsWith("dow_jones_visual_page")));
  check("builds world_check_visual_page", built.some((a) => a.assetRef.startsWith("world_check_visual_page")));
  check("skips unapproved DJ visual", !built.some((a) => a.evidenceRefs.includes("database_profile:dj-unapproved")));
  check("assets are compliance_visual_page kind", built.every((a) => a.kind === "compliance_visual_page"));

  const assets: ReportAssetV1[] = built;
  const deck = composeOrionClassicAuditDeck(minimalSpec(), assets, { includeCommercial: false });
  const djSlide = deck.finalSlides.find((s) => (s.assetRefs ?? []).some((r) => r.startsWith("dow_jones_visual")));
  const wcSlide = deck.finalSlides.find((s) => (s.assetRefs ?? []).some((r) => r.startsWith("world_check_visual")));
  check("classic deck injects DJ visual", Boolean(djSlide), `tpl=${djSlide?.template}`);
  check("classic deck injects WC visual", Boolean(wcSlide), `tpl=${wcSlide?.template}`);
  check(
    "DJ visual uses compliance template",
    djSlide?.template === "orion_golden_compliance_visual_page"
  );

  const first36 = composeOrionFirst36CeoDeck(minimalSpec(), assets);
  const p34 = first36.finalSlides.find((s) => s.slideKey === "p34_dow_jones");
  check("first36 p34 has compliance visual analysis", Boolean(p34?.visualAnalysis && p34.assetRefs?.length));
  check("first36 base-slot coverage remains 36", first36.baseSlotCoverage === 36);
  check("first36 total pages >= 36", first36.slideCount >= 36, `=${first36.slideCount}`);

  const first36NoAssets = composeOrionFirst36CeoDeck(minimalSpec(), []);
  const p34Prose = first36NoAssets.finalSlides.find((s) => s.slideKey === "p34_dow_jones");
  check(
    "first36 p34 falls back to prose without approved visual",
    p34Prose?.template !== "orion_golden_compliance_visual_page" || !p34Prose.assetRefs?.length,
    `tpl=${p34Prose?.template}`
  );

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
