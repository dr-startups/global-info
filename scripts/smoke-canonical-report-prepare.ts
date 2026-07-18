/**
 * B-1 — canonical job-scoped prepare E2E (NETWORK_CALLS=0).
 *
 * Proves the ORION_PREPARE stub is replaced by the real canonical pipeline:
 *   CompositeDataset -> SubjectResolution -> SurfaceAnalysis ->
 *   VerifiedFindingBundle -> ExecutiveSummary -> SectionPacks ->
 *   DeckAssembler -> one render -> acceptance.
 *
 * The render is stubbed by an injected adapter so the E2E stays offline while
 * still asserting exactly one assembly + one render, and fail-closed behavior
 * on disabled / foreign / stale / missing-profile inputs.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-canonical-report-prepare.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import {
  runCanonicalReportPrepare,
  compositeObservationsToInventory,
  CanonicalPrepareBlockedError,
  type CanonicalPrepareInput,
} from "../src/modules/digital-profile/services/canonical-report-prepare";
import {
  mergeCompositeSerp,
  buildReportDataBinding,
  type CompositeObservation,
} from "../src/modules/digital-profile/services/composite-serp-merge";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";
import type { ClassifierSubjectProfile } from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { DeckRenderAdapter } from "../src/modules/digital-profile/services/render-deck-artifacts";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

const GLINKA_LEAK_RE =
  /глинк|glinka|композитор|махмудов|makhmudov|бокарев|bokarev|ликсутов|liksutov|трансмаш|transmash|дерипаск|deripaska|nutriband|773800015809/i;

function subjectProfile(): ClassifierSubjectProfile {
  return {
    displayName: "Anders Holmström",
    givenNames: ["Anders"],
    familyNames: ["Holmström", "Holmstrom"],
    patronymics: [],
    aliases: ["A. Holmström", "Anders Holmstrom"],
    transliterations: ["Anders Holmstrom"],
    contextIdentifiers: ["Nordkap Capital", "fintech", "Stockholm"],
    namesakeProfiles: [
      { label: "Anders Holmström (ice-hockey goaltender)", noiseTerms: ["hockey", "nhl", "goaltender", "хоккей"] },
    ],
    negativeIdentitySignals: { wrongPatronymics: [], wrongNames: [], unrelatedKnownPersons: [] },
  };
}

let k = 0;
function obs(partial: Partial<CompositeObservation> & Pick<CompositeObservation, "kind">): CompositeObservation {
  k += 1;
  return {
    key: `k-${k}-${partial.url ?? partial.suggestion ?? partial.question ?? partial.title ?? k}`,
    region: "RU",
    engine: "YANDEX",
    query: "Anders Holmström",
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: [],
    ...partial,
  };
}

/** A composite dataset rich enough to assemble a full 36-slot deck. */
function compositeObservations(): CompositeObservation[] {
  return [
    obs({
      kind: "organic",
      region: "RU",
      engine: "YANDEX",
      url: "https://di.se/holmstrom-tax-probe",
      title: "Anders Holmström, founder of Nordkap Capital, faces tax-fraud probe in Stockholm",
      snippet: "Swedish prosecutors opened a tax fraud investigation into fintech founder Anders Holmström (Nordkap Capital).",
      riskLabel: "adverse",
    }),
    obs({
      kind: "organic",
      region: "RU",
      engine: "YANDEX",
      url: "https://svd.se/holmstrom-watchlist",
      title: "Anders Holmström flagged during sanctions screening watchlist review",
      snippet: "A compliance watchlist review referenced Anders Holmström, founder Nordkap Capital; requires analyst verification.",
    }),
    obs({
      kind: "organic",
      region: "RU",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      url: "https://dn.se/holmstrom-malta",
      title: "Anders Holmström linked to Malta holding structure and offshore beneficial ownership",
      snippet: "Corporate filings connect Anders Holmström (Nordkap Capital) to a Malta holding with offshore beneficial ownership.",
    }),
    obs({
      kind: "organic",
      region: "RU",
      engine: "YANDEX",
      url: "https://forbes.com/profile/holmstrom",
      title: "Anders Holmström, CEO of Nordkap Capital AB — fintech investor profile",
      snippet: "Business profile of Anders Holmström, founder and CEO of Stockholm fintech Nordkap Capital.",
    }),
    // Namesake — must resolve OTHER_SUBJECT and stay out of KPI.
    obs({
      kind: "organic",
      region: "RU",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      url: "https://nhl.com/holmstrom-goalie",
      title: "Holmström, ice-hockey goaltender, signs with NHL club",
      snippet: "Goaltender Holmström joins the NHL after a strong hockey season.",
    }),
    obs({
      kind: "suggestion",
      region: "RU",
      engine: "YANDEX",
      suggestion: "Anders Holmström Nordkap Capital fraud",
      title: "Anders Holmström Nordkap Capital fraud",
    }),
    obs({
      kind: "paa",
      region: "RU",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      question: "Who is Anders Holmström of Nordkap Capital?",
      title: "Who is Anders Holmström of Nordkap Capital?",
    }),
    // UAE market
    obs({
      kind: "organic",
      region: "UAE",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      url: "https://thenationalnews.com/holmstrom-dubai",
      title: "Anders Holmström expands Nordkap Capital into Dubai real-estate investment",
      snippet: "Anders Holmström announced a Dubai real-estate vehicle under Nordkap Capital.",
    }),
    obs({
      kind: "organic",
      region: "UAE",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      url: "https://gulfnews.com/holmstrom-pep",
      title: "Anders Holmström referenced in UAE PEP/RCA compliance screening",
      snippet: "A UAE compliance database returned a potential PEP/RCA reference to Anders Holmström; requires verification.",
      riskLabel: "adverse",
    }),
    obs({
      kind: "suggestion",
      region: "UAE",
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      suggestion: "Anders Holmström Dubai Nordkap",
      title: "Anders Holmström Dubai Nordkap",
    }),
  ];
}

async function seededPrepareInput(root: string): Promise<{
  input: CanonicalPrepareInput;
  compositeDatasetId: string;
}> {
  const unifiedJobId = "unified-canon-1";
  const caseId = "case-canon-holmstrom";
  const manifest: BaseCollectionManifest = {
    version: "base-collection-manifest-v1",
    unifiedJobId,
    caseId,
    capturedAt: new Date().toISOString(),
    baseReportRunId: "base-canon-1",
    searchResultIds: ["sr1", "sr2"],
    searchSurfaceItemIds: [],
    baseCount: compositeObservations().length,
    actualProviders: [
      { providerId: "yandex", runtime: "real", status: "completed" },
      { providerId: "serper", runtime: "real", status: "completed" },
    ],
    realCollectionSufficient: true,
  };
  const merge = await mergeCompositeSerp({ manifest, fixtureBaseRows: compositeObservations() });
  const binding = buildReportDataBinding({
    caseId,
    unifiedJobId,
    baseReportRunId: manifest.baseReportRunId,
    enrichmentRunIds: [],
    compositeDatasetId: merge.compositeDatasetId,
    providerCounts: merge.providerCounts,
  });

  const fakeRender: DeckRenderAdapter = async (r) => ({
    pdf: undefined,
    pptx: undefined,
    pngDir: undefined,
    pageCount: r.deckManifest.pageCount,
    renderer: "fake",
  });

  const input: CanonicalPrepareInput = {
    caseId,
    unifiedJobId,
    artifactsDir: root,
    binding,
    merge,
    subjectProfile: subjectProfile(),
    render: fakeRender,
  };
  return { input, compositeDatasetId: merge.compositeDatasetId };
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("B-1 — canonical prepare converts composite observations to inventory", () => {
  it("maps kind/provider/region into inventory items", () => {
    const items = compositeObservationsToInventory({
      caseId: "c1",
      baseReportRunId: "b1",
      enrichmentRunId: null,
      observations: compositeObservations(),
    });
    assert.equal(items.length, compositeObservations().length);
    assert.ok(items.every((i) => i.caseId === "c1"));
    assert.ok(items.some((i) => i.rawMetadata?.surface === "organic"));
    assert.ok(items.some((i) => i.rawMetadata?.surface === "autocomplete"));
    // paa rows normalize to the canonical "paa" surface bucket (was "related").
    assert.ok(items.some((i) => i.rawMetadata?.surface === "paa"));
    assert.ok(items.some((i) => i.region === "UAE"));
  });
});

describe("B-1 — canonical prepare happy path (one assembly, one render)", () => {
  it("produces analytics + deck + summary, coverage=36, prepareDatasetId==composite", async () => {
    const root = tmp("canon-happy-");
    const { input, compositeDatasetId } = await seededPrepareInput(root);
    const res = await runCanonicalReportPrepare(input);
    assert.equal(res.ok, true);
    assert.equal(res.prepareDatasetId, compositeDatasetId);
    assert.equal(res.assemblyCount, 1);
    assert.equal(res.renderCount, 1);
    assert.equal(res.baseSlotCoverage, 36);
    assert.deepEqual(res.requiredSectionsFailed, []);
    assert.ok(existsSync(join(root, "analytics", "verified-finding-bundle.json")));
    assert.ok(existsSync(join(root, "deck", "assembled-deck.json")));
    assert.ok(existsSync(join(root, "canonical-prepare-summary.json")));
  });

  it("no Glinka baseline leak in the produced artifacts", async () => {
    const root = tmp("canon-leak-");
    const { input } = await seededPrepareInput(root);
    await runCanonicalReportPrepare(input);
    const { readFileSync, readdirSync } = await import("node:fs");
    const readAll = (dir: string): string => {
      let blob = "";
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) blob += readAll(p);
        else if (e.name.endsWith(".json")) blob += `\n${readFileSync(p, "utf8")}`;
      }
      return blob;
    };
    const m = readAll(root).match(GLINKA_LEAK_RE);
    assert.equal(m, null, `leaked: ${m?.[0]}`);
  });
});

describe("B-1 — canonical prepare fail-closed (never legacy)", () => {
  it("ORION_CANONICAL_PREPARE=0 → CANONICAL_PREPARE_DISABLED blocker", async () => {
    const root = tmp("canon-disabled-");
    const { input } = await seededPrepareInput(root);
    const prev = process.env.ORION_CANONICAL_PREPARE;
    process.env.ORION_CANONICAL_PREPARE = "0";
    try {
      await assert.rejects(
        () => runCanonicalReportPrepare(input),
        (e: unknown) =>
          e instanceof CanonicalPrepareBlockedError && e.code === "CANONICAL_PREPARE_DISABLED"
      );
    } finally {
      if (prev === undefined) delete process.env.ORION_CANONICAL_PREPARE;
      else process.env.ORION_CANONICAL_PREPARE = prev;
    }
  });

  it("foreign binding.caseId → FOREIGN_ARTIFACT blocker", async () => {
    const root = tmp("canon-foreign-");
    const { input } = await seededPrepareInput(root);
    const bad: CanonicalPrepareInput = {
      ...input,
      binding: { ...input.binding, caseId: "some-other-case" },
    };
    await assert.rejects(
      () => runCanonicalReportPrepare(bad),
      (e: unknown) => e instanceof CanonicalPrepareBlockedError && e.code === "FOREIGN_ARTIFACT"
    );
  });

  it("stale composite id mismatch → STALE_ARTIFACT blocker", async () => {
    const root = tmp("canon-stale-");
    const { input } = await seededPrepareInput(root);
    const bad: CanonicalPrepareInput = {
      ...input,
      binding: { ...input.binding, compositeDatasetId: "composite-STALE" },
    };
    await assert.rejects(
      () => runCanonicalReportPrepare(bad),
      (e: unknown) => e instanceof CanonicalPrepareBlockedError && e.code === "STALE_ARTIFACT"
    );
  });

  it("missing subject profile → SUBJECT_PROFILE_MISSING blocker", async () => {
    const root = tmp("canon-noprofile-");
    const { input } = await seededPrepareInput(root);
    const bad: CanonicalPrepareInput = { ...input, subjectProfile: null };
    await assert.rejects(
      () => runCanonicalReportPrepare(bad),
      (e: unknown) =>
        e instanceof CanonicalPrepareBlockedError && e.code === "SUBJECT_PROFILE_MISSING"
    );
  });
});
