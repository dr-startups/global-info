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
  isNarrativeOrPlaceholderMatchName,
  pickComplianceClientMatchTitle,
  resolveComplianceInventoryItems,
  type DatabaseProfileHitInput,
} from "../src/modules/digital-profile/services/compliance-inventory-adapter";
import { classifySubjectRelevance } from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { SubjectIdentity } from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import {
  buildComplianceFragment,
  dedupeComplianceHits,
} from "../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders";
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

  it("prefers riskTypes over LEXISNEXIS_SIGNAL; humanizes Potential match title", () => {
    const item = adaptDatabaseProfileToInventoryItem({
      row: {
        ...BASE_ROW,
        id: "ln-1",
        provider: "LEXISNEXIS",
        matchType: "LEXISNEXIS_SIGNAL",
        matchedName: "Potential match",
        subjectName: "Дерипаска Олег Владимирович",
        riskTypes: ["ADVERSE_MEDIA"],
      },
      caseId: "c",
      reportRunId: "r",
    });
    assert.ok(item);
    assert.equal(item!.rawMetadata?.matchCategory, "ADVERSE_MEDIA");
    assert.equal(item!.title, "Дерипаска Олег Владимирович");
  });

  it("rejects English narrative blobs as match names (PDF p41)", () => {
    const blob =
      "Additional Information On December 11, 2025, the Moldova Interinstitutional Supervisory Council designated Oleg Vladimir";
    assert.equal(isNarrativeOrPlaceholderMatchName(blob), true);
    assert.equal(
      pickComplianceClientMatchTitle({
        matchedName: blob,
        subjectName: "Дерипаска Олег Владимирович",
      }),
      "Дерипаска Олег Владимирович"
    );
    const item = adaptDatabaseProfileToInventoryItem({
      row: {
        ...BASE_ROW,
        id: "ln-blob",
        provider: "LEXISNEXIS",
        matchType: "LEXISNEXIS_SIGNAL",
        matchedName: blob,
        subjectName: "Дерипаска Олег Владимирович",
        riskTypes: ["SANCTIONS"],
      },
      caseId: "c",
      reportRunId: "r",
    });
    assert.equal(item!.title, "Дерипаска Олег Владимирович");
  });

  it("dedupes Lexis hits with same provider/category/score/name", () => {
    const subject = "Дерипаска Олег Владимирович";
    const hits: Array<[string, { kind: string; providerLabel: string; matchCategory: string; matchScore: number; title: string; reviewStatus: string }]> = [
      [
        "inventory:db-a",
        {
          kind: "compliance_hit",
          providerLabel: "LEXISNEXIS",
          matchCategory: "SANCTIONS",
          matchScore: 85,
          title:
            "Additional Information On December 11, 2025, the Moldova Interinstitutional Supervisory Council designated Oleg Vladimir",
          reviewStatus: "NEEDS_REVIEW",
        },
      ],
      [
        "inventory:db-b",
        {
          kind: "compliance_hit",
          providerLabel: "LEXISNEXIS",
          matchCategory: "SANCTIONS",
          matchScore: 85,
          title:
            "Additional Information On December 11, 2025, the Moldova Interinstitutional Supervisory Council designated Oleg Vladimir",
          reviewStatus: "NEEDS_REVIEW",
        },
      ],
      [
        "inventory:db-c",
        {
          kind: "compliance_hit",
          providerLabel: "LEXISNEXIS",
          matchCategory: "ADVERSE_MEDIA",
          matchScore: 52,
          title: subject,
          reviewStatus: "NEEDS_REVIEW",
        },
      ],
    ];
    const deduped = dedupeComplianceHits(hits as never, subject);
    assert.equal(deduped.length, 2);
    const scoped: ScopedFragmentInput = {
      subject: { displayName: subject },
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
        likelySubjectCount: 0,
        ambiguousCount: 0,
        otherSubjectCount: 0,
        adverseFindingCount: 0,
        perRegionCounts: {},
      },
      scope: { region: null, engine: null, surface: "compliance", subjectMatch: null, findingIds: null },
      evidenceIndex: Object.fromEntries(hits),
    };
    const out = buildComplianceFragment("COMPLIANCE", scoped, {});
    const lexis = out.slides.find((s) => s.baseSlotId === "p35_lexis_visual")!;
    const nameCells = (lexis.content.table?.rows ?? [])
      .filter((r) => r[0] === "Совпадение по имени")
      .map((r) => r[1]);
    assert.equal(nameCells.length, 2);
    assert.ok(nameCells.every((n) => n === subject));
    assert.ok(!nameCells.some((n) => /Additional Information/i.test(String(n))));
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
        likelySubjectCount: 0,
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
