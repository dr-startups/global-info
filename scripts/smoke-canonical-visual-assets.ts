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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";
import {
  buildImageGridItems,
  fetchImagePreviewsWithBudget,
} from "../src/modules/digital-profile/orion-golden/assets/media-asset-svg";
import { buildCanonicalVisualAssets } from "../src/modules/digital-profile/services/canonical-visual-assets";
import {
  compositeObservationsToInventory,
  runCanonicalReportPrepare,
} from "../src/modules/digital-profile/services/canonical-report-prepare";
import type { CompositeObservation } from "../src/modules/digital-profile/services/composite-serp-merge";

/** 1×1 PNG — sharp-decodable bytes for fake preview fetch (§5.2). */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

function fakeOkResponse(): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      TINY_PNG.buffer.slice(TINY_PNG.byteOffset, TINY_PNG.byteOffset + TINY_PNG.byteLength),
  } as Response;
}

function fakeFailResponse(): Response {
  return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
}

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

  it("REMEDIATION §5.1: one panel failure leaves SERP snapshots built", async () => {
    const items: RawInventoryItem[] = [
      item({
        inventoryId: "o1",
        title: "Иван Тестов — биография",
        sourceUrl: "https://forbes.ru/ivan-testov",
      }),
      item({
        inventoryId: "s1",
        evidenceType: "suggestion",
        title: "иван тестов уголовное дело",
        sourceUrl: undefined,
        rawMetadata: { engine: "YANDEX", surface: "autocomplete", queryText: "иван тестов" },
      }),
      item({
        inventoryId: "s2",
        evidenceType: "suggestion",
        title: "иван тестов биография",
        sourceUrl: undefined,
        rawMetadata: { engine: "GOOGLE", surface: "autocomplete", queryText: "иван тестов" },
      }),
    ];
    const out = await buildCanonicalVisualAssets({
      subjectName: "Тестов Иван",
      items,
      injectFailureForAssetRef: "ru_suggestions_yandex",
    });
    assert.equal(out.counts.serpSnapshots, 1, "SERP snapshot must survive panel failure");
    assert.ok(out.visualAssets["p10_ru_serp_visual"]?.length, "p10 SERP bound");
    assert.equal(out.visualAssets["p11_ru_suggestions_yandex"], undefined);
    assert.ok(out.failed.some((f) => f.assetRef === "ru_suggestions_yandex"));
    assert.equal(out.failed.length, 1);
    // Sibling suggestion panel still builds.
    assert.ok(out.visualAssets["p12_ru_suggestions_google"]?.length);
  });

  it("REMEDIATION §5.2: 2 of 6 fetches fail → grid built with 2 placeholders", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      fetchCalls += 1;
      const url = String(input);
      return url.includes("/fail-") ? fakeFailResponse() : fakeOkResponse();
    }) as typeof fetch;
    const items = Array.from({ length: 6 }, (_, i) => ({
      title: `Фото ${i + 1}`,
      domain: `cdn${i}.example.org`,
      imageUrl:
        i < 2
          ? `https://cdn.example.org/fail-${i}.jpg`
          : `https://cdn.example.org/ok-${i}.jpg`,
    }));
    const grid = await buildImageGridItems(items, {
      fetchImpl,
      concurrency: 4,
      timeoutMs: 5000,
      budgetMs: 30_000,
    });
    assert.equal(grid.length, 6);
    assert.equal(grid.filter((g) => !g.previewBase64).length, 2);
    assert.equal(grid.filter((g) => Boolean(g.previewBase64)).length, 4);
    assert.ok(grid.every((g) => g.unavailableNote || g.previewBase64));
    assert.equal(fetchCalls, 6);
  });

  it("REMEDIATION §5.2: offline NETWORK_CALLS=0 does not fetch", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async () => {
      fetchCalls += 1;
      return fakeOkResponse();
    }) as typeof fetch;
    // Without inject, tryFetch short-circuits under NETWORK_CALLS=0.
    const offline = await fetchImagePreviewsWithBudget(
      ["https://cdn.example.org/a.jpg", "https://cdn.example.org/b.jpg"],
      { concurrency: 4, budgetMs: 30_000 }
    );
    assert.equal(offline.get("https://cdn.example.org/a.jpg"), undefined);
    assert.equal(offline.get("https://cdn.example.org/b.jpg"), undefined);
    // Injected fetch still runs (tests); production offline never passes inject.
    const withInject = await fetchImagePreviewsWithBudget(["https://cdn.example.org/c.jpg"], {
      fetchImpl,
      concurrency: 1,
    });
    assert.ok(withInject.get("https://cdn.example.org/c.jpg"));
    assert.equal(fetchCalls, 1);
  });

  it("REMEDIATION §5.2: disk cache skips network on second pass", async () => {
    const cacheDir = join(tmpdir(), `img-preview-cache-${Date.now()}`);
    mkdirSync(cacheDir, { recursive: true });
    try {
      let fetchCalls = 0;
      const fetchImpl = (async () => {
        fetchCalls += 1;
        return fakeOkResponse();
      }) as typeof fetch;
      const url = "https://cdn.example.org/cached.jpg";
      const first = await fetchImagePreviewsWithBudget([url], {
        fetchImpl,
        cacheDir,
        concurrency: 1,
      });
      assert.ok(first.get(url));
      assert.equal(fetchCalls, 1);
      const second = await fetchImagePreviewsWithBudget([url], {
        fetchImpl,
        cacheDir,
        concurrency: 1,
      });
      assert.ok(second.get(url));
      assert.equal(fetchCalls, 1, "second pass must hit disk cache");
      assert.ok(readdirSync(cacheDir).some((f) => f.endsWith(".b64")));
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  it("REMEDIATION §5.2: canonical grids use injected preview fetch + placeholders", async () => {
    let fetchCalls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      fetchCalls += 1;
      return String(input).includes("fail") ? fakeFailResponse() : fakeOkResponse();
    }) as typeof fetch;
    const items: RawInventoryItem[] = Array.from({ length: 6 }, (_, i) =>
      item({
        inventoryId: `img-${i}`,
        evidenceType: "image_result",
        title: `Фото ${i}`,
        sourceUrl: `https://cdn.example.org/${i < 2 ? "fail" : "ok"}-${i}.jpg`,
        imageUrl: `https://cdn.example.org/${i < 2 ? "fail" : "ok"}-${i}.jpg`,
        rawMetadata: { engine: "GOOGLE", surface: "images", queryText: "иван тестов" },
      })
    );
    const out = await buildCanonicalVisualAssets({
      subjectName: "Тестов Иван",
      items,
      fetchImagePreviews: true,
      previewFetch: { fetchImpl, concurrency: 4, budgetMs: 30_000 },
    });
    assert.ok(out.visualAssets["p14_ru_images_1"]?.length);
    assert.equal(out.counts.imageGrids, 1);
    assert.equal(fetchCalls, 6);
    const asset = out.assets.find((a) => a.assetRef === "ru_image_grid_1");
    assert.ok(asset && String(asset.imageData ?? "").length > 1000);
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
