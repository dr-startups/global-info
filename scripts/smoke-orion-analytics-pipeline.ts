/**
 * Prompt 2 — mandatory offline tests, NETWORK_CALLS=0.
 * Covers: composite preservation, multi-run Arsenkin binding/provenance,
 * subject resolution, finding synthesis, contradiction detection,
 * provider delta, summary evidence coverage, benchmark trace.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";
import type { ArsenkinReportBindingV2 } from "../src/modules/digital-profile/orion-golden/classic/arsenkin-report-binding";
import {
  buildAnalyticsCompositeDataset,
  compositeObservationKey,
} from "../src/modules/digital-profile/orion-golden/analytics/composite-dataset-builder";
import {
  buildSubjectResolution,
  classifySubjectRelevance,
  type SubjectIdentity,
} from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import {
  bestIdentityDecision,
  countIdentityByObservation,
} from "../src/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import {
  buildRiskMatrixFragment,
  packRiskMatrixPages,
} from "../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders";
import type { Finding } from "../src/modules/digital-profile/orion-golden/contracts/finding";
import { runSurfaceAnalyzers } from "../src/modules/digital-profile/orion-golden/analytics/surface-analyzers";
import {
  synthesizeFindings,
  claimFingerprint,
} from "../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import {
  reconcileEnrichmentRuns,
  checkAcceptanceEnrichmentCoverage,
} from "../src/modules/digital-profile/orion-golden/analytics/enrichment-run-reconciler";
import { buildBenchmarkTrace } from "../src/modules/digital-profile/orion-golden/analytics/benchmark-trace";
import { runOrionAnalyticsPipeline } from "../src/modules/digital-profile/orion-golden/analytics/run-analytics-pipeline";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

const CASE_ID = "case-analytics-test";

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
    collectedAt: "2026-07-16T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    ...partial,
  };
}

const GLINKA_COMPOSER_NOISE = [
  "михаил глинка",
  "михаила глинки",
  "mikhail glinka",
  "композитор",
  "composer",
  "опера",
  "opera",
  "жизнь за царя",
  "руслан и людмила",
  "imslp",
  "симфони",
  "романс",
  "партитур",
];

const GLINKA_SUBJECT: SubjectIdentity = {
  displayName: "Глинка Сергей Михайлович",
  lastName: "Глинка",
  lastNameVariants: ["glinka"],
  firstNames: ["Сергей", "sergey", "sergei"],
  patronymics: ["Михайлович", "mikhaylovich"],
  aliases: ["Глинка Сергей Михайлович", "sergey glinka"],
  strongIdentifiers: ["773800015809"],
  contextIdentifiers: ["бизнесмен", "предприниматель", "инвестор", "транспорт"],
  wrongFirstNames: [],
  wrongPatronymics: ["николаевич"],
  unrelatedKnownPersons: ["дерипаск"],
  namesakeProfiles: [{ label: "Михаил Глинка (композитор)", noiseTerms: GLINKA_COMPOSER_NOISE }],
  namesakeNoise: GLINKA_COMPOSER_NOISE,
};

function subjectItems(): {
  base: RawInventoryItem[];
  enrichment: RawInventoryItem[];
} {
  const base = [
    item({
      title: "Сергей Глинка — бизнесмен и инвестор транспортной отрасли",
      sourceUrl: "https://rbc.ru/person/glinka",
      rawMetadata: { engine: "YANDEX", surface: "organic", queryText: "Глинка Сергей" },
    }),
    item({
      title: "Уголовное расследование: компании Сергея Глинки под проверкой прокуратуры",
      sourceUrl: "https://rucriminal.info/glinka-case",
      rawMetadata: { engine: "YANDEX", surface: "organic", queryText: "Глинка Сергей" },
    }),
    item({
      title: "Potential compliance match — WORLD_CHECK",
      snippet:
        "A potential SANCTIONS match for Глинка Сергей requires analyst review before any conclusion. Match score 41 (not verified).",
      source: "risk_finding",
      evidenceType: "risk_finding",
      provider: "INTERNAL",
      region: "GLOBAL",
      classification: "sanctions",
    }),
    item({
      title: "Опера «Жизнь за царя» Михаила Глинки — премьера в Большом театре",
      sourceUrl: "https://bolshoi.ru/glinka-opera",
      rawMetadata: { engine: "GOOGLE", surface: "organic", queryText: "Глинка" },
    }),
    item({
      title: "Глинка — история дворянского рода",
      sourceUrl: "https://example.org/glinka-family",
      rawMetadata: { engine: "GOOGLE", surface: "organic", queryText: "Глинка" },
    }),
    item({
      title: "Городские новости без упоминаний",
      sourceUrl: "https://news.example/123",
      rawMetadata: { engine: "GOOGLE", surface: "organic", queryText: "новости" },
    }),
  ];
  const enrichment = [
    item({
      title: "сергей глинка бизнесмен санкции проверка",
      provider: "arsenkin",
      reportRunId: "orion-arsenkin-run-A",
      evidenceType: "suggestion",
      sourceUrl: "arsenkin://suggest/abc1",
      rawMetadata: { engine: "YANDEX", surface: "autocomplete", queryText: "Глинка Сергей", provider: "arsenkin" },
    }),
    item({
      // Exact duplicate identity of the base adverse organic row (same query/engine/region/surface/url).
      title: "Уголовное расследование: компании Сергея Глинки под проверкой прокуратуры",
      provider: "arsenkin",
      reportRunId: "orion-arsenkin-run-B",
      sourceUrl: "https://rucriminal.info/glinka-case",
      rawMetadata: { engine: "YANDEX", surface: "organic", queryText: "Глинка Сергей", provider: "arsenkin" },
    }),
    item({
      title: "Сергей Глинка транспортный бизнес — новый домен",
      provider: "arsenkin",
      reportRunId: "orion-arsenkin-run-B",
      sourceUrl: "https://newdomain.md/glinka-transport",
      rawMetadata: { engine: "GOOGLE", surface: "organic", queryText: "Глинка Сергей", provider: "arsenkin" },
    }),
  ];
  return { base, enrichment };
}

const BINDING: ArsenkinReportBindingV2 = {
  caseId: CASE_ID,
  sourceReportRunId: "base-run-1",
  effectiveReportRunId: "orion-arsenkin-run-A",
  provider: "arsenkin",
  workflow: "case-agent",
  stage: "ARSENKIN_SEARCH_TOP_REAL",
  status: "REPORT_BOUND",
  transferredAt: "2026-07-16T00:00:00.000Z",
  providerTaskCount: 2,
  observationCount: 3,
  coverageCount: 2,
  version: "arsenkin-report-binding-v2",
  enrichmentRuns: [
    {
      reportRunId: "orion-arsenkin-run-A",
      provider: "arsenkin",
      workflow: "suggest-canary",
      stage: "SUGGEST_RU_CANARY",
      coveredSurfaces: [{ region: "RU", engine: "YANDEX", surface: "autocomplete", status: "COLLECTED" }],
    },
    {
      reportRunId: "orion-arsenkin-run-B",
      provider: "arsenkin",
      workflow: "case-agent",
      stage: "ARSENKIN_SEARCH_TOP_REAL",
      coveredSurfaces: [{ region: "RU", engine: "YANDEX", surface: "organic", status: "COLLECTED" }],
    },
  ],
  compositeDigest: "cmp-test",
} as ArsenkinReportBindingV2;

function buildComposite() {
  const { base, enrichment } = subjectItems();
  return {
    base,
    enrichment,
    result: buildAnalyticsCompositeDataset({
      caseId: CASE_ID,
      baseItems: base,
      enrichmentItems: enrichment,
      binding: BINDING,
      coverageRows: [
        { region: "RU", engine: "YANDEX", surface: "organic", status: "OK" },
        { region: "RU", engine: "YANDEX", surface: "ai_answer", status: "NO_RESULTS" },
        { region: "UAE", engine: "GOOGLE", surface: "images", status: "HTTP_500" },
        { region: "RU", engine: "GOOGLE", surface: "indexation", status: "NOT_SUPPORTED" },
      ],
      baseReportRunId: "base-run-1",
    }),
  };
}

describe("analytics NETWORK_CALLS", () => {
  it("forces NETWORK_CALLS=0", () => {
    assert.equal(process.env.NETWORK_CALLS, "0");
  });
});

describe("1. composite preservation", () => {
  it("keeps every base observation; NO_RESULTS/500/NOT_SUPPORTED never erase base", () => {
    const { base, result } = buildComposite();
    assert.equal(result.dataset.baseCount, base.length);
    assert.ok(result.dataset.compositeCount >= result.dataset.baseCount, "baseCount never decreases");
    const keys = new Set(result.dataset.observations.map((o) => o.observationKey));
    for (const b of base) {
      assert.ok(keys.has(compositeObservationKey(b)), `base observation lost: ${b.title}`);
    }
    // Non-OK coverage recorded, not destructive.
    assert.equal(result.provenance.nonOkCoverageCells.length, 3);
    assert.ok(result.provenance.warnings.some((w) => w.includes("not destructive")));
    const baseOwned = result.dataset.observations.filter((o) => o.provenanceOwner === "base");
    assert.equal(baseOwned.length, base.length);
  });
});

describe("2. multi-run Arsenkin binding and provenance", () => {
  it("lists all enrichment runs and merges duplicate provenance instead of dropping base", () => {
    const { result } = buildComposite();
    assert.deepEqual(result.dataset.enrichmentRunIds, [
      "orion-arsenkin-run-A",
      "orion-arsenkin-run-B",
    ]);
    // The duplicate adverse row: base row must survive with merged providers.
    assert.equal(result.dataset.duplicateCount, 1);
    const dupEntry = result.provenance.entries.find((e) => e.duplicateOfBase);
    assert.ok(dupEntry, "duplicate provenance entry expected");
    assert.equal(dupEntry!.owner, "base");
    assert.ok(dupEntry!.providers.includes("yandex") && dupEntry!.providers.includes("arsenkin"));
    assert.ok(dupEntry!.reportRunIds.includes("base-run-1"));
    assert.ok(dupEntry!.reportRunIds.includes("orion-arsenkin-run-B"));
  });
});

describe("2b. fail-closed enrichment-run reconciliation", () => {
  // Base + suggest canary (run-A) + ARSENKIN_SEARCH_TOP_REAL (run-B) +
  // extra CaseAgent PAA run (run-C, observed but absent from binding).
  const reconcile = () =>
    reconcileEnrichmentRuns({
      caseId: CASE_ID,
      subjectDisplayName: GLINKA_SUBJECT.displayName,
      inventoryReportRunId: "base-run-1",
      binding: BINDING,
      evidence: {
        observedRunIds: ["orion-arsenkin-run-A", "orion-arsenkin-run-B", "orion-arsenkin-run-C"],
        providerTaskRunIds: ["orion-arsenkin-run-A", "orion-arsenkin-run-B", "orion-arsenkin-run-C"],
        coverageRunIds: ["orion-arsenkin-run-B"],
      },
      caseAgentRecords: [
        {
          reportRunId: "orion-arsenkin-run-C",
          caseId: CASE_ID,
          stage: "ARSENKIN_PAA_REAL",
          workflow: "case-agent",
          sourceReportRunId: "base-run-1",
          subjectDisplayName: GLINKA_SUBJECT.displayName,
        },
        // Foreign case run — must be rejected.
        {
          reportRunId: "orion-arsenkin-run-FOREIGN",
          caseId: "another-case",
          stage: "ARSENKIN_SEARCH_TOP_REAL",
          workflow: "case-agent",
          sourceReportRunId: "base-run-1",
        },
        // Same case but stale base lineage — must be rejected.
        {
          reportRunId: "orion-arsenkin-run-STALE",
          caseId: CASE_ID,
          stage: "ARSENKIN_AI_SEARCH_REAL",
          workflow: "case-agent",
          sourceReportRunId: "some-older-base-run",
        },
        // Same case, но нет ни lineage-поля, ни улик — reject, не guess.
        {
          reportRunId: "orion-arsenkin-run-NOPROOF",
          caseId: CASE_ID,
          stage: "ARSENKIN_URL_AUDIT_REAL",
          workflow: "case-agent",
          sourceReportRunId: null,
        },
      ],
    });

  it("includes every valid run exactly once, binding order first, base preserved", () => {
    const r = reconcile();
    assert.equal(r.baseReportRunId, "base-run-1", "canonical base must be preserved");
    assert.deepEqual(r.enrichmentRunIds, [
      "orion-arsenkin-run-A",
      "orion-arsenkin-run-B",
      "orion-arsenkin-run-C",
    ]);
    assert.equal(new Set(r.enrichmentRunIds).size, r.enrichmentRunIds.length, "no duplicates");
    const runC = r.includedRuns.find((x) => x.reportRunId === "orion-arsenkin-run-C")!;
    assert.equal(runC.stage, "ARSENKIN_PAA_REAL");
    assert.ok(runC.proof.includes("observations_in_run_inventory"));
  });

  it("rejects stale and foreign runs with explicit reasons", () => {
    const r = reconcile();
    const reasons = Object.fromEntries(r.rejectedRuns.map((x) => [x.reportRunId, x.reason]));
    assert.equal(reasons["orion-arsenkin-run-FOREIGN"], "FOREIGN_CASE_ID");
    assert.equal(reasons["orion-arsenkin-run-STALE"], "STALE_BASE_LINEAGE");
    assert.equal(reasons["orion-arsenkin-run-NOPROOF"], "NO_LINEAGE_PROOF");
    for (const bad of ["orion-arsenkin-run-FOREIGN", "orion-arsenkin-run-STALE", "orion-arsenkin-run-NOPROOF"]) {
      assert.ok(!r.enrichmentRunIds.includes(bad), `${bad} must not be bound`);
    }
  });

  it("rejects a foreign binding wholesale and emits a gap", () => {
    const r = reconcileEnrichmentRuns({
      caseId: CASE_ID,
      subjectDisplayName: GLINKA_SUBJECT.displayName,
      inventoryReportRunId: "base-run-1",
      binding: { ...BINDING, caseId: `${CASE_ID}-xfer-test` },
      evidence: { observedRunIds: ["orion-arsenkin-run-B"] },
    });
    assert.ok(r.gaps.some((g) => g.kind === "FOREIGN_BINDING"));
    assert.ok(
      r.rejectedRuns.some(
        (x) => x.reportRunId === "orion-arsenkin-run-A" && x.reason === "FOREIGN_BINDING_CASE_MISMATCH"
      )
    );
    // Runs proven by in-lineage observations survive independently of the binding.
    assert.deepEqual(r.enrichmentRunIds, ["orion-arsenkin-run-B"]);
    assert.equal(r.baseReportRunId, "base-run-1");
  });

  it("emits an explicit gap for orphan runs instead of loose discovery", () => {
    const r = reconcileEnrichmentRuns({
      caseId: CASE_ID,
      subjectDisplayName: GLINKA_SUBJECT.displayName,
      inventoryReportRunId: "base-run-1",
      binding: null,
      evidence: {
        observedRunIds: [],
        providerTaskRunIds: ["orion-arsenkin-run-ORPHAN"],
      },
    });
    assert.ok(
      r.gaps.some((g) => g.kind === "ORPHAN_ENRICHMENT_RUN" && g.detail.includes("ORPHAN")),
      "orphan run must produce a gap"
    );
    assert.ok(!r.enrichmentRunIds.includes("orion-arsenkin-run-ORPHAN"));
    assert.ok(r.gaps.some((g) => g.kind === "NO_BINDING_FOR_CASE"));
  });

  it("is deterministic and idempotent", () => {
    assert.deepEqual(reconcile(), reconcile());
  });

  it("acceptance-binding check flags under-listed enrichment runs", () => {
    const r = reconcile();
    const underListed = checkAcceptanceEnrichmentCoverage({
      acceptanceEnrichmentRunIds: ["orion-arsenkin-run-A"],
      reconciledEnrichmentRunIds: r.enrichmentRunIds,
      baseReportRunId: r.baseReportRunId,
    });
    assert.equal(underListed.ok, false);
    assert.deepEqual(underListed.missingFromAcceptance, [
      "orion-arsenkin-run-B",
      "orion-arsenkin-run-C",
    ]);
    const complete = checkAcceptanceEnrichmentCoverage({
      acceptanceEnrichmentRunIds: r.enrichmentRunIds,
      reconciledEnrichmentRunIds: r.enrichmentRunIds,
      baseReportRunId: r.baseReportRunId,
    });
    assert.equal(complete.ok, true);
  });
});

describe("3. subject resolution", () => {
  const cases: Array<[string, RawInventoryItem, string, string?]> = [
    [
      "full name + business context → SUBJECT_MATCH",
      item({ title: "Сергей Глинка, бизнесмен, инвестирует в транспорт" }),
      "SUBJECT_MATCH",
    ],
    [
      "composer namesake → OTHER_SUBJECT",
      item({ title: "Михаил Глинка — великий композитор, опера «Руслан и Людмила»" }),
      "OTHER_SUBJECT",
    ],
    [
      "surname-only → AMBIGUOUS, never SUBJECT_MATCH",
      item({ title: "Глинка: справочная статья" }),
      "AMBIGUOUS",
    ],
    [
      "surname + context → LIKELY_SUBJECT (§2.1)",
      item({ title: "Глинка инвестирует в транспортный бизнес" }),
      "LIKELY_SUBJECT",
      "surname_with_context",
    ],
    [
      "surname + namesake conflict → OTHER_SUBJECT (not LIKELY)",
      item({ title: "Глинка — композитор, опера" }),
      "OTHER_SUBJECT",
    ],
    [
      "suggestion surname + context → LIKELY_SUBJECT (§2.1)",
      item({
        title: "глинка транспорт инвестиции",
        rawMetadata: { surface: "suggestions" },
      }),
      "LIKELY_SUBJECT",
      "surname_with_context",
    ],
    [
      "no identifiers → INSUFFICIENT_IDENTIFIERS",
      item({ title: "Транспортные новости региона" }),
      "INSUFFICIENT_IDENTIFIERS",
    ],
    [
      "strong INN identifier → SUBJECT_MATCH",
      item({ title: "Выписка: Глинка, ИНН 773800015809" }),
      "SUBJECT_MATCH",
    ],
  ];
  for (const [label, testItem, expected, reason] of cases) {
    it(label, () => {
      const decision = classifySubjectRelevance(testItem, GLINKA_SUBJECT);
      assert.equal(decision.decision, expected);
      if (reason) assert.equal(decision.reasonCode, reason);
    });
  }

  it("risk matrix reserves a first-page slot for LIKELY «Требует подтверждения»", () => {
    const mk = (id: string, subjectMatch: Finding["subjectMatch"], riskLevel: Finding["riskLevel"]): Finding =>
      ({
        findingId: id,
        theme: id,
        subjectMatch,
        riskLevel,
        claim: "x",
        promotionPriority: "APPENDIX",
      }) as Finding;
    const confirmed = [
      mk("c1", "SUBJECT_MATCH", "critical"),
      mk("c2", "SUBJECT_MATCH", "high"),
      mk("c3", "SUBJECT_MATCH", "high"),
      mk("c4", "SUBJECT_MATCH", "high"),
      mk("c5", "SUBJECT_MATCH", "medium"),
    ];
    const likely = [mk("l1", "LIKELY_SUBJECT", "low"), mk("l2", "LIKELY_SUBJECT", "none")];
    const pages = packRiskMatrixPages(confirmed, likely, 5, 1);
    assert.ok(pages.length >= 2);
    assert.equal(pages[0]!.length, 5);
    assert.ok(pages[0]!.some((f) => f.subjectMatch === "LIKELY_SUBJECT"));
    assert.equal(pages[0]!.filter((f) => f.subjectMatch === "SUBJECT_MATCH").length, 4);
    assert.ok(pages.flat().some((f) => f.findingId === "l2"));
  });

  it("risk matrix shows Требует подтверждения from likelySubjectCount without LIKELY findings", () => {
    const confirmed = [
      {
        findingId: "c1",
        theme: "Тема A",
        subjectMatch: "SUBJECT_MATCH",
        riskLevel: "high",
        claim: "claim a",
        promotionPriority: "P1",
        evidenceRefs: ["inventory:1"],
        recommendedAction: "act",
      } as Finding,
    ];
    const out = buildRiskMatrixFragment(
      "EXECUTIVE",
      {
        subject: { displayName: "Test", aliases: [] },
        findings: confirmed,
        surfaceUnits: [],
        metricSnapshot: {
          metricSnapshotId: "m",
          datasetId: "d",
          reportRunId: "r",
          baseCount: 10,
          enrichmentCount: 0,
          compositeCount: 10,
          subjectMatchCount: 5,
          likelySubjectCount: 28,
          ambiguousCount: 1,
          otherSubjectCount: 0,
          adverseFindingCount: 1,
          perRegionCounts: { RU: 10 },
        },
        scope: {
          regions: null,
          surfaces: [],
          subjectMatch: ["SUBJECT_MATCH", "LIKELY_SUBJECT"],
          findingIds: null,
        },
        evidenceIndex: {},
      },
      {}
    );
    const rows = out.slides.flatMap((s) => s.content.table?.rows ?? []);
    assert.ok(rows.some((r) => String(r[1]).includes("Требует подтверждения")));
    assert.ok(rows.some((r) => String(r[0]).includes("вероятной принадлежностью")));
  });

  it("KPI identity counts one decision per observation, not per inventory duplicate", () => {
    const decisionByRef = new Map([
      ["inventory:a", "SUBJECT_MATCH"],
      ["inventory:b", "SUBJECT_MATCH"],
      ["inventory:c", "LIKELY_SUBJECT"],
      ["inventory:d", "AMBIGUOUS"],
    ]);
    // Two inventory SUBJECT_MATCH refs collapse into one observation row.
    const counts = countIdentityByObservation({
      decisionByRef,
      observationRefGroups: [
        ["inventory:a", "inventory:b"],
        ["inventory:c"],
        ["inventory:d"],
      ],
    });
    assert.equal(counts.subjectMatchCount, 1);
    assert.equal(counts.likelySubjectCount, 1);
    assert.equal(counts.ambiguousCount, 1);
    assert.equal(bestIdentityDecision(["inventory:a", "inventory:c"], decisionByRef), "SUBJECT_MATCH");
    assert.ok(counts.subjectMatchCount + counts.likelySubjectCount + counts.ambiguousCount <= 3);
  });

  it("surname_only on SUBJECT_MATCH domain → LIKELY via shared domain (§2.1)", () => {
    const matched = item({
      title: "Сергей Глинка — бизнесмен",
      sourceUrl: "https://rbc.ru/person/glinka",
    });
    const surnameOnly = item({
      title: "Глинка: новости компании",
      sourceUrl: "https://rbc.ru/business/glinka-news",
    });
    const resolution = buildSubjectResolution({
      caseId: CASE_ID,
      datasetId: "ds-likely-domain",
      subject: GLINKA_SUBJECT,
      items: [matched, surnameOnly],
      sourceHashes: ["sha256:test"],
    });
    const byTitle = new Map(
      resolution.items.map((r) => {
        const it = [matched, surnameOnly].find((i) => `inventory:${i.inventoryId}` === r.evidenceRef)!;
        return [it.title, r] as const;
      })
    );
    assert.equal(byTitle.get(matched.title)?.decision, "SUBJECT_MATCH");
    assert.equal(byTitle.get(surnameOnly.title)?.decision, "LIKELY_SUBJECT");
    assert.equal(byTitle.get(surnameOnly.title)?.reasonCode, "surname_with_confirmed_domain");
  });

  it("keeps ambiguous evidence for review instead of dropping it", () => {
    const { base } = subjectItems();
    const resolution = buildSubjectResolution({
      caseId: CASE_ID,
      datasetId: "ds-test",
      subject: GLINKA_SUBJECT,
      items: base,
      sourceHashes: ["sha256:test"],
    });
    const ambiguous = resolution.items.filter((i) => i.decision === "AMBIGUOUS");
    assert.ok(ambiguous.length >= 1);
    assert.equal(resolution.items.length, base.length, "every observation classified");
  });
});

describe("4. finding synthesis", () => {
  function synth() {
    const { base, enrichment } = subjectItems();
    const items = [...base, ...enrichment];
    const resolution = buildSubjectResolution({
      caseId: CASE_ID,
      datasetId: "ds-test",
      subject: GLINKA_SUBJECT,
      items,
      sourceHashes: ["sha256:test"],
    });
    const byRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));
    return {
      items,
      byRef,
      result: synthesizeFindings({
        caseId: CASE_ID,
        datasetId: "ds-test",
        items,
        resolutionByRef: byRef,
        sourceHashes: ["sha256:test"],
      }),
    };
  }

  it("produces a VerifiedFindingBundle with all required fields", () => {
    const { result } = synth();
    assert.ok(result.bundle.findings.length > 0);
    for (const f of result.bundle.findings) {
      assert.ok(f.findingId && f.theme && f.claim && f.recommendedAction);
      assert.ok(Array.isArray(f.contradictions));
      assert.ok(Array.isArray(f.limitations));
      assert.ok(["P1", "P2", "P3", "APPENDIX"].includes(f.promotionPriority));
      assert.ok(f.evidenceRefs.length > 0);
    }
  });

  it("excludes OTHER_SUBJECT findings with explicit reasons; KPI eligibility is SUBJECT_MATCH only", () => {
    const { result } = synth();
    assert.deepEqual(result.bundle.kpiEligibleSubjectMatches, ["SUBJECT_MATCH"]);
    for (const id of result.bundle.excludedFindingIds) {
      assert.ok(result.bundle.exclusionReasons[id]?.includes("OTHER_SUBJECT"));
      const f = result.bundle.findings.find((x) => x.findingId === id);
      assert.equal(f?.subjectMatch, "OTHER_SUBJECT");
    }
    // Composer opera evidence must not sit in a SUBJECT_MATCH finding.
    const verified = result.bundle.findings.filter((f) => f.subjectMatch === "SUBJECT_MATCH");
    assert.ok(!verified.some((f) => /опера|композитор/iu.test(f.claim)));
  });

  it("same claim fingerprint yields one finding; same evidence may support multiple distinct claims", () => {
    // Item that genuinely supports two claims: criminal AND political.
    const dualItem = item({
      title:
        "Уголовное дело о финансировании политической партии в Молдове: бизнесмен Сергей Глинка под следствием",
      sourceUrl: "https://newsmaker.md/glinka-party-case",
    });
    // Exact duplicate of the same claim (same normalized title) from a re-crawl.
    const duplicateClaim = item({
      title:
        "Уголовное дело о финансировании политической партии в Молдове: бизнесмен Сергей Глинка под следствием",
      sourceUrl: "https://newsmaker.md/glinka-party-case?utm=copy",
    });
    const items = [dualItem, duplicateClaim];
    const resolution = buildSubjectResolution({
      caseId: CASE_ID,
      datasetId: "ds-multi",
      subject: GLINKA_SUBJECT,
      items,
      sourceHashes: ["sha256:test"],
    });
    const byRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));
    const { bundle, themeAssignments } = synthesizeFindings({
      caseId: CASE_ID,
      datasetId: "ds-multi",
      items,
      resolutionByRef: byRef,
      sourceHashes: ["sha256:test"],
    });
    const verified = bundle.findings.filter((f) => f.subjectMatch === "SUBJECT_MATCH");
    const criminal = verified.find((f) => f.findingId.includes("criminal_legal"));
    const political = verified.find((f) => f.findingId.includes("political_exposure"));
    // Distinct supported claims → separate findings sharing the same evidence.
    assert.ok(criminal, "criminal finding expected");
    assert.ok(political, "political finding expected (must not be consumed by criminal theme)");
    const ref = `inventory:${dualItem.inventoryId}`;
    assert.ok(criminal!.evidenceRefs.includes(ref), "shared provenance on criminal finding");
    assert.ok(political!.evidenceRefs.includes(ref), "shared provenance on political finding");
    const assigned = themeAssignments.get(ref) ?? [];
    for (const t of ["criminal_legal", "political_exposure"]) {
      assert.ok(assigned.includes(t), `assignment for ${t} expected, got ${assigned.join(",")}`);
    }
    // Same normalized claim fingerprint appears once per theme: the duplicate
    // re-crawl must not double the evidence within a theme.
    assert.equal(
      claimFingerprint("criminal_legal", dualItem),
      claimFingerprint("criminal_legal", duplicateClaim)
    );
    assert.equal(criminal!.evidenceRefs.length, 1, "duplicate claim collapsed in criminal theme");
    assert.equal(political!.evidenceRefs.length, 1, "duplicate claim collapsed in political theme");
    // No two findings share the same (theme, subjectMatch) fingerprint.
    const findingKeys = verified.map((f) => f.findingId.replace(/-[0-9a-f]{8}$/u, ""));
    assert.equal(new Set(findingKeys).size, findingKeys.length);
  });
});

describe("5. contradiction detection", () => {
  it("flags unverified compliance signals presented alongside asserted adverse media", () => {
    const items = [
      item({
        title: "Санкционное расследование против Сергея Глинки подтверждено судом",
        sourceUrl: "https://media-one.ru/glinka",
        rawMetadata: { engine: "YANDEX", surface: "organic" },
      }),
      item({
        title: "Суд отклонил претензии: санкции против Сергея Глинки не вводились",
        sourceUrl: "https://media-two.ru/glinka",
        rawMetadata: { engine: "GOOGLE", surface: "organic" },
      }),
      item({
        title: "Potential compliance match — WORLD_CHECK",
        snippet: "potential SANCTIONS match for Сергей Глинка requires analyst review (not verified)",
        source: "risk_finding",
        evidenceType: "risk_finding",
        classification: "sanctions",
      }),
    ];
    const resolution = buildSubjectResolution({
      caseId: CASE_ID,
      datasetId: "ds-contradiction",
      subject: GLINKA_SUBJECT,
      items,
      sourceHashes: ["sha256:test"],
    });
    const byRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));
    const { bundle } = synthesizeFindings({
      caseId: CASE_ID,
      datasetId: "ds-contradiction",
      items,
      resolutionByRef: byRef,
      sourceHashes: ["sha256:test"],
    });
    const withContradiction = bundle.findings.filter((f) => f.contradictions.length > 0);
    assert.ok(withContradiction.length >= 1, "expected at least one contradiction");
    const withUnverifiedLimitation = bundle.findings.filter((f) =>
      f.limitations.some((l) => /неподтверждён/iu.test(l))
    );
    assert.ok(withUnverifiedLimitation.length >= 1, "unverified signals must surface as limitations");
  });

  it("flags conflicting tone (adverse vs positive) inside a theme", () => {
    const items = [
      item({
        title: "Расследование о мошенничестве: бизнесмен Сергей Глинка под следствием",
        sourceUrl: "https://media-neg.ru/1",
      }),
      item({
        title: "Суд по делу бизнесмена Сергея Глинки: интервью и биография предпринимателя",
        sourceUrl: "https://media-pos.ru/2",
      }),
    ];
    const resolution = buildSubjectResolution({
      caseId: CASE_ID,
      datasetId: "ds-tone",
      subject: GLINKA_SUBJECT,
      items,
      sourceHashes: ["sha256:test"],
    });
    const byRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));
    const { bundle } = synthesizeFindings({
      caseId: CASE_ID,
      datasetId: "ds-tone",
      items,
      resolutionByRef: byRef,
      sourceHashes: ["sha256:test"],
    });
    assert.ok(
      bundle.findings.some((f) =>
        f.contradictions.some((c) => /тональность/iu.test(c.description))
      )
    );
  });
});

describe("6. provider delta", () => {
  it("computes base/arsenkin/duplicate/unique-domain deltas", () => {
    const { result } = buildComposite();
    const d = result.providerDelta;
    assert.equal(d.baseCount, 6);
    assert.equal(d.arsenkinObservationCount, 3);
    assert.equal(d.duplicateCount, 1);
    assert.equal(d.uniqueArsenkinCount, 2);
    assert.ok(d.uniqueDomainCount >= 1, "newdomain.md must count as a new domain");
    assert.ok(d.uniqueArsenkinCount === d.arsenkinObservationCount - d.duplicateCount);
  });
});

describe("7. summary evidence coverage (end-to-end wiring)", () => {
  it("wires Executive Summary to the actual pipeline bundle; P1/P2 adverse findings are promoted", async () => {
    const { base, enrichment } = subjectItems();
    // Enough material for a non-INSUFFICIENT summary.
    const extra = [
      item({
        title: "PEP-статус: Сергей Глинка упоминается в списках RuPEP как бизнесмен",
        sourceUrl: "https://rupep.org/glinka",
      }),
      item({
        title: "Оборонный контур: транспортные контракты Сергея Глинки и интерес службы безопасности",
        sourceUrl: "https://zdg.md/glinka-defense",
        region: "MD",
      }),
      item({
        title: "Жена Сергея Глинки — совладелица девелоперской компании (бизнесмен подтвердил)",
        sourceUrl: "https://vedomosti.ru/glinka-family",
      }),
    ];
    const dir = mkdtempSync(join(tmpdir(), "orion-analytics-e2e-"));
    const result = await runOrionAnalyticsPipeline({
      caseId: CASE_ID,
      inventoryReportRunId: "base-run-1",
      items: [...base, ...enrichment, ...extra],
      binding: BINDING,
      coverageRows: [
        { region: "RU", engine: "YANDEX", surface: "organic", status: "OK" },
        { region: "UAE", engine: "GOOGLE", surface: "images", status: "HTTP_500" },
      ],
      subjectProfile: {
        displayName: GLINKA_SUBJECT.displayName,
        fullNameRu: { lastName: "Глинка", firstName: "Сергей", patronymic: "Михайлович" },
        givenNames: ["Сергей", "sergey", "sergei"],
        familyNames: ["Глинка", "glinka"],
        patronymics: ["Михайлович", "mikhaylovich", "mikhailovich"],
        contextIdentifiers: GLINKA_SUBJECT.contextIdentifiers,
        namesakeProfiles: [
          { label: "Михаил Глинка (композитор)", noiseTerms: GLINKA_COMPOSER_NOISE },
        ],
        aliases: GLINKA_SUBJECT.aliases,
        transliterations: ["glinka sergey mikhaylovich", "sergey glinka"],
        knownIdentifiers: { inn: ["773800015809"] },
        negativeIdentitySignals: { wrongPatronymics: ["николаевич"], wrongNames: [], unrelatedKnownPersons: [] },
      },
      artifactsDir: dir,
    });

    assert.equal(result.executiveSummary.status, "OK");
    const out = result.executiveSummary.output!;
    const bundleIds = new Set(
      result.synthesis.bundle.findings
        .filter((f) => f.subjectMatch === "SUBJECT_MATCH")
        .map((f) => f.findingId)
    );
    // Every summary claim references an actual pipeline finding (not a fixture).
    for (const kf of out.keyFindings) {
      assert.ok(bundleIds.has(kf.findingId), `summary claim ${kf.findingId} not from pipeline bundle`);
    }
    // Adverse P1/P2 findings must not silently remain only in deep sections.
    const p12Adverse = result.synthesis.bundle.findings.filter(
      (f) =>
        f.subjectMatch === "SUBJECT_MATCH" &&
        (f.promotionPriority === "P1" || f.promotionPriority === "P2") &&
        ["medium", "high", "critical"].includes(f.riskLevel)
    );
    const promoted = new Set(out.keyFindings.map((k) => k.findingId));
    for (const f of p12Adverse) {
      assert.ok(promoted.has(f.findingId), `adverse ${f.promotionPriority} ${f.findingId} missing from summary`);
    }
    // Identity pollution and data gaps surfaced.
    assert.ok(out.identityCaveats.length > 0);
    assert.ok(out.dataLimitations.length > 0);
  });
});

describe("8. benchmark trace", () => {
  it("emits all six statuses and never copies benchmark claims into facts", () => {
    const { base, enrichment } = subjectItems();
    // PRESENT_NOT_SYNTHESIZED: subject-match corporate evidence whose theme
    // regex does not synthesize (assigned to business_profile but benchmark
    // corporate-ownership maps to it → construct via ambiguous-only politics).
    const items = [
      ...base,
      ...enrichment,
      // SUBJECT_AMBIGUOUS for spouse: surname-only spouse mention.
      item({ title: "Жена Глинки рассказала о семье", sourceUrl: "https://gossip.example/1" }),
    ];
    const resolution = buildSubjectResolution({
      caseId: CASE_ID,
      datasetId: "ds-bm",
      subject: GLINKA_SUBJECT,
      items,
      sourceHashes: ["sha256:test"],
    });
    const byRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));
    const synthesis = synthesizeFindings({
      caseId: CASE_ID,
      datasetId: "ds-bm",
      items,
      resolutionByRef: byRef,
      sourceHashes: ["sha256:test"],
    });
    const verified = synthesis.bundle.findings.filter((f) => f.subjectMatch === "SUBJECT_MATCH");

    // Scenario A: nothing promoted → SYNTHESIZED_NOT_PROMOTED + alert on P1/P2.
    const traceNone = buildBenchmarkTrace({
      caseId: CASE_ID,
      datasetId: "ds-bm",
      items,
      resolutionByRef: byRef,
      verifiedFindings: verified,
      ambiguousFindings: synthesis.ambiguousFindings,
      promotedFindingIds: new Set(),
      themeAssignments: synthesis.themeAssignments,
    });
    const criminal = traceNone.rows.find((r) => r.benchmarkId === "bm-criminal-judicial")!;
    assert.equal(criminal.status, "SYNTHESIZED_NOT_PROMOTED");
    assert.ok(criminal.notes.some((n) => n.includes("ALERT")), "P1/P2 non-promotion must alert");
    const offshore = traceNone.rows.find((r) => r.benchmarkId === "bm-offshore")!;
    assert.equal(offshore.status, "ABSENT_IN_RAW");

    // Scenario B: promote criminal finding → PROMOTED.
    const criminalFinding = verified.find((f) => f.findingId.includes("criminal_legal"))!;
    const tracePromoted = buildBenchmarkTrace({
      caseId: CASE_ID,
      datasetId: "ds-bm",
      items,
      resolutionByRef: byRef,
      verifiedFindings: verified,
      ambiguousFindings: synthesis.ambiguousFindings,
      promotedFindingIds: new Set([criminalFinding.findingId]),
      themeAssignments: synthesis.themeAssignments,
    });
    assert.equal(
      tracePromoted.rows.find((r) => r.benchmarkId === "bm-criminal-judicial")!.status,
      "PROMOTED"
    );

    // Scenario C: noise-only theme → FILTERED_AS_NOISE.
    const noiseItems = [
      item({ title: "Купить лампу глинка панама на ozon по низкой цене", sourceUrl: "https://ozon.ru/x" }),
    ];
    const noiseResolution = buildSubjectResolution({
      caseId: CASE_ID,
      datasetId: "ds-noise",
      subject: GLINKA_SUBJECT,
      items: noiseItems,
      sourceHashes: ["sha256:test"],
    });
    const traceNoise = buildBenchmarkTrace({
      caseId: CASE_ID,
      datasetId: "ds-noise",
      items: noiseItems,
      resolutionByRef: new Map(noiseResolution.items.map((i) => [i.evidenceRef, i])),
      verifiedFindings: [],
      ambiguousFindings: [],
      promotedFindingIds: new Set(),
      themeAssignments: new Map(),
    });
    assert.equal(
      traceNoise.rows.find((r) => r.benchmarkId === "bm-offshore")!.status,
      "FILTERED_AS_NOISE"
    );

    // Scenario D: ambiguous-only evidence → SUBJECT_AMBIGUOUS.
    const ambItems = [
      item({ title: "Офшорные схемы: обзор без имён, упоминается некий Глинка", sourceUrl: "https://blog.example/offshore" }),
    ];
    const ambResolution = buildSubjectResolution({
      caseId: CASE_ID,
      datasetId: "ds-amb",
      subject: GLINKA_SUBJECT,
      items: ambItems,
      sourceHashes: ["sha256:test"],
    });
    const traceAmb = buildBenchmarkTrace({
      caseId: CASE_ID,
      datasetId: "ds-amb",
      items: ambItems,
      resolutionByRef: new Map(ambResolution.items.map((i) => [i.evidenceRef, i])),
      verifiedFindings: [],
      ambiguousFindings: [],
      promotedFindingIds: new Set(),
      themeAssignments: new Map(),
    });
    assert.equal(
      traceAmb.rows.find((r) => r.benchmarkId === "bm-offshore")!.status,
      "SUBJECT_AMBIGUOUS"
    );

    // Scenario E: subject-match evidence without a synthesized finding → PRESENT_NOT_SYNTHESIZED.
    const pnsItems = [
      item({
        title: "Сергей Глинка, бизнесмен: бенефициар и владелец транспортных активов",
        sourceUrl: "https://corp.example/glinka",
      }),
    ];
    const pnsResolution = buildSubjectResolution({
      caseId: CASE_ID,
      datasetId: "ds-pns",
      subject: GLINKA_SUBJECT,
      items: pnsItems,
      sourceHashes: ["sha256:test"],
    });
    const tracePns = buildBenchmarkTrace({
      caseId: CASE_ID,
      datasetId: "ds-pns",
      items: pnsItems,
      resolutionByRef: new Map(pnsResolution.items.map((i) => [i.evidenceRef, i])),
      verifiedFindings: [],
      ambiguousFindings: [],
      promotedFindingIds: new Set(),
      themeAssignments: new Map(),
    });
    assert.equal(
      tracePns.rows.find((r) => r.benchmarkId === "bm-corporate-ownership")!.status,
      "PRESENT_NOT_SYNTHESIZED"
    );

    // Benchmark claims are never report facts.
    assert.ok(traceNone.disclaimer.includes("not report facts"));
    for (const f of verified) {
      assert.ok(!f.claim.includes("Benchmark"), "benchmark text must not leak into findings");
    }
  });
});

describe("surface analyzers output typed data", () => {
  it("returns SurfaceAnalysis per surface with metrics/claims, no slide copy", () => {
    const { base, enrichment } = subjectItems();
    const items = [...base, ...enrichment];
    const resolution = buildSubjectResolution({
      caseId: CASE_ID,
      datasetId: "ds-surf",
      subject: GLINKA_SUBJECT,
      items,
      sourceHashes: ["sha256:test"],
    });
    const analyses = runSurfaceAnalyzers({
      caseId: CASE_ID,
      datasetId: "ds-surf",
      items,
      resolutionLookup: new Map(resolution.items.map((i) => [i.evidenceRef, i])),
      sourceHashes: ["sha256:test"],
    });
    const kinds = Object.keys(analyses);
    for (const k of [
      "organic",
      "suggestions",
      "paa_related",
      "images",
      "wikipedia",
      "ai_answers",
      "url_audit",
      "compliance",
    ]) {
      assert.ok(kinds.includes(k), `analyzer ${k} missing`);
    }
    const organic = analyses.organic;
    assert.ok(organic.units.length > 0);
    for (const unit of organic.units) {
      assert.ok(unit.metrics.some((m) => m.key === "subjectMatchCount"));
      for (const claim of unit.claims) {
        assert.ok(claim.evidenceRefs.length > 0, "claims must carry evidence refs");
      }
    }
    // compliance analyzer sees the risk_finding item.
    const compliance = analyses.compliance;
    assert.ok(compliance.units.length > 0, "compliance evidence must be analyzed");
  });
});
