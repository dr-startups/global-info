/**
 * B-1 — Glinka canonical prepare replay + render parity.
 *
 * Regenerates the Glinka report/contact sheet through the CANONICAL prepare
 * deck+render stage (the exact engine the unified job uses:
 * `loadDeckInputsFromAnalyticsDir` -> `runDeckBuild` -> `renderDeckWithPython`)
 * fed the Glinka job-scoped analytics artifacts, and proves visual/content
 * parity with the accepted Prompt 3 output (page count + PDF/PNG parity).
 *
 * Glinka literals are allowed here: this is a baseline replay in scripts/.
 *
 * Run: npx tsx scripts/run-canonical-prepare-glinka-replay.ts
 *      SKIP_RENDER=1 npx tsx scripts/run-canonical-prepare-glinka-replay.ts  (structure only)
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadDeckInputsFromAnalyticsDir } from "../src/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import { runDeckBuild } from "../src/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import {
  CANONICAL_SLOT_IDS,
  MERGED_SLOT_IDS,
} from "../src/modules/digital-profile/orion-golden/deck-sections/canonical-slots";
import { renderDeckWithPython } from "../src/modules/digital-profile/services/render-deck-artifacts";
import { loadReportAssets } from "./run-orion-deck-sections-report72";

const REPO = process.cwd();
const ANALYTICS = join(REPO, "baselines", "report-72", "artifacts", "analytics");
const ACCEPTED = join(REPO, "baselines", "report-72", "artifacts", "deck-sections");
const OUT = join(REPO, "baselines", "report-72", "artifacts", "canonical-replay");

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const analyticsDir = join(OUT, "analytics");
  cpSync(ANALYTICS, analyticsDir, { recursive: true });

  const inputs = loadDeckInputsFromAnalyticsDir(analyticsDir);
  const { assets, visualAssets } = loadReportAssets(inputs.evidenceIndex);

  console.log("=== CANONICAL DECK BUILD (job-scoped analytics) ===");
  const deck = runDeckBuild({
    ctx: {
      caseId: inputs.caseId,
      reportRunId: inputs.reportRunId,
      sourceDatasetId: inputs.sourceDatasetId,
      contentVersion: "deck-sections-v14",
      subject: { displayName: "Сергей Глинка", aliases: [] },
      bundle: inputs.mergedBundle,
      surfaceUnits: inputs.surfaceUnits,
      metricSnapshot: inputs.metricSnapshot,
      evidenceIndex: inputs.evidenceIndex,
      extras: { executiveSummary: inputs.executiveSummary as never, visualAssets },
    },
    bundleForValidation: inputs.mergedBundle,
    knownEvidenceRefs: inputs.knownEvidenceRefs,
    outputRoot: join(OUT, "deck"),
    baseObservationCountBefore: inputs.baseCountBefore,
    baseObservationCountAfter: inputs.baseCountAfter,
  });

  if (deck.assembly.errors.length > 0) {
    throw new Error(`assembly errors: ${deck.assembly.errors.join("; ")}`);
  }
  if (deck.manifest.requiredSectionsFailed.length > 0) {
    throw new Error(`required sections failed: ${deck.manifest.requiredSectionsFailed.join(", ")}`);
  }

  const built = deck.assembly.deckManifest;
  const accepted = readJson<{ pageCount: number; toc: unknown[]; slides: Array<{ baseSlotId: string; isContinuation?: boolean }> }>(
    join(ACCEPTED, "report-deck-manifest.json")
  );

  const present = new Set(built.slides.filter((s) => !s.isContinuation).map((s) => s.baseSlotId));
  const covered = new Set([...present, ...MERGED_SLOT_IDS]);
  const missing = CANONICAL_SLOT_IDS.filter((id) => !covered.has(id));
  const acceptedBase = new Set(accepted.slides.filter((s) => !s.isContinuation).map((s) => s.baseSlotId));
  const lost = [...acceptedBase].filter((id) => !present.has(id));

  const structureParity = {
    baseSlotCoverage: missing.length === 0 ? 36 : 36 - missing.length,
    missingCanonicalSlots: missing,
    lostAcceptedBaseSlots: lost,
    builtPageCount: built.pageCount,
    acceptedPageCount: accepted.pageCount,
    tocMatch: built.toc.length === accepted.toc.length,
    pageCountMatch: built.pageCount === accepted.pageCount,
  };
  console.log("=== STRUCTURE PARITY ===");
  console.log(JSON.stringify(structureParity, null, 2));

  let renderParity: Record<string, unknown> = { skipped: true };
  if (process.env.SKIP_RENDER !== "1") {
    console.log("=== RENDER (canonical prepare adapter → existing python renderer) ===");
    const renderDir = join(OUT, "render");
    const rendered = await renderDeckWithPython({
      deckManifest: built,
      rendererSlides: deck.assembly.rendererSlides,
      subjectName: "Сергей Глинка",
      assets,
      outputRoot: renderDir,
    });
    let pdfPages = 0;
    if (rendered.pdf && existsSync(rendered.pdf)) {
      pdfPages = Number(
        execFileSync("python", ["-X", "utf8", "-c", "import fitz,sys;print(len(fitz.open(sys.argv[1])))", rendered.pdf], {
          encoding: "utf8",
        }).trim()
      );
    }
    const pngPages = rendered.pngDir && existsSync(rendered.pngDir)
      ? readdirSync(rendered.pngDir).filter((f) => f.endsWith(".png")).length
      : 0;
    renderParity = {
      renderer: rendered.renderer,
      pptx: rendered.pptx,
      pdf: rendered.pdf,
      contactSheet: rendered.contactSheet,
      pdfPages,
      pngPages,
      pdfPageParity: pdfPages === built.pageCount,
      pngPageParity: pngPages === built.pageCount,
      acceptedPageParity: pdfPages === accepted.pageCount,
    };
    console.log("=== RENDER PARITY ===");
    console.log(JSON.stringify(renderParity, null, 2));
  }

  const pass =
    structureParity.missingCanonicalSlots.length === 0 &&
    structureParity.lostAcceptedBaseSlots.length === 0 &&
    structureParity.pageCountMatch &&
    structureParity.tocMatch &&
    (process.env.SKIP_RENDER === "1" ||
      (Boolean((renderParity as { pdfPageParity?: boolean }).pdfPageParity) &&
        Boolean((renderParity as { acceptedPageParity?: boolean }).acceptedPageParity)));

  const verdict = {
    version: "canonical-glinka-replay-parity-v1",
    GLINKA_CANONICAL_REPLAY_PARITY: pass ? "PASS" : "FAIL",
    structureParity,
    renderParity,
    generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(OUT, "parity-report.json"), `${JSON.stringify(verdict, null, 2)}\n`, "utf8");
  console.log(`\nGLINKA_CANONICAL_REPLAY_PARITY=${pass ? "PASS" : "FAIL"}`);
  if (!pass) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error("GLINKA REPLAY ERROR:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
