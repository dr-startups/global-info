/**
 * Offline acceptance for REMEDIATION_PLAN §1.2 / F6 — compliance inventory adapter.
 *
 * Run: npm run smoke:compliance-inventory-adapter
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adaptDatabaseProfilesToInventory,
  adaptDatabaseProfileToInventoryItem,
  isActiveComplianceHit,
  resolveComplianceInventoryItems,
  type DatabaseProfileHitInput,
} from "../src/modules/digital-profile/services/compliance-inventory-adapter";
import { classifySubjectRelevance } from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { SubjectIdentity } from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { buildComplianceFragment } from "../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders";
import type { ScopedFragmentInput } from "../src/modules/digital-profile/orion-golden/deck-sections/scoped-input";

process.env.NETWORK_CALLS = "0";

const BASE_ROW: DatabaseProfileHitInput = {
  id: "hit-1",
  provider: "DOW_JONES",
  matchedName: "Test Subject",
  matchType: "PEP",
  matchScore: 80,
  reviewStatus: "PENDING",
  riskTypes: ["PEP"],
  summary: "Fixture hit",
};

const SUBJECT: SubjectIdentity = {
  displayName: "Test Subject",
  lastName: "Subject",
  lastNameVariants: [],
  firstNames: ["Test"],
  patronymics: [],
  aliases: [],
  strongIdentifiers: [],
  contextIdentifiers: [],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

describe("§1.2 compliance-inventory-adapter", () => {
  it("maps DatabaseProfile → compliance_hit inventory item", () => {
    const item = adaptDatabaseProfileToInventoryItem({
      row: BASE_ROW,
      caseId: "case-1",
      reportRunId: "base-1",
    });
    assert.ok(item);
    assert.equal(item!.evidenceType, "compliance_hit");
    assert.equal(item!.source, "database_profile");
    assert.equal(item!.inventoryId, "db-hit-1");
    assert.equal(item!.provider, "DOW_JONES");
    assert.equal(item!.rawMetadata?.surface, "compliance_hit");
    assert.equal(item!.rawMetadata?.matchCategory, "PEP");
    assert.equal(item!.rawMetadata?.matchScore, 80);
    assert.equal(item!.rawMetadata?.reviewStatus, "PENDING");
    assert.equal(item!.rawMetadata?.skipTextClassifier, true);
    assert.deepEqual(item!.rawMetadata?.evidenceRefs, ["databaseProfile:hit-1"]);
  });

  it("excludes DISMISSED and FALSE_POSITIVE", () => {
    assert.equal(isActiveComplianceHit({ ...BASE_ROW, reviewStatus: "DISMISSED" }), false);
    assert.equal(isActiveComplianceHit({ ...BASE_ROW, reviewStatus: "FALSE_POSITIVE" }), false);
    const items = adaptDatabaseProfilesToInventory({
      rows: [
        BASE_ROW,
        { ...BASE_ROW, id: "x", reviewStatus: "DISMISSED" },
        { ...BASE_ROW, id: "y", reviewStatus: "FALSE_POSITIVE" },
      ],
      caseId: "c",
      reportRunId: "r",
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].inventoryId, "db-hit-1");
  });

  it("identity from reviewStatus skips text classifier", () => {
    const pending = adaptDatabaseProfileToInventoryItem({
      row: BASE_ROW,
      caseId: "c",
      reportRunId: "r",
    })!;
    const confirmed = adaptDatabaseProfileToInventoryItem({
      row: { ...BASE_ROW, id: "hit-2", reviewStatus: "MATCH_CONFIRMED" },
      caseId: "c",
      reportRunId: "r",
    })!;

    // Title has no surname tokens — text classifier would be INSUFFICIENT.
    pending.title = "Database match #1";
    confirmed.title = "Database match #2";

    assert.equal(classifySubjectRelevance(pending, SUBJECT).decision, "AMBIGUOUS");
    assert.equal(classifySubjectRelevance(pending, SUBJECT).reasonCode, "compliance_review_pending");
    assert.equal(classifySubjectRelevance(confirmed, SUBJECT).decision, "SUBJECT_MATCH");
    assert.equal(classifySubjectRelevance(confirmed, SUBJECT).reasonCode, "compliance_match_confirmed");
  });

  it("resolveComplianceInventoryItems: explicit hits beat prisma", async () => {
    const prisma = {
      databaseProfile: {
        findMany: async () => [{ ...BASE_ROW, id: "from-db" }],
      },
    };
    const items = await resolveComplianceInventoryItems({
      caseId: "c",
      reportRunId: "r",
      complianceHits: [{ ...BASE_ROW, id: "from-fixture" }],
      prisma,
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].inventoryId, "db-from-fixture");
  });

  it("resolveComplianceInventoryItems: empty array forces no hits", async () => {
    const items = await resolveComplianceInventoryItems({
      caseId: "c",
      reportRunId: "r",
      complianceHits: [],
      prisma: {
        databaseProfile: {
          findMany: async () => [BASE_ROW],
        },
      },
    });
    assert.equal(items.length, 0);
  });

  it("resolveComplianceInventoryItems: loads from prisma when hits omitted", async () => {
    const items = await resolveComplianceInventoryItems({
      caseId: "c",
      reportRunId: "r",
      prisma: {
        databaseProfile: {
          findMany: async () => [
            BASE_ROW,
            { ...BASE_ROW, id: "ln", provider: "LEXISNEXIS", matchType: "SANCTIONS" },
          ],
        },
      },
    });
    assert.equal(items.length, 2);
    assert.ok(items.some((i) => i.provider === "LEXISNEXIS"));
  });

  it("empty hits keep «Совпадений не зафиксировано» on Dow / Lexis slides", () => {
    const scoped: ScopedFragmentInput = {
      subject: { displayName: "Test" },
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
      scope: { region: null, engine: null, surface: "compliance", subjectMatch: null, findingIds: null },
      evidenceIndex: {},
    };
    const out = buildComplianceFragment("COMPLIANCE", scoped, {});
    const dow = out.slides.find((s) => s.baseSlotId === "p34_dow_jones");
    const lexis = out.slides.find((s) => s.baseSlotId === "p35_lexis_visual");
    assert.ok(dow?.content.whatWasFound?.includes("Совпадений"));
    assert.ok(dow?.content.whatWasFound?.includes("не зафиксировано"));
    assert.ok(lexis?.content.whatWasFound?.includes("Совпадений"));
    assert.ok(lexis?.content.whatWasFound?.includes("не зафиксировано"));
  });
});
