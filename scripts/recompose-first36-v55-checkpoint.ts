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
import {
  assertValidHighlightExplanation,
  isValidSourceDomain,
  resolveFrameTone,
  type HighlightExplanation,
} from "../src/modules/digital-profile/orion-report-spec/highlight-explanation";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

const DOMAIN_REASON_RE =
  /([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\s*[—–-]\s*([^.;]+)/gi;

function enrichFrozenImageAssets(assets: ReportAssetV1[]): ReportAssetV1[] {
  return assets.map((asset) => {
    if (asset.kind !== "image_grid") return asset;
    if (asset.highlightExplanations && asset.highlightExplanations.length > 0) return asset;
    const region = /uae/i.test(asset.assetRef) ? "ОАЭ" : "Россия";
    const caption = String(asset.caption || "");
    const explanations: HighlightExplanation[] = [];
    DOMAIN_REASON_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DOMAIN_REASON_RE.exec(caption)) !== null) {
      const domain = m[1]!.toLowerCase();
      if (!isValidSourceDomain(domain)) continue;
      const reasonTail = m[2]!.trim();
      const namesake = /однофамил|историческ|дворян|композитор|портрет/i.test(reasonTail);
      const identityStatus = namesake ? "namesake" : "likely_subject";
      const frameTone = resolveFrameTone(identityStatus, true);
      const clientReason = namesake
        ? `${domain} — исторический или однофамильный контекст; риск смешения профилей.`
        : /PEP|политич|rupep/i.test(reasonTail)
          ? `${domain} — карточка или материал с PEP/санкционным контекстом; требуется сверка идентификаторов.`
          : `${domain} — источник с нежелательным контекстом; сверить принадлежность субъекту.`;
      const ex: HighlightExplanation = {
        evidenceRef: asset.evidenceRefs[explanations.length] || `${asset.assetRef}-h${explanations.length}`,
        itemIndex: explanations.length,
        displayLabel: domain,
        sourceDomain: domain,
        riskCategory: namesake
          ? "namesake_confusion"
          : /PEP|санкц|rupep/i.test(reasonTail)
            ? "sanctions_pep"
            : "adverse_source",
        identityStatus,
        clientReason,
        confidence: namesake ? "low" : "medium",
        frameTone,
      };
      assertValidHighlightExplanation(ex);
      explanations.push(ex);
    }
    const framed = explanations.filter((x) => x.frameTone === "red" || x.frameTone === "amber");
    const redCount = framed.filter((x) => x.frameTone === "red").length;
    const amberCount = framed.filter((x) => x.frameTone === "amber").length;
    return {
      ...asset,
      caption:
        framed.length > 0
          ? `Подборка изображений (${region}): выделено кадров ${framed.length} (красных ${redCount}, янтарных ${amberCount}).`
          : `Подборка изображений из поиска по субъекту (${region}). Выделенных кадров на этой странице нет.`,
      highlightExplanations: framed,
    };
  });
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
    "qa-first36-v57-checkpoint",
    String(Date.now())
  );
  mkdirSync(outRoot, { recursive: true });

  const reportSpec = readJson<OrionClassicAuditReportSpec>(join(src, "orion-classic-report-spec.json"));
  const assets = enrichFrozenImageAssets(readJson<ReportAssetV1[]>(join(src, "report-assets.json")));
  const themeSet = readJson<OrionThemeSet>(join(src, "orion-theme-set.json"));

  const deck = composeOrionFirst36CeoDeck(reportSpec, assets, { themeSet });
  writeFileSync(join(outRoot, "final-deck-manifest.json"), `${JSON.stringify(deck, null, 2)}\n`);
  writeFileSync(join(outRoot, "orion-theme-set.json"), `${JSON.stringify(themeSet, null, 2)}\n`);
  writeFileSync(join(outRoot, "report-assets.json"), `${JSON.stringify(assets, null, 2)}\n`);
  copyFileSync(join(src, "orion-classic-report-spec.json"), join(outRoot, "orion-classic-report-spec.json"));

  const p3 = deck.finalSlides.find((s) => s.pageNumber === 3);
  const p14 = deck.finalSlides.find((s) => s.pageNumber === 14);
  console.log(
    JSON.stringify(
      {
        outRoot,
        slideCount: deck.slideCount,
        p3Action: p3?.actions?.[0]?.label,
        p14: {
          mode: p14?.visualAnalysis?.sidebarMode,
          explanations: p14?.visualAnalysis?.highlightExplanations?.map((x) => x.sourceDomain),
          headline: p14?.visualAnalysis?.headlineConclusion,
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
