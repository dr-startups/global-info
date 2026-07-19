/**
 * Offline acceptance for REMEDIATION_PLAN §1.4 — evidence supplement
 * (WikipediaCheck + real SERP screenshot selection).
 *
 * Run: npm run smoke:evidence-supplement
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adaptWikipediaCheckToInventoryItem,
  pickRealSerpScreenshot,
  SERP_SCREENSHOT_MAX_AGE_MS,
  type RealSerpScreenshotInput,
} from "../src/modules/digital-profile/services/evidence-supplement-adapter";
import { buildCanonicalVisualAssets } from "../src/modules/digital-profile/services/canonical-visual-assets";
import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";
import { buildIdentityFragment } from "../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders";
import type { ScopedFragmentInput } from "../src/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import {
  buildSurfacePanelSvg,
  svgToPngBase64,
} from "../src/modules/digital-profile/orion-report-spec/media-asset-svg";

process.env.NETWORK_CALLS = "0";

function organicItem(id: string): RawInventoryItem {
  return {
    inventoryId: id,
    caseId: "c",
    reportRunId: "r",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    query: "тест",
    collectedAt: new Date(0).toISOString(),
    evidenceType: "search_result",
    title: `Строка ${id}`,
    snippet: "",
    sourceUrl: `https://example.org/${id}`,
    rawMetadata: { engine: "YANDEX", surface: "organic", queryText: "тест" },
  };
}

describe("§1.4 evidence-supplement", () => {
  it("adapts WikipediaCheck → wikipedia_check inventory item", () => {
    const item = adaptWikipediaCheckToInventoryItem({
      row: {
        id: "w1",
        exists: true,
        language: "ru",
        pageTitle: "Тестов",
        url: "https://ru.wikipedia.org/wiki/Testov",
      },
      caseId: "c",
      reportRunId: "r",
    });
    assert.equal(item.evidenceType, "wikipedia_check");
    assert.equal(item.rawMetadata?.wikipediaExists, true);
    assert.equal(item.rawMetadata?.skipTextClassifier, true);
    assert.equal(item.region, "RU");
  });

  it("pickRealSerpScreenshot prefers fresh regional asset; rejects stale", async () => {
    const png = await svgToPngBase64(
      buildSurfacePanelSvg({
        title: "SERP",
        subtitle: "t",
        engineLabel: "Yandex",
        items: [{ label: "row" }],
      })
    );
    const now = Date.parse("2026-07-19T12:00:00.000Z");
    const fresh: RealSerpScreenshotInput = {
      id: "fresh",
      region: "RU",
      engine: "YANDEX",
      imageData: png,
      capturedAt: "2026-07-10T12:00:00.000Z",
    };
    const stale: RealSerpScreenshotInput = {
      id: "stale",
      region: "RU",
      engine: "YANDEX",
      imageData: png,
      capturedAt: "2025-01-01T12:00:00.000Z",
    };
    assert.equal(pickRealSerpScreenshot([stale], "RU", { nowMs: now }), null);
    assert.equal(pickRealSerpScreenshot([stale, fresh], "RU", { nowMs: now })?.id, "fresh");
    assert.ok(SERP_SCREENSHOT_MAX_AGE_MS > 0);
  });

  it("buildCanonicalVisualAssets prefers real screenshot for p10", async () => {
    const png = await svgToPngBase64(
      buildSurfacePanelSvg({
        title: "LIVE SERP",
        subtitle: "fixture",
        engineLabel: "Yandex",
        items: [{ label: "Subject row" }, { label: "Second row" }],
      })
    );
    const items = [organicItem("o1"), organicItem("o2")];
    const withReal = await buildCanonicalVisualAssets({
      subjectName: "Тест",
      items,
      realSerpScreenshots: [
        {
          id: "cap-1",
          region: "RU",
          engine: "YANDEX",
          imageData: png,
          capturedAt: "2026-07-01T00:00:00.000Z",
        },
      ],
      nowMs: Date.parse("2026-07-19T00:00:00.000Z"),
    });
    assert.equal(withReal.counts.realSerpSnapshots, 1);
    const bound = withReal.visualAssets["p10_ru_serp_visual"];
    assert.ok(bound?.[0]);
    assert.equal(bound![0].kind, "live_serp");
    assert.match(bound![0].assetRef, /_real_cap-1$/);

    const synthetic = await buildCanonicalVisualAssets({
      subjectName: "Тест",
      items,
      realSerpScreenshots: [],
    });
    assert.equal(synthetic.counts.realSerpSnapshots, 0);
    assert.equal(synthetic.visualAssets["p10_ru_serp_visual"]?.[0]?.kind, "serp_screenshot");
  });

  it("identity fragment uses WikipediaCheck.exists for narrative", () => {
    const scoped: ScopedFragmentInput = {
      subject: { displayName: "Тест" },
      findings: [],
      surfaceUnits: [],
      metricSnapshot: {
        metricSnapshotId: "m",
        datasetId: "d",
        reportRunId: "r",
        baseCount: 0,
        enrichmentCount: 0,
        compositeCount: 0,
        subjectMatchCount: 0,
        ambiguousCount: 0,
        otherSubjectCount: 0,
        adverseFindingCount: 0,
        perRegionCounts: {},
      },
      scope: {
        region: "RU",
        engine: null,
        surface: "wikipedia",
        subjectMatch: null,
        findingIds: null,
      },
      evidenceIndex: {
        "inventory:wiki-w1": {
          kind: "wikipedia_check",
          wikipediaExists: false,
          language: "ru",
          region: "RU",
          title: "not found",
        },
      },
    };
    const missing = buildIdentityFragment("RU_IDENTITY_WIKIPEDIA", "RU_PROFILE", "Россия", scoped);
    assert.equal(missing.slides[0]?.emptyStateReason, "wikipedia-not-found");
    assert.match(missing.slides[0]?.content.narrative ?? "", /не найдена/i);

    scoped.evidenceIndex["inventory:wiki-w1"] = {
      kind: "wikipedia_check",
      wikipediaExists: true,
      language: "ru",
      region: "RU",
      title: "Тестов",
      url: "https://ru.wikipedia.org/wiki/Testov",
    };
    const found = buildIdentityFragment("RU_IDENTITY_WIKIPEDIA", "RU_PROFILE", "Россия", scoped);
    assert.equal(found.slides[0]?.emptyStateReason, undefined);
    assert.match(found.slides[0]?.content.narrative ?? "", /WikipediaCheck|проверк/i);
  });
});
