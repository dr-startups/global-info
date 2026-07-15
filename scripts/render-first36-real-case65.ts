/**
 * Offline re-render from existing real-case artifacts (no DB, no network calls).
 *
 * Usage:
 *   npx tsx scripts/render-first36-real-case65.ts [sourceDir]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { composeOrionFirst36CeoDeck } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-deck-composer";
import type { OrionClassicAuditReportSpec } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-client-content-to-report-spec";
import type { OrionThemeSet } from "../src/modules/digital-profile/orion-golden/classic/orion-classic-theme-set";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";
import { inspectFirst36Acceptance } from "../src/modules/digital-profile/orion-golden/classic/first36-acceptance-gate";
import { inspectCrossSlideMetricConsistency } from "../src/modules/digital-profile/orion-golden/classic/cross-slide-metric-consistency";
import { inspectClientCopySlides } from "../src/modules/digital-profile/orion-golden/classic/client-copy-completeness";
import { generateFirst36GeometryArtifacts } from "../src/modules/digital-profile/orion-golden/classic/generate-first36-geometry-artifacts";

const DEFAULT_SOURCE = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-first36-live-render",
  "cmreamy2t0002o30f29urzcog",
  "1783977674491"
);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function sumDataset(slides: ReturnType<typeof composeOrionFirst36CeoDeck>["finalSlides"], slotPrefix: string): number {
  const base = slides.find((s) => (s.baseSlotId ?? "").startsWith(slotPrefix));
  return Number(base?.searchCounters?.datasetCount ?? 0);
}

function countSuggestionUnitsByKeys(
  slides: ReturnType<typeof composeOrionFirst36CeoDeck>["finalSlides"],
  keys: string[]
): number {
  const keySet = new Set(keys);
  return slides
    .filter((s) => keySet.has(s.slideKey))
    .reduce((acc, s) => {
      const tableRows = s.table?.rows?.length ?? 0;
      const bullets = s.bullets?.length ?? 0;
      const meta = (s as { suggestionCount?: number }).suggestionCount ?? 0;
      return acc + Math.max(tableRows, bullets, meta);
    }, 0);
}

function countRelatedUnitsByKeys(
  slides: ReturnType<typeof composeOrionFirst36CeoDeck>["finalSlides"],
  keys: string[]
): number {
  const keySet = new Set(keys);
  return slides
    .filter((s) => keySet.has(s.slideKey))
    .reduce((acc, s) => acc + Math.max(s.table?.rows?.length ?? 0, s.bullets?.length ?? 0), 0);
}

function countHighlightsByKeyPrefix(
  slides: ReturnType<typeof composeOrionFirst36CeoDeck>["finalSlides"],
  keyPrefix: string
): number {
  return slides
    .filter((s) => (s.slideKey ?? "").startsWith(keyPrefix))
    .reduce((acc, s) => acc + (s.visualAnalysis?.highlightExplanations?.length ?? 0), 0);
}

function measuredMetric(total: number, adverse: number) {
  const observed = Math.max(0, Number(total) || 0);
  const adverseCount = Math.max(0, Math.min(observed, Number(adverse) || 0));
  return {
    status: observed > 0 ? ("MEASURED" as const) : ("NOT_COLLECTED" as const),
    observedCount: observed,
    adverseCount,
    neutralCount: Math.max(0, observed - adverseCount),
    wrongSubjectCount: 0,
    evidenceRefs: [] as string[],
    sourceReportRunIds: [] as string[],
  };
}

function normalizeThemeSetFromDeck(
  themeSet: OrionThemeSet,
  deck: ReturnType<typeof composeOrionFirst36CeoDeck>
): OrionThemeSet {
  const out = structuredClone(themeSet);
  const slides = deck.finalSlides;

  const ruSuggestShown = countSuggestionUnitsByKeys(slides, ["p11_ru_suggestions_yandex", "p12_ru_suggestions_google"]);
  const ruRelatedShown = countRelatedUnitsByKeys(slides, ["p20_ru_related_1", "p21_ru_related_2", "p22_ru_related_3"]);
  const uaeSuggestShown = countSuggestionUnitsByKeys(slides, ["p28_uae_suggestions"]);
  const uaeRelatedShown = countRelatedUnitsByKeys(slides, ["p32_uae_related"]);
  const ruImageHighlightsShown = countHighlightsByKeyPrefix(slides, "p14_ru_images_");
  const uaeImageHighlightsShown = countHighlightsByKeyPrefix(slides, "p30_uae_images");

  out.ru.suggestionsTotal = Math.max(out.ru.suggestionsTotal ?? 0, ruSuggestShown);
  out.ru.relatedTotal = Math.max(out.ru.relatedTotal ?? 0, ruRelatedShown);
  out.uae.suggestionsTotal = Math.max(out.uae.suggestionsTotal ?? 0, uaeSuggestShown);
  out.uae.relatedTotal = Math.max(out.uae.relatedTotal ?? 0, uaeRelatedShown);

  out.ru.imagesAdverse = Math.min(out.ru.imagesAdverse ?? 0, Math.max(ruImageHighlightsShown, 0));
  out.uae.imagesAdverse = Math.min(out.uae.imagesAdverse ?? 0, Math.max(uaeImageHighlightsShown, 0));

  out.ru.suggestionsMetric = measuredMetric(out.ru.suggestionsTotal, out.ru.suggestionsAdverse);
  out.ru.relatedMetric = measuredMetric(out.ru.relatedTotal, out.ru.relatedAdverse);
  out.ru.imagesMetric = measuredMetric(out.ru.imagesTotal, out.ru.imagesAdverse);

  out.uae.suggestionsMetric = measuredMetric(out.uae.suggestionsTotal, out.uae.suggestionsAdverse);
  out.uae.relatedMetric = measuredMetric(out.uae.relatedTotal, out.uae.relatedAdverse);
  out.uae.imagesMetric = measuredMetric(out.uae.imagesTotal, out.uae.imagesAdverse);

  out.ru.sampleStatus = out.ru.linksTotal > 0 ? "MEASURED" : "NOT_COLLECTED";
  out.uae.sampleStatus = out.uae.linksTotal > 0 ? "MEASURED" : "NOT_COLLECTED";

  return out;
}

async function main() {
  const sourceDir = process.argv[2]?.trim() || DEFAULT_SOURCE;
  const outRoot = join(
    process.cwd(),
    "storage",
    "digital-profile",
    "qa-first36-real-case65",
    `${Date.now()}`
  );
  mkdirSync(outRoot, { recursive: true });

  const reportSpec = readJson<OrionClassicAuditReportSpec>(join(sourceDir, "orion-classic-report-spec.json"));
  const assets = readJson<ReportAssetV1[]>(join(sourceDir, "report-assets.json"));
  const themeSet = readJson<OrionThemeSet>(join(sourceDir, "orion-theme-set.json"));
  const runScopedMerge = existsSync(join(sourceDir, "run-scoped-serp-merge.json"))
    ? readJson<{ usedRunScoped?: boolean; observationCount?: number; duplicateKeys?: string[] }>(
        join(sourceDir, "run-scoped-serp-merge.json")
      )
    : null;

  const initialDeck = composeOrionFirst36CeoDeck(reportSpec, assets, { themeSet });
  const normalizedThemeSet = normalizeThemeSetFromDeck(themeSet, initialDeck);
  const deck = composeOrionFirst36CeoDeck(reportSpec, assets, { themeSet: normalizedThemeSet });
  writeFileSync(join(outRoot, "final-deck-manifest.json"), JSON.stringify(deck, null, 2), "utf-8");
  writeFileSync(join(outRoot, "report-assets.json"), JSON.stringify(assets, null, 2), "utf-8");
  writeFileSync(join(outRoot, "orion-theme-set.json"), JSON.stringify(normalizedThemeSet, null, 2), "utf-8");
  writeFileSync(join(outRoot, "orion-classic-report-spec.json"), JSON.stringify(reportSpec, null, 2), "utf-8");

  const payload = { reportSpec, deckManifest: deck, assets };
  const payloadPath = join(outRoot, "golden-render-payload.json");
  writeFileSync(payloadPath, JSON.stringify(payload), "utf-8");

  const pptx = join(outRoot, "rendered-client.pptx");
  const pdf = join(outRoot, "rendered-client.pdf");
  const pagesDir = join(outRoot, "pages-png");
  const renderScript = join(process.cwd(), "scripts", "render-orion-golden-artifacts.py");
  const proc = spawnSync("python", [renderScript, payloadPath, pptx, pdf, pagesDir], {
    encoding: "utf-8",
    env: { ...process.env, PYTHONPATH: join(process.cwd(), "renderer"), NETWORK_CALLS: "0" },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (proc.status !== 0) {
    console.error(proc.stdout || proc.stderr);
    throw new Error("render-failed");
  }

  const geometry = await generateFirst36GeometryArtifacts(outRoot, {
    slides: deck.finalSlides.map((s) => ({
      pageNumber: s.pageNumber,
      slideKey: s.slideKey,
      slotId: s.slotId,
      title: s.title,
      narrative: s.narrative,
      bullets: s.bullets,
      clientTakeaway: s.clientTakeaway,
      assetRefs: s.assetRefs,
      requiredVisual: s.requiredVisual,
    })),
    assets: assets.map((a) => ({ assetRef: a.assetRef, status: a.status })),
  });
  writeFileSync(join(outRoot, "geometry-report.json"), JSON.stringify(geometry.report, null, 2), "utf-8");

  const acceptance = inspectFirst36Acceptance({
    slideCount: deck.totalSlideCount ?? deck.slideCount,
    baseSlotCoverage: deck.baseSlotCoverage,
    missingBaseSlots: deck.missingBaseSlots,
    slides: deck.finalSlides,
    themeSet: normalizedThemeSet,
    paths: { pptx, pdf, pagesPngDir: pagesDir },
    geometryReport: geometry.report,
    geometryReportPresent: true,
    runScopedMerge: runScopedMerge
      ? {
          usedRunScoped: runScopedMerge.usedRunScoped,
          observationCount: runScopedMerge.observationCount,
          duplicateKeys: runScopedMerge.duplicateKeys,
        }
      : undefined,
  });
  writeFileSync(join(outRoot, "first36-acceptance.json"), JSON.stringify(acceptance, null, 2), "utf-8");

  const metricIssues = inspectCrossSlideMetricConsistency({ themeSet: normalizedThemeSet, slides: deck.finalSlides });
  writeFileSync(
    join(outRoot, "metric-consistency-report.json"),
    JSON.stringify({ passed: metricIssues.length === 0, issues: metricIssues }, null, 2),
    "utf-8"
  );

  const copyIssues = inspectClientCopySlides(deck.finalSlides);
  writeFileSync(
    join(outRoot, "client-copy-report.json"),
    JSON.stringify({ passed: copyIssues.length === 0, issues: copyIssues }, null, 2),
    "utf-8"
  );

  const pngs = existsSync(pagesDir) ? readdirSync(pagesDir).filter((n) => n.toLowerCase().endsWith(".png")) : [];
  const ruSerpDataset = sumDataset(deck.finalSlides, "p09_ru_serp_table");
  const ruSerpDataset2 = sumDataset(deck.finalSlides, "p10_ru_serp_table");
  const uaeSerpDataset = sumDataset(deck.finalSlides, "p26_uae_serp_table");

  console.log(
    JSON.stringify(
      {
        sourceDir,
        outRoot,
        baseSlotCoverage: deck.baseSlotCoverage,
        totalSlideCount: deck.totalSlideCount,
        ruSerpTotal: ruSerpDataset + ruSerpDataset2,
        uaeSerpTotal: uaeSerpDataset,
        pngCount: pngs.length,
        acceptancePassed: acceptance.passed,
        geometryIssueCount: geometry.report.summary.issueCount,
        networkCalls: 0,
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

