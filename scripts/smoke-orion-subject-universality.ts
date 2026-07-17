/**
 * B-2A — SUBJECT UNIVERSALITY (canonical pipeline), NETWORK_CALLS=0.
 *
 * Proves the NEW canonical analytical + deck pipeline is subject-agnostic:
 *   1. A second synthetic subject (Latin name ordering, NO patronymic) passes
 *      the full offline analytics + deck E2E.
 *   2. No Glinka baseline data leaks into that subject's artifacts / packs /
 *      assembled model / client copy.
 *   3. Cross-case isolation: foreign-subject SectionPacks are rejected
 *      fail-closed at assembly.
 *   4. Cache isolation: a different caseId never reuses another subject's
 *      cached packs; same subject is idempotent.
 *   5. The canonical import graph contains no legacy monolithic-composer import
 *      and no Glinka-specific literals.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-orion-subject-universality.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";
import type { ClassifierSubjectProfile } from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { CoverageCellStatusRow } from "../src/modules/digital-profile/orion-golden/analytics/composite-dataset-builder";
import { runOrionAnalyticsPipeline } from "../src/modules/digital-profile/orion-golden/analytics/run-analytics-pipeline";
import {
  runDeckBuild,
  type ScopedEvidenceIndex,
  type MetricSnapshot,
} from "../src/modules/digital-profile/orion-golden/deck-sections";
import { assembleDeck } from "../src/modules/digital-profile/orion-golden/deck-sections/deck-assembler";
import {
  CANONICAL_SLOT_IDS,
  MERGED_SLOT_IDS,
} from "../src/modules/digital-profile/orion-golden/deck-sections/canonical-slots";
import type { VerifiedFindingBundle } from "../src/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";
import type { Finding } from "../src/modules/digital-profile/orion-golden/contracts/finding";
import type { SurfaceAnalysis } from "../src/modules/digital-profile/orion-golden/contracts/surface-analysis";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

/** Any token that would betray Glinka baseline contamination in an artifact. */
const GLINKA_LEAK_RE =
  /глинк|glinka|композитор|михаил\s*глинк|mikhail\s*glinka|махмудов|makhmudov|бокарев|bokarev|ликсутов|liksutov|трансмаш|transmash|лаврова|lavrova|дерипаск|deripaska|молдав|moldova|сергей\s*глинк|nutriband|773800015809/i;

// ---------------------------------------------------------------------------
// Synthetic subject factory — every value is dynamic, none Glinka-derived.
// ---------------------------------------------------------------------------

type SyntheticSubject = {
  caseId: string;
  baseReportRunId: string;
  displayName: string;
  profile: ClassifierSubjectProfile;
  items: RawInventoryItem[];
  coverageRows: CoverageCellStatusRow[];
};

let seq = 0;
function mkItem(
  caseId: string,
  reportRunId: string,
  partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">
): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `${caseId}-it-${seq}`,
    caseId,
    reportRunId,
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-07-16T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    ...partial,
  };
}

/**
 * Subject B: "Anders Holmström" — Swedish fintech founder searched in RU/UAE
 * markets. Latin (given-first) ordering, NO patronymic. Namesake: an ice-hockey
 * goaltender of the same name (must resolve OTHER_SUBJECT).
 */
function subjectAndersHolmstrom(): SyntheticSubject {
  const caseId = "case-univ-holmstrom";
  const run = "base-run-holmstrom";
  const company = "Nordkap Capital";
  const profile: ClassifierSubjectProfile = {
    displayName: "Anders Holmström",
    givenNames: ["Anders"],
    familyNames: ["Holmström", "Holmstrom"],
    // NO patronymic — deliberately omitted (non-Russian subject).
    patronymics: [],
    aliases: ["A. Holmström", "Anders Holmstrom"],
    transliterations: ["Anders Holmstrom"],
    contextIdentifiers: ["Nordkap Capital", "fintech", "Stockholm", "founder"],
    namesakeProfiles: [
      {
        label: "Anders Holmström (ice-hockey goaltender)",
        noiseTerms: ["hockey", "nhl", "goaltender", "elitserien", "хоккей", "вратарь"],
      },
    ],
    negativeIdentitySignals: {
      wrongPatronymics: [],
      wrongNames: [],
      unrelatedKnownPersons: [],
    },
  };
  const items: RawInventoryItem[] = [
    mkItem(caseId, run, {
      title: "Anders Holmström, founder of Nordkap Capital, faces tax-fraud probe in Stockholm",
      snippet: "Swedish prosecutors opened a tax fraud investigation into fintech founder Anders Holmström (Nordkap Capital).",
      sourceUrl: "https://di.se/holmstrom-tax-probe",
      rawMetadata: { engine: "YANDEX", surface: "organic", queryText: "Anders Holmström" },
    }),
    mkItem(caseId, run, {
      title: "Anders Holmström flagged during sanctions screening watchlist review",
      snippet: "A compliance watchlist review referenced Anders Holmström, founder Nordkap Capital; requires analyst verification.",
      sourceUrl: "https://svd.se/holmstrom-watchlist",
      classification: "sanctions",
      rawMetadata: { engine: "YANDEX", surface: "organic", queryText: "Anders Holmström Nordkap" },
    }),
    mkItem(caseId, run, {
      title: "Anders Holmström linked to Malta holding structure and offshore beneficial ownership",
      snippet: "Corporate filings connect Anders Holmström (Nordkap Capital) to a Malta holding with offshore beneficial ownership.",
      sourceUrl: "https://dn.se/holmstrom-malta",
      rawMetadata: { engine: "GOOGLE", surface: "organic", queryText: "Anders Holmström offshore" },
    }),
    mkItem(caseId, run, {
      title: "Anders Holmström, CEO of Nordkap Capital AB — fintech investor profile",
      snippet: "Business profile of Anders Holmström, founder and CEO of Stockholm fintech Nordkap Capital.",
      sourceUrl: "https://forbes.com/profile/holmstrom",
      rawMetadata: { engine: "YANDEX", surface: "organic", queryText: "Anders Holmström" },
    }),
    // Namesake — must NOT enter subject KPI (OTHER_SUBJECT via namesakeNoise:
    // surname present, subject given name absent, hockey noise terms present).
    mkItem(caseId, run, {
      title: "Holmström, ice-hockey goaltender, signs with NHL club",
      snippet: "Goaltender Holmström joins the NHL after a strong Elitserien hockey season.",
      sourceUrl: "https://nhl.com/holmstrom-goalie",
      rawMetadata: { engine: "GOOGLE", surface: "organic", queryText: "Holmström hockey" },
    }),
    // Surname-only ambiguity.
    mkItem(caseId, run, {
      title: "Holmström family history and genealogy records",
      snippet: "An overview of the Holmström surname across Scandinavian records.",
      sourceUrl: "https://example.org/holmstrom-family",
      rawMetadata: { engine: "GOOGLE", surface: "organic", queryText: "Holmström" },
    }),
    mkItem(caseId, run, {
      title: "Anders Holmström Nordkap Capital fraud",
      sourceUrl: "arsenkin://suggest/holmstrom",
      evidenceType: "suggestion",
      rawMetadata: { engine: "YANDEX", surface: "autocomplete", queryText: "Anders Holmström" },
    }),
    mkItem(caseId, run, {
      title: "Anders Holmström — Wikipedia (Swedish businessman)",
      snippet: "Anders Holmström is a Swedish entrepreneur, founder of Nordkap Capital.",
      sourceUrl: "https://en.wikipedia.org/wiki/Anders_Holmstrom",
      evidenceType: "knowledge_panel",
      rawMetadata: { engine: "GOOGLE", surface: "knowledge", queryText: "Anders Holmström" },
    }),
    mkItem(caseId, run, {
      title: "People also ask: Who is Anders Holmström of Nordkap Capital?",
      evidenceType: "related_query",
      sourceUrl: "https://google.com/paa/holmstrom",
      rawMetadata: { engine: "GOOGLE", surface: "related", queryText: "Anders Holmström" },
    }),
    mkItem(caseId, run, {
      title: "Anders Holmström image result — conference keynote",
      evidenceType: "image_result",
      imageUrl: "https://img.example/holmstrom.jpg",
      sourceUrl: "https://img.example/holmstrom.jpg",
      rawMetadata: { engine: "YANDEX", surface: "images", queryText: "Anders Holmström" },
    }),
    // UAE market
    mkItem(caseId, run, {
      title: "Anders Holmström expands Nordkap Capital into Dubai real-estate investment",
      snippet: "Anders Holmström announced a Dubai real-estate vehicle under Nordkap Capital.",
      sourceUrl: "https://thenationalnews.com/holmstrom-dubai",
      region: "UAE",
      rawMetadata: { engine: "GOOGLE", surface: "organic", queryText: "Anders Holmström Dubai" },
    }),
    mkItem(caseId, run, {
      title: "Anders Holmström referenced in UAE PEP/RCA compliance screening",
      snippet: "A UAE compliance database returned a potential PEP/RCA reference to Anders Holmström; requires verification.",
      sourceUrl: "https://gulfnews.com/holmstrom-pep",
      region: "UAE",
      classification: "pep",
      rawMetadata: { engine: "GOOGLE", surface: "organic", queryText: "Anders Holmström PEP" },
    }),
    mkItem(caseId, run, {
      title: "Anders Holmström Dubai Nordkap",
      region: "UAE",
      evidenceType: "suggestion",
      sourceUrl: "arsenkin://suggest/holmstrom-uae",
      rawMetadata: { engine: "GOOGLE", surface: "autocomplete", queryText: "Anders Holmström Dubai" },
    }),
    mkItem(caseId, run, {
      title: "Anders Holmström — Dubai business knowledge card",
      region: "UAE",
      evidenceType: "knowledge_panel",
      sourceUrl: "https://kg.example/holmstrom-uae",
      rawMetadata: { engine: "GOOGLE", surface: "knowledge", queryText: "Anders Holmström Dubai" },
    }),
  ];
  const coverageRows: CoverageCellStatusRow[] = [
    { region: "RU", engine: "YANDEX", surface: "organic", status: "OK" },
    { region: "RU", engine: "GOOGLE", surface: "organic", status: "OK" },
    { region: "RU", engine: "YANDEX", surface: "autocomplete", status: "OK" },
    { region: "RU", engine: "GOOGLE", surface: "knowledge", status: "OK" },
    { region: "UAE", engine: "GOOGLE", surface: "organic", status: "OK" },
    { region: "UAE", engine: "GOOGLE", surface: "autocomplete", status: "OK" },
    { region: "UAE", engine: "YANDEX", surface: "ai_answer", status: "NO_RESULTS" },
  ] as unknown as CoverageCellStatusRow[];
  return { caseId, baseReportRunId: run, displayName: "Anders Holmström", profile, items, coverageRows };
}

/** Subject C: "Mateus Ferreira" — a second, different non-Russian subject. */
function subjectMateusFerreira(): SyntheticSubject {
  const caseId = "case-univ-ferreira";
  const run = "base-run-ferreira";
  const profile: ClassifierSubjectProfile = {
    displayName: "Mateus Ferreira",
    givenNames: ["Mateus"],
    familyNames: ["Ferreira"],
    patronymics: [],
    aliases: ["M. Ferreira"],
    transliterations: ["Mateus Ferreira"],
    contextIdentifiers: ["Atlântico Ventures", "logistics", "Lisbon"],
    namesakeProfiles: [
      { label: "Mateus Ferreira (footballer)", noiseTerms: ["football", "midfielder", "liga", "футбол"] },
    ],
    negativeIdentitySignals: { wrongPatronymics: [], wrongNames: [], unrelatedKnownPersons: [] },
  };
  const items: RawInventoryItem[] = [
    mkItem(caseId, run, {
      title: "Mateus Ferreira, Atlântico Ventures owner, named in corruption inquiry",
      snippet: "Portuguese authorities named Mateus Ferreira (Atlântico Ventures) in a corruption inquiry.",
      sourceUrl: "https://publico.pt/ferreira-inquiry",
      rawMetadata: { engine: "YANDEX", surface: "organic", queryText: "Mateus Ferreira" },
    }),
    mkItem(caseId, run, {
      title: "Mateus Ferreira, footballer, transfers to a new club",
      snippet: "Midfielder Mateus Ferreira completed a football transfer this week.",
      sourceUrl: "https://espn.com/ferreira-transfer",
      rawMetadata: { engine: "GOOGLE", surface: "organic", queryText: "Mateus Ferreira football" },
    }),
    mkItem(caseId, run, {
      title: "Mateus Ferreira — Atlântico Ventures logistics profile",
      snippet: "Business profile of Mateus Ferreira, founder of Lisbon logistics firm Atlântico Ventures.",
      sourceUrl: "https://eco.pt/ferreira-profile",
      region: "UAE",
      rawMetadata: { engine: "GOOGLE", surface: "organic", queryText: "Mateus Ferreira" },
    }),
  ];
  const coverageRows: CoverageCellStatusRow[] = [
    { region: "RU", engine: "YANDEX", surface: "organic", status: "OK" },
    { region: "UAE", engine: "GOOGLE", surface: "organic", status: "OK" },
  ] as unknown as CoverageCellStatusRow[];
  return { caseId, baseReportRunId: run, displayName: "Mateus Ferreira", profile, items, coverageRows };
}

// ---------------------------------------------------------------------------
// Generic deck-input assembly from a freshly generated analytics artifact dir
// (subject-agnostic version of loadReport72DeckInputs — no report-72 paths).
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

type CompositeObservationRow = {
  surface: string;
  region: string;
  engine?: string;
  url?: string;
  title?: string;
  domain?: string;
  evidenceRefs: string[];
};

function loadDeckInputsFromDir(analyticsDir: string) {
  const bundle = readJson<VerifiedFindingBundle>(join(analyticsDir, "verified-finding-bundle.json"));
  const ambiguous = readJson<Finding[]>(join(analyticsDir, "ambiguous-findings.json"));
  const surfaceAnalysis = readJson<Record<string, SurfaceAnalysis>>(
    join(analyticsDir, "surface-analysis.json")
  );
  const executiveSummary = readJson<Record<string, unknown>>(join(analyticsDir, "executive-summary.json"));
  const binding = readJson<{ baseReportRunId: string; datasetId: string; caseId: string }>(
    join(analyticsDir, "report-data-binding.json")
  );
  const providerDelta = readJson<{ baseCount: number; arsenkinObservationCount: number }>(
    join(analyticsDir, "provider-delta.json")
  );
  const observations = readJson<{
    observations: CompositeObservationRow[];
    baseCount: number;
    compositeCount: number;
  }>(join(analyticsDir, "composite-serp-observations.json"));
  const subjectResolution = readJson<{ items: Array<{ decision: string }> }>(
    join(analyticsDir, "subject-resolution.json")
  );

  const mergedBundle: VerifiedFindingBundle = {
    ...bundle,
    findings: [...bundle.findings, ...ambiguous],
  };
  const surfaceUnits = Object.values(surfaceAnalysis).flatMap((sa) => sa.units);

  const evidenceIndex: ScopedEvidenceIndex = {};
  const knownEvidenceRefs = new Set<string>();
  const perRegionCounts: Record<string, number> = {};
  for (const obs of observations.observations) {
    const regionKey = obs.region === "RU" ? "RU" : "UAE";
    perRegionCounts[regionKey] = (perRegionCounts[regionKey] ?? 0) + 1;
    for (const ref of obs.evidenceRefs) {
      knownEvidenceRefs.add(ref);
      evidenceIndex[ref] = {
        url: obs.url,
        domain: obs.domain,
        title: obs.title,
        kind: obs.surface,
        region: obs.region,
        engine: obs.engine,
      };
    }
  }
  for (const f of mergedBundle.findings) for (const r of f.evidenceRefs) knownEvidenceRefs.add(r);
  for (const u of surfaceUnits) {
    for (const r of u.evidenceRefs) knownEvidenceRefs.add(r);
    for (const c of u.claims) for (const r of c.evidenceRefs) knownEvidenceRefs.add(r);
  }

  const decisions = subjectResolution.items.reduce<Record<string, number>>((acc, i) => {
    acc[i.decision] = (acc[i.decision] ?? 0) + 1;
    return acc;
  }, {});
  const RISK_ORDER: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
  const metricSnapshot: MetricSnapshot = {
    metricSnapshotId: `${binding.datasetId}-metrics`,
    datasetId: binding.datasetId,
    reportRunId: binding.baseReportRunId,
    baseCount: observations.baseCount,
    enrichmentCount: providerDelta.arsenkinObservationCount,
    compositeCount: observations.compositeCount,
    subjectMatchCount: decisions.SUBJECT_MATCH ?? 0,
    ambiguousCount: decisions.AMBIGUOUS ?? 0,
    otherSubjectCount: decisions.OTHER_SUBJECT ?? 0,
    adverseFindingCount: bundle.findings.filter(
      (f) => f.subjectMatch === "SUBJECT_MATCH" && (RISK_ORDER[f.riskLevel] ?? 0) >= 2
    ).length,
    perRegionCounts,
  };

  return {
    caseId: binding.caseId,
    reportRunId: binding.baseReportRunId,
    sourceDatasetId: binding.datasetId,
    mergedBundle,
    surfaceUnits,
    evidenceIndex,
    knownEvidenceRefs,
    metricSnapshot,
    executiveSummary,
    subjectResolution,
    baseCountBefore: providerDelta.baseCount,
    baseCountAfter: observations.baseCount,
  };
}

type BuiltSubject = {
  subject: SyntheticSubject;
  analyticsDir: string;
  deckDir: string;
  inputs: ReturnType<typeof loadDeckInputsFromDir>;
  deck: ReturnType<typeof runDeckBuild>;
};

async function buildSubjectE2E(subject: SyntheticSubject, outRoot: string): Promise<BuiltSubject> {
  const analyticsDir = join(outRoot, "analytics");
  const deckDir = join(outRoot, "deck");
  await runOrionAnalyticsPipeline({
    caseId: subject.caseId,
    inventoryReportRunId: subject.baseReportRunId,
    items: subject.items,
    binding: null,
    coverageRows: subject.coverageRows,
    subjectProfile: subject.profile,
    artifactsDir: analyticsDir,
  });
  const inputs = loadDeckInputsFromDir(analyticsDir);
  const deck = runDeckBuild({
    ctx: {
      caseId: inputs.caseId,
      reportRunId: inputs.reportRunId,
      sourceDatasetId: inputs.sourceDatasetId,
      contentVersion: "deck-sections-v14",
      subject: { displayName: subject.displayName, aliases: subject.profile.aliases ?? [] },
      bundle: inputs.mergedBundle,
      surfaceUnits: inputs.surfaceUnits,
      metricSnapshot: inputs.metricSnapshot,
      evidenceIndex: inputs.evidenceIndex,
      extras: { executiveSummary: inputs.executiveSummary as never, visualAssets: {} },
    },
    bundleForValidation: inputs.mergedBundle,
    knownEvidenceRefs: inputs.knownEvidenceRefs,
    outputRoot: deckDir,
    baseObservationCountBefore: inputs.baseCountBefore,
    baseObservationCountAfter: inputs.baseCountAfter,
  });
  return { subject, analyticsDir, deckDir, inputs, deck };
}

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Every JSON artifact under a directory, concatenated for a leak scan. */
function readAllArtifacts(dir: string): string {
  let blob = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) blob += readAllArtifacts(p);
    else if (entry.name.endsWith(".json")) blob += `\n${readFileSync(p, "utf8")}`;
  }
  return blob;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("B-2A.2 — second subject full offline analytics + deck E2E", () => {
  let built: BuiltSubject;

  before(async () => {
    built = await buildSubjectE2E(subjectAndersHolmstrom(), tmp("univ-holmstrom-"));
  });

  it("analytics produced findings and resolved the namesake as OTHER_SUBJECT", () => {
    const res = built.inputs.subjectResolution.items as Array<{ decision: string }>;
    const other = res.filter((r) => r.decision === "OTHER_SUBJECT").length;
    const match = res.filter((r) => r.decision === "SUBJECT_MATCH").length;
    assert.ok(match > 0, "subject must have SUBJECT_MATCH observations");
    assert.ok(other > 0, "hockey namesake must be OTHER_SUBJECT");
    assert.ok(built.inputs.mergedBundle.findings.length > 0, "must synthesize findings");
  });

  it("deck assembled fail-open-free: full 36-slot coverage, zero errors, no failed required section", () => {
    assert.equal(built.deck.assembly.errors.length, 0, "assembly errors must be empty");
    assert.deepEqual(
      built.deck.manifest.requiredSectionsFailed,
      [],
      "no required section may fail for a valid second subject"
    );
    // baseSlotCoverage=36: every canonical slot is either physically present or
    // an explicitly-merged slot — proven without the Glinka v72 baseline.
    const present = new Set(
      built.deck.assembly.deckManifest.slides.filter((s) => !s.isContinuation).map((s) => s.baseSlotId)
    );
    const covered = new Set([...present, ...MERGED_SLOT_IDS]);
    const missing = CANONICAL_SLOT_IDS.filter((id) => !covered.has(id));
    assert.deepEqual(missing, [], `all 36 canonical base slots must be covered; missing: ${missing.join(",")}`);
  });

  it("every SectionPack carries this subject's caseId/datasetId lineage (check 24)", () => {
    for (const p of built.deck.packs) {
      assert.equal(p.caseId, built.subject.caseId, `${p.fragmentKey} caseId`);
      assert.equal(p.datasetId, built.inputs.sourceDatasetId, `${p.fragmentKey} datasetId`);
      assert.equal(p.reportRunId, built.subject.baseReportRunId, `${p.fragmentKey} reportRunId`);
      assert.ok(p.schemaVersion, `${p.fragmentKey} schemaVersion`);
      assert.ok(p.contentHash, `${p.fragmentKey} contentHash`);
    }
  });

  it("NO Glinka baseline data leaks into artifacts, packs, assembled model or client copy", () => {
    const analyticsBlob = readAllArtifacts(built.analyticsDir);
    const deckBlob = readAllArtifacts(built.deckDir);
    for (const [label, blob] of [
      ["analytics", analyticsBlob],
      ["deck", deckBlob],
    ] as const) {
      const m = blob.match(GLINKA_LEAK_RE);
      assert.equal(m, null, `${label} artifacts leaked Glinka data: ${m?.[0]}`);
    }
  });
});

describe("B-2A.3 — cross-case + cache isolation", () => {
  it("foreign-subject SectionPacks are rejected fail-closed at assembly (FOREIGN_CASE)", async () => {
    const b = await buildSubjectE2E(subjectAndersHolmstrom(), tmp("univ-iso-b-"));
    const c = await buildSubjectE2E(subjectMateusFerreira(), tmp("univ-iso-c-"));
    // Assemble subject C's packs but claim subject B's caseId → every pack foreign.
    const assembly = assembleDeck({
      manifest: c.deck.manifest,
      packs: c.deck.packs,
      expectedCaseId: b.subject.caseId,
      expectedReportRunId: b.subject.baseReportRunId,
      expectedDatasetId: b.inputs.sourceDatasetId,
    });
    assert.ok(assembly.errors.length > 0, "foreign packs must block assembly");
    assert.ok(
      assembly.rejections.some((r) => r.reason === "FOREIGN_CASE"),
      "must reject with FOREIGN_CASE"
    );
  });

  it("a different caseId never reuses another subject's cached packs", async () => {
    const root = tmp("univ-cache-");
    const deckDir = join(root, "shared-deck");
    // Build subject B into the shared deck dir.
    const b = subjectAndersHolmstrom();
    const bAnalytics = join(root, "b-analytics");
    await runOrionAnalyticsPipeline({
      caseId: b.caseId,
      inventoryReportRunId: b.baseReportRunId,
      items: b.items,
      binding: null,
      coverageRows: b.coverageRows,
      subjectProfile: b.profile,
      artifactsDir: bAnalytics,
    });
    const bInputs = loadDeckInputsFromDir(bAnalytics);
    const runFor = (inputs: ReturnType<typeof loadDeckInputsFromDir>, s: SyntheticSubject) =>
      runDeckBuild({
        ctx: {
          caseId: inputs.caseId,
          reportRunId: inputs.reportRunId,
          sourceDatasetId: inputs.sourceDatasetId,
          contentVersion: "deck-sections-v14",
          subject: { displayName: s.displayName, aliases: s.profile.aliases ?? [] },
          bundle: inputs.mergedBundle,
          surfaceUnits: inputs.surfaceUnits,
          metricSnapshot: inputs.metricSnapshot,
          evidenceIndex: inputs.evidenceIndex,
          extras: { executiveSummary: inputs.executiveSummary as never, visualAssets: {} },
        },
        bundleForValidation: inputs.mergedBundle,
        knownEvidenceRefs: inputs.knownEvidenceRefs,
        outputRoot: deckDir,
        baseObservationCountBefore: inputs.baseCountBefore,
        baseObservationCountAfter: inputs.baseCountAfter,
      });

    runFor(bInputs, b); // seed cache with subject B packs
    const bAgain = runFor(bInputs, b); // idempotent rebuild
    assert.ok(
      bAgain.buildLog.every((l) => l.action === "REUSED_CACHE"),
      "identical subject rebuild must reuse every cached pack"
    );

    // Now build subject C into the SAME dir (B's packs are the previousPacks).
    const c = subjectMateusFerreira();
    const cAnalytics = join(root, "c-analytics");
    await runOrionAnalyticsPipeline({
      caseId: c.caseId,
      inventoryReportRunId: c.baseReportRunId,
      items: c.items,
      binding: null,
      coverageRows: c.coverageRows,
      subjectProfile: c.profile,
      artifactsDir: cAnalytics,
    });
    const cInputs = loadDeckInputsFromDir(cAnalytics);
    const cBuild = runFor(cInputs, c);
    assert.ok(
      cBuild.buildLog.every((l) => l.action === "REGENERATED"),
      "a foreign caseId must never reuse another subject's cached packs"
    );
    for (const p of cBuild.packs) assert.equal(p.caseId, c.caseId, "packs rebound to subject C");
  });
});

describe("B-2A.4 — canonical import graph has no legacy composer / Glinka literals", () => {
  const SRC_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
  const HERE = dirname(fileURLToPath(import.meta.url));

  const LEGACY_COMPOSER_RE =
    /classic\/(orion-classic-theme-set|orion-first36-deck-composer|orion-classic-audit-deck-composer|orion-classic-client-content-to-report-spec|orion-classic-text-utils|serp-position-tables)/;
  const IDENTITY_LEAK_RE =
    /глинк|glinka|композитор|махмудов|makhmudov|бокарев|bokarev|ликсутов|liksutov|трансмаш|transmash|лаврова|lavrova|дерипаск|deripaska|nutriband|773800015809/i;

  /** Resolve a relative import specifier to a concrete .ts file. */
  function resolveImport(fromFile: string, spec: string): string | null {
    if (!spec.startsWith(".")) return null;
    const base = join(dirname(fromFile), spec);
    for (const cand of [`${base}.ts`, join(base, "index.ts"), `${base}.tsx`]) {
      if (existsSync(cand)) return cand;
    }
    return null;
  }

  const PARENT = new Map<string, string>();

  /**
   * Value-only (runtime) import specifiers. `import type` / `export type`
   * statements are erased by the compiler and never execute code, so they cannot
   * introduce runtime contamination and are excluded — this measures the graph
   * that actually runs.
   */
  function runtimeSpecifiers(src: string): string[] {
    const out: string[] = [];
    // `import ... from "x"` / `export ... from "x"` (skip pure type clauses).
    const fromRe = /(?:^|\n)\s*(?:import|export)\b([^;\n]*?)\bfrom\s*["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = fromRe.exec(src)) !== null) {
      const clause = (m[1] ?? "").trimStart();
      if (clause.startsWith("type")) continue; // `import type {...}` / `export type {...}`
      out.push(m[2]!);
    }
    // Side-effect imports: `import "x";`
    const sideRe = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
    while ((m = sideRe.exec(src)) !== null) out.push(m[1]!);
    return out;
  }

  function importGraph(entries: string[]): Set<string> {
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file) || !existsSync(file)) continue;
      seen.add(file);
      for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
        const resolved = resolveImport(file, spec);
        if (resolved) {
          if (!PARENT.has(resolved)) PARENT.set(resolved, file);
          queue.push(resolved);
        }
      }
    }
    return seen;
  }

  function chainTo(file: string): string {
    const rels: string[] = [];
    let cur: string | undefined = file;
    let guard = 0;
    while (cur && guard++ < 40) {
      rels.push(cur.replace(/\\/g, "/").replace(/.*\/src\//, "src/"));
      cur = PARENT.get(cur);
    }
    return rels.reverse().join("\n   -> ");
  }
  void chainTo;

  const CANONICAL_ENTRIES = [
    join(SRC_ROOT, "modules/digital-profile/orion-golden/analytics/run-analytics-pipeline.ts"),
    join(SRC_ROOT, "modules/digital-profile/orion-golden/deck-sections/index.ts"),
    join(SRC_ROOT, "modules/digital-profile/orion-golden/deck-sections/run-deck-build.ts"),
  ];

  it("no file in the canonical graph imports the legacy monolithic composer", () => {
    const graph = importGraph(CANONICAL_ENTRIES);
    const offenders = [...graph].filter((f) => LEGACY_COMPOSER_RE.test(f.replace(/\\/g, "/")));
    if (offenders.length) for (const o of offenders) console.error(`\nCHAIN:\n   ${chainTo(o)}\n`);
    assert.deepEqual(offenders, [], `legacy composer reachable from canonical graph: ${offenders.join(", ")}`);
  });

  it("no file in the canonical graph contains subject-identity Glinka literals", () => {
    const graph = importGraph(CANONICAL_ENTRIES);
    const offenders: string[] = [];
    for (const f of graph) {
      const rel = f.replace(/\\/g, "/");
      // fixtures / samples / baselines / tests may legitimately carry baseline data.
      if (/\/(fixtures|__fixtures__|sample-contracts|baselines)\//.test(rel) || /\.test\.ts$/.test(rel)) {
        continue;
      }
      const src = readFileSync(f, "utf8");
      const hit = src.match(IDENTITY_LEAK_RE);
      if (hit) offenders.push(`${rel}: ${hit[0]}`);
    }
    assert.deepEqual(offenders, [], `Glinka literals in canonical runtime graph:\n${offenders.join("\n")}`);
  });

  it("the second-subject smoke itself contains no report-72 path dependency", () => {
    const self = readFileSync(join(HERE, "smoke-orion-subject-universality.ts"), "utf8");
    assert.ok(!/baselines\/report-72/.test(self), "universality proof must not read the Glinka baseline");
  });
});
