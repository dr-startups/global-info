/**
 * Offline First36 compose + Python render (no DB).
 * Uses calibration client content + inventory; optional report-assets.json.
 *
 *   npx tsx scripts/offline-first36-compose-render.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildOrionClassicReportSpecFromClientContent } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import { composeOrionClassicAuditDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-audit-deck-composer";
import { inspectClassicOrionAuditQuality } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-audit-quality-inspection";
import type { OrionClientContent } from "../src/modules/digital-profile/orion-golden/content/orion-client-content-builder";
import type { FullEvidenceInventory } from "../src/modules/digital-profile/orion-golden/evidence/full-evidence-inventory";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import { renderOrionGoldenArtifacts } from "../src/modules/digital-profile/orion-golden/renderer/orion-golden-render-client";

const root = join(process.cwd(), "storage", "digital-profile", "qa-r10-7-real-subject-calibration");
const outRoot = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-first36-offline-render",
  String(Date.now())
);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

async function main() {
  mkdirSync(outRoot, { recursive: true });
  const clientContent = readJson<OrionClientContent>(join(root, "orion-client-content.post-review.json"));
  const inventory = readJson<FullEvidenceInventory>(join(root, "full-evidence-inventory.json"));

  const assetCandidates = [
    join(process.cwd(), "storage", "digital-profile", "qa-r10-orion-golden-parallel", "report-assets.json"),
    join(root, "report-assets.json"),
  ];
  let assets: ReportAssetV1[] = [];
  for (const p of assetCandidates) {
    if (existsSync(p)) {
      assets = readJson<ReportAssetV1[]>(p);
      console.log(`assets from ${p}: ${assets.length}`);
      break;
    }
  }

  const execPath = join(root, "executive-synthesis.output.json");
  const riskPath = join(root, "risk-matrix.section-derived.json");
  const executiveSynthesis = existsSync(execPath) ? readJson(execPath) : null;
  const riskMatrix = existsSync(riskPath) ? readJson(riskPath) : null;

  const reportSpec = buildOrionClassicReportSpecFromClientContent({
    clientContent,
    inventory,
    assets,
    inventoryCounts: inventory.counts,
    warnings: inventory.warnings,
    executiveSynthesis: executiveSynthesis as never,
    riskMatrix: riskMatrix as never,
    includeCommercial: false,
  });
  const deckManifest = composeOrionClassicAuditDeck(reportSpec, assets, { includeCommercial: false });

  writeFileSync(join(outRoot, "orion-classic-report-spec.json"), `${JSON.stringify(reportSpec, null, 2)}\n`);
  writeFileSync(join(outRoot, "final-deck-manifest.json"), `${JSON.stringify(deckManifest, null, 2)}\n`);
  writeFileSync(join(outRoot, "report-assets.json"), `${JSON.stringify(assets, null, 2)}\n`);

  const qa = inspectClassicOrionAuditQuality({
    deckManifest,
    reportSpec,
    inventory,
    outputRoot: outRoot,
    assets,
    first36CeoMode: true,
    clientProductionFinalize: false,
  });
  writeFileSync(join(outRoot, "classic-audit-quality-inspection.json"), `${JSON.stringify(qa, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        outRoot,
        slideCount: deckManifest.slideCount,
        commercial: deckManifest.finalSlides.filter((s) =>
          ["offer", "product_overview", "about"].includes(s.sectionKey)
        ).length,
        videoSlides: deckManifest.finalSlides.filter((s) => s.template === "orion_golden_video_cards").length,
        knowledgeSlides: deckManifest.finalSlides.filter((s) => s.template === "orion_golden_knowledge_panel")
          .length,
        qaPassed: qa.passed,
        readiness: qa.readiness,
        ceoReady: qa.ceoReady,
        issues: qa.issues.slice(0, 8),
      },
      null,
      2
    )
  );

  const render = await renderOrionGoldenArtifacts({
    reportSpec,
    deckManifest,
    assets,
    pptxOut: join(outRoot, "rendered-client.pptx"),
    pdfOut: join(outRoot, "rendered-client.pdf"),
    pagesOut: join(outRoot, "pages-png"),
  });

  console.log(
    JSON.stringify(
      {
        pdfExportMode: render.pdfExportMode,
        warnings: render.warnings,
        outRoot,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
