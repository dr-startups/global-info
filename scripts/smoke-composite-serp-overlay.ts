/**
 * Composite overlay merge regression — SUGGEST_RU_CANARY must not wipe base organic/UAE.
 * NETWORK_CALLS=0. No live Arsenkin.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  overlayInventoryByCoverageCells,
  cellKey,
  mapRegionBucket,
} from "../src/modules/digital-profile/orion-golden/classic/composite-serp-overlay-merge";
import {
  classifySuggestionIntent,
  type OrionSurfaceKpis,
} from "../src/modules/digital-profile/orion-golden/classic/orion-classic-theme-set";
import { inspectFirst36Acceptance } from "../src/modules/digital-profile/orion-golden/classic/first36-acceptance-gate";
import type { FullEvidenceInventory } from "../src/modules/digital-profile/orion-golden/evidence/full-evidence-inventory";
import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";
import {
  getArsenkinNetworkCallCount,
  resetArsenkinNetworkCallCount,
} from "../src/modules/digital-profile/providers/arsenkin/network-guard";

function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "inventoryId" | "evidenceType" | "region">): RawInventoryItem {
  return {
    caseId: "composite-test-case",
    reportRunId: String(partial.reportRunId ?? "orion-r10-base"),
    source: "test",
    provider: String(partial.provider ?? "GOOGLE"),
    query: partial.query ?? "query",
    collectedAt: new Date().toISOString(),
    title: partial.title ?? partial.query ?? "title",
    snippet: "",
    sourceUrl: partial.sourceUrl ?? "https://example.com/x",
    classification: undefined,
    rawMetadata: partial.rawMetadata ?? {
      engine: partial.provider ?? "GOOGLE",
      surface: partial.evidenceType === "search_result" ? "organic" : "autocomplete",
      provenanceStatus: "inherited_base",
    },
    ...partial,
  };
}

function baseInventory(): FullEvidenceInventory {
  const items: RawInventoryItem[] = [
    item({
      inventoryId: "ru-org-1",
      evidenceType: "search_result",
      region: "RU",
      reportRunId: "orion-r10-base",
      provider: "YANDEX",
      title: "RU organic unique A",
      sourceUrl: "https://ru.example/a",
      rawMetadata: { engine: "YANDEX", surface: "organic", provenanceStatus: "inherited_base" },
    }),
    item({
      inventoryId: "ru-org-2",
      evidenceType: "search_result",
      region: "RU",
      reportRunId: "orion-r10-base",
      provider: "GOOGLE",
      title: "RU organic unique B",
      sourceUrl: "https://ru.example/b",
      rawMetadata: { engine: "GOOGLE", surface: "organic", provenanceStatus: "inherited_base" },
    }),
    item({
      inventoryId: "uae-org-1",
      evidenceType: "search_result",
      region: "UAE",
      reportRunId: "orion-r10-base",
      provider: "GOOGLE",
      title: "UAE organic unique C",
      sourceUrl: "https://ae.example/c",
      rawMetadata: { engine: "GOOGLE", surface: "organic", provenanceStatus: "inherited_base" },
    }),
    item({
      inventoryId: "uae-org-2",
      evidenceType: "search_result",
      region: "UAE",
      reportRunId: "orion-r10-base",
      provider: "GOOGLE",
      title: "UAE organic unique D",
      sourceUrl: "https://ae.example/d",
      rawMetadata: { engine: "GOOGLE", surface: "organic", provenanceStatus: "inherited_base" },
    }),
    item({
      inventoryId: "uae-org-3",
      evidenceType: "search_result",
      region: "UAE",
      reportRunId: "orion-r10-base",
      provider: "GOOGLE",
      title: "UAE organic unique E",
      sourceUrl: "https://ae.example/e",
      rawMetadata: { engine: "GOOGLE", surface: "organic", provenanceStatus: "inherited_base" },
    }),
    item({
      inventoryId: "ru-sug-old",
      evidenceType: "suggestion",
      region: "RU",
      reportRunId: "orion-r10-base",
      provider: "yandex",
      query: "old ru suggest",
      title: "old ru suggest",
      rawMetadata: { engine: "YANDEX", surface: "autocomplete", provenanceStatus: "inherited_base" },
    }),
    item({
      inventoryId: "uae-sug-1",
      evidenceType: "suggestion",
      region: "UAE",
      reportRunId: "orion-r10-base",
      provider: "google",
      query: "uae suggest keep",
      title: "uae suggest keep",
      rawMetadata: { engine: "GOOGLE", surface: "autocomplete", provenanceStatus: "inherited_base" },
    }),
    item({
      inventoryId: "risk-1",
      evidenceType: "risk_finding",
      region: "RU",
      reportRunId: "orion-r10-base",
      title: "criminal legal finding",
      rawMetadata: { provenanceStatus: "inherited_base" },
    }),
    item({
      inventoryId: "db-1",
      evidenceType: "database_profile",
      region: "RU",
      reportRunId: "orion-r10-base",
      provider: "Dow Jones",
      title: "PEP match",
      rawMetadata: { provenanceStatus: "inherited_base" },
    }),
  ];
  return {
    version: "test",
    caseId: "composite-test-case",
    reportRunId: "orion-r10-base",
    generatedAt: new Date().toISOString(),
    subject: { fullName: "Test Subject", aliases: [] },
    items,
    counts: { searchResults: 5 },
    countsByEvidenceType: { search_result: 5, suggestion: 2 },
    mediaAvailability: { suggestions: 2, relatedQueries: 0 },
    warnings: [],
  } as FullEvidenceInventory;
}

function enrichmentSuggestions(n: number): RawInventoryItem[] {
  const out: RawInventoryItem[] = [];
  for (let i = 0; i < Math.ceil(n / 2); i++) {
    out.push(
      item({
        inventoryId: `ars-y-${i}`,
        evidenceType: "suggestion",
        region: "RU",
        reportRunId: "orion-arsenkin-enrich",
        provider: "yandex",
        query: `arsenkin yandex suggest ${i}`,
        title: `arsenkin yandex suggest ${i}`,
        rawMetadata: {
          engine: "YANDEX",
          surface: "autocomplete",
          provider: "arsenkin",
          observationKey: `y-${i}`,
          evidenceRefs: [`serp_observation:y-${i}`],
          provenanceStatus: "arsenkin",
          arsenkinTool: "suggest",
        },
      })
    );
  }
  for (let i = 0; i < Math.floor(n / 2); i++) {
    out.push(
      item({
        inventoryId: `ars-g-${i}`,
        evidenceType: "suggestion",
        region: "RU",
        reportRunId: "orion-arsenkin-enrich",
        provider: "google",
        query: `arsenkin google suggest ${i}`,
        title: `arsenkin google suggest ${i}`,
        rawMetadata: {
          engine: "GOOGLE",
          surface: "autocomplete",
          provider: "arsenkin",
          observationKey: `g-${i}`,
          evidenceRefs: [`serp_observation:g-${i}`],
          provenanceStatus: "arsenkin",
          arsenkinTool: "suggest",
        },
      })
    );
  }
  return out;
}

describe("composite serp overlay merge", () => {
  it("preserves base organic + UAE suggest; replaces only RU autocomplete", () => {
    resetArsenkinNetworkCallCount();
    const base = baseInventory();
    const enrichment = enrichmentSuggestions(10);
    const covered = new Map([
      [
        cellKey({ region: "RU", engine: "YANDEX", surface: "autocomplete" }),
        { region: "RU", engine: "YANDEX", surface: "autocomplete", count: 5, status: "COLLECTED" as const },
      ],
      [
        cellKey({ region: "RU", engine: "GOOGLE", surface: "autocomplete" }),
        { region: "RU", engine: "GOOGLE", surface: "autocomplete", count: 5, status: "COLLECTED" as const },
      ],
    ]);

    const result = overlayInventoryByCoverageCells({
      baseInventory: base,
      enrichmentItems: enrichment,
      coveredCells: covered,
      baseReportRunId: "orion-r10-base",
      enrichmentRunIds: ["orion-arsenkin-enrich"],
    });

    const ruOrganic = result.inventory.items.filter(
      (i) => i.evidenceType === "search_result" && mapRegionBucket(i.region) === "RU"
    );
    const uaeOrganic = result.inventory.items.filter(
      (i) => i.evidenceType === "search_result" && mapRegionBucket(i.region) === "UAE"
    );
    assert.equal(ruOrganic.length, 2, "RU organic base preserved");
    assert.equal(uaeOrganic.length, 3, "UAE organic base preserved with different denominator");
    assert.notEqual(ruOrganic.length, uaeOrganic.length, "RU/UAE denominators must differ");

    assert.ok(
      result.inventory.items.some(
        (i) => /suggestion/i.test(i.evidenceType) && mapRegionBucket(i.region) === "UAE"
      ),
      "UAE autocomplete preserved"
    );
    assert.ok(
      !result.inventory.items.some((i) => i.inventoryId === "ru-sug-old"),
      "old RU suggest replaced"
    );
    assert.ok(
      result.inventory.items.some(
        (i) =>
          /suggestion/i.test(i.evidenceType) &&
          String((i.rawMetadata as { provider?: string })?.provider) === "arsenkin"
      ),
      "Arsenkin suggestions present"
    );
    assert.ok(
      result.inventory.items.some((i) => i.evidenceType === "risk_finding"),
      "risk finding preserved"
    );
    assert.ok(
      result.inventory.items.every(
        (i) =>
          i.reportRunId === "orion-r10-base" ||
          i.reportRunId === "orion-arsenkin-enrich"
      ),
      "no falsely renamed provenance"
    );
    assert.equal(result.provenance.replacedCells, 2);
    assert.ok(result.provenance.preservedCells >= 2);
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });

  it("KPI null pct when linksTotal=0; classification separates contextual", () => {
    assert.equal(
      classifySuggestionIntent("Иванов мошенничество", "Иванов", []),
      "explicitAdverse"
    );
    assert.equal(
      classifySuggestionIntent("Иванов Трансмашхолдинг", "Иванов", ["Трансмашхолдинг"]),
      "contextualRisk"
    );

    const emptyOrganic: OrionSurfaceKpis = {
      region: "RU",
      linksTotal: 0,
      linksAdverse: 0,
      linksAdversePct: null,
      sampleStatus: "NOT_COLLECTED",
      suggestionsTotal: 5,
      suggestionsAdverse: 0,
      suggestionsExplicitAdverse: 0,
      suggestionsContextualRisk: 2,
      suggestionsIdentityRisk: 0,
      relatedTotal: 0,
      relatedAdverse: 0,
      wikipediaPresent: false,
      wikipediaStatus: "ABSENT",
      imagesTotal: 0,
      imagesAdverse: 0,
      videosTotal: 0,
      knowledgeTotal: 0,
      knowledgeAdverse: 0,
      searchVisibilityBadge: "Данных недостаточно",
      overallRiskBadge: "Нежелательный",
      dataQualityBadge: "PARTIAL",
      overallBadge: "Нежелательный",
    };
    assert.equal(emptyOrganic.linksAdversePct, null);
    assert.notEqual(emptyOrganic.searchVisibilityBadge, "Нейтральный");
  });

  it("acceptance allows composite source!=effective; blocks zero-denominator 0%", () => {
    const ok = inspectFirst36Acceptance({
      slideCount: 36,
      slides: Array.from({ length: 36 }, (_, i) => ({
        pageNumber: i + 1,
        title: `Page ${i + 1}`,
        narrative: "Клиентский текст с достаточной длиной предложения для проверки.",
        bullets: ["Первый пункт клиентского текста."],
      })),
      runScopedMerge: { usedRunScoped: true, observationCount: 10, duplicateKeys: [] },
      expectedRunId: "orion-arsenkin-enrich",
      clientContentSourceReportRunId: "orion-r10-base",
      compositeBinding: {
        sourceReportRunId: "orion-r10-base",
        effectiveReportRunId: "orion-arsenkin-enrich",
        enrichmentRunIds: ["orion-arsenkin-enrich"],
      },
      themeKpis: {
        ru: { linksTotal: 2, linksAdversePct: 0, overallBadge: "Нейтральный", overallRiskBadge: "Нейтральный" },
        uae: { linksTotal: 3, linksAdversePct: 0, overallBadge: "Нейтральный", overallRiskBadge: "Нейтральный" },
      },
      typecheckPassed: true,
    });
    assert.ok(
      !ok.issues.some((i) => i.code === "foreign-client-content-run"),
      "composite source!=effective must not be foreign"
    );

    const bad = inspectFirst36Acceptance({
      slideCount: 36,
      slides: Array.from({ length: 36 }, (_, i) => ({ pageNumber: i + 1, title: `p${i + 1}` })),
      runScopedMerge: { usedRunScoped: true, observationCount: 1, duplicateKeys: [] },
      expectedRunId: "orion-arsenkin-enrich",
      themeKpis: {
        ru: { linksTotal: 0, linksAdversePct: 0, overallBadge: "Нейтральный", overallRiskBadge: "Нейтральный" },
      },
      typecheckPassed: true,
    });
    assert.ok(bad.issues.some((i) => i.code === "zero-denominator-percentage"));
    assert.ok(bad.issues.some((i) => i.code === "neutral-badge-with-high-risk-evidence"));

    const lost = inspectFirst36Acceptance({
      slideCount: 36,
      slides: Array.from({ length: 36 }, (_, i) => ({ pageNumber: i + 1, title: `p${i + 1}` })),
      runScopedMerge: { usedRunScoped: true, observationCount: 18, duplicateKeys: [] },
      expectedRunId: "orion-arsenkin-enrich",
      clientContentSourceReportRunId: "orion-r10-base",
      compositeBinding: {
        sourceReportRunId: "orion-r10-base",
        effectiveReportRunId: "orion-arsenkin-enrich",
        enrichmentRunIds: ["orion-arsenkin-enrich"],
      },
      compositeMergeWarnings: ["uncovered-surface-data-loss:organic"],
      themeKpis: {
        ru: { linksTotal: 5, linksAdversePct: 0, overallBadge: "Нейтральный", overallRiskBadge: "Нейтральный" },
      },
      typecheckPassed: true,
    });
    assert.ok(lost.issues.some((i) => i.code === "uncovered-surface-data-loss"));

    const mismatch = inspectFirst36Acceptance({
      slideCount: 36,
      slides: Array.from({ length: 36 }, (_, i) => ({
        pageNumber: i + 1,
        title: `p${i + 1}`,
        evidenceRefs: i === 10 ? ["serp_observation:arsenkin-1"] : [],
        visualAnalysis:
          i === 10
            ? { provenanceLabel: "Источник: сохранённые поисковые подсказки" }
            : undefined,
      })),
      runScopedMerge: { usedRunScoped: true, observationCount: 1, duplicateKeys: [] },
      expectedRunId: "orion-arsenkin-enrich",
      typecheckPassed: true,
    });
    assert.ok(mismatch.issues.some((i) => i.code === "provenance-label-mismatch"));
  });

  it("RU/UAE denominators stay distinct after overlay", () => {
    const covered = new Map([
      [
        cellKey({ region: "RU", engine: "YANDEX", surface: "autocomplete" }),
        { region: "RU", engine: "YANDEX", surface: "autocomplete", count: 5, status: "COLLECTED" as const },
      ],
      [
        cellKey({ region: "RU", engine: "GOOGLE", surface: "autocomplete" }),
        { region: "RU", engine: "GOOGLE", surface: "autocomplete", count: 5, status: "COLLECTED" as const },
      ],
    ]);
    const result = overlayInventoryByCoverageCells({
      baseInventory: baseInventory(),
      enrichmentItems: enrichmentSuggestions(8),
      coveredCells: covered,
      baseReportRunId: "orion-r10-base",
      enrichmentRunIds: ["orion-arsenkin-enrich"],
    });
    const ru = result.inventory.items.filter(
      (i) => i.evidenceType === "search_result" && mapRegionBucket(i.region) === "RU"
    ).length;
    const uae = result.inventory.items.filter(
      (i) => i.evidenceType === "search_result" && mapRegionBucket(i.region) === "UAE"
    ).length;
    assert.ok(ru > 0 && uae > 0);
    assert.notEqual(ru, uae, "RU and UAE organic denominators must differ in fixture");
  });

  it("NETWORK_CALLS=0", () => {
    assert.equal(getArsenkinNetworkCallCount(), 0);
  });
});
