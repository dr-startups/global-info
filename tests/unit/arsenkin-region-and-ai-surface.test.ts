import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  arsenkinRegionIdToLabel,
  resolveRegionLabelFromArsenkinRequest,
  ARSENKIN_REGION,
} from "../../src/modules/digital-profile/providers/arsenkin/regions";
import { normalizeCompositeRegion } from "../../src/modules/digital-profile/services/composite-serp-merge";
import { adaptArsenkinToolResponse } from "../../src/modules/digital-profile/services/arsenkin-tool-adapters";

describe("arsenkin region + AI surface routing", () => {
  it("maps Google UAE numeric region to UAE (not RU)", () => {
    assert.equal(arsenkinRegionIdToLabel(ARSENKIN_REGION.GOOGLE_UAE), "UAE");
    assert.equal(arsenkinRegionIdToLabel(String(ARSENKIN_REGION.GOOGLE_UAE)), "UAE");
    assert.equal(arsenkinRegionIdToLabel(ARSENKIN_REGION.YANDEX_MOSCOW), "RU");
    assert.equal(normalizeCompositeRegion("1011981"), "UAE");
    assert.equal(normalizeCompositeRegion("213"), "RU");
  });

  it("resolves UAE from check-top requestJson se[].region", () => {
    const label = resolveRegionLabelFromArsenkinRequest({
      tools_name: "check-top",
      data: {
        query: ["Umar Kremlev"],
        se: [{ type: 11, region: ARSENKIN_REGION.GOOGLE_UAE }],
      },
    });
    assert.equal(label, "UAE");
  });

  it("adaptSearchTop tags UAE from requestJson even when response omits region", () => {
    const adapted = adaptArsenkinToolResponse({
      toolName: "check-top",
      responseJson: {
        items: [{ url: "https://example.com/a", title: "Umar", snippet: "bio" }],
      },
      requestJson: {
        tools_name: "check-top",
        data: { se: [{ type: 11, region: 1011981 }], query: ["Umar"] },
      },
      ctx: {
        caseAgent: "ARSENKIN_SEARCH_TOP_REAL",
        toolName: "check-top",
        externalTaskId: "1",
        enrichmentRunId: "run-uae",
        unifiedJobId: "job-1",
        providerTaskId: "pt-1",
      },
    });
    assert.equal(adapted.ok, true);
    if (!adapted.ok) return;
    assert.equal(adapted.observations[0]?.region, "UAE");
    assert.equal(adapted.observations[0]?.surface, "organic");
  });

  it("adaptAiSearch sets surface ai_answer and keeps citation off url", () => {
    const adapted = adaptArsenkinToolResponse({
      toolName: "ai-serp",
      responseJson: {
        items: [
          {
            title: "AI Overview",
            answer: "Long AI overview text about the subject.",
            url: "https://tass.ru/encyclopedia/person/kremlev",
          },
        ],
      },
      requestJson: { tools_name: "ai-serp", data: { se: 1, region: 213, query: "умар кремлев" } },
      ctx: {
        caseAgent: "ARSENKIN_AI_SEARCH_REAL",
        toolName: "ai-serp",
        externalTaskId: "2",
        enrichmentRunId: "run-ai",
        unifiedJobId: "job-1",
        providerTaskId: "pt-2",
      },
    });
    assert.equal(adapted.ok, true);
    if (!adapted.ok) return;
    const row = adapted.observations[0]!;
    assert.equal(row.surface, "ai_answer");
    assert.equal(row.region, "RU");
    assert.ok(row.snippet && row.snippet.length > 10);
    assert.equal(row.url, undefined);
  });
});
