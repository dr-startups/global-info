/**
 * Offline acceptance for REMEDIATION_PLAN §0.1 — report-quality-summary aggregator.
 *
 * Builds a fixture job catalog with representative artifacts and asserts the
 * funnel counts / GPT / visuals / slides / arsenkin aggregates. Also checks
 * that canonical prepare writes report-quality-summary.json without breaking
 * the existing prepare smoke path.
 *
 * Run: npm run smoke:report-quality-summary
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";

import {
  buildReportQualitySummary,
  buildReportQualityWarnings,
  mergeJobWarnings,
  toJobReportQuality,
  ReportQualitySummarySchema,
  REPORT_QUALITY_SUMMARY_VERSION,
} from "../src/modules/digital-profile/services/report-quality-summary";
import {
  runCanonicalReportPrepare,
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

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function seedFixtureJobDir(root: string): void {
  mkdirSync(join(root, "analytics"), { recursive: true });
  mkdirSync(join(root, "deck"), { recursive: true });

  writeJson(join(root, "base-collection-manifest.json"), {
    version: "base-collection-manifest-v1",
    searchResultIds: ["sr1", "sr2", "sr3"],
    searchSurfaceItemIds: ["ss1", "ss2"],
    baseCount: 5,
  });
  writeJson(join(root, "composite-serp-observations.json"), {
    compositeDatasetId: "comp-1",
    compositeCount: 12,
    observations: Array.from({ length: 12 }, (_, i) => ({ key: `k${i}` })),
  });
  writeJson(join(root, "analytics", "subject-resolution.json"), {
    schemaVersion: "subject-resolution-v1",
    caseId: "case-q",
    datasetId: "d1",
    reportRunId: "r1",
    generatedAt: new Date().toISOString(),
    sourceHashes: [],
    subjectDisplayName: "Test Subject",
    items: [
      { evidenceRef: "a", decision: "SUBJECT_MATCH", confidence: 0.9, matchedIdentifiers: ["x"], conflictingIdentifiers: [], reasonCode: "full" },
      { evidenceRef: "b", decision: "SUBJECT_MATCH", confidence: 0.85, matchedIdentifiers: ["x"], conflictingIdentifiers: [], reasonCode: "full" },
      { evidenceRef: "c", decision: "AMBIGUOUS", confidence: 0.4, matchedIdentifiers: ["surname"], conflictingIdentifiers: [], reasonCode: "surname_only" },
      { evidenceRef: "d", decision: "AMBIGUOUS", confidence: 0.4, matchedIdentifiers: ["surname"], conflictingIdentifiers: [], reasonCode: "surname_only" },
      { evidenceRef: "e", decision: "AMBIGUOUS", confidence: 0.4, matchedIdentifiers: ["surname"], conflictingIdentifiers: [], reasonCode: "surname_only" },
      { evidenceRef: "f", decision: "OTHER_SUBJECT", confidence: 0.8, matchedIdentifiers: [], conflictingIdentifiers: ["namesake"], reasonCode: "namesake" },
      { evidenceRef: "g", decision: "INSUFFICIENT_IDENTIFIERS", confidence: 0.1, matchedIdentifiers: [], conflictingIdentifiers: [], reasonCode: "empty" },
    ],
  });
  writeJson(join(root, "analytics", "verified-finding-bundle.json"), {
    findings: [{ findingId: "f1" }, { findingId: "f2" }],
  });
  writeJson(join(root, "analytics", "ambiguous-findings.json"), [{ findingId: "af1" }]);
  writeJson(join(root, "analytics", "gpt-case-analysis-diagnostics.json"), {
    status: "FAILED",
    reason: "schema: overallRiskLevel Required",
    at: new Date().toISOString(),
  });
  writeJson(join(root, "deck", "gpt-report-copy.json"), {
    version: "gpt-report-copy-v1",
    promptVersion: "v2",
    caseAnalysisUsed: false,
    fragments: [
      { fragmentKey: "EXECUTIVE_SUMMARY", status: "FALLBACK_ERROR", appliedFields: 0, rejectedFields: [] },
      { fragmentKey: "RU_SERP", status: "APPLIED", appliedFields: 3, rejectedFields: [] },
      { fragmentKey: "RU_SUGGESTIONS", status: "FALLBACK_VALIDATION", appliedFields: 0, rejectedFields: ["narrative:over-budget:900>850"] },
      { fragmentKey: "FRONT_MATTER_MAIN", status: "SKIPPED_DETERMINISTIC", appliedFields: 0, rejectedFields: [] },
      { fragmentKey: "RU_IMAGES", status: "NO_CHANGES", appliedFields: 0, rejectedFields: ["whatWasFound:foreign-domain"] },
    ],
  });
  writeJson(join(root, "visual-assets-by-slot.json"), {
    counts: { serpSnapshots: 1, suggestionPanels: 2, relatedPanels: 0, aiPanels: 1, imageGrids: 2 },
    visualAssets: {},
  });
  writeJson(join(root, "canonical-prepare-summary.json"), {
    visualAssetCount: 6,
    visualAssetWarning: "visual asset build failed: sharp missing",
  });
  writeJson(join(root, "deck", "assembled-deck.json"), {
    slides: [
      { baseSlotId: "p03_executive", narrative: "Вывод.", emptyStateReason: undefined },
      { baseSlotId: "p11_ru_suggestions", emptyStateReason: "no-suggestions", narrative: "Пусто." },
      { baseSlotId: "p14_ru_images_1", emptyStateReason: "VISUAL_ASSET_UNAVAILABLE" },
      { baseSlotId: "p09_ru_serp", bullets: ["строка"], table: { rows: [["a"]] } },
    ],
  });
  writeJson(join(root, "arsenkin-enrichment-state.json"), {
    enrichmentComplete: true,
    enrichmentObservationCount: 40,
    agents: [
      { agentName: "check-top", terminalKind: "SUCCEEDED", observationCount: 10 },
      { agentName: "suggest", terminalKind: "SUCCEEDED", observationCount: 8 },
      { agentName: "paa", terminalKind: "EMPTY_VALID", observationCount: 0 },
      { agentName: "ai-serp", terminalKind: "FAILED", observationCount: 0 },
      { agentName: "check-h", terminalKind: "SUCCEEDED", observationCount: 22 },
    ],
  });
}

describe("report-quality-summary aggregator (§0.1)", () => {
  it("aggregates funnel counts, GPT, visuals, slides and arsenkin from a fixture job dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "rqs-fixture-"));
    seedFixtureJobDir(root);

    const fakePrisma = {
      searchResult: {
        count: async ({ where }: { where: { caseId: string } }) => {
          assert.equal(where.caseId, "case-q");
          return 120;
        },
      },
      searchSurfaceItem: {
        count: async ({ where }: { where: { caseId: string } }) => {
          assert.equal(where.caseId, "case-q");
          return 80;
        },
      },
    };

    const summary = await buildReportQualitySummary({
      jobDir: root,
      caseId: "case-q",
      unifiedJobId: "unified-q",
      prisma: fakePrisma,
    });

    const parsed = ReportQualitySummarySchema.parse(summary);
    assert.equal(parsed.version, REPORT_QUALITY_SUMMARY_VERSION);
    assert.equal(parsed.counts.dbSearchResults, 120);
    assert.equal(parsed.counts.dbSurfaceItems, 80);
    assert.equal(parsed.counts.manifestIds, 5);
    assert.equal(parsed.counts.compositeObservations, 12);
    assert.equal(parsed.counts.subjectMatch, 2);
    assert.equal(parsed.counts.ambiguous, 3);
    assert.equal(parsed.counts.otherSubject, 1);
    assert.equal(parsed.counts.insufficient, 1);
    assert.equal(parsed.counts.verifiedFindings, 2);
    assert.equal(parsed.counts.ambiguousFindings, 1);

    assert.equal(parsed.gpt.stage1.status, "FAILED");
    assert.match(parsed.gpt.stage1.reason ?? "", /schema/);
    assert.equal(parsed.gpt.stage2.applied, 1);
    assert.equal(parsed.gpt.stage2.fallbackError, 1);
    assert.equal(parsed.gpt.stage2.fallbackValidation, 1);
    assert.equal(parsed.gpt.stage2.skippedDeterministic, 1);
    assert.equal(parsed.gpt.stage2.noChanges, 1);
    assert.equal(parsed.gpt.stage2.caseAnalysisUsed, false);
    assert.ok(parsed.gpt.stage2.rejectedFieldsTop.some((r) => r.startsWith("narrative")));

    assert.equal(parsed.visuals.built, 6);
    assert.equal(parsed.visuals.failed, 1);
    assert.match(parsed.visuals.warning ?? "", /sharp/);

    assert.equal(parsed.slides.total, 4);
    assert.equal(parsed.slides.emptyState.length, 2);
    assert.ok(parsed.slides.emptyState.some((e) => e.slotId === "p11_ru_suggestions" && e.reason === "no-suggestions"));
    assert.ok(parsed.slides.withContent >= 1);

    assert.equal(parsed.arsenkin.agents.length, 5);
    assert.equal(parsed.arsenkin.enrichmentComplete, true);
    assert.equal(parsed.arsenkin.enrichmentObservationCount, 40);

    const compact = toJobReportQuality(parsed);
    assert.equal(compact.gpt.stage1Status, "FAILED");
    assert.equal(compact.slides.emptyStateCount, 2);
    assert.equal(compact.arsenkin.agentsFailed, 1);
    assert.equal(compact.arsenkin.agentsOk, 4);
  });

  it("leaves DB counts null when prisma is omitted; survives missing optional artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "rqs-sparse-"));
    mkdirSync(join(root, "analytics"), { recursive: true });
    mkdirSync(join(root, "deck"), { recursive: true });
    writeJson(join(root, "analytics", "subject-resolution.json"), {
      items: [{ decision: "SUBJECT_MATCH" }],
    });
    writeJson(join(root, "deck", "assembled-deck.json"), { slides: [] });

    const summary = await buildReportQualitySummary({
      jobDir: root,
      caseId: "case-sparse",
    });
    assert.equal(summary.counts.dbSearchResults, null);
    assert.equal(summary.counts.dbSurfaceItems, null);
    assert.equal(summary.counts.manifestIds, null);
    assert.equal(summary.counts.compositeObservations, null);
    assert.equal(summary.counts.subjectMatch, 1);
    assert.equal(summary.gpt.stage1.status, "SKIPPED");
    assert.equal(summary.slides.total, 0);
    assert.equal(summary.arsenkin.agents.length, 0);
  });

  it("marks stage1 APPLIED when gpt-case-analysis.json is present", async () => {
    const root = mkdtempSync(join(tmpdir(), "rqs-gpt-ok-"));
    mkdirSync(join(root, "analytics"), { recursive: true });
    mkdirSync(join(root, "deck"), { recursive: true });
    writeJson(join(root, "analytics", "gpt-case-analysis.json"), {
      overallRiskLevel: "высокий",
      executiveConclusion: "ok",
    });
    writeJson(join(root, "deck", "assembled-deck.json"), { slides: [] });
    const summary = await buildReportQualitySummary({ jobDir: root, caseId: "c" });
    assert.equal(summary.gpt.stage1.status, "APPLIED");
  });
});

describe("report-quality warnings mapping (§0.2)", () => {
  it("maps visual / GPT stage1 / stage2 / empty-state into job warning strings", async () => {
    const root = mkdtempSync(join(tmpdir(), "rqs-warn-"));
    seedFixtureJobDir(root);
    const summary = await buildReportQualitySummary({
      jobDir: root,
      caseId: "case-q",
    });
    const warnings = buildReportQualityWarnings(summary);
    assert.ok(warnings.some((w) => w.startsWith("visual-asset-warning:")), warnings.join("|"));
    assert.ok(warnings.some((w) => w.startsWith("gpt-stage1-fallback:")), warnings.join("|"));
    assert.ok(warnings.some((w) => /^gpt-stage2-fallback:2\/\d+$/.test(w)), warnings.join("|"));
    assert.ok(warnings.some((w) => w === "empty-state-slides:2"), warnings.join("|"));
  });

  it("mergeJobWarnings replaces prior quality warnings with the same prefix", () => {
    const merged = mergeJobWarnings(
      ["arsenkin-awaiting-ingest", "gpt-stage1-fallback:old", "empty-state-slides:9"],
      ["gpt-stage1-fallback:schema: x", "empty-state-slides:2", "visual-asset-warning:sharp"]
    );
    assert.deepEqual(merged, [
      "arsenkin-awaiting-ingest",
      "gpt-stage1-fallback:schema: x",
      "empty-state-slides:2",
      "visual-asset-warning:sharp",
    ]);
  });

  it("omits GPT/visual warnings when the funnel is clean", () => {
    const warnings = buildReportQualityWarnings({
      version: REPORT_QUALITY_SUMMARY_VERSION,
      caseId: "c",
      unifiedJobId: "j",
      generatedAt: new Date().toISOString(),
      counts: {
        dbSearchResults: null,
        dbSurfaceItems: null,
        manifestIds: 1,
        compositeObservations: 1,
        subjectMatch: 1,
        ambiguous: 0,
        otherSubject: 0,
        insufficient: 0,
        verifiedFindings: 1,
        ambiguousFindings: 0,
      },
      gpt: {
        stage1: { status: "APPLIED" },
        stage2: {
          applied: 3,
          noChanges: 0,
          skippedDeterministic: 2,
          skippedEmpty: 0,
          skippedCached: 0,
          fallbackError: 0,
          fallbackValidation: 0,
          rejectedFieldsTop: [],
          caseAnalysisUsed: true,
        },
      },
      visuals: { built: 4, failed: 0, warning: null },
      slides: { total: 36, withContent: 30, emptyState: [] },
      arsenkin: { agents: [], enrichmentComplete: true, enrichmentObservationCount: 0 },
    });
    assert.deepEqual(warnings, []);
  });
});

describe("canonical prepare emits report-quality-summary.json", () => {
  function subjectProfile(): ClassifierSubjectProfile {
    return {
      displayName: "Anders Holmström",
      givenNames: ["Anders"],
      familyNames: ["Holmström", "Holmstrom"],
      patronymics: [],
      aliases: ["Anders Holmstrom"],
      transliterations: ["Anders Holmstrom"],
      contextIdentifiers: ["Nordkap Capital"],
      namesakeProfiles: [],
      negativeIdentitySignals: { wrongPatronymics: [], wrongNames: [], unrelatedKnownPersons: [] },
    };
  }

  let k = 0;
  function obs(
    partial: Partial<CompositeObservation> & Pick<CompositeObservation, "kind">
  ): CompositeObservation {
    k += 1;
    return {
      key: `k-${k}`,
      region: "RU",
      engine: "YANDEX",
      query: "Anders Holmström",
      providers: ["yandex"],
      primaryProvider: "yandex",
      evidenceRefs: [],
      ...partial,
    };
  }

  it("writes summary artifact and returns reportQuality on successful prepare", async () => {
    const root = mkdtempSync(join(tmpdir(), "rqs-prepare-"));
    const rows: CompositeObservation[] = [
      obs({
        kind: "organic",
        url: "https://di.se/holmstrom-tax",
        title: "Anders Holmström Nordkap Capital tax probe",
        snippet: "Anders Holmström of Nordkap Capital faces investigation.",
        riskLabel: "adverse",
      }),
      obs({
        kind: "organic",
        url: "https://forbes.com/holmstrom",
        title: "Anders Holmström CEO Nordkap Capital",
        snippet: "Business profile of Anders Holmström.",
      }),
      obs({ kind: "suggestion", suggestion: "Anders Holmström fraud", title: "Anders Holmström fraud" }),
    ];
    const unifiedJobId = "unified-rqs";
    const caseId = "case-rqs";
    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId,
      caseId,
      capturedAt: new Date().toISOString(),
      baseReportRunId: "base-rqs",
      searchResultIds: [],
      searchSurfaceItemIds: [],
      baseCount: rows.length,
      actualProviders: [{ providerId: "yandex", runtime: "real", status: "completed" }],
      realCollectionSufficient: true,
    };
    // Persist funnel inputs the aggregator expects at the job root.
    writeJson(join(root, "base-collection-manifest.json"), {
      ...manifest,
      searchResultIds: ["a", "b"],
      searchSurfaceItemIds: ["c"],
    });
    const merge = await mergeCompositeSerp({ manifest, fixtureBaseRows: rows });
    writeJson(join(root, "composite-serp-observations.json"), merge);
    const binding = buildReportDataBinding({
      caseId,
      unifiedJobId,
      baseReportRunId: manifest.baseReportRunId,
      enrichmentRunIds: [],
      compositeDatasetId: merge.compositeDatasetId,
      providerCounts: merge.providerCounts,
    });
    const fakeRender: DeckRenderAdapter = async (r) => ({
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
      gptCaller: null,
    };
    const res = await runCanonicalReportPrepare(input);
    assert.equal(res.ok, true);
    assert.ok(existsSync(join(root, "report-quality-summary.json")), "summary must be written");
    assert.ok(res.reportQuality, "result must carry compact reportQuality");
    assert.equal(res.reportQuality!.version, REPORT_QUALITY_SUMMARY_VERSION);
    assert.ok((res.reportQuality!.counts.compositeObservations ?? 0) >= rows.length);
    assert.ok((res.reportQuality!.slides.total ?? 0) > 0);
    assert.ok(Array.isArray(res.qualityWarnings), "prepare must return qualityWarnings");
    // gptCaller=null → stage1 SKIPPED (no fallback warning); empty slides may appear.
    assert.ok(
      !res.qualityWarnings!.some((w) => w.startsWith("gpt-stage1-fallback:")),
      `unexpected stage1 fallback: ${res.qualityWarnings!.join("|")}`
    );

    const onDisk = JSON.parse(readFileSync(join(root, "report-quality-summary.json"), "utf8"));
    assert.equal(onDisk.version, REPORT_QUALITY_SUMMARY_VERSION);
    assert.equal(onDisk.gpt.stage1.status, "SKIPPED");
  });
});
