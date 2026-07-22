/**
 * Stage 1 — offline contract/schema + characterization tests.
 * NETWORK_CALLS=0. No live providers, no production ThemeSet wiring.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it, before } from "node:test";
import {
  buildArchitectureManifest,
  parseArchitectureManifest,
  safeParseArchitectureManifest,
  catalogLlmUsagePoints,
} from "../src/modules/digital-profile/orion-golden/architecture/orion-architecture-manifest";
import {
  STAGE1_CONTRACT_VALIDATORS,
  STAGE1_REGRESSION_FIXTURES,
  characterizeFixture,
  validateStage1Contract,
  type Stage1ContractName,
} from "../src/modules/digital-profile/orion-golden/contracts";
import {
  sampleAssembledDeckModel,
  sampleCompositeDataset,
  sampleExecutiveSummary,
  sampleFinding,
  sampleCanonicalClaimsBundle,
  sampleObservationDispositionLedger,
  sampleClientSummaryPack,
  sampleComposedClientSummary,
  sampleRepresentativeEvidenceSelection,
  sampleSectionPack,
  sampleSubjectResolution,
  sampleSurfaceAnalysis,
  sampleSurfaceFragment,
  sampleVerifiedFindingBundle,
} from "../src/modules/digital-profile/orion-golden/contracts/sample-contracts";

const ROOT = join(__dirname, "..");
const BASELINE_DIR = join(ROOT, "baselines", "report-72");

before(() => {
  process.env.NETWORK_CALLS = "0";
});

describe("orion-stage1 NETWORK_CALLS", () => {
  it("forces NETWORK_CALLS=0", () => {
    assert.equal(process.env.NETWORK_CALLS, "0");
  });
});

describe("orion-stage1 contract schemas", () => {
  const samples: Record<Stage1ContractName, unknown> = {
    CompositeDataset: sampleCompositeDataset(),
    SubjectResolution: sampleSubjectResolution(),
    SurfaceAnalysis: sampleSurfaceAnalysis(),
    Finding: sampleFinding(),
    VerifiedFindingBundle: sampleVerifiedFindingBundle(),
    ExecutiveSummary: sampleExecutiveSummary(),
    SectionPack: sampleSectionPack(),
    SurfaceFragment: sampleSurfaceFragment(),
    AssembledDeckModel: sampleAssembledDeckModel(),
    ObservationDispositionLedger: sampleObservationDispositionLedger(),
    CanonicalClaimsBundle: sampleCanonicalClaimsBundle(),
    RepresentativeEvidenceSelection: sampleRepresentativeEvidenceSelection(),
    ClientSummaryPack: sampleClientSummaryPack(),
    ComposedClientSummary: sampleComposedClientSummary(),
  };

  for (const name of Object.keys(STAGE1_CONTRACT_VALIDATORS) as Stage1ContractName[]) {
    it(`validates ${name} sample with required envelope fields`, () => {
      const parsed = validateStage1Contract(name, samples[name]);
      assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
      if (parsed.success) {
        const v = parsed.data as {
          schemaVersion: string;
          caseId: string;
          datasetId: string;
          sourceHashes: string[];
          evidenceRefs: string[];
        };
        assert.ok(v.schemaVersion.length > 0);
        assert.ok(v.caseId.length > 0);
        assert.ok(v.datasetId.length > 0);
        assert.ok(Array.isArray(v.sourceHashes));
        assert.ok(Array.isArray(v.evidenceRefs));
      }
    });

    it(`rejects ${name} without schemaVersion`, () => {
      const broken = { ...(samples[name] as object) } as Record<string, unknown>;
      delete broken.schemaVersion;
      const parsed = validateStage1Contract(name, broken);
      assert.equal(parsed.success, false);
    });
  }

  it("SubjectResolution encodes SUBJECT_MATCH and OTHER_SUBJECT", () => {
    const sr = sampleSubjectResolution();
    const decisions = new Set(sr.items.map((i) => i.decision));
    assert.ok(decisions.has("SUBJECT_MATCH"));
    assert.ok(decisions.has("OTHER_SUBJECT"));
  });
});

describe("orion-stage1 architecture manifest", () => {
  it("builds and parses a manifest with complete enrichmentRunIds field", () => {
    const manifest = buildArchitectureManifest({
      caseId: "c1",
      datasetId: "d1",
      canonicalBaseReportRunId: "base-1",
      enrichmentRunIds: ["e1", "e2"],
      effectiveCompositeDatasetId: "composite-1",
      notes: ["stage1"],
    });
    assert.equal(manifest.enrichmentRunIds.length, 2);
    assert.ok(manifest.llmUsagePoints.length >= catalogLlmUsagePoints().length);
    assert.ok(manifest.destructiveReplacementPoints.length > 0);
    assert.ok(manifest.staleForeignArtifactRisks.length > 0);
    const roundTrip = parseArchitectureManifest(JSON.parse(JSON.stringify(manifest)));
    assert.equal(roundTrip.canonicalBaseReportRunId, "base-1");
  });

  it("loads baselines/report-72/architecture-manifest.json", () => {
    const path = join(BASELINE_DIR, "architecture-manifest.json");
    assert.ok(existsSync(path), `missing ${path}`);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = safeParseArchitectureManifest(raw);
    assert.equal(parsed.success, true, parsed.success ? "" : JSON.stringify(parsed.error.issues));
    if (parsed.success) {
      assert.ok(Array.isArray(parsed.data.enrichmentRunIds));
      assert.ok(parsed.data.llmUsagePoints.some((p) => p.id === "classic-render-reads-synthesis"));
    }
  });
});

describe("orion-stage1 regression fixtures", () => {
  it("includes all eight required defect flags", () => {
    const flags = new Set(STAGE1_REGRESSION_FIXTURES.map((f) => f.defectFlag));
    for (const required of [
      "REPEATED_TOC_PAGE_SUFFIX",
      "RED_MARKER_WITHOUT_LABEL",
      "OTHER_SUBJECT_ENTERING_KPI",
      "NOT_COLLECTED_SHOWN_AS_ZERO_PERCENT",
      "STALE_ARSENKIN_ONLY_BINDING",
      "ADVERSE_FINDING_ABSENT_FROM_SUMMARY",
      "TRUNCATED_AI_LEXIS_SENTENCE",
      "EMPTY_FULL_PAGE_STATE",
    ] as const) {
      assert.ok(flags.has(required), `missing fixture for ${required}`);
    }
    assert.equal(STAGE1_REGRESSION_FIXTURES.length, 8);
  });

  for (const fixture of STAGE1_REGRESSION_FIXTURES) {
    it(`characterizes ${fixture.id}`, () => {
      const result = characterizeFixture(fixture);
      assert.equal(result.matched, true, JSON.stringify(result));
    });
  }
});

type StatusField<T> = { status: "MEASURED" | "DERIVED" | "UNAVAILABLE"; value: T; note?: string };

describe("orion-stage1 report №72 baseline", () => {
  it("loads baseline.json with per-field MEASURED/DERIVED/UNAVAILABLE (no blanket ARTIFACTS_MISSING)", () => {
    const path = join(BASELINE_DIR, "baseline.json");
    assert.ok(existsSync(path), `missing ${path}`);
    const baseline = JSON.parse(readFileSync(path, "utf8")) as {
      overallStatus: StatusField<string>;
      pageCount: StatusField<number>;
      pageSizePt: StatusField<{ width: number; height: number }>;
      pdf: { sha256: StatusField<string>; pageCount: StatusField<number> };
      slideIds: StatusField<string[]>;
      baseSlots: StatusField<{ count: number }>;
      continuations: StatusField<{ countBeyondRegistry: number; explicitContinuationPages: number[] }>;
      providerCounts: StatusField<unknown>;
      datasetCounts: StatusField<unknown>;
      kpiDenominators: StatusField<unknown>;
      geometryGate: StatusField<null>;
      clientCopyGate: StatusField<{ issueCount: number }>;
      acceptanceGate: StatusField<null>;
      metricConsistencyGate: StatusField<unknown>;
      artifactFingerprints: StatusField<Array<{ sha256: string; present: boolean }>>;
      missingRunArtifacts: StatusField<string[]>;
    };

    assert.notEqual(baseline.overallStatus.value, "ARTIFACTS_MISSING");
    assert.equal(baseline.overallStatus.value, "PARTIAL_BASELINE");
    assert.equal(baseline.pageCount.status, "MEASURED");
    assert.equal(baseline.pageCount.value, 43);
    assert.equal(baseline.pageSizePt.status, "MEASURED");
    assert.equal(baseline.pageSizePt.value.width, 921.6);
    assert.equal(baseline.pageSizePt.value.height, 576);
    assert.equal(
      baseline.pdf.sha256.value,
      "78adc2e3708feb551521b2ac6b75958947d46e241f6f5162a7e6c65e343d7091"
    );
    assert.equal(baseline.baseSlots.status, "DERIVED");
    assert.equal(baseline.baseSlots.value.count, 36);
    assert.equal(baseline.continuations.status, "DERIVED");
    assert.equal(baseline.continuations.value.countBeyondRegistry, 7);
    assert.deepEqual(baseline.continuations.value.explicitContinuationPages, [35, 36, 37, 38]);
    assert.equal(baseline.slideIds.status, "DERIVED");
    assert.equal(baseline.slideIds.value.length, 43);
    assert.equal(baseline.providerCounts.status, "MEASURED");
    assert.equal(baseline.kpiDenominators.status, "MEASURED");
    assert.equal(baseline.geometryGate.status, "UNAVAILABLE");
    assert.equal(baseline.acceptanceGate.status, "UNAVAILABLE");
    assert.equal(baseline.clientCopyGate.status, "MEASURED");
    assert.ok(baseline.clientCopyGate.value.issueCount >= 1);
    assert.equal(baseline.metricConsistencyGate.status, "DERIVED");
    assert.equal(baseline.artifactFingerprints.status, "MEASURED");
    assert.ok(baseline.artifactFingerprints.value.some((f) => f.present && f.sha256.startsWith("78adc2e3")));
    assert.equal(baseline.missingRunArtifacts.status, "UNAVAILABLE");
    for (const required of [
      "final-deck-manifest.json",
      "first36-acceptance.json",
      "geometry-artifacts.json",
      "arsenkin-report-binding.json",
      "rendered-client.pptx",
    ]) {
      assert.ok(
        baseline.missingRunArtifacts.value.includes(required),
        `missing blocker entry: ${required}`
      );
    }
  });

  it("persists PDF artifact when present on disk", () => {
    const pdfPath = join(BASELINE_DIR, "artifacts", "orion-classic-audit-v72.pdf");
    if (!existsSync(pdfPath)) {
      // *.pdf may be gitignored; fingerprint in baseline.json remains authoritative.
      return;
    }
    const sha = createHash("sha256").update(readFileSync(pdfPath)).digest("hex");
    assert.equal(sha, "78adc2e3708feb551521b2ac6b75958947d46e241f6f5162a7e6c65e343d7091");
  });
});
