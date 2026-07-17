/**
 * Offline base observation coverage + Yandex attribution (NETWORK_CALLS=0).
 * Fixtures G–I.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildBaseObservationCoverage,
  assertBaseObservationCoverage,
  BASE_OBSERVATION_COVERAGE_VERSION,
} from "../src/modules/digital-profile/services/base-observation-coverage";
import { assertPreRenderDataGates } from "../src/modules/digital-profile/services/pre-render-data-gates";
import { mergeCompositeSerp, buildReportDataBinding } from "../src/modules/digital-profile/services/composite-serp-merge";
import { resolveSerpProviderAttribution } from "../src/modules/digital-profile/services/unified-base-report-run";
import { buildArsenkinEnrichmentState } from "../src/modules/digital-profile/services/arsenkin-enrichment-state";
import { ARSENKIN_REAL_AGENT_NAMES } from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";
import type { CompositeObservation } from "../src/modules/digital-profile/services/composite-serp-merge";

process.env.NETWORK_CALLS = "0";

function completeEnrichmentState(caseId: string, unifiedJobId: string) {
  return buildArsenkinEnrichmentState({
    caseId,
    unifiedJobId,
    agents: ARSENKIN_REAL_AGENT_NAMES.map((agentName) => ({
      agentName,
      enrichmentRunId: `r-${agentName}`,
      scheduled: true,
      terminal: true,
      terminalKind: "EMPTY_VALID" as const,
      ingested: true,
      pendingTaskCount: 0,
      doneTaskCount: 1,
      submitUnknownCount: 0,
      observationCount: 0,
    })),
  });
}

describe("base observation coverage + yandex attribution", () => {
  it("G: 43 IDs → 41 rows, 43/43 provenance → PRE_RENDER PASS", async () => {
    const ids = Array.from({ length: 43 }, (_, i) => `b${i + 1}`);
    const rows: CompositeObservation[] = [];
    // 41 rows: two rows cite two base ids each
    for (let i = 0; i < 39; i++) {
      rows.push({
        key: `organic|ru|yandex|q|https://u${i}.example`,
        kind: "organic",
        engine: "YANDEX",
        providers: ["yandex"],
        primaryProvider: "yandex",
        evidenceRefs: [`searchResult:${ids[i]}`],
        baseSearchResultId: ids[i],
      });
    }
    rows.push({
      key: "organic|ru|yandex|q|https://dup-a.example",
      kind: "organic",
      engine: "YANDEX",
      providers: ["yandex"],
      primaryProvider: "yandex",
      evidenceRefs: [`searchResult:${ids[39]}`, `searchResult:${ids[40]}`],
      baseSearchResultId: ids[39],
    });
    rows.push({
      key: "organic|ru|yandex|q|https://dup-b.example",
      kind: "organic",
      engine: "YANDEX",
      providers: ["yandex"],
      primaryProvider: "yandex",
      evidenceRefs: [`searchResult:${ids[41]}`, `searchResult:${ids[42]}`],
      baseSearchResultId: ids[41],
    });

    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: "u-cov",
      caseId: "c-cov",
      capturedAt: new Date().toISOString(),
      baseReportRunId: "base-1",
      searchResultIds: ids,
      searchSurfaceItemIds: [],
      baseCount: 43,
      actualProviders: [],
      realCollectionSufficient: true,
    };

    const merge = await mergeCompositeSerp({
      manifest,
      fixtureBaseRows: rows,
      enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n) => `e-${n}`),
      arsenkinObservations: [],
    });

    // fixture path counts rows as-is; force observations to our 41-row set with multi-cite
    merge.observations = rows;
    merge.compositeCount = 41;
    merge.providerCounts.composite = 41;

    const coverage = buildBaseObservationCoverage({ manifest, merge });
    assert.equal(coverage.version, BASE_OBSERVATION_COVERAGE_VERSION);
    assert.equal(coverage.diagnosticCounts.rawBaseCount, 43);
    assert.equal(coverage.diagnosticCounts.compositeRowCount, 41);
    assert.equal(coverage.missingBaseObservationIds.length, 0);
    assert.equal(coverage.coverageRatio, 1);
    assert.equal(coverage.allBaseObservationsTraceable, true);
    assert.equal(assertBaseObservationCoverage(coverage).ok, true);

    const binding = buildReportDataBinding({
      caseId: "c-cov",
      unifiedJobId: "u-cov",
      baseReportRunId: "base-1",
      enrichmentRunIds: ["e1"],
      compositeDatasetId: merge.compositeDatasetId,
      providerCounts: merge.providerCounts,
    });
    const gate = assertPreRenderDataGates({
      binding,
      manifest,
      merge,
      enrichmentState: completeEnrichmentState("c-cov", "u-cov"),
      realCollectionSufficient: true,
    });
    assert.equal(gate.ok, true, gate.errors.join("; "));
  });

  it("H: 43 IDs → 41 rows, 42/43 provenance → FAIL before render", async () => {
    const ids = Array.from({ length: 43 }, (_, i) => `m${i + 1}`);
    const rows: CompositeObservation[] = ids.slice(0, 41).map((id, i) => ({
      key: `organic|ru|google|q|https://x${i}.example`,
      kind: "organic" as const,
      engine: "GOOGLE",
      providers: ["serper"],
      primaryProvider: "serper",
      evidenceRefs: [`searchResult:${id}`],
      baseSearchResultId: id,
    }));
    // ids[41] and ids[42] missing — only 41 covered
    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: "u-miss",
      caseId: "c-miss",
      capturedAt: new Date().toISOString(),
      baseReportRunId: "base-1",
      searchResultIds: ids,
      searchSurfaceItemIds: [],
      baseCount: 43,
      actualProviders: [],
      realCollectionSufficient: true,
    };
    const merge = await mergeCompositeSerp({
      manifest,
      fixtureBaseRows: rows,
    });
    merge.observations = rows;
    merge.compositeCount = 41;
    const coverage = buildBaseObservationCoverage({ manifest, merge });
    assert.equal(coverage.coveredBaseObservationIds.length, 41);
    assert.equal(coverage.missingBaseObservationIds.length, 2);
    assert.equal(assertBaseObservationCoverage(coverage).ok, false);

    const binding = buildReportDataBinding({
      caseId: "c-miss",
      unifiedJobId: "u-miss",
      baseReportRunId: "base-1",
      enrichmentRunIds: ["e1"],
      compositeDatasetId: merge.compositeDatasetId,
      providerCounts: { yandex: 0, serper: 41, arsenkin: 0, composite: 41 },
    });
    const gate = assertPreRenderDataGates({
      binding,
      manifest,
      merge,
      enrichmentState: completeEnrichmentState("c-miss", "u-miss"),
      realCollectionSufficient: true,
    });
    assert.equal(gate.ok, false);
    assert.match(gate.errors.join(" "), /missingBaseObservationIds|coverageRatio/i);
  });

  it("I: Yandex 6 without query.engine → providerCounts.yandex=6", async () => {
    // Full contract: AgentRun / ProviderTask / manifest — not query.engine alone
    for (let i = 0; i < 6; i++) {
      const attr = resolveSerpProviderAttribution({
        agentRunProvider: "YANDEX",
        queryEngine: null,
      });
      assert.equal(attr.provider, "yandex");
    }
    assert.equal(
      resolveSerpProviderAttribution({
        providerTaskLineage: "YANDEX",
        queryEngine: undefined,
      }).provider,
      "yandex"
    );
    assert.equal(
      resolveSerpProviderAttribution({
        manifestProviderHint: "yandex",
        queryEngine: null,
      }).provider,
      "yandex"
    );
    assert.equal(
      resolveSerpProviderAttribution({
        queryEngine: "GOOGLE",
      }).provider,
      "serper"
    );
    const conflict = resolveSerpProviderAttribution({
      observationProvider: "yandex",
      agentRunProvider: "serper",
    });
    assert.equal(conflict.provider, "yandex");
    assert.ok(conflict.conflictDiagnostic);

    const unknownOnly = resolveSerpProviderAttribution({
      engine: null,
      source: null,
      queryEngine: null,
    });
    assert.equal(unknownOnly.provider, "base");
    assert.equal(unknownOnly.source, "UNKNOWN");

    const rows: CompositeObservation[] = Array.from({ length: 6 }, (_, i) => ({
      key: `organic|ru|yandex|q|https://y${i}.example`,
      kind: "organic" as const,
      engine: "YANDEX",
      providers: ["yandex"],
      primaryProvider: "yandex",
      evidenceRefs: [`searchResult:y${i}`],
      baseSearchResultId: `y${i}`,
    }));
    const googleRows: CompositeObservation[] = [
      {
        key: "organic|ru|google|q|https://g.example",
        kind: "organic",
        engine: "GOOGLE",
        providers: ["serper"],
        primaryProvider: "serper",
        evidenceRefs: ["searchResult:g1"],
        baseSearchResultId: "g1",
      },
    ];
    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: "u-ya",
      caseId: "c-ya",
      capturedAt: new Date().toISOString(),
      baseReportRunId: "base-ya",
      searchResultIds: [...rows.map((r) => r.baseSearchResultId!), "g1"],
      searchSurfaceItemIds: [],
      baseCount: 7,
      actualProviders: [],
      realCollectionSufficient: true,
    };
    const merge = await mergeCompositeSerp({
      manifest,
      fixtureBaseRows: [...rows, ...googleRows],
    });
    assert.equal(merge.providerCounts.yandex, 6);
    assert.equal(merge.providerCounts.serper, 1);
  });
});
