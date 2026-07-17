/**
 * B-1 — Glinka canonical deck parity (NETWORK_CALLS=0, offline, no render).
 *
 * Proves the canonical prepare's deck stage — `loadDeckInputsFromAnalyticsDir`
 * + `runDeckBuild`, the exact engine the unified job uses — reproduces the
 * accepted Prompt 3 deck structure when fed the Glinka job-scoped analytics
 * artifacts (copied into a job dir). Structural/content parity: canonical slot
 * coverage, section order, base-slot set and page count.
 *
 * Glinka literals are allowed here: this is a baseline replay in scripts/.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-canonical-glinka-parity.ts
 */

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadDeckInputsFromAnalyticsDir } from "../src/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import { runDeckBuild } from "../src/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import {
  CANONICAL_SLOT_IDS,
  MERGED_SLOT_IDS,
} from "../src/modules/digital-profile/orion-golden/deck-sections/canonical-slots";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

const REPO = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const ANALYTICS = join(REPO, "baselines", "report-72", "artifacts", "analytics");
const ACCEPTED = join(REPO, "baselines", "report-72", "artifacts", "deck-sections");

function readJson<T>(p: string): T {
  return JSON.parse(readFileSync(p, "utf8")) as T;
}

type DeckManifest = {
  pageCount: number;
  toc: Array<{ title: string }>;
  slides: Array<{ baseSlotId: string; isContinuation?: boolean }>;
  sections?: Array<{ sectionType?: string; fragmentKey?: string }>;
};

function buildCanonicalGlinkaDeck() {
  const jobDir = mkdtempSync(join(tmpdir(), "glinka-parity-"));
  const analyticsDir = join(jobDir, "analytics");
  cpSync(ANALYTICS, analyticsDir, { recursive: true });
  const inputs = loadDeckInputsFromAnalyticsDir(analyticsDir);
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
      extras: { executiveSummary: inputs.executiveSummary as never, visualAssets: {} },
    },
    bundleForValidation: inputs.mergedBundle,
    knownEvidenceRefs: inputs.knownEvidenceRefs,
    outputRoot: join(jobDir, "deck"),
    baseObservationCountBefore: inputs.baseCountBefore,
    baseObservationCountAfter: inputs.baseCountAfter,
  });
  return { jobDir, deck };
}

describe("B-1 — Glinka canonical deck parity with accepted Prompt 3 output", () => {
  const accepted = readJson<DeckManifest>(join(ACCEPTED, "report-deck-manifest.json"));
  const { deck } = buildCanonicalGlinkaDeck();
  const built = deck.assembly.deckManifest as unknown as DeckManifest;

  it("canonical deck assembles with zero errors and no failed required sections", () => {
    assert.deepEqual(deck.assembly.errors, []);
    assert.deepEqual(deck.manifest.requiredSectionsFailed, []);
  });

  it("baseSlotCoverage=36 (all canonical slots covered)", () => {
    const present = new Set(built.slides.filter((s) => !s.isContinuation).map((s) => s.baseSlotId));
    const covered = new Set([...present, ...MERGED_SLOT_IDS]);
    const missing = CANONICAL_SLOT_IDS.filter((id) => !covered.has(id));
    assert.deepEqual(missing, [], `missing canonical slots: ${missing.join(",")}`);
  });

  it("every accepted base slot is preserved in the canonical deck (no lost slots)", () => {
    const acceptedBase = new Set(
      accepted.slides.filter((s) => !s.isContinuation).map((s) => s.baseSlotId)
    );
    const builtBase = new Set(
      built.slides.filter((s) => !s.isContinuation).map((s) => s.baseSlotId)
    );
    const lost = [...acceptedBase].filter((id) => !builtBase.has(id));
    assert.deepEqual(lost, [], `base slots lost vs accepted: ${lost.join(",")}`);
  });

  it("TOC section count matches the accepted deck", () => {
    assert.equal(built.toc.length, accepted.toc.length);
  });

  it("page count matches the accepted Prompt 3 deck", () => {
    assert.equal(
      built.pageCount,
      accepted.pageCount,
      `built=${built.pageCount} accepted=${accepted.pageCount}`
    );
  });
});
