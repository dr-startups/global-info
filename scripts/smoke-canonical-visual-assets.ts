/**
 * Smoke: canonical synthetic visual assets for the unified report.
 *
 * Offline, deterministic: builds SERP snapshots / suggestion panels / related
 * panels / AI panels / image grids from composite inventory items and checks
 *   - assets carry PNG imageData and the evidenceRefs of drawn rows;
 *   - slot binding targets the canonical slot ids the fragments consume;
 *   - adverse rows are red-frame classified in visibleItems;
 *   - empty surfaces produce NO asset (honest empty state downstream);
 *   - full canonical prepare persists report-assets.json + binding and passes
 *     assets to the renderer.
 */

process.env.NETWORK_CALLS = "0";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";
import { buildCanonicalVisualAssets } from "../src/modules/digital-profile/services/canonical-visual-assets";
import {
  compositeObservationsToInventory,
  runCanonicalReportPrepare,
} from "../src/modules/digital-profile/services/canonical-report-prepare";
import type { CompositeObservation } from "../src/modules/digital-profile/services/composite-serp-merge";

function item(over: Partial<RawInventoryItem>): RawInventoryItem {
  return {
    inventoryId: over.inventoryId ?? `inv-${Math.random().toString(36).slice(2, 10)}`,
    caseId: "case-vis",
    reportRunId: "run-vis",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    query: "иван тестов",
    collectedAt: new Date(0).toISOString(),
    evidenceType: "search_result",
    title: "Заголовок",
    snippet: "",
    sourceUrl: "https://example.org/a",
    rawMetadata: { engine: "YANDEX", surface: "organic", queryText: "иван тестов" },
    ...over,
  };
}

describe("canonical visual assets", () => {
  it("builds SERP snapshot with red-framed adverse row bound to p10", async () => {
    const items: RawInventoryItem[] = [
      item({
        inventoryId: "o1",
        title: "Иван Тестов — биография",
        sourceUrl: "https://forbes.ru/ivan-testov",
      }),
      item({
        inventoryId: "o2",
        title: "Иван Тестов: уголовное дело и арест",
        sourceUrl: "https://rucriminal.info/testov",
        rawMetadata: { engine: "GOOGLE", surface: "organic", queryText: "иван тестов" },
      }),
    ];
    const out = await buildCanonicalVisualAssets({ subjectName: "Тестов Иван", items });
    assert.equal(out.counts.serpSnapshots, 1);
    const bound = out.visualAssets["p10_ru_serp_visual"];
    assert.ok(bound && bound.length === 1, "p10 must have one bound asset");
    assert.ok(bound[0].hasImage);
    const adverse = (bound[0].visibleItems ?? []).find((v) => v.adverse);
    assert.ok(adverse, "rucriminal row must be red-frame classified");
    assert.equal(adverse!.ref, "inventory:o2");
    const asset = out.assets.find((a) => a.assetRef === bound[0].assetRef)!;
    assert.ok(String(asset.imageData ?? "").length > 1000, "asset carries PNG base64");
    assert.ok((asset.evidenceRefs as string[]).includes("inventory:o2"));
  });

  it("builds suggestion / related / AI / image assets on their canonical slots", async () => {
    const items: RawInventoryItem[] = [
      item({
        inventoryId: "s1",
        evidenceType: "suggestion",
        title: "иван тестов уголовное дело",
        sourceUrl: undefined,
        rawMetadata: { engine: "YANDEX", surface: "autocomplete", queryText: "иван тестов" },
      }),
      item({
        inventoryId: "r1",
        evidenceType: "related_query",
        title: "кто такой иван тестов",
        sourceUrl: undefined,
        rawMetadata: { engine: "GOOGLE", surface: "paa", queryText: "иван тестов" },
      }),
      item({
        inventoryId: "a1",
        evidenceType: "ai_answer",
        title: "AI Overview",
        snippet: "Иван Тестов — предприниматель в сфере логистики.",
        sourceUrl: undefined,
        provider: "arsenkin",
        rawMetadata: { engine: "ARSENKIN", surface: "ai_answer", queryText: "иван тестов" },
      }),
      item({
        inventoryId: "i1",
        evidenceType: "image_result",
        title: "Фото с конференции",
        sourceUrl: "https://media.example.org/photo.jpg",
        rawMetadata: { engine: "GOOGLE", surface: "images", queryText: "иван тестов" },
      }),
    ];
    const out = await buildCanonicalVisualAssets({ subjectName: "Тестов Иван", items });
    assert.ok(out.visualAssets["p11_ru_suggestions_yandex"], "suggestions bound to p11");
    assert.ok(out.visualAssets["p20_ru_related_1"], "related bound to p20");
    assert.ok(out.visualAssets["p19_ru_knowledge_2"], "AI answers bound to p19");
    assert.ok(out.visualAssets["p14_ru_images_1"], "images bound to p14");
    for (const metas of Object.values(out.visualAssets)) {
      for (const m of metas) {
        assert.ok(m.hasImage);
        assert.ok((m.evidenceRefs ?? []).every((r) => r.startsWith("inventory:")));
      }
    }
  });

  it("produces NO asset for empty surfaces (fail-closed, honest empty state)", async () => {
    const out = await buildCanonicalVisualAssets({
      subjectName: "Тестов Иван",
      items: [item({ inventoryId: "only-organic" })],
    });
    assert.equal(out.visualAssets["p14_ru_images_1"], undefined);
    assert.equal(out.visualAssets["p19_ru_knowledge_2"], undefined);
    assert.equal(out.visualAssets["p28_uae_suggestions"], undefined);
  });

  it("surface hints survive composite → inventory → visual build (images/ai)", async () => {
    const observations: CompositeObservation[] = [
      {
        key: "k1",
        kind: "organic",
        surface: "organic",
        region: "RU",
        engine: "YANDEX",
        query: "иван тестов",
        url: "https://example.org/1",
        title: "Иван Тестов",
        providers: ["yandex"],
        primaryProvider: "yandex",
        evidenceRefs: ["searchResult:1"],
      },
      {
        key: "k2",
        kind: "other",
        surface: "images",
        region: "RU",
        engine: "GOOGLE",
        query: "иван тестов",
        url: "https://img.example.org/1.jpg",
        title: "Фото",
        providers: ["serper"],
        primaryProvider: "serper",
        evidenceRefs: ["searchSurfaceItem:2"],
      },
      {
        key: "k3",
        kind: "other",
        surface: "ai_answer",
        region: "RU",
        engine: "ARSENKIN",
        query: "иван тестов",
        title: "AI Overview",
        snippet: "Предприниматель.",
        providers: ["arsenkin"],
        primaryProvider: "arsenkin",
        evidenceRefs: [],
      },
    ];
    const items = compositeObservationsToInventory({
      caseId: "case-vis",
      baseReportRunId: "run-vis",
      enrichmentRunId: "enr-vis",
      observations,
    });
    assert.equal(items.find((i) => i.inventoryId && i.rawMetadata?.surface === "images")?.evidenceType, "image_result");
    assert.equal(items.find((i) => i.rawMetadata?.surface === "ai_answer")?.evidenceType, "ai_answer");
    const out = await buildCanonicalVisualAssets({ subjectName: "Тестов Иван", items });
    assert.ok(out.visualAssets["p14_ru_images_1"], "composite image row reaches image grid");
    assert.ok(out.visualAssets["p19_ru_knowledge_2"], "composite AI row reaches AI panel");
  });
});

describe("canonical prepare persists and forwards visual assets", () => {
  it("writes report-assets.json + visual-assets-by-slot.json and passes assets to renderer", async () => {
    const dir = join(tmpdir(), `canonical-visuals-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, "subject-identity-profile.json"),
        JSON.stringify({
          displayName: "Тестов Иван Петрович",
          aliases: ["Ivan Testov"],
          contextIdentifiers: ["логистика"],
        }),
        "utf8"
      );
      const observations: CompositeObservation[] = [
        {
          key: "o1",
          kind: "organic",
          surface: "organic",
          region: "RU",
          engine: "YANDEX",
          query: "тестов иван",
          url: "https://forbes.ru/testov",
          title: "Тестов Иван Петрович — предприниматель в сфере логистики",
          snippet: "Тестов Иван Петрович — предприниматель, логистика.",
          providers: ["yandex"],
          primaryProvider: "yandex",
          evidenceRefs: ["searchResult:1"],
        },
        {
          key: "s1",
          kind: "suggestion",
          surface: "autocomplete",
          region: "RU",
          engine: "YANDEX",
          query: "тестов иван",
          suggestion: "тестов иван логистика",
          title: "тестов иван логистика",
          providers: ["arsenkin"],
          primaryProvider: "arsenkin",
          evidenceRefs: [],
        },
      ];
      let renderedAssets: unknown[] | null = null;
      const result = await runCanonicalReportPrepare({
        caseId: "case-vis",
        unifiedJobId: "job-vis",
        artifactsDir: dir,
        binding: {
          version: "report-data-binding-v1",
          caseId: "case-vis",
          unifiedJobId: "job-vis",
          baseReportRunId: "run-vis",
          enrichmentRunIds: ["enr-vis"],
          compositeDatasetId: "composite-job-vis",
          providerCounts: { yandex: 1, serper: 0, arsenkin: 1, composite: 2 },
          generatedAt: new Date().toISOString(),
        },
        merge: {
          compositeDatasetId: "composite-job-vis",
          observations,
          providerCounts: { yandex: 1, serper: 0, arsenkin: 1, composite: 2 },
          baseCount: 1,
          compositeCount: 2,
          provenance: {
            unifiedJobId: "job-vis",
            baseProviders: ["yandex"],
            enrichmentProviders: ["arsenkin"],
            baseSearchResultIds: ["1"],
            baseSearchSurfaceItemIds: [],
            enrichmentRunIds: ["enr-vis"],
          },
        },
        render: async (input) => {
          renderedAssets = input.assets ?? [];
          return { pageCount: input.deckManifest.pageCount, renderer: "fake-offline" };
        },
      });
      assert.ok(result.ok);
      assert.ok(existsSync(join(dir, "report-assets.json")), "report-assets.json persisted");
      assert.ok(
        existsSync(join(dir, "visual-assets-by-slot.json")),
        "visual-assets-by-slot.json persisted"
      );
      const persisted = JSON.parse(readFileSync(join(dir, "report-assets.json"), "utf8")) as Array<{
        assetRef: string;
        imageData?: string;
      }>;
      assert.ok(persisted.length >= 2, "SERP snapshot + suggestions panel persisted");
      assert.ok(persisted.every((a) => (a.imageData ?? "").length > 0));
      assert.ok(renderedAssets && (renderedAssets as unknown[]).length === persisted.length,
        "renderer received the same assets");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
