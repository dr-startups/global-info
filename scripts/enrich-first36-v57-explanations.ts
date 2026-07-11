/**
 * One-time / offline bridge: attach highlightExplanations to frozen image_grid assets.
 * Uses domain-aware regex (never split on bare ".") then rewrites caption to provenance-only.
 *
 *   npx tsx scripts/enrich-first36-v57-explanations.ts [report-assets.json]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import type { HighlightExplanation } from "../src/modules/digital-profile/orion-report-spec/highlight-explanation";
import {
  assertValidHighlightExplanation,
  isValidSourceDomain,
  resolveFrameTone,
} from "../src/modules/digital-profile/orion-report-spec/highlight-explanation";

const DOMAIN_REASON_RE =
  /([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\s*[—–-]\s*([^.;]+)/gi;

function migrateFromLegacyCaption(
  asset: ReportAssetV1,
  regionLabel: string
): ReportAssetV1 {
  if (asset.kind !== "image_grid") return asset;
  if (asset.highlightExplanations && asset.highlightExplanations.length > 0) {
    return {
      ...asset,
      caption:
        asset.caption && /Подборка изображений|выделено кадров/i.test(asset.caption)
          ? asset.caption
          : `Подборка изображений (${regionLabel}).`,
    };
  }

  const caption = String(asset.caption || "");
  const explanations: HighlightExplanation[] = [];
  let m: RegExpExecArray | null;
  DOMAIN_REASON_RE.lastIndex = 0;
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
  const newCaption =
    framed.length > 0
      ? `Подборка изображений (${regionLabel}): выделено кадров ${framed.length} (красных ${redCount}, янтарных ${amberCount}).`
      : `Подборка изображений из поиска по субъекту (${regionLabel}). Выделенных кадров на этой странице нет.`;

  return {
    ...asset,
    caption: newCaption,
    highlightExplanations: framed,
  };
}

function main() {
  const src =
    process.argv[2]?.trim() ||
    join(
      process.cwd(),
      "storage/digital-profile/qa-first36-live-render/cmreamy2t0002o30f29urzcog/1783723714287/report-assets.json"
    );
  const assets = JSON.parse(readFileSync(src, "utf-8")) as ReportAssetV1[];
  const out = assets.map((a) => {
    const region = /uae/i.test(a.assetRef) ? "ОАЭ" : "Россия";
    return migrateFromLegacyCaption(a, region);
  });
  const outPath = src.replace(/report-assets\.json$/i, "report-assets.v57.json");
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  const withEx = out.filter((a) => (a.highlightExplanations?.length ?? 0) > 0);
  console.log(
    JSON.stringify(
      {
        src,
        outPath,
        imageGrids: out.filter((a) => a.kind === "image_grid").length,
        withExplanations: withEx.length,
        sample: withEx[0]?.highlightExplanations?.slice(0, 2),
      },
      null,
      2
    )
  );
}

main();
