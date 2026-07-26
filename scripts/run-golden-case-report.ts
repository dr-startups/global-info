/**
 * §0.3 — golden-case offline report harness.
 *
 * Runs `runCanonicalReportPrepare` on fixtures/golden-case with a fake renderer,
 * prints report-quality-summary, and compares a stable projection to
 * fixtures/golden-case/baseline.json.
 *
 * Usage:
 *   NETWORK_CALLS=0 npx tsx scripts/run-golden-case-report.ts
 *   NETWORK_CALLS=0 npx tsx scripts/run-golden-case-report.ts --update-baseline
 *   NETWORK_CALLS=0 npx tsx scripts/run-golden-case-report.ts --check-determinism
 *
 * npm: npm run golden-case / npm run smoke:golden-case
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runCanonicalReportPrepare,
  type CanonicalPrepareInput,
} from "../src/modules/digital-profile/services/canonical-report-prepare";
import {
  mergeCompositeSerp,
  buildReportDataBinding,
} from "../src/modules/digital-profile/services/composite-serp-merge";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";
import type { ClassifierSubjectProfile } from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { DeckRenderAdapter } from "../src/modules/digital-profile/services/render-deck-artifacts";
import type { ReportQualitySummary } from "../src/modules/digital-profile/services/report-quality-summary";
import {
  buildGoldenCaseObservations,
  goldenCaseObservationStats,
} from "../fixtures/golden-case/build-observations";
import type { DatabaseProfileHitInput } from "../src/modules/digital-profile/services/compliance-inventory-adapter";
import type { AnalystOverridesBundle } from "../src/modules/digital-profile/services/analyst-overrides-loader";
import type { EvidenceSupplementBundle } from "../src/modules/digital-profile/services/evidence-supplement-adapter";
import {
  buildSurfacePanelSvg,
  svgToPngBase64,
} from "../src/modules/digital-profile/orion-golden/assets/media-asset-svg";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(ROOT, "fixtures", "golden-case");
const BASELINE_PATH = join(FIXTURE_DIR, "baseline.json");
const PROFILE_PATH = join(FIXTURE_DIR, "subject-profile.json");
const COMPLIANCE_HITS_PATH = join(FIXTURE_DIR, "compliance-hits.json");
const ANALYST_OVERRIDES_PATH = join(FIXTURE_DIR, "analyst-overrides.json");
const EVIDENCE_SUPPLEMENT_PATH = join(FIXTURE_DIR, "evidence-supplement.json");

const CASE_ID = "case-golden-holmstrom";
const UNIFIED_JOB_ID = "unified-golden-1";
const BASE_REPORT_RUN_ID = "base-golden-1";

process.env.NETWORK_CALLS = "0";

export type GoldenBaseline = {
  version: "golden-case-baseline-v1";
  observationCount: number;
  observationStats: Record<string, number>;
  /** Stable projection of report-quality-summary (no generatedAt). */
  quality: Omit<ReportQualitySummary, "generatedAt">;
};

function loadSubjectProfile(): ClassifierSubjectProfile {
  return JSON.parse(readFileSync(PROFILE_PATH, "utf8")) as ClassifierSubjectProfile;
}

function loadComplianceHits(): DatabaseProfileHitInput[] {
  if (!existsSync(COMPLIANCE_HITS_PATH)) return [];
  return JSON.parse(readFileSync(COMPLIANCE_HITS_PATH, "utf8")) as DatabaseProfileHitInput[];
}

function loadAnalystOverrides(): AnalystOverridesBundle | null {
  if (!existsSync(ANALYST_OVERRIDES_PATH)) return null;
  return JSON.parse(readFileSync(ANALYST_OVERRIDES_PATH, "utf8")) as AnalystOverridesBundle;
}

async function loadEvidenceSupplement(): Promise<EvidenceSupplementBundle | null> {
  if (!existsSync(EVIDENCE_SUPPLEMENT_PATH)) return null;
  const bundle = JSON.parse(
    readFileSync(EVIDENCE_SUPPLEMENT_PATH, "utf8")
  ) as EvidenceSupplementBundle;
  // Fill empty imageData with a deterministic offline PNG (keeps git fixture small).
  for (const shot of bundle.serpScreenshots ?? []) {
    if (shot.imageData && shot.imageData.length >= 80) continue;
    shot.imageData = await svgToPngBase64(
      buildSurfacePanelSvg({
        title: shot.title ?? "Golden SERP fixture",
        subtitle: "golden-case",
        engineLabel: String(shot.engine ?? "Yandex"),
        items: [
          { label: "Anders Holmström — Nordkap Capital", meta: "ru.example" },
          { label: "Fixture SERP row (real screenshot path)", meta: "news.example" },
        ],
      })
    );
  }
  return bundle;
}

function assertEvidenceSupplementSlides(artifactsDir: string): void {
  const visualsPath = join(artifactsDir, "visual-assets-by-slot.json");
  assert.ok(existsSync(visualsPath), "visual-assets-by-slot.json missing");
  const visuals = JSON.parse(readFileSync(visualsPath, "utf8")) as {
    counts?: { realSerpSnapshots?: number };
    visualAssets?: Record<string, Array<{ kind?: string; assetRef?: string }>>;
  };
  assert.ok((visuals.counts?.realSerpSnapshots ?? 0) >= 1, "expected real SERP snapshot count ≥ 1");
  const p10 = visuals.visualAssets?.["p10_ru_serp_visual"]?.[0];
  assert.ok(p10, "p10_ru_serp_visual missing");
  assert.equal(p10.kind, "live_serp", `p10 must use real screenshot, got kind=${p10.kind}`);
  assert.match(String(p10.assetRef), /_real_golden-serp-ru-1$/);

  const assembled = JSON.parse(
    readFileSync(join(artifactsDir, "deck", "assembled-deck.json"), "utf8")
  ) as { slides: Array<{ baseSlotId?: string; narrative?: string }> };
  const p13 = assembled.slides.find((s) => s.baseSlotId === "p13_ru_wikipedia");
  assert.ok(p13, "p13_ru_wikipedia missing");
  assert.match(
    String(p13.narrative ?? ""),
    /проверк|Wikipedia/i,
    `p13 should mention Wikipedia check: ${p13.narrative}`
  );
}

function assertComplianceSlides(artifactsDir: string): void {
  const assembledPath = join(artifactsDir, "deck", "assembled-deck.json");
  assert.ok(existsSync(assembledPath), "assembled-deck.json missing");
  const assembled = JSON.parse(readFileSync(assembledPath, "utf8")) as {
    slides: Array<{
      baseSlotId?: string;
      table?: { rows?: unknown[][] };
      whatWasFound?: string;
    }>;
  };
  const bySlot = new Map(assembled.slides.map((s) => [s.baseSlotId, s]));
  const p33 = bySlot.get("p33_compliance_toc");
  const p34 = bySlot.get("p34_dow_jones");
  const p35 = bySlot.get("p35_lexis_visual");
  assert.ok(p33, "p33_compliance_toc missing");
  assert.ok(p34, "p34_dow_jones missing");
  assert.ok(p35, "p35_lexis_visual missing");
  assert.equal(p33!.table?.rows?.length, 2, "p33 must show 2 compliance hit rows");
  assert.ok(
    (p34!.whatWasFound ?? "").includes("Потенциальное совпадение"),
    `p34 Dow Jones card empty: ${p34!.whatWasFound}`
  );
  assert.ok(
    (p35!.whatWasFound ?? "").includes("Потенциальное совпадение"),
    `p35 LexisNexis card empty: ${p35!.whatWasFound}`
  );
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stableQuality(summary: ReportQualitySummary): GoldenBaseline["quality"] {
  const { generatedAt: _g, ...rest } = summary;
  return {
    ...rest,
    slides: {
      ...rest.slides,
      emptyState: [...rest.slides.emptyState].sort((a, b) =>
        a.slotId === b.slotId ? a.reason.localeCompare(b.reason) : a.slotId.localeCompare(b.slotId)
      ),
    },
    gpt: {
      ...rest.gpt,
      stage2: {
        ...rest.gpt.stage2,
        rejectedFieldsTop: [...rest.gpt.stage2.rejectedFieldsTop].sort(),
      },
    },
    arsenkin: {
      ...rest.arsenkin,
      agents: [...rest.arsenkin.agents].sort((a, b) => a.name.localeCompare(b.name)),
    },
  };
}

export async function runGoldenCasePrepare(artifactsDir: string): Promise<{
  summary: ReportQualitySummary;
  baseline: GoldenBaseline;
  prepareOk: boolean;
}> {
  const rows = buildGoldenCaseObservations();
  const profile = loadSubjectProfile();

  const searchResultIds = rows
    .map((r) => r.baseSearchResultId)
    .filter((x): x is string => Boolean(x));
  const searchSurfaceItemIds = rows
    .map((r) => r.baseSearchSurfaceItemId)
    .filter((x): x is string => Boolean(x));

  const manifest: BaseCollectionManifest = {
    version: "base-collection-manifest-v1",
    unifiedJobId: UNIFIED_JOB_ID,
    caseId: CASE_ID,
    capturedAt: "2026-01-15T12:00:00.000Z",
    baseReportRunId: BASE_REPORT_RUN_ID,
    searchResultIds,
    searchSurfaceItemIds,
    baseCount: rows.length,
    actualProviders: [
      { providerId: "yandex", runtime: "real", status: "completed" },
      { providerId: "serper", runtime: "real", status: "completed" },
      { providerId: "arsenkin", runtime: "real", status: "completed" },
    ],
    realCollectionSufficient: true,
  };

  // Persist funnel inputs the quality aggregator expects (orchestrator normally writes these).
  writeJson(join(artifactsDir, "base-collection-manifest.json"), manifest);
  writeJson(join(artifactsDir, "composite-serp-observations.json"), {
    compositeDatasetId: `composite-${UNIFIED_JOB_ID}`,
    compositeCount: rows.length,
    observations: rows,
  });
  writeJson(join(artifactsDir, "arsenkin-enrichment-state.json"), {
    enrichmentComplete: true,
    enrichmentObservationCount: rows.filter((r) => r.primaryProvider === "arsenkin").length,
    agents: [
      { agentName: "ai-serp", terminalKind: "EMPTY_VALID", observationCount: 12 },
      { agentName: "suggest", terminalKind: "EMPTY_VALID", observationCount: 54 },
      { agentName: "paa", terminalKind: "EMPTY_VALID", observationCount: 36 },
    ],
  });
  writeJson(join(artifactsDir, "subject-identity-profile.json"), profile);

  const merge = await mergeCompositeSerp({ manifest, fixtureBaseRows: rows });
  // Keep full fixture row set (merge may reshape; golden case measures prepare on our corpus).
  merge.observations = rows;
  merge.compositeCount = rows.length;
  merge.providerCounts.composite = rows.length;

  const binding = buildReportDataBinding({
    caseId: CASE_ID,
    unifiedJobId: UNIFIED_JOB_ID,
    baseReportRunId: BASE_REPORT_RUN_ID,
    enrichmentRunIds: ["enr-golden-ai", "enr-golden-suggest", "enr-golden-paa"],
    compositeDatasetId: merge.compositeDatasetId,
    providerCounts: merge.providerCounts,
  });
  // Freeze binding timestamp for determinism of any downstream hashes that might read it.
  binding.generatedAt = "2026-01-15T12:00:00.000Z";

  const fakeRender: DeckRenderAdapter = async (r) => ({
    pdf: undefined,
    pptx: undefined,
    pngDir: undefined,
    pageCount: r.deckManifest.pageCount,
    renderer: "fake-golden",
  });

  const input: CanonicalPrepareInput = {
    caseId: CASE_ID,
    unifiedJobId: UNIFIED_JOB_ID,
    artifactsDir,
    binding,
    merge,
    subjectProfile: profile,
    render: fakeRender,
    gptCaller: null,
    complianceHits: loadComplianceHits(),
    analystOverrides: loadAnalystOverrides(),
    evidenceSupplement: await loadEvidenceSupplement(),
  };

  const res = await runCanonicalReportPrepare(input);
  assertComplianceSlides(artifactsDir);
  assertEvidenceSupplementSlides(artifactsDir);
  const overridesPath = join(artifactsDir, "analytics", "analyst-overrides-applied.json");
  assert.ok(existsSync(overridesPath), "analyst-overrides-applied.json missing");
  const overridesApplied = JSON.parse(readFileSync(overridesPath, "utf8")) as {
    count: number;
    applied: Array<{ kind: string }>;
  };
  assert.ok(overridesApplied.count >= 3, `expected ≥3 applied overrides, got ${overridesApplied.count}`);
  assert.ok(overridesApplied.applied.some((a) => a.kind === "classification_neutral"));
  assert.ok(overridesApplied.applied.some((a) => a.kind === "classification_adverse"));
  assert.ok(
    overridesApplied.applied.some(
      (a) => a.kind === "identity_other_subject" || a.kind === "manual_review_wrong_subject"
    )
  );
  const summaryPath = join(artifactsDir, "report-quality-summary.json");
  assert.ok(existsSync(summaryPath), "report-quality-summary.json missing");
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as ReportQualitySummary;

  const baseline: GoldenBaseline = {
    version: "golden-case-baseline-v1",
    observationCount: rows.length,
    observationStats: goldenCaseObservationStats(rows),
    quality: stableQuality(summary),
  };

  return { summary, baseline, prepareOk: res.ok === true };
}

function printSummary(summary: ReportQualitySummary): void {
  const q = summary;
  console.log("--- golden-case report-quality-summary ---");
  console.log(
    JSON.stringify(
      {
        counts: q.counts,
        gpt: { stage1: q.gpt.stage1.status, stage2Applied: q.gpt.stage2.applied },
        visuals: q.visuals,
        slides: {
          total: q.slides.total,
          withContent: q.slides.withContent,
          emptyStateCount: q.slides.emptyState.length,
          emptyState: q.slides.emptyState,
        },
        arsenkin: {
          enrichmentComplete: q.arsenkin.enrichmentComplete,
          enrichmentObservationCount: q.arsenkin.enrichmentObservationCount,
          agents: q.arsenkin.agents.length,
        },
      },
      null,
      2
    )
  );
}

function diffJson(expected: unknown, actual: unknown, path = ""): string[] {
  const diffs: string[] = [];
  if (typeof expected !== typeof actual) {
    diffs.push(`${path || "$"}: type ${typeof expected} → ${typeof actual}`);
    return diffs;
  }
  if (expected === null || actual === null || typeof expected !== "object") {
    if (expected !== actual) {
      diffs.push(`${path || "$"}: ${JSON.stringify(expected)} → ${JSON.stringify(actual)}`);
    }
    return diffs;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      diffs.push(`${path}: array mismatch`);
      return diffs;
    }
    if (expected.length !== actual.length) {
      diffs.push(`${path}.length: ${expected.length} → ${actual.length}`);
    }
    const n = Math.max(expected.length, actual.length);
    for (let i = 0; i < n; i++) {
      diffs.push(...diffJson(expected[i], actual[i], `${path}[${i}]`));
    }
    return diffs;
  }
  const ek = Object.keys(expected as object).sort();
  const ak = Object.keys(actual as object).sort();
  for (const k of new Set([...ek, ...ak])) {
    if (!(k in (expected as object))) {
      diffs.push(`${path}.${k}: missing in baseline, present in actual`);
      continue;
    }
    if (!(k in (actual as object))) {
      diffs.push(`${path}.${k}: present in baseline, missing in actual`);
      continue;
    }
    diffs.push(
      ...diffJson(
        (expected as Record<string, unknown>)[k],
        (actual as Record<string, unknown>)[k],
        path ? `${path}.${k}` : k
      )
    );
  }
  return diffs;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const updateBaseline = argv.includes("--update-baseline");
  const checkDeterminism = argv.includes("--check-determinism") || !updateBaseline;

  const dirA = mkdtempSync(join(tmpdir(), "golden-case-a-"));
  try {
    const { summary, baseline, prepareOk } = await runGoldenCasePrepare(dirA);
    assert.equal(prepareOk, true, "canonical prepare must succeed");
    printSummary(summary);

    if (checkDeterminism) {
      const dirB = mkdtempSync(join(tmpdir(), "golden-case-b-"));
      try {
        const second = await runGoldenCasePrepare(dirB);
        const d = diffJson(baseline, second.baseline);
        if (d.length) {
          console.error("DETERMINISM FAIL — two runs differ:");
          for (const line of d.slice(0, 40)) console.error(`  ${line}`);
          return 1;
        }
        console.log("determinism: OK (two runs identical)");
      } finally {
        rmSync(dirB, { recursive: true, force: true });
      }
    }

    if (updateBaseline) {
      writeJson(BASELINE_PATH, baseline);
      console.log(`baseline updated: ${BASELINE_PATH}`);
      return 0;
    }

    if (!existsSync(BASELINE_PATH)) {
      console.error(`baseline missing: ${BASELINE_PATH}`);
      console.error("Run with --update-baseline to create it.");
      return 1;
    }

    const expected = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as GoldenBaseline;
    const diffs = diffJson(expected, baseline);
    if (diffs.length) {
      console.error("BASELINE MISMATCH:");
      for (const line of diffs.slice(0, 60)) console.error(`  ${line}`);
      console.error("If the change is intentional, re-run with --update-baseline.");
      return 1;
    }
    console.log("baseline: OK");
    return 0;
  } finally {
    rmSync(dirA, { recursive: true, force: true });
  }
}

const invokedAsCli = process.argv[1]?.replace(/\\/g, "/").endsWith("run-golden-case-report.ts");
if (invokedAsCli) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
