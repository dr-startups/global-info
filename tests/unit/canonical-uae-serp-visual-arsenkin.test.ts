import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { buildCanonicalVisualAssets } from "../../src/modules/digital-profile/services/canonical-visual-assets";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";

describe("canonical UAE SERP visual from Arsenkin organic", () => {
  it("builds p27 when organic rows have engine=ARSENKIN", async () => {
    const items: RawInventoryItem[] = Array.from({ length: 8 }, (_, i) => ({
      inventoryId: `uae-${i}`,
      caseId: "case-1",
      reportRunId: "run-1",
      source: "arsenkin",
      provider: "arsenkin",
      region: "UAE",
      query: "Umar Kremlev",
      collectedAt: new Date().toISOString(),
      evidenceType: "serp_result",
      title: `Umar Kremlev result ${i}`,
      snippet: "President of IBA",
      sourceUrl: `https://example.com/uae/${i}`,
      rawMetadata: { engine: "ARSENKIN", surface: "organic", provider: "arsenkin" },
    }));

    const visuals = await buildCanonicalVisualAssets({
      subjectName: "Умар Назарович Кремлев",
      items,
      allowImagePreviewNetwork: false,
    });

    assert.ok(visuals.visualAssets.p27_uae_serp_visual?.length, "p27 asset bound");
    assert.ok(visuals.counts.serpSnapshots >= 1);
  });
});
