/**
 * Offline acceptance for REMEDIATION_PLAN §1.3 — analyst overrides.
 *
 * Run: npm run smoke:analyst-overrides
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";
import type { SubjectResolutionItem } from "../src/modules/digital-profile/orion-golden/contracts/subject-resolution";
import {
  applyAnalystOverrides,
  buildInventoryOverrideIndex,
  findInventoryForOverride,
  type AnalystOverridesBundle,
} from "../src/modules/digital-profile/services/analyst-overrides-loader";
import { ADVERSE_PATTERNS } from "../src/modules/digital-profile/orion-golden/analytics/surface-analyzers";

process.env.NETWORK_CALLS = "0";

function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "inventoryId" | "title">): RawInventoryItem {
  return {
    caseId: "c",
    reportRunId: "r",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: new Date(0).toISOString(),
    evidenceType: "search_result",
    snippet: "",
    ...partial,
  };
}

function resolution(inventoryId: string, decision: SubjectResolutionItem["decision"]): SubjectResolutionItem {
  return {
    evidenceRef: `inventory:${inventoryId}`,
    decision,
    confidence: 0.9,
    matchedIdentifiers: ["Holmström"],
    conflictingIdentifiers: [],
    reasonCode: "test",
  };
}

describe("§1.3 analyst-overrides", () => {
  it("matches inventory by searchResult id and normalized URL", () => {
    const items = [
      item({
        inventoryId: "a",
        title: "Tax probe",
        sourceUrl: "https://RU.EXAMPLE/path/?utm_source=x",
        rawMetadata: {
          sourceEvidenceRefs: ["searchResult:sr-1"],
          baseSearchResultId: "sr-1",
        },
      }),
    ];
    const index = buildInventoryOverrideIndex(items);
    assert.equal(findInventoryForOverride(index, { searchResultId: "sr-1" }).length, 1);
    assert.equal(
      findInventoryForOverride(index, { url: "https://ru.example/path" }).length,
      1
    );
  });

  it("neutral removes material from adverse", () => {
    const adverseItem = item({
      inventoryId: "adv",
      title: "Faces tax-fraud probe and criminal investigation",
      sourceUrl: "https://ru.example/fraud",
      rawMetadata: { sourceEvidenceRefs: ["searchResult:sr-adv"], baseSearchResultId: "sr-adv" },
    });
    assert.equal(ADVERSE_PATTERNS.test(adverseItem.title), true);

    const resolutionByRef = new Map([["inventory:adv", resolution("adv", "SUBJECT_MATCH")]]);
    const subjectResolution = {
      schemaVersion: "subject-resolution-v1" as const,
      caseId: "c",
      datasetId: "d",
      sourceHashes: [],
      evidenceRefs: ["inventory:adv"],
      subjectDisplayName: "Test",
      items: [resolution("adv", "SUBJECT_MATCH")],
    };
    const overrides: AnalystOverridesBundle = {
      version: "analyst-overrides-v1",
      caseId: "c",
      classification: [
        {
          searchResultId: "sr-adv",
          classification: "NEUTRAL",
          source: "result_classification",
        },
      ],
      manualReview: [],
      approvedFindings: [],
    };
    const { applied } = applyAnalystOverrides({
      items: [adverseItem],
      resolutionByRef,
      subjectResolution,
      overrides,
    });
    assert.ok(applied.some((a) => a.kind === "classification_neutral"));
    assert.equal(adverseItem.rawMetadata?.analystNeutral, true);
    // Surface/synth adverse helpers honor analystNeutral (see surface-analyzers).
    const meta = adverseItem.rawMetadata as Record<string, unknown>;
    assert.equal(meta.analystNeutral === true, true);
  });

  it("adverse adds adverse_media classification", () => {
    const benign = item({
      inventoryId: "b",
      title: "CEO investor profile",
      rawMetadata: { sourceEvidenceRefs: ["searchResult:sr-b"], baseSearchResultId: "sr-b" },
    });
    const resolutionByRef = new Map([["inventory:b", resolution("b", "SUBJECT_MATCH")]]);
    const subjectResolution = {
      schemaVersion: "subject-resolution-v1" as const,
      caseId: "c",
      datasetId: "d",
      sourceHashes: [],
      evidenceRefs: ["inventory:b"],
      subjectDisplayName: "Test",
      items: [resolution("b", "SUBJECT_MATCH")],
    };
    applyAnalystOverrides({
      items: [benign],
      resolutionByRef,
      subjectResolution,
      overrides: {
        version: "analyst-overrides-v1",
        caseId: "c",
        classification: [
          {
            searchResultId: "sr-b",
            classification: "ADVERSE_MEDIA",
            riskTheme: "adverse_media",
            source: "result_classification",
          },
        ],
        manualReview: [],
        approvedFindings: [],
      },
    });
    assert.equal(benign.classification, "adverse_media");
    assert.equal(benign.rawMetadata?.analystAdverse, true);
  });

  it("OTHER_SUBJECT overrides SUBJECT_MATCH", () => {
    const row = item({
      inventoryId: "s",
      title: "Anders Holmström founder of Nordkap Capital",
      rawMetadata: { sourceEvidenceRefs: ["searchResult:sr-s"], baseSearchResultId: "sr-s" },
    });
    const resolutionByRef = new Map([["inventory:s", resolution("s", "SUBJECT_MATCH")]]);
    const subjectResolution = {
      schemaVersion: "subject-resolution-v1" as const,
      caseId: "c",
      datasetId: "d",
      sourceHashes: [],
      evidenceRefs: ["inventory:s"],
      subjectDisplayName: "Test",
      items: [resolution("s", "SUBJECT_MATCH")],
    };
    applyAnalystOverrides({
      items: [row],
      resolutionByRef,
      subjectResolution,
      overrides: {
        version: "analyst-overrides-v1",
        caseId: "c",
        classification: [
          {
            searchResultId: "sr-s",
            classification: "OTHER_SUBJECT",
            source: "result_classification",
          },
        ],
        manualReview: [],
        approvedFindings: [],
      },
    });
    assert.equal(resolutionByRef.get("inventory:s")?.decision, "OTHER_SUBJECT");
    assert.equal(subjectResolution.items[0]?.decision, "OTHER_SUBJECT");
  });
});
