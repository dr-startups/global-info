/**
 * Offline acceptance for REMEDIATION_PLAN §1.1 / F5 — case corpus in base manifest.
 *
 * Capture: delta=3 new + corpus=50 old → baseCount=53.
 * Merge (fixture): composite ≥ 53, fromCaseCorpus distinguishes groups.
 * Coverage: all 53 IDs traceable.
 *
 * Run: npm run smoke:case-corpus-manifest
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { captureBaseCollectionManifest } from "../src/modules/digital-profile/services/base-collection-manifest";
import {
  mergeCompositeSerp,
  isMockBaseRow,
  type CompositeObservation,
} from "../src/modules/digital-profile/services/composite-serp-merge";
import {
  buildBaseObservationCoverage,
  assertBaseObservationCoverage,
} from "../src/modules/digital-profile/services/base-observation-coverage";
import {
  manifestBaseObservationIds,
  manifestCorpusIdCount,
  manifestDeltaIdCount,
  type BaseCollectionManifest,
} from "../src/modules/digital-profile/services/unified-collection-types";

process.env.NETWORK_CALLS = "0";

describe("§1.1 captureBaseCollectionManifest — delta + corpus", () => {
  it("partial re-run: delta=3, corpus=50, baseCount=53", async () => {
    const beforeIds = Array.from({ length: 50 }, (_, i) => `old-${i + 1}`);
    const afterIds = [...beforeIds, "new-1", "new-2", "new-3"];
    const prisma = {
      searchResult: {
        findMany: async () => afterIds.map((id) => ({ id })),
      },
      searchSurfaceItem: {
        findMany: async () => [] as Array<{ id: string }>,
      },
    };

    const manifest = await captureBaseCollectionManifest({
      prisma: prisma as never,
      caseId: "case-f5",
      unifiedJobId: "unified-f5",
      beforeSearchResultIds: new Set(beforeIds),
      beforeSearchSurfaceItemIds: new Set(),
      actualProviders: [{ providerId: "yandex", runtime: "real", status: "completed" }],
      baseReportRunId: "base-f5",
    });

    assert.equal(manifest.searchResultIds.length, 3);
    assert.deepEqual(manifest.searchResultIds.sort(), ["new-1", "new-2", "new-3"]);
    assert.equal(manifest.caseCorpusSearchResultIds?.length, 50);
    assert.equal(manifest.caseCorpusSurfaceItemIds?.length, 0);
    assert.equal(manifestDeltaIdCount(manifest), 3);
    assert.equal(manifestCorpusIdCount(manifest), 50);
    assert.equal(manifest.baseCount, 53);
    assert.equal(manifestBaseObservationIds(manifest).length, 53);
  });

  it("empty delta fallback puts all IDs in delta and corpus=[]", async () => {
    const ids = ["a", "b", "c"];
    const prisma = {
      searchResult: { findMany: async () => ids.map((id) => ({ id })) },
      searchSurfaceItem: { findMany: async () => [] as Array<{ id: string }> },
    };
    const manifest = await captureBaseCollectionManifest({
      prisma: prisma as never,
      caseId: "case-empty-delta",
      unifiedJobId: "u-ed",
      beforeSearchResultIds: new Set(ids),
      beforeSearchSurfaceItemIds: new Set(),
      actualProviders: [],
      baseReportRunId: null,
    });
    assert.equal(manifest.searchResultIds.length, 3);
    assert.equal(manifest.caseCorpusSearchResultIds?.length, 0);
    assert.equal(manifest.baseCount, 3);
  });
});

describe("§1.1 merge + coverage — corpus rows reach composite", () => {
  it("delta=3 + corpus=50 → composite ≥ 53, provenance distinguishes groups", async () => {
    const corpusIds = Array.from({ length: 50 }, (_, i) => `old-${i + 1}`);
    const deltaIds = ["new-1", "new-2", "new-3"];
    const rows: CompositeObservation[] = [
      ...deltaIds.map((id, i) => ({
        key: `organic|ru|yandex|q|https://delta.example/${i}`,
        kind: "organic" as const,
        surface: "organic",
        region: "RU",
        engine: "YANDEX",
        providers: ["yandex"],
        primaryProvider: "yandex",
        evidenceRefs: [`searchResult:${id}`],
        baseSearchResultId: id,
        fromCaseCorpus: false,
      })),
      ...corpusIds.map((id, i) => ({
        key: `organic|ru|yandex|q|https://corpus.example/${i}`,
        kind: "organic" as const,
        surface: "organic",
        region: "RU",
        engine: "YANDEX",
        providers: ["yandex"],
        primaryProvider: "yandex",
        evidenceRefs: [`searchResult:${id}`],
        baseSearchResultId: id,
        fromCaseCorpus: true,
      })),
    ];

    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: "unified-f5-merge",
      caseId: "case-f5-merge",
      capturedAt: "2026-01-15T12:00:00.000Z",
      baseReportRunId: "base-f5",
      searchResultIds: deltaIds,
      searchSurfaceItemIds: [],
      caseCorpusSearchResultIds: corpusIds,
      caseCorpusSurfaceItemIds: [],
      baseCount: 53,
      actualProviders: [{ providerId: "yandex", runtime: "real", status: "completed" }],
      realCollectionSufficient: true,
    };

    const merge = await mergeCompositeSerp({ manifest, fixtureBaseRows: rows });
    assert.ok(merge.compositeCount >= 53, `composite=${merge.compositeCount}`);
    assert.equal(merge.observations.filter((o) => o.fromCaseCorpus).length, 50);
    assert.equal(merge.observations.filter((o) => !o.fromCaseCorpus).length, 3);
    assert.deepEqual(
      (merge.provenance.caseCorpusSearchResultIds ?? []).sort(),
      corpusIds.sort()
    );
    assert.equal(merge.provenance.baseSearchResultIds.length, 3);

    const coverage = buildBaseObservationCoverage({ manifest, merge });
    assert.equal(coverage.baseObservationIds.length, 53);
    assert.equal(coverage.missingBaseObservationIds.length, 0);
    assert.equal(assertBaseObservationCoverage(coverage).ok, true);
  });

  it("isMockBaseRow rejects demo/mock providers and example URLs", () => {
    assert.equal(isMockBaseRow({ provider: "yandex", url: "https://news.ru/a" }), false);
    assert.equal(isMockBaseRow({ provider: "mock-yandex", url: "https://news.ru/a" }), true);
    assert.equal(isMockBaseRow({ source: "demo:seed", title: "x" }), true);
    assert.equal(isMockBaseRow({ title: "[demo] Person", url: "https://x.ru" }), true);
    assert.equal(isMockBaseRow({ url: "https://images.example/x.jpg" }), true);
  });
});
