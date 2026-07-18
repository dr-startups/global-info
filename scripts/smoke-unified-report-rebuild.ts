/**
 * Offline «Пересобрать отчёт» + self-conflicting negative identity signals.
 * NETWORK_CALLS=0 npx tsx --test scripts/smoke-unified-report-rebuild.ts
 *
 * Covers:
 *  1. Profiles that list the subject's own name/transliteration among negative
 *     signals are sanitized — genuine subject mentions classify SUBJECT_MATCH.
 *  2. Rebuild eligibility: COMPLETED jobs only, lineage-safe, fail-closed.
 *  3. Rebuild transition: same jobId, COMPOSITE_MERGE (composite regenerated,
 *     then full prepare), refreshed job-scoped subject profile from case root,
 *     zero base/Arsenkin calls, one prepare/render, back to REPORT_READY.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  saveUnifiedCollectionJob,
  writeUnifiedArtifact,
  readUnifiedArtifact,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  evaluateUnifiedReportRebuildEligibility,
  rebuildUnifiedReport,
} from "../src/modules/digital-profile/services/unified-report-rebuild";
import { runUnifiedCollectionTick } from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { emptyCoverage } from "../src/modules/digital-profile/services/unified-collection-types";
import type { CompositeMergeResult } from "../src/modules/digital-profile/services/composite-serp-merge";
import type { ReportDataBinding } from "../src/modules/digital-profile/services/unified-collection-types";
import {
  classifySubjectRelevance,
  subjectIdentityFromProfile,
  isSelfConflictingNegativeSignal,
  ownNameTextOfVariants,
  type ClassifierSubjectProfile,
} from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { buildSubjectIdentityProfile } from "../src/modules/digital-profile/orion-golden/identity/subject-identity-profile-builder";
import {
  ORION_GOLDEN_QA_STORAGE_ROOT,
  caseScopedArtifactRoot,
} from "../src/modules/digital-profile/orion-golden/evidence/admin-review-decision-store";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

const AGENTS = [
  "ARSENKIN_SEARCH_TOP_REAL",
  "ARSENKIN_SUGGESTIONS_REAL",
  "ARSENKIN_PAA_REAL",
  "ARSENKIN_AI_SEARCH_REAL",
  "ARSENKIN_URL_AUDIT_REAL",
];

/** Profile poisoned exactly like the live defect: own name in negative signals. */
function poisonedProfile(): ClassifierSubjectProfile {
  return {
    displayName: "Дерипаска Олег Владимирович",
    fullNameRu: { lastName: "Дерипаска", firstName: "Олег", patronymic: "Владимирович" },
    aliases: ["Дерипаска Олег Владимирович", "Дерипаска"],
    transliterations: ["deripaska oleg vladimirovich", "oleg deripaska"],
    contextIdentifiers: [],
    namesakeProfiles: [
      { label: "Дерипаска Олег Игоревич (тёзка)", noiseTerms: ["игоревич", "дерипаска"] },
    ],
    negativeIdentitySignals: {
      wrongPatronymics: ["володимирович", "владимирович"],
      wrongNames: ["дерипаск", "deripaska", "олег владимирович", "oleg vladimirovich"],
      unrelatedKnownPersons: ["дерипаск", "deripaska", "олег владимирович"],
    },
  };
}

describe("self-conflicting negative identity signals", () => {
  it("drops own-name entries from negative signals; keeps real namesake terms", () => {
    const identity = subjectIdentityFromProfile(poisonedProfile());
    assert.deepEqual(identity.wrongFirstNames, [], "own name variants dropped from wrongNames");
    assert.deepEqual(identity.unrelatedKnownPersons, [], "own tokens dropped from unrelated");
    assert.ok(
      identity.wrongPatronymics.includes("володимирович"),
      "genuinely wrong patronymic kept"
    );
    assert.ok(
      !identity.wrongPatronymics.includes("владимирович"),
      "own patronymic dropped from wrongPatronymics"
    );
    assert.ok(identity.namesakeNoise.includes("игоревич"), "namesake patronymic kept");
    assert.ok(!identity.namesakeNoise.includes("дерипаска"), "own surname dropped from noise");
  });

  it("genuine subject mention classifies SUBJECT_MATCH despite poisoned profile", () => {
    const identity = subjectIdentityFromProfile(poisonedProfile());
    const res = classifySubjectRelevance(
      {
        inventoryId: "i1",
        caseId: "c",
        reportRunId: "r",
        source: "serp_observation",
        provider: "yandex",
        region: "RU",
        query: "Дерипаска Олег Владимирович",
        collectedAt: new Date(0).toISOString(),
        evidenceType: "search_result",
        title: "Дерипаска Олег Владимирович — предприниматель, основатель компании",
        snippet: "Олег Дерипаска — российский предприниматель.",
        sourceUrl: "https://example.com/deripaska",
        rawMetadata: {},
      },
      identity
    );
    assert.equal(res.decision, "SUBJECT_MATCH", `reason=${res.reasonCode}`);
    assert.deepEqual(res.conflictingIdentifiers, []);
  });

  it("namesake conflict still detected (other patronymic → not SUBJECT_MATCH)", () => {
    const identity = subjectIdentityFromProfile(poisonedProfile());
    const res = classifySubjectRelevance(
      {
        inventoryId: "i2",
        caseId: "c",
        reportRunId: "r",
        source: "serp_observation",
        provider: "yandex",
        region: "RU",
        query: "Дерипаска",
        collectedAt: new Date(0).toISOString(),
        evidenceType: "search_result",
        title: "Дерипаска Олег Игоревич — однофамилец",
        snippet: "",
        sourceUrl: "https://example.com/other",
        rawMetadata: {},
      },
      identity
    );
    assert.notEqual(res.decision, "SUBJECT_MATCH");
    assert.ok(res.conflictingIdentifiers.length > 0, "namesake noise still fires");
  });

  it("builder filters self-conflicting unrelatedKnownPersons input", () => {
    const profile = buildSubjectIdentityProfile({
      caseId: "case-builder",
      subjectName: "Дерипаска Олег Владимирович",
      unrelatedKnownPersons: ["deripaska", "олег владимирович", "Петров Игорь Саулович"],
    });
    assert.deepEqual(profile.negativeIdentitySignals.unrelatedKnownPersons, [
      "Петров Игорь Саулович",
    ]);
    assert.deepEqual(profile.negativeIdentitySignals.wrongNames, ["Петров Игорь Саулович"]);
  });

  it("predicate: own tokens conflict, foreign tokens do not", () => {
    const ownText = ownNameTextOfVariants([
      "Дерипаска Олег Владимирович",
      "deripaska oleg vladimirovich",
    ]);
    assert.equal(isSelfConflictingNegativeSignal(ownText, "deripaska"), true);
    assert.equal(isSelfConflictingNegativeSignal(ownText, "дерипаск"), true);
    assert.equal(isSelfConflictingNegativeSignal(ownText, "oleg vladimirovich"), true);
    assert.equal(isSelfConflictingNegativeSignal(ownText, "игоревич"), false);
    assert.equal(isSelfConflictingNegativeSignal(ownText, "навальный"), false);
  });
});

function seedCompletedJob(caseId: string, jobId: string) {
  deleteUnifiedCollectionJobForTests(caseId);
  const now = new Date().toISOString();
  const compositeDatasetId = `composite-${jobId}`;
  const enrichmentRunIds = AGENTS.map((a) => `enr-${a}`);
  saveUnifiedCollectionJob({
    version: "unified-orion-collection-job-v1",
    jobId,
    unifiedJobId: jobId,
    caseId,
    stage: "REPORT_READY",
    status: "COMPLETED",
    progress: 1,
    versionNum: 5,
    leaseOwnerId: null,
    leaseUntil: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: now,
    requestedBy: "smoke",
    arsenkinMode: "full-first36",
    baseReportRunId: `orion-unified-base-${jobId}`,
    arsenkinReportRunId: enrichmentRunIds[0]!,
    enrichmentRunIds,
    compositeDatasetId,
    actualProviders: [
      { providerId: "yandex", runtime: "real", status: "completed" },
      { providerId: "serper", runtime: "real", status: "completed" },
    ],
    coverage: { ...emptyCoverage(), measured: 12, progressRatio: 1 },
    warnings: [],
    lastError: null,
    lastErrorCode: null,
    artifactPaths: {},
    reportLinks: { pdf: "render/rendered-client.pdf", pptx: "render/rendered-client.pptx" },
    cancelRequested: false,
    arsenkinEnrichmentState: {
      version: "arsenkin-enrichment-state-v1",
      unifiedJobId: jobId,
      caseId,
      scheduledAgents: AGENTS,
      completedAgents: AGENTS,
      failedAgents: [],
      pendingAgents: [],
      ingestedAgents: AGENTS,
      enrichmentObservationCount: 5,
      enrichmentComplete: true,
      agents: [],
      updatedAt: now,
      ingestedResultHashes: [],
      resultHashToObservationIds: {},
      externalTaskIdToResultHash: {},
    },
  });

  writeUnifiedArtifact(caseId, jobId, "base-collection-manifest.json", {
    version: "base-collection-manifest-v1",
    unifiedJobId: jobId,
    caseId,
    capturedAt: now,
    baseReportRunId: `orion-unified-base-${jobId}`,
    searchResultIds: ["sr1"],
    searchSurfaceItemIds: [],
    baseCount: 1,
    actualProviders: [],
    realCollectionSufficient: true,
  });

  const binding: ReportDataBinding = {
    version: "report-data-binding-v1",
    caseId,
    unifiedJobId: jobId,
    baseReportRunId: `orion-unified-base-${jobId}`,
    enrichmentRunIds,
    compositeDatasetId,
    providerCounts: { yandex: 1, serper: 0, arsenkin: 5, composite: 6 },
    generatedAt: now,
  };
  writeUnifiedArtifact(caseId, jobId, "report-data-binding.json", binding);

  const merge: CompositeMergeResult = {
    compositeDatasetId,
    observations: [
      {
        key: "k1",
        kind: "organic",
        region: "RU",
        engine: "YANDEX",
        query: "Дерипаска Олег Владимирович",
        providers: ["yandex"],
        primaryProvider: "yandex",
        evidenceRefs: ["searchResult:sr1"],
        baseSearchResultId: "sr1",
        url: "https://example.com/a",
        title: "Дерипаска Олег Владимирович — статья",
      },
    ],
    providerCounts: { yandex: 1, serper: 0, arsenkin: 0, composite: 1 },
    baseCount: 1,
    compositeCount: 1,
    provenance: {
      unifiedJobId: jobId,
      baseProviders: ["yandex"],
      enrichmentProviders: ["arsenkin"],
      baseSearchResultIds: ["sr1"],
      baseSearchSurfaceItemIds: [],
      enrichmentRunIds,
    },
  };
  writeUnifiedArtifact(caseId, jobId, "composite-serp-observations.json", merge);
  writeUnifiedArtifact(caseId, jobId, "arsenkin-enrichment-observations.json", {
    observations: [],
    arsenkinReportRunId: enrichmentRunIds[0],
    enrichmentRunIds,
    enrichmentComplete: true,
  });
  // Stale job-scoped profile (pre-edit) — rebuild must refresh it from case root.
  writeUnifiedArtifact(caseId, jobId, "subject-identity-profile.json", {
    displayName: "Дерипаска Олег Владимирович",
    aliases: ["Дерипаска"],
    transliterations: [],
    contextIdentifiers: [],
    namesakeProfiles: [],
    negativeIdentitySignals: { wrongPatronymics: [], wrongNames: [], unrelatedKnownPersons: [] },
  });
}

/** Case-owned identity artifact with the operator's edits (contextIdentifiers). */
function writeCaseRootProfile(caseId: string) {
  const caseRoot = caseScopedArtifactRoot(ORION_GOLDEN_QA_STORAGE_ROOT, caseId);
  mkdirSync(caseRoot, { recursive: true });
  writeFileSync(
    join(caseRoot, "subject-identity-profile.json"),
    JSON.stringify(
      {
        version: "r10-7b-subject-identity-profile-v1",
        caseId,
        displayName: "Дерипаска Олег Владимирович",
        fullNameRu: { lastName: "Дерипаска", firstName: "Олег", patronymic: "Владимирович" },
        aliases: ["Дерипаска Олег Владимирович", "Дерипаска"],
        transliterations: ["deripaska oleg vladimirovich"],
        queryVariants: [],
        contextIdentifiers: ["Русал", "En+ Group", "Базовый элемент", "олигарх", "санкции"],
        knownIdentifiers: { inn: ["190200291847"] },
        negativeIdentitySignals: {
          wrongPatronymics: [],
          wrongNames: [],
          wrongBirthDates: [],
          unrelatedKnownPersons: [],
        },
        regionHints: ["RU"],
        languageHints: ["ru", "en"],
      },
      null,
      2
    ),
    "utf8"
  );
}

async function drain(caseId: string, deps: Parameters<typeof runUnifiedCollectionTick>[1], max = 10) {
  for (let i = 0; i < max; i++) {
    const job = await runUnifiedCollectionTick(caseId, deps);
    if (!job) break;
    if (
      ["REPORT_READY", "COMPLETED_PARTIAL", "FAILED_TERMINAL", "FAILED_RETRYABLE", "CANCELLED"].includes(
        job.stage
      )
    ) {
      return job;
    }
  }
  return loadUnifiedCollectionJob(caseId);
}

describe("unified report rebuild («Пересобрать отчёт»)", () => {
  it("eligibility: COMPLETED job with lineage-safe prepare inputs only", () => {
    const caseId = "rebuild-elig-case";
    const jobId = "unified-rebuild-elig";
    seedCompletedJob(caseId, jobId);

    const ok = evaluateUnifiedReportRebuildEligibility({
      caseId,
      job: loadUnifiedCollectionJob(caseId),
    });
    assert.equal(ok.rebuildAllowed, true);
    assert.equal(ok.rebuildBlockerReason, null);

    // Foreign jobId → mismatch.
    const foreign = evaluateUnifiedReportRebuildEligibility({
      caseId,
      job: loadUnifiedCollectionJob(caseId),
      requestedJobId: "unified-other-job",
    });
    assert.equal(foreign.rebuildAllowed, false);
    assert.equal(foreign.rebuildBlockerReason, "JOB_ID_MISMATCH");

    // Running job → not completed.
    saveUnifiedCollectionJob({
      ...loadUnifiedCollectionJob(caseId)!,
      stage: "ORION_PREPARE",
      status: "RUNNING",
    });
    const running = evaluateUnifiedReportRebuildEligibility({
      caseId,
      job: loadUnifiedCollectionJob(caseId),
    });
    assert.equal(running.rebuildAllowed, false);
    assert.equal(running.rebuildBlockerReason, "JOB_NOT_COMPLETED");
  });

  it("missing composite artifacts → REBUILD_INPUTS_MISSING (fail-closed)", () => {
    const caseId = "rebuild-noinputs-case";
    const jobId = "unified-rebuild-noinputs";
    seedCompletedJob(caseId, jobId);
    // Wipe binding by pointing at a different job dir: simulate missing input.
    writeUnifiedArtifact(caseId, jobId, "report-data-binding.json", null);
    const elig = evaluateUnifiedReportRebuildEligibility({
      caseId,
      job: loadUnifiedCollectionJob(caseId),
    });
    assert.equal(elig.rebuildAllowed, false);
    assert.equal(elig.rebuildBlockerReason, "REBUILD_INPUTS_MISSING");
  });

  it("happy path: same jobId, refreshed profile, zero base/Arsenkin, one prepare", async () => {
    const caseId = "rebuild-happy-case";
    const jobId = "unified-rebuild-happy";
    seedCompletedJob(caseId, jobId);
    writeCaseRootProfile(caseId);

    let baseCalls = 0;
    let arsenkinCalls = 0;
    let prepareCalls = 0;

    const accepted = await rebuildUnifiedReport({
      caseId,
      jobId,
      actorId: "admin",
      deps: { autoSchedule: false },
    });
    assert.equal(accepted.jobId, jobId);
    assert.equal(accepted.unifiedJobId, jobId);
    // Rebuild restarts from COMPOSITE_MERGE so the composite dataset itself is
    // regenerated (surface hints, region normalization) — not just re-rendered.
    assert.equal(accepted.stage, "COMPOSITE_MERGE");
    assert.equal(accepted.status, "WAITING");
    assert.equal(accepted.subjectProfileRefreshed, true);

    // Job-scoped profile now carries the case-root edits.
    const jobProfile = readUnifiedArtifact<{ contextIdentifiers?: string[] }>(
      caseId,
      jobId,
      "subject-identity-profile.json"
    );
    assert.ok(jobProfile?.contextIdentifiers?.includes("Русал"), "profile refreshed from case root");

    // Rebuild audit persisted.
    const audit = readUnifiedArtifact<{ previousStage?: string; subjectProfileRefreshed?: boolean }>(
      caseId,
      jobId,
      "unified-rebuild-audit.json"
    );
    assert.equal(audit?.previousStage, "REPORT_READY");
    assert.equal(audit?.subjectProfileRefreshed, true);

    // Full prepare (not render-only): checkpoint cleared.
    const midJob = loadUnifiedCollectionJob(caseId);
    assert.equal(midJob?.resumeCheckpoint ?? null, null);
    assert.equal(midJob?.lastErrorCode, null);

    const job = await drain(caseId, {
      autoSchedule: false,
      // Offline stand-in for the base rows Prisma would return: the rebuild's
      // COMPOSITE_MERGE step re-merges the composite without any live calls.
      fixtureBaseRows: [
        {
          key: "k1",
          kind: "organic",
          region: "RU",
          engine: "YANDEX",
          query: "Дерипаска Олег Владимирович",
          providers: ["yandex"],
          primaryProvider: "yandex",
          evidenceRefs: ["searchResult:sr1"],
          baseSearchResultId: "sr1",
          url: "https://example.com/a",
          title: "Дерипаска Олег Владимирович — статья",
        },
      ],
      runFullAudit: async () => {
        baseCalls += 1;
        throw new Error("base must not run");
      },
      runArsenkinEnrichment: async () => {
        arsenkinCalls += 1;
        throw new Error("arsenkin must not run");
      },
      runPrepare: async ({ binding }) => {
        prepareCalls += 1;
        return {
          prepareDatasetId: binding.compositeDatasetId,
          pdf: "render/rendered-client.pdf",
          pptx: "render/rendered-client.pptx",
          contactSheet: "contact-sheet.png",
          assemblyCount: 1,
          renderCount: 1,
        };
      },
    });

    assert.ok(job);
    assert.equal(job!.jobId, jobId, "same jobId preserved");
    assert.equal(job!.stage, "REPORT_READY", `stage=${job!.stage} err=${job!.lastError}`);
    assert.equal(baseCalls, 0, "zero base provider calls");
    assert.equal(arsenkinCalls, 0, "zero Arsenkin submissions");
    assert.equal(prepareCalls, 1, "exactly one prepare/render");
    assert.equal(job!.reportLinks.pdf, "render/rendered-client.pdf");

    // Double-click while completed again → allowed (idempotent new cycle), but
    // rebuild during RUNNING/WAITING is rejected: simulate mid-flight state.
    saveUnifiedCollectionJob({ ...job!, stage: "ORION_PREPARE", status: "RUNNING" });
    await assert.rejects(
      () =>
        rebuildUnifiedReport({
          caseId,
          jobId,
          actorId: "admin",
          deps: { autoSchedule: false },
        }),
      (err: unknown) => err instanceof Error && /JOB_NOT_COMPLETED/i.test(err.message)
    );
  });

  it("foreign jobId rejected fail-closed", async () => {
    const caseId = "rebuild-foreign-case";
    const jobId = "unified-rebuild-foreign";
    seedCompletedJob(caseId, jobId);
    await assert.rejects(
      () =>
        rebuildUnifiedReport({
          caseId,
          jobId: "unified-someone-elses-job",
          actorId: "admin",
          deps: { autoSchedule: false },
        }),
      (err: unknown) => err instanceof Error && /not found|does not belong/i.test(err.message)
    );
  });

  it("UI + API wiring: rebuild CTA and endpoint exist, no paid-collection route", () => {
    const header = readFileSync(join(SRC, "modules/digital-profile/client/CaseHeader.tsx"), "utf8");
    const view = readFileSync(join(SRC, "modules/digital-profile/client/CaseDetailView.tsx"), "utf8");
    const api = readFileSync(join(SRC, "modules/digital-profile/client/api.ts"), "utf8");
    assert.match(header, /Пересобрать отчёт/);
    assert.match(header, /unified-rebuild-report-cta/);
    assert.match(view, /rebuildUnifiedReport/);
    assert.match(api, /unified-collection\/rebuild-report/);
    assert.ok(
      existsSync(
        join(
          SRC,
          "app/api/digital-profile/cases/[id]/unified-collection/rebuild-report/route.ts"
        )
      ),
      "rebuild-report route exists"
    );
  });
});
