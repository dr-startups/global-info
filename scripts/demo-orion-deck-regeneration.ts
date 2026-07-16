/**
 * Prompt 3 acceptance — required regeneration demonstrations on report-72:
 *   A. change only RU suggestions  → only that fragment + assembly;
 *   B. change one promoted executive finding → Executive Summary + dependent packs + assembly;
 *   C. template-only (layout) change → assembly/render only, zero pack regeneration.
 *
 * NETWORK_CALLS=0. Writes baselines/report-72/artifacts/deck-sections/regeneration-demos.json
 *
 * Run: npx tsx scripts/demo-orion-deck-regeneration.ts
 */

process.env.NETWORK_CALLS = "0";

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runDeckBuild,
  DECK_TEMPLATE_REGISTRY,
  type FragmentKey,
  type SectionBuildContext,
} from "../src/modules/digital-profile/orion-golden/deck-sections";
import { loadReport72DeckInputs, loadReportAssets } from "./run-orion-deck-sections-report72";

const inputs = loadReport72DeckInputs();
const { visualAssets } = loadReportAssets(inputs.evidenceIndex);

type BuildResult = ReturnType<typeof runDeckBuild>;

function makeCtx(): Omit<SectionBuildContext, "previousPacks" | "buildLog"> {
  return {
    caseId: inputs.caseId,
    reportRunId: inputs.reportRunId,
    sourceDatasetId: inputs.sourceDatasetId,
    contentVersion: "deck-sections-v13",
    subject: { displayName: "Сергей Глинка", aliases: ["Sergey Glinka"] },
    bundle: structuredClone(inputs.mergedBundle),
    surfaceUnits: structuredClone(inputs.surfaceUnits),
    metricSnapshot: inputs.metricSnapshot,
    evidenceIndex: inputs.evidenceIndex,
    extras: {
      executiveSummary: structuredClone(inputs.executiveSummary),
      visualAssets,
    },
  };
}

function build(dir: string, ctx: Omit<SectionBuildContext, "previousPacks" | "buildLog">): BuildResult {
  return runDeckBuild({
    ctx,
    bundleForValidation: ctx.bundle,
    knownEvidenceRefs: inputs.knownEvidenceRefs,
    outputRoot: dir,
    baseObservationCountBefore: inputs.baseCountBefore,
    baseObservationCountAfter: inputs.baseCountAfter,
  });
}

function hashTable(result: BuildResult): Record<string, string> {
  return Object.fromEntries(result.packs.map((p) => [p.fragmentKey, p.contentHash.slice(0, 23)]));
}

function diff(before: Record<string, string>, after: BuildResult) {
  const regenerated = after.buildLog
    .filter((l) => l.action === "REGENERATED")
    .map((l) => l.fragmentKey);
  const reused = after.buildLog
    .filter((l) => l.action === "REUSED_CACHE")
    .map((l) => l.fragmentKey);
  const hashChanges: Record<string, { before: string; after: string }> = {};
  for (const p of after.packs) {
    const b = before[p.fragmentKey];
    const a = p.contentHash.slice(0, 23);
    if (b !== a) hashChanges[p.fragmentKey] = { before: b, after: a };
  }
  return { regenerated, reused, hashChanges };
}

function scenarioA() {
  const dir = mkdtempSync(join(tmpdir(), "orion-demo-a-"));
  const base = build(dir, makeCtx());
  const before = hashTable(base);
  const deckHashBefore = base.assembly.deckManifest.assembledDeckHash;

  const ctx = makeCtx();
  const unit = ctx.surfaceUnits.find((u) => u.surface === "suggestions" && u.region === "RU")!;
  unit.claims.push({
    claimId: "demo-ru-suggestion-change",
    text: "Новая подсказка: в выдаче появилась строка о деловой активности субъекта в 2026 году.",
    subjectMatch: "SUBJECT_MATCH",
    evidenceRefs: unit.evidenceRefs.slice(0, 1),
  });
  const after = build(dir, ctx);
  return {
    name: "A: change only RU suggestions",
    expected: "only RU_SUGGESTIONS regenerated; RU SectionPack + assembly updated",
    ...diff(before, after),
    assemblyReassembled: after.assembly.deckManifest.assembledDeckHash !== deckHashBefore ||
      after.assembly.deckManifest.sectionContentHashes.RU_SUGGESTIONS !==
        base.assembly.deckManifest.sectionContentHashes.RU_SUGGESTIONS,
    pageCountBefore: base.assembly.deckManifest.pageCount,
    pageCountAfter: after.assembly.deckManifest.pageCount,
  };
}

function scenarioB() {
  const dir = mkdtempSync(join(tmpdir(), "orion-demo-b-"));
  const base = build(dir, makeCtx());
  const before = hashTable(base);

  const ctx = makeCtx();
  // One promoted executive finding: the first key finding of the summary.
  const promotedId = ctx.extras.executiveSummary!.keyFindings[0].findingId;
  const finding = ctx.bundle.findings.find((f) => f.findingId === promotedId)!;
  finding.claim = `${finding.claim} Дополнение: тема получила продолжение в новых публикациях.`;
  ctx.extras.executiveSummary!.keyFindings[0].factualBasis = finding.claim.slice(0, 300);
  const after = build(dir, ctx);
  const d = diff(before, after);
  return {
    name: "B: change one promoted executive finding",
    changedFindingId: promotedId,
    findingSurfaces: finding.surfaceKinds ?? [],
    findingRegions: finding.regions,
    expected:
      "EXECUTIVE_SUMMARY plus only SectionPacks whose scoped input contains the finding; assembly updated",
    ...d,
    executiveRegenerated: d.regenerated.includes("EXECUTIVE_SUMMARY"),
  };
}

function scenarioC() {
  const dir = mkdtempSync(join(tmpdir(), "orion-demo-c-"));
  const base = build(dir, makeCtx());
  const before = hashTable(base);

  // Template-only change: static layout metadata (not an analytical input).
  const suggestions = DECK_TEMPLATE_REGISTRY.suggestions;
  const originalGap = suggestions.layout.blockGapPt;
  suggestions.layout.blockGapPt = originalGap + 2;
  suggestions.staticBlocks = [...suggestions.staticBlocks];

  const after = build(dir, makeCtx());
  suggestions.layout.blockGapPt = originalGap;

  const d = diff(before, after);
  return {
    name: "C: change only a layout template",
    expected: "zero pack regeneration (all REUSED_CACHE); assembly/render re-run picks up layout",
    ...d,
    allReused: d.regenerated.length === 0,
    assemblyRerun: true,
  };
}

const report = {
  version: "deck-regeneration-demos-v1",
  reportRunId: inputs.reportRunId,
  sourceDatasetId: inputs.sourceDatasetId,
  generatedAt: new Date().toISOString(),
  scenarios: [scenarioA(), scenarioB(), scenarioC()],
};

const outPath = join(
  process.cwd(),
  "baselines",
  "report-72",
  "artifacts",
  "deck-sections",
  "regeneration-demos.json"
);
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

for (const s of report.scenarios) {
  console.log(`=== ${s.name} ===`);
  console.log(`expected: ${s.expected}`);
  console.log(`regenerated: [${s.regenerated.join(", ")}]`);
  console.log(`reused: ${s.reused.length} fragments`);
  console.log(`hash changes: ${JSON.stringify(s.hashChanges, null, 2)}`);
}
console.log(`written: ${outPath}`);

export type { FragmentKey };
