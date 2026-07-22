/**
 * Stage 7 — filter-loss audit, overlay preserve, executive theme coverage.
 * NETWORK_CALLS=0.
 */

import { describe, expect, it } from "vitest";
import {
  isOverlayMaterialAdverseItem,
  overlayInventoryByCoverageCells,
} from "../../src/modules/digital-profile/orion-golden/classic/composite-serp-overlay-merge";
import { selectKeyFindings } from "../../src/modules/digital-profile/orion-golden/executive-summary/deterministic-composer";
import {
  assertFilterLossGatesPass,
  buildFilterLossMatrix,
} from "../../src/modules/digital-profile/orion-golden/analytics/filter-loss-audit";
import type { ObservationDispositionLedger } from "../../src/modules/digital-profile/orion-golden/contracts/observation-disposition";
import type { Finding } from "../../src/modules/digital-profile/orion-golden/contracts/finding";
import type { FullEvidenceInventory } from "../../src/modules/digital-profile/orion-golden/evidence/full-evidence-inventory";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";

function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "inventoryId" | "title">): RawInventoryItem {
  return {
    caseId: "case-f7",
    reportRunId: "base-run",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-07-16T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: partial.snippet ?? "",
    sourceUrl: partial.sourceUrl ?? `https://news.example/${partial.inventoryId}`,
    ...partial,
  };
}

function emptyInventory(items: RawInventoryItem[]): FullEvidenceInventory {
  return {
    version: "r10-full-evidence-inventory-v1",
    caseId: "case-f7",
    reportRunId: "base-run",
    inspectedAt: "2026-07-16T00:00:00.000Z",
    subject: { fullName: "Test", aliases: [] },
    counts: {
      searchResults: items.length,
      searchSurfaces: 0,
      databaseProfiles: 0,
      riskFindings: 0,
      wikiChecks: 0,
      screenshots: 0,
    },
    countsBySource: {},
    countsByRegion: {},
    countsByEvidenceType: {},
    mediaAvailability: {
      images: 0,
      videos: 0,
      knowledgePanels: 0,
      serpScreenshots: 0,
      suggestions: 0,
      relatedQueries: 0,
      manualNotes: 0,
      organicResults: items.length,
    },
    lexisNexis: {
      uploadExists: false,
      latestReady: false,
      visualPageCount: 0,
      parsedSignals: 0,
      status: "none",
    },
    missingSources: [],
    warnings: [],
    items,
  };
}

function finding(partial: Partial<Finding> & Pick<Finding, "findingId" | "theme">): Finding {
  return {
    schemaVersion: "finding-v2",
    caseId: "case-f7",
    datasetId: "ds",
    sourceHashes: ["sha256:x"],
    evidenceRefs: [`inventory:${partial.findingId}`],
    claim: "claim",
    subjectMatch: "SUBJECT_MATCH",
    riskLevel: "high",
    confidence: 0.9,
    regions: ["RU"],
    sourceDomains: ["news.example"],
    providers: ["yandex"],
    recommendedAction: "Проверить.",
    contradictions: [],
    limitations: [],
    promotionPriority: "P1",
    ...partial,
  };
}

describe("Stage 7 overlay preserve", () => {
  it("preserves base material adverse when enrichment cell is empty (NOT_COLLECTED)", () => {
    const base = item({
      inventoryId: "b1",
      title: "Расследование ФБК о коррупции",
      snippet: "конфликт интересов",
      sourceUrl: "https://www.currenttime.tv/a/1",
      rawMetadata: { surface: "organic", engine: "YANDEX" },
    });
    expect(isOverlayMaterialAdverseItem(base)).toBe(true);
    const covered = new Map([
      [
        "RU|YANDEX|organic",
        { region: "RU", engine: "YANDEX", surface: "organic", count: 0 },
      ],
    ]);
    const result = overlayInventoryByCoverageCells({
      baseInventory: emptyInventory([base]),
      enrichmentItems: [],
      coveredCells: covered as never,
      baseReportRunId: "base-run",
      enrichmentRunIds: ["enrich-1"],
    });
    expect(result.inventory.items.some((i) => i.inventoryId === "b1")).toBe(true);
    expect(result.provenance.baseLineageCoveragePercent).toBe(100);
    expect(result.provenance.baseLineage?.some((e) => e.fate === "preserved_empty_enrichment_cell")).toBe(
      true
    );
    expect(result.warnings.some((w) => /overlay-preserved-empty/.test(w))).toBe(true);
  });

  it("preserves material adverse missing from non-empty enrichment cell", () => {
    const baseAdverse = item({
      inventoryId: "b-adverse",
      title: "Уголовное дело и санкции против субъекта",
      sourceUrl: "https://theguardian.com/world/adverse",
      rawMetadata: { surface: "organic", engine: "YANDEX" },
    });
    const baseNeutral = item({
      inventoryId: "b-neutral",
      title: "Биография предпринимателя",
      sourceUrl: "https://bio.example/person",
      rawMetadata: { surface: "organic", engine: "YANDEX" },
    });
    const enrich = item({
      inventoryId: "e1",
      title: "Новый нейтральный результат",
      sourceUrl: "https://enrich.example/n1",
      reportRunId: "enrich-1",
      provider: "arsenkin",
      rawMetadata: { surface: "organic", engine: "YANDEX", observationKey: "e1" },
    });
    const covered = new Map([
      [
        "RU|YANDEX|organic",
        { region: "RU", engine: "YANDEX", surface: "organic", count: 1 },
      ],
    ]);
    const result = overlayInventoryByCoverageCells({
      baseInventory: emptyInventory([baseAdverse, baseNeutral]),
      enrichmentItems: [enrich],
      coveredCells: covered as never,
      baseReportRunId: "base-run",
      enrichmentRunIds: ["enrich-1"],
    });
    const ids = result.inventory.items.map((i) => i.inventoryId);
    expect(ids).toContain("b-adverse");
    expect(ids).toContain("e1");
    expect(ids).not.toContain("b-neutral");
    expect(
      result.provenance.baseLineage?.find((e) => e.inventoryId === "b-adverse")?.fate
    ).toBe("preserved_material_despite_overlay");
    expect(result.provenance.baseLineageCoveragePercent).toBe(100);
  });
});

describe("Stage 7 executive theme coverage before top-N", () => {
  it("keeps one key finding per distinct mandatory theme even above MAX 7", () => {
    const themes = [
      "criminal",
      "corruption",
      "sanctions",
      "political",
      "offshore",
      "family",
      "reputational",
      "business",
    ];
    const eligible = themes.map((theme, i) =>
      finding({
        findingId: `finding-${theme}-${i}`,
        theme,
        riskLevel: "critical",
        promotionPriority: "P1",
      })
    );
    const picked = selectKeyFindings(eligible, new Set());
    expect(picked.length).toBe(8);
    expect(new Set(picked.map((f) => f.theme)).size).toBe(8);
  });
});

describe("Stage 7 filter-loss matrix gates", () => {
  it("passes gates on a fully accounted disposition ledger", () => {
    const ledger: ObservationDispositionLedger = {
      schemaVersion: "observation-disposition-ledger-v1",
      caseId: "case-f7",
      datasetId: "ds",
      sourceHashes: ["sha256:x"],
      evidenceRefs: ["inventory:1"],
      inventoryReportRunId: "base-run",
      rawObservationCount: 1,
      entries: [
        {
          rawObservationId: "inventory:1",
          normalizedObservationId: "norm:1",
          disposition: "KEEP_PRIMARY",
          reasonCode: "finding:primary_subject_match",
          subjectDecision: "SUBJECT_MATCH",
          confidence: 0.9,
          themeCandidates: ["criminal_judicial"],
          materialitySignals: ["adverse_text"],
          duplicateOf: null,
          duplicateGroupId: null,
          evidenceRefs: ["inventory:1"],
          provenance: {
            source: "serp_observation",
            provider: "yandex",
            reportRunId: "base-run",
            region: "RU",
            surface: "organic",
            sourceEvidenceRefs: ["inventory:1"],
          },
          originalTitle: "Уголовное дело",
          originalSnippet: "суд",
          fullTextRef: null,
          decidedBy: { stage: "disposition", functionName: "decideDisposition" },
        },
      ],
      gates: {
        RAW_OBSERVATION_ACCOUNTING: 100,
        UNREASONED_DROPS: 0,
        P1_P2_SILENT_DROPS: 0,
        OTHER_SUBJECT_IN_SUBJECT_KPI: 0,
      },
    };
    const matrix = buildFilterLossMatrix({
      caseId: "case-f7",
      datasetId: "ds",
      sourceHashes: ["sha256:x"],
      dispositionLedger: ledger,
      analyticsProvenance: {
        schemaVersion: "composite-serp-provenance-v1",
        caseId: "case-f7",
        datasetId: "ds",
        baseReportRunId: "base-run",
        enrichmentRunIds: [],
        baseCount: 1,
        compositeCount: 1,
        entries: [
          {
            observationKey: "k1",
            owner: "base",
            providers: ["yandex"],
            reportRunIds: ["base-run"],
            evidenceRefs: ["inventory:1"],
            duplicateOfBase: false,
          },
        ],
        nonOkCoverageCells: [],
        preservedBaseKeys: 1,
        warnings: [],
      },
      findings: [finding({ findingId: "f1", theme: "criminal" })],
      kpiFindingIds: new Set(["f1"]),
      surfaceMetricRows: [
        { region: "RU", status: "MEASURED", adverseSharePercent: 10, totalCount: 20 },
        { region: "UAE", status: "NOT_COLLECTED", adverseSharePercent: null, totalCount: 0 },
      ],
      coverageLimitations: ["Провайдер вернул ERROR по UAE organic"],
    });
    assertFilterLossGatesPass(matrix);
    expect(matrix.gates.RAW_ACCOUNTING).toBe(100);
    expect(matrix.gates.MATERIAL_FILTER_FALSE_NEGATIVES).toBe(0);
    expect(matrix.gates.BASE_LINEAGE_COVERAGE).toBe(100);
    expect(matrix.gates.METRIC_CONSISTENCY_PASS).toBe(true);
    expect(matrix.rows.length).toBeGreaterThanOrEqual(15);
  });

  it("fails METRIC_CONSISTENCY when NOT_COLLECTED is shown as 0%", () => {
    const ledger: ObservationDispositionLedger = {
      schemaVersion: "observation-disposition-ledger-v1",
      caseId: "case-f7",
      datasetId: "ds",
      sourceHashes: ["sha256:x"],
      evidenceRefs: [],
      inventoryReportRunId: "base-run",
      rawObservationCount: 0,
      entries: [],
      gates: {
        RAW_OBSERVATION_ACCOUNTING: 100,
        UNREASONED_DROPS: 0,
        P1_P2_SILENT_DROPS: 0,
        OTHER_SUBJECT_IN_SUBJECT_KPI: 0,
      },
    };
    const matrix = buildFilterLossMatrix({
      caseId: "case-f7",
      datasetId: "ds",
      sourceHashes: ["sha256:x"],
      dispositionLedger: ledger,
      findings: [],
      surfaceMetricRows: [
        { region: "RU", status: "NOT_COLLECTED", adverseSharePercent: 0, totalCount: 0 },
      ],
    });
    expect(matrix.gates.METRIC_CONSISTENCY_PASS).toBe(false);
    expect(matrix.gates.MATERIAL_FILTER_FALSE_NEGATIVES).toBeGreaterThan(0);
    expect(() => assertFilterLossGatesPass(matrix)).toThrow(/MATERIAL_FILTER|METRIC_CONSISTENCY/);
  });
});
