/**
 * Offline acceptance for the automatic subject-context pipeline:
 *  - context terms are mined from confirmed matches only (never from namesakes);
 *  - two-pass classification upgrades matched items to full_name_with_context;
 *  - analytics pipeline persists derived-subject-context.json;
 *  - subject profile is bootstrapped automatically from case subject +
 *    collected data when no case-owned profile exists (operator edits win).
 *
 * NETWORK_CALLS=0 npx tsx --test scripts/smoke-subject-context-automation.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, before } from "node:test";
import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";
import {
  subjectIdentityFromProfile,
  type ClassifierSubjectProfile,
  type SubjectIdentity,
} from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import {
  mineSubjectContextTerms,
  resolveSubjectWithDerivedContext,
} from "../src/modules/digital-profile/orion-golden/analytics/subject-context-miner";
import { buildSubjectResolution } from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { runOrionAnalyticsPipeline } from "../src/modules/digital-profile/orion-golden/analytics/run-analytics-pipeline";
import { bootstrapSubjectProfileFromCollection } from "../src/modules/digital-profile/services/job-subject-profile-bootstrap";
import { subjectProfilePath } from "../src/modules/digital-profile/services/subject-profile-admin";
import type { CompositeObservation } from "../src/modules/digital-profile/services/composite-serp-merge";
import {
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  readUnifiedArtifact,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  startUnifiedOrionCollection,
  runUnifiedCollectionTick,
} from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { ARSENKIN_REAL_AGENT_NAMES } from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import type { FullAuditResultDTO } from "../src/modules/digital-profile/services/agent-run-service";
import {
  emptyCoverage,
  FIRST36_PLANNED_SUPPORTED_SURFACES,
} from "../src/modules/digital-profile/services/unified-collection-types";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

const CASE_ID = "subject-context-automation-case";

const PROFILE: ClassifierSubjectProfile = {
  displayName: "Тестов Пётр Сергеевич",
  fullNameRu: { lastName: "Тестов", firstName: "Пётр", patronymic: "Сергеевич" },
  givenNames: ["Пётр", "petr"],
  familyNames: ["Тестов", "testov"],
  patronymics: ["Сергеевич"],
  aliases: [],
  transliterations: ["testov petr"],
  namesakeProfiles: [],
  contextIdentifiers: [],
  knownIdentifiers: { inn: [] },
  negativeIdentitySignals: {
    wrongPatronymics: ["игоревич"],
    wrongNames: [],
    unrelatedKnownPersons: [],
  },
};

function subject(): SubjectIdentity {
  return subjectIdentityFromProfile(PROFILE);
}

let seq = 0;
function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-${seq}`,
    caseId: CASE_ID,
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-07-18T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    sourceUrl: `https://example.com/${seq}`,
    ...partial,
  };
}

/** 3 confirmed subject items (business context) + 2 namesake items (composer). */
function fixtureItems(): RawInventoryItem[] {
  return [
    item({
      title: "Тестов Пётр Сергеевич — основатель холдинга Промресурс",
      snippet: "Бизнесмен Тестов Пётр расширяет активы холдинга Промресурс в металлургии",
    }),
    item({
      title: "Пётр Тестов и холдинг Промресурс: интервью о металлургии",
      snippet: "Глава Промресурс Пётр Тестов рассказал о новых проектах в металлургии",
    }),
    item({
      title: "Тестов Пётр Сергеевич возглавил совет директоров Промресурс",
      snippet: "",
    }),
    item({
      title: "Тестов Пётр Игоревич — композитор консерватории",
      snippet: "Композитор Тестов Пётр Игоревич представил симфонию в консерватории",
    }),
    item({
      title: "Пётр Игоревич Тестов: концерт композитора в консерватории",
      snippet: "",
    }),
  ];
}

describe("subject context miner", () => {
  it("mines business terms from conflict-free matches only, never namesake vocabulary", () => {
    const items = fixtureItems();
    const s = subject();
    const pass1 = buildSubjectResolution({
      caseId: CASE_ID,
      datasetId: "ds-1",
      subject: s,
      items,
      sourceHashes: [],
    });
    // Sanity: namesake items are conflicted (wrong patronymic "игоревич").
    const namesake = pass1.items.filter((r) => r.conflictingIdentifiers.length > 0);
    assert.ok(namesake.length >= 2, "namesake items must carry identity conflicts");

    const mined = mineSubjectContextTerms({ items, resolution: pass1, subject: s });
    assert.ok(mined.matchedItemCount >= 3);
    assert.ok(mined.minedTerms.includes("промресурс"), `mined=${mined.minedTerms.join(",")}`);
    assert.ok(mined.minedTerms.includes("металлургии"), `mined=${mined.minedTerms.join(",")}`);
    // Namesake vocabulary must never leak into subject context.
    assert.ok(!mined.minedTerms.includes("композитор"));
    assert.ok(!mined.minedTerms.some((t) => t.includes("консерватори")));
    // Own name tokens and stopwords are never context.
    assert.ok(!mined.minedTerms.some((t) => t.includes("тестов") || t.includes("петр")));
    assert.ok(!mined.minedTerms.includes("новости"));
  });

  it("two-pass resolution upgrades matched items to full_name_with_context", () => {
    const items = fixtureItems();
    const derived = resolveSubjectWithDerivedContext({
      caseId: CASE_ID,
      datasetId: "ds-2",
      subject: subject(),
      items,
      sourceHashes: [],
    });
    assert.ok(derived.minedContext.length > 0);
    assert.deepEqual(derived.suppliedContext, []);
    assert.ok(derived.effectiveContext.includes("промресурс"));

    const matched = derived.resolution.items.filter((r) => r.decision === "SUBJECT_MATCH");
    assert.ok(matched.length >= 3);
    assert.ok(
      matched.some((r) => r.reasonCode === "full_name_with_context"),
      `reasons=${matched.map((r) => r.reasonCode).join(",")}`
    );
    // Namesake items still never become SUBJECT_MATCH after enrichment.
    for (const r of derived.resolution.items) {
      if (r.conflictingIdentifiers.length > 0) assert.notEqual(r.decision, "SUBJECT_MATCH");
    }
  });

  it("falls back to single pass when nothing qualifies for mining", () => {
    const items = [
      item({ title: "Тестов Пётр Сергеевич — основатель холдинга Промресурс", snippet: "" }),
    ];
    const derived = resolveSubjectWithDerivedContext({
      caseId: CASE_ID,
      datasetId: "ds-3",
      subject: subject(),
      items,
      sourceHashes: [],
    });
    // Single document — no term reaches the 2-distinct-docs threshold.
    assert.deepEqual(derived.minedContext, []);
    assert.equal(derived.resolution.items.length, 1);
    assert.equal(derived.resolution.items[0]!.decision, "SUBJECT_MATCH");
  });

  it("analytics pipeline persists derived-subject-context.json", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "derived-context-"));
    try {
      const res = await runOrionAnalyticsPipeline({
        caseId: CASE_ID,
        inventoryReportRunId: "base-run-1",
        items: fixtureItems(),
        binding: null,
        coverageRows: [],
        subjectProfile: PROFILE,
        artifactsDir,
      });
      const path = res.artifactPaths["derived-subject-context.json"];
      assert.ok(path && existsSync(path), "derived-subject-context.json must be written");
      const artifact = JSON.parse(readFileSync(path, "utf8")) as {
        version: string;
        minedContext: string[];
        effectiveContext: string[];
      };
      assert.equal(artifact.version, "derived-subject-context-v1");
      assert.ok(artifact.minedContext.includes("промресурс"));
      assert.ok(artifact.effectiveContext.includes("промресурс"));
      assert.ok(
        res.subjectResolution.items.some((r) => r.reasonCode === "full_name_with_context")
      );
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  });
});

const bootstrapObservations: CompositeObservation[] = [
  {
    key: "organic|ru|yandex|fio|https://a.example",
    kind: "organic",
    region: "RU",
    engine: "YANDEX",
    query: "fio",
    url: "https://a.example",
    title: "Тестов Пётр Сергеевич — основатель холдинга Промресурс",
    snippet: "Бизнесмен Тестов Пётр Сергеевич, холдинг Промресурс",
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: ["searchResult:sr1"],
    baseSearchResultId: "sr1",
  },
  {
    key: "organic|ru|google|fio|https://b.example",
    kind: "organic",
    region: "RU",
    engine: "GOOGLE",
    query: "fio",
    url: "https://b.example",
    title: "Тестов Пётр Игоревич — композитор",
    snippet: "Композитор Тестов Пётр Игоревич",
    providers: ["serper"],
    primaryProvider: "serper",
    evidenceRefs: ["searchResult:sr2"],
    baseSearchResultId: "sr2",
  },
];

function freshCaseRoot(caseId: string): void {
  rmSync(dirname(subjectProfilePath(caseId)), { recursive: true, force: true });
}

describe("automatic subject profile bootstrap", () => {
  it("builds and persists a profile from case subject + collected data", async () => {
    const caseId = "bootstrap-unit-case";
    freshCaseRoot(caseId);
    const res = await bootstrapSubjectProfileFromCollection({
      caseId,
      baseReportRunId: "base-run-1",
      enrichmentRunId: null,
      observations: bootstrapObservations,
      subject: { fullName: "Тестов Пётр Сергеевич", aliases: [] },
    });
    assert.ok(res);
    assert.equal(res!.profile.displayName, "Тестов Пётр Сергеевич");
    assert.ok(res!.profile.familyNames.some((f) => f.toLowerCase() === "тестов"));
    assert.equal(res!.persistedToCaseRoot, true);
    assert.ok(existsSync(subjectProfilePath(caseId)));
    // Never fires on its own name even though data contains name variants.
    const ownText = "тестов петр сергеевич";
    for (const w of [
      ...res!.profile.negativeIdentitySignals.wrongNames,
      ...res!.profile.negativeIdentitySignals.unrelatedKnownPersons,
    ]) {
      assert.ok(!ownText.includes(w.toLowerCase()), `self-conflicting negative: ${w}`);
    }

    // Second run: the case-owned file already exists — never overwritten.
    const again = await bootstrapSubjectProfileFromCollection({
      caseId,
      baseReportRunId: "base-run-1",
      enrichmentRunId: null,
      observations: bootstrapObservations,
      subject: { fullName: "Тестов Пётр Сергеевич", aliases: [] },
    });
    assert.equal(again!.persistedToCaseRoot, false);
  });

  it("returns null without a resolvable case subject (prepare stays fail-closed)", async () => {
    const res = await bootstrapSubjectProfileFromCollection({
      caseId: "bootstrap-no-subject",
      baseReportRunId: "base-run-1",
      enrichmentRunId: null,
      observations: bootstrapObservations,
      subject: null,
      prisma: null,
    });
    assert.equal(res, null);
  });

  it("unified job without any case profile gets a bootstrapped job-scoped profile", async () => {
    const caseId = "bootstrap-orchestrator-case";
    freshCaseRoot(caseId);
    deleteUnifiedCollectionJobForTests(caseId);

    const fullAudit: FullAuditResultDTO = {
      outcome: "SUCCESS",
      runs: [],
      runSummary: [
        { providerId: "yandex", phase: "collection", status: "completed", runtime: "real", agentName: "REAL_YANDEX_SEARCH", reason: "ok" },
        { providerId: "google", phase: "collection", status: "completed", runtime: "real", agentName: "REAL_GOOGLE_SEARCH", reason: "ok" },
        { providerId: "orion_profile", phase: "collection", status: "completed", runtime: "real", agentName: "REAL_ORION_SEARCH_PROFILE", reason: "ok" },
      ],
      runtimeStrategy: {
        mode: "real_first_with_fallback",
        selectedOrder: [],
        fallbackPolicy: "allow_mock_fallback",
        realProvidersAvailable: 3,
        mockProvidersAvailable: 0,
        fallbackEvents: [],
        warnings: [],
        decisions: [],
      },
    };

    const deps = {
      autoSchedule: false as const,
      allowMockReport: false,
      fixtureBaseRows: bootstrapObservations,
      caseSubject: { fullName: "Тестов Пётр Сергеевич", aliases: [] },
      runFullAudit: async () => fullAudit,
      runArsenkinEnrichment: async () => ({
        arsenkinReportRunId: "arsenkin-enrich-1",
        enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n, i) => `arsenkin-enrich-${i + 1}`),
        coverage: {
          ...emptyCoverage(FIRST36_PLANNED_SUPPORTED_SURFACES.length),
          measured: 2,
          noResults: 1,
          notSupported: 1,
          failedFinal: 0,
          progressRatio: 4 / 12,
        },
        observations: [],
        warnings: [],
        partial: false,
        enrichmentComplete: true,
      }),
      runPrepare: async ({ binding }: { binding: { compositeDatasetId: string } }) => ({
        prepareDatasetId: binding.compositeDatasetId,
        pdf: "/tmp/demo.pdf",
      }),
    };

    const started = await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps });
    assert.equal(started.created, true);
    for (let i = 0; i < 20; i++) {
      const job = await runUnifiedCollectionTick(caseId, deps);
      if (!job) break;
      if (["REPORT_READY", "COMPLETED_PARTIAL", "FAILED_TERMINAL", "CANCELLED"].includes(job.stage)) break;
    }
    const job = loadUnifiedCollectionJob(caseId);
    assert.ok(job);
    assert.ok(
      job!.stage === "REPORT_READY" || job!.stage === "COMPLETED_PARTIAL",
      `stage=${job!.stage} err=${job!.lastError}`
    );

    // The job dir received a bootstrapped classifier profile...
    const jobProfile = readUnifiedArtifact<ClassifierSubjectProfile>(
      caseId,
      job!.unifiedJobId,
      "subject-identity-profile.json"
    );
    assert.ok(jobProfile, "job-scoped subject profile must be bootstrapped");
    assert.equal(jobProfile!.displayName, "Тестов Пётр Сергеевич");
    // ...and the case root now owns the same profile for the panel / rebuilds.
    assert.ok(existsSync(subjectProfilePath(caseId)));
  });
});
