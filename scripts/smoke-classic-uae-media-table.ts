/**
 * Offline smoke: UAE media composites + structured search table payload.
 *
 * Run: npm run smoke:classic-uae-media-table
 */

import { buildRegionMediaComposites } from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import { tableFromSearchBullets } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import { composeOrionClassicAuditDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-audit-deck-composer";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import type { NormalizedEvidenceV1 } from "../src/modules/digital-profile/orion-report-spec/normalized-evidence";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

const FAKE = "A".repeat(900);

function ev(partial: Partial<NormalizedEvidenceV1>): NormalizedEvidenceV1 {
  return {
    evidenceRef: partial.evidenceRef ?? "e1",
    sectionKey: partial.sectionKey ?? "uae_search_results",
    sourceKind: partial.sourceKind ?? "image_result",
    provider: partial.provider ?? "google",
    title: partial.title ?? "photo",
    ...partial,
  };
}

function minimalSpec(): OrionClassicAuditReportSpec {
  return {
    version: "r10-classic-orion-audit-report-spec-v1",
    subject: {
      displayName: "Test Subject",
      reportTitle: "Audit",
      asOfDate: "2026-07-10",
    },
    globalToc: [{ title: "RU", sectionId: "10_ru_audit_summary" }],
    registrySections: [
      {
        sectionId: "12_ru_serp_position_table",
        order: 12,
        block: {
          sectionKey: "12_ru_serp_position_table",
          sectionTitle: "SERP",
          metrics: {},
          narrative: "",
          tables: [],
          evidenceCards: [],
          visualAssets: [],
          sourceRefs: [],
          qaMetadata: { sectionKey: "12_ru_serp_position_table" },
          slideSpecs: [
            {
              slideKey: "ru-serp-table",
              template: "orion_golden_search_table",
              title: "Позиции SERP",
              bullets: ["[Н] #1 bad.example — Adverse title", "#2 ok.com — Neutral title"],
              table: {
                headers: ["Поз.", "Домен", "Заголовок", "URL", "Риск"],
                rows: [
                  ["1", "bad.example", "Adverse title", "https://bad.example", "Н"],
                  ["2", "ok.com", "Neutral title", "https://ok.com", "·"],
                ],
              },
            },
          ],
        },
      },
      {
        sectionId: "30_uae_audit_summary",
        order: 30,
        block: {
          sectionKey: "30_uae_audit_summary",
          sectionTitle: "UAE",
          metrics: {},
          narrative: "UAE summary",
          tables: [],
          evidenceCards: [],
          visualAssets: [],
          sourceRefs: [],
          qaMetadata: { sectionKey: "30_uae_audit_summary" },
          slideSpecs: [
            {
              slideKey: "uae-sum",
              template: "orion_golden_prose",
              title: "ОАЭ — резюме",
              narrative: "Тест",
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
  console.log("Smoke: UAE media composites + search table\n");

  const parsed = tableFromSearchBullets(
    ["[Н] #1 bad.example — Adverse title · https://bad.example", "#2 ok.com — Neutral title"],
    10
  );
  check("tableFromSearchBullets parses heat-grid", Boolean(parsed && parsed.rows.length === 2));
  check("parsed adverse mark", parsed?.rows[0]?.[4] === "Н");

  const uaeEvidence = [
    ev({
      evidenceRef: "uae-img-1",
      sourceKind: "image_result",
      title: "Subject Dubai",
      domain: "example.ae",
      imageUrl: "https://example.com/a.jpg",
    }),
    ev({
      evidenceRef: "uae-vid-1",
      sourceKind: "video_result",
      title: "Interview",
      domain: "youtube.com",
      snippet: "UAE interview clip",
    }),
    ev({
      evidenceRef: "uae-kp-1",
      sourceKind: "knowledge_panel",
      title: "Knowledge",
      snippet: "Businessman in UAE",
    }),
  ];

  // Without real image fetch, grid may still produce SVG PNG from placeholders
  const composites = await buildRegionMediaComposites({
    subjectName: "Test Subject",
    evidence: uaeEvidence,
    regionPrefix: "uae",
    regionLabel: "ОАЭ",
  });
  check(
    "uae_image_grid assetRef",
    composites.some((a) => a.assetRef === "uae_image_grid" && Boolean(a.imageData))
  );
  check(
    "uae_video_cards assetRef",
    composites.some((a) => a.assetRef === "uae_video_cards" && Boolean(a.imageData))
  );
  check(
    "uae_knowledge_panel assetRef",
    composites.some((a) => a.assetRef === "uae_knowledge_panel" && Boolean(a.imageData))
  );

  const assets: ReportAssetV1[] = [
    ...composites,
    {
      assetRef: "uae_provider_serp",
      kind: "synthetic_serp",
      title: "Google UAE",
      caption: "Синтетический снимок на основе сохранённых результатов API",
      imageData: FAKE,
      evidenceRefs: ["serp_observation:uae"],
      status: "ready",
    },
  ];

  const deck = composeOrionClassicAuditDeck(minimalSpec(), assets);
  const tableSlide = deck.finalSlides.find((s) => s.template === "orion_golden_search_table");
  check("deck search_table keeps structured table", Boolean(tableSlide?.table?.rows?.length));
  const uaeImage = deck.finalSlides.find(
    (s) => s.template === "orion_golden_image_grid" && (s.assetRefs ?? []).includes("uae_image_grid")
  );
  check("deck injects uae_image_grid", Boolean(uaeImage), `refs=${uaeImage?.assetRefs?.join(",")}`);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
