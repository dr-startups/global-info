/**
 * Checkpoint: recompose First36 from latest live-render inputs + local Python render.
 *
 *   npx tsx scripts/recompose-first36-v55-checkpoint.ts [sourceDir]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { composeOrionFirst36CeoDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-deck-composer";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import type { OrionThemeSet } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-theme-set";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import { renderOrionGoldenArtifacts } from "../src/modules/digital-profile/orion-golden/renderer/orion-golden-render-client";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

const defaultSrc = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-first36-live-render",
  "cmreamy2t0002o30f29urzcog",
  "1783723714287"
);

async function main() {
  process.env.ORION_GOLDEN_FORCE_LOCAL_RENDER = "1";
  process.env.ORION_FIRST36_CEO_MODE = "1";

  const src = process.argv[2]?.trim() || defaultSrc;
  const outRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-v55-checkpoint",
    String(Date.now())
  );
  mkdirSync(outRoot, { recursive: true });

  const reportSpec = readJson<OrionClassicAuditReportSpec>(join(src, "orion-classic-report-spec.json"));
  const assets = readJson<ReportAssetV1[]>(join(src, "report-assets.json"));
  const themeSet = readJson<OrionThemeSet>(join(src, "orion-theme-set.json"));

  const deck = composeOrionFirst36CeoDeck(reportSpec, assets, { themeSet });
  writeFileSync(join(outRoot, "final-deck-manifest.json"), `${JSON.stringify(deck, null, 2)}\n`);
  writeFileSync(join(outRoot, "orion-theme-set.json"), `${JSON.stringify(themeSet, null, 2)}\n`);
  copyFileSync(join(src, "report-assets.json"), join(outRoot, "report-assets.json"));
  copyFileSync(join(src, "orion-classic-report-spec.json"), join(outRoot, "orion-classic-report-spec.json"));

  const p3 = deck.finalSlides.find((s) => s.pageNumber === 3);
  const p4 = deck.finalSlides.find((s) => s.pageNumber === 4);
  const p5 = deck.finalSlides.find((s) => s.pageNumber === 5);
  console.log(
    JSON.stringify(
      {
        outRoot,
        slideCount: deck.slideCount,
        p3: {
          template: p3?.template,
          metrics: p3?.metrics,
          findings: p3?.keyFindings?.length,
          actions: p3?.actions,
        },
        p4: { template: p4?.template, findings: p4?.keyFindings?.map((f) => f.headline) },
        p5: { template: p5?.template, metrics: p5?.metrics?.slice(0, 4), badge: p5?.statusBadge },
        p7: deck.finalSlides.find((s) => s.pageNumber === 7)?.metrics?.slice(0, 3),
        p10: {
          template: deck.finalSlides.find((s) => s.pageNumber === 10)?.template,
          hasAnalysis: Boolean(deck.finalSlides.find((s) => s.pageNumber === 10)?.visualAnalysis),
        },
      },
      null,
      2
    )
  );

  const render = await renderOrionGoldenArtifacts({
    reportSpec: reportSpec as never,
    deckManifest: deck,
    assets,
    pptxOut: join(outRoot, "rendered-client.pptx"),
    pdfOut: join(outRoot, "rendered-client.pdf"),
    pagesOut: join(outRoot, "pages-png"),
  });
  console.log(JSON.stringify({ render, outRoot }, null, 2));
  if (!existsSync(join(outRoot, "rendered-client.pdf"))) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
