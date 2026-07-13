/**
 * Offline First36 P0 rebuild from frozen inventory + assets (no DB required).
 *
 *   npx tsx scripts/rebuild-first36-p0-offline.ts
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { composeOrionFirst36CeoDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-deck-composer";
import { buildOrionClassicReportSpecFromClientContent } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import { buildOrionThemeSet } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-theme-set";
import { inspectFirst36Acceptance } from "../src/modules/digital-profile/orion-golden/classic/first36-acceptance-gate";
import type { OrionClientContent } from "../src/modules/digital-profile/orion-golden/content/orion-client-content-builder";
import type { FullEvidenceInventory } from "../src/modules/digital-profile/orion-golden/evidence/full-evidence-inventory";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import { renderOrionGoldenArtifacts } from "../src/modules/digital-profile/orion-golden/renderer/orion-golden-render-client";

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeJson(path: string, payload: unknown): void {
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

/** Offline stand-in for run-scoped merge: drop ambiguous INTL/empty search rows from KPI pool. */
function applyOfflineRunScopedFilter(inventory: FullEvidenceInventory): FullEvidenceInventory {
  const kept = inventory.items.filter((item) => {
    if (item.evidenceType !== "search_result") return true;
    const r = String(item.region ?? "").toUpperCase();
    return r === "RU" || r === "RUSSIA" || r === "RF" || r === "UAE" || r === "AE";
  });
  const searchCount = kept.filter((i) => i.evidenceType === "search_result").length;
  return {
    ...inventory,
    items: kept,
    counts: { ...inventory.counts, searchResults: searchCount },
    countsByEvidenceType: { ...inventory.countsByEvidenceType, search_result: searchCount },
    warnings: [
      ...(inventory.warnings ?? []),
      "offline-run-scoped-filter:dropped-intl-empty-search-results",
    ],
  };
}

async function main(): Promise<void> {
  process.env.ORION_GOLDEN_FORCE_LOCAL_RENDER = "1";
  process.env.ORION_FIRST36_CEO_MODE = "1";
  process.env.ORION_CLASSIC_AUDIT_MODE = "1";

  const caseId = "cmreamy2t0002o30f29urzcog";
  const caseRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-r10-orion-golden-parallel",
    "cases",
    caseId
  );
  const liveSrc = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-live-render",
    caseId,
    "1783723714287"
  );
  const outRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-p0-offline",
    String(Date.now())
  );
  mkdirSync(outRoot, { recursive: true });

  const clientContent = readJson<OrionClientContent>(
    join(caseRoot, "orion-client-content.post-review.json")
  );
  const inventory = applyOfflineRunScopedFilter(
    readJson<FullEvidenceInventory>(join(caseRoot, "full-evidence-inventory.json"))
  );
  const assets = readJson<ReportAssetV1[]>(join(liveSrc, "report-assets.json"));

  // Drop Wikipedia knowledge panels that are WRONG_SUBJECT (offline filter by title).
  const filteredAssets = assets.filter((a) => {
    if (a.kind !== "knowledge_panel") return true;
    const blob = `${a.title} ${a.caption}`;
    return !/дворянский\s+род|wrong.?subject|другого субъекта/i.test(blob);
  });

  const themeSet = buildOrionThemeSet({
    inventory,
    subjectName: clientContent.subject.displayName,
    caseId,
    clientContent,
  });

  const reportSpec = buildOrionClassicReportSpecFromClientContent({
    clientContent,
    inventory,
    assets: filteredAssets,
    inventoryCounts: inventory.counts,
    warnings: inventory.warnings,
    includeCommercial: false,
  });

  const deck = composeOrionFirst36CeoDeck(reportSpec, filteredAssets, { themeSet });

  writeJson(join(outRoot, "full-evidence-inventory.json"), inventory);
  writeJson(join(outRoot, "orion-theme-set.json"), themeSet);
  writeJson(join(outRoot, "orion-classic-report-spec.json"), reportSpec);
  writeJson(join(outRoot, "final-deck-manifest.json"), deck);
  writeJson(join(outRoot, "report-assets.json"), filteredAssets);
  writeJson(join(outRoot, "run-scoped-serp-merge.json"), {
    auditRunId: clientContent.reportRunId,
    usedRunScoped: true,
    observationCount: inventory.counts.searchResults,
    duplicateKeys: [],
    mode: "offline-filter",
    warnings: inventory.warnings,
  });

  const render = await renderOrionGoldenArtifacts({
    reportSpec: reportSpec as never,
    deckManifest: deck,
    assets: filteredAssets,
    pptxOut: join(outRoot, "rendered-client.pptx"),
    pdfOut: join(outRoot, "rendered-client.pdf"),
    pagesOut: join(outRoot, "pages-png"),
  });

  const acceptance = inspectFirst36Acceptance({
    slideCount: deck.slideCount,
    slides: deck.finalSlides.map((s) => ({
      pageNumber: s.pageNumber,
      title: s.title,
      narrative: s.narrative,
      bullets: s.bullets,
      template: s.template,
      table: s.table,
      clientTakeaway: s.clientTakeaway,
      visualAnalysis: s.visualAnalysis,
      statusBadge: s.statusBadge,
    })),
    themeSet: {
      ru: {
        linksTotal: themeSet.ru.linksTotal,
        linksAdverse: themeSet.ru.linksAdverse,
        wikipediaStatus: themeSet.ru.wikipediaStatus,
      },
      uae: {
        linksTotal: themeSet.uae.linksTotal,
        linksAdverse: themeSet.uae.linksAdverse,
        wikipediaStatus: themeSet.uae.wikipediaStatus,
      },
    },
    runScopedMerge: { usedRunScoped: true, duplicateKeys: [], observationCount: inventory.counts.searchResults },
  });
  writeJson(join(outRoot, "qa.json"), {
    passed: acceptance.passed,
    issueCount: acceptance.issues.length,
    issues: acceptance.issues,
    themeKpis: {
      ru: `${themeSet.ru.linksAdverse}/${themeSet.ru.linksTotal}`,
      uae: `${themeSet.uae.linksAdverse}/${themeSet.uae.linksTotal}`,
    },
    render,
  });

  console.log(
    JSON.stringify(
      {
        outRoot,
        slideCount: deck.slideCount,
        kpis: {
          ru: `${themeSet.ru.linksAdverse}/${themeSet.ru.linksTotal} (${themeSet.ru.linksAdversePct}%)`,
          uae: `${themeSet.uae.linksAdverse}/${themeSet.uae.linksTotal} (${themeSet.uae.linksAdversePct}%)`,
        },
        acceptance,
        pdf: join(outRoot, "rendered-client.pdf"),
        qa: join(outRoot, "qa.json"),
      },
      null,
      2
    )
  );

  if (!acceptance.passed) process.exitCode = 1;
  if (!existsSync(join(outRoot, "rendered-client.pdf"))) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
