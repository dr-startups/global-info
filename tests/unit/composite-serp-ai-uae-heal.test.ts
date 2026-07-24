import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeCompositeSerp } from "../../src/modules/digital-profile/services/composite-serp-merge";
import type { BaseCollectionManifest } from "../../src/modules/digital-profile/services/unified-collection-types";

describe("composite merge heals UAE region + AI surface", () => {
  it("remaps check-top rows to UAE via providerTask requestJson and keeps AI separate", async () => {
    const manifest = {
      unifiedJobId: "unified-heal-1",
      baseCount: 0,
      actualProviders: [],
      searchResultIds: [],
      searchSurfaceItemIds: [],
      baseSearchResultIds: [],
      baseSearchSurfaceItemIds: [],
      realCollectionSufficient: true,
    } as unknown as BaseCollectionManifest;

    const prisma = {
      providerTask: {
        findMany: async () => [
          {
            id: "pt-uae",
            requestJson: {
              tools_name: "check-top",
              data: { se: [{ type: 11, region: 1011981 }], query: ["Umar"] },
            },
          },
          {
            id: "pt-ai",
            requestJson: {
              tools_name: "ai-serp",
              data: { se: 1, region: 213, query: "умар" },
            },
          },
        ],
      },
    };

    const merge = await mergeCompositeSerp({
      prisma: prisma as never,
      manifest,
      arsenkinObservations: [
        {
          kind: "organic",
          region: "RU",
          engine: "ARSENKIN",
          query: "Umar",
          url: "https://example.com/uae-result",
          title: "UAE organic",
          tool: "check-top",
          providerTaskId: "pt-uae",
        },
        {
          kind: "other",
          region: "RU",
          engine: "ARSENKIN",
          query: "умар",
          title: "AI Overview",
          snippet: "Long AI answer text about Umar Kremlev from search AI.",
          url: "https://example.com/uae-result",
          tool: "ai-serp",
          providerTaskId: "pt-ai",
        },
      ],
    });

    const uaeOrganic = merge.observations.filter(
      (o) => o.surface === "organic" && o.region === "UAE"
    );
    const ai = merge.observations.filter((o) => o.surface === "ai_answer");
    assert.equal(uaeOrganic.length, 1);
    assert.equal(ai.length, 1);
    assert.ok((ai[0]?.snippet ?? "").includes("Long AI answer"));
  });
});
