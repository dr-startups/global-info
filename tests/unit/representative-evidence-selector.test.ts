/**
 * Stage 3 — RepresentativeEvidenceSelector.
 * NETWORK_CALLS=0 (vitest.config env).
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";
import {
  buildSubjectResolution,
  type SubjectIdentity,
} from "../../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { synthesizeFindings } from "../../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { buildObservationDispositionLedger } from "../../src/modules/digital-profile/orion-golden/analytics/observation-disposition-ledger";
import { buildCanonicalClaimsBundle } from "../../src/modules/digital-profile/orion-golden/analytics/canonical-claim-builder";
import {
  assertRepresentativeGatesPass,
  buildSemanticDisplayExcerpt,
  representativeSelectionFingerprint,
  selectRepresentativeEvidence,
} from "../../src/modules/digital-profile/orion-golden/analytics/representative-evidence-selector";
import { validateStage1Contract } from "../../src/modules/digital-profile/orion-golden/contracts";
import { sampleRepresentativeEvidenceSelection } from "../../src/modules/digital-profile/orion-golden/contracts/sample-contracts";
import type { CanonicalClaim } from "../../src/modules/digital-profile/orion-golden/contracts/canonical-claim";

const CASE_A = "case-rep-a";
const CASE_B = "case-rep-b";

let seq = 0;
function item(
  caseId: string,
  partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">
): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-${seq}`,
    caseId,
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-07-16T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: partial.snippet ?? "",
    sourceUrl: partial.sourceUrl ?? `https://news.example/${seq}`,
    ...partial,
  };
}

const SUBJECT_A: SubjectIdentity = {
  displayName: "Тестов Сергей Михайлович",
  lastName: "Тестов",
  lastNameVariants: ["testov"],
  firstNames: ["Сергей", "sergey"],
  patronymics: ["Михайлович"],
  aliases: ["Тестов Сергей Михайлович"],
  strongIdentifiers: ["770000000001"],
  contextIdentifiers: ["бизнесмен"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

const SUBJECT_B: SubjectIdentity = {
  displayName: "John Smith",
  lastName: "Smith",
  lastNameVariants: ["smith"],
  firstNames: ["John", "john"],
  patronymics: [],
  aliases: ["John Smith"],
  strongIdentifiers: ["US-TAX-999"],
  contextIdentifiers: ["investor"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

function selectFor(
  caseId: string,
  subject: SubjectIdentity,
  items: RawInventoryItem[],
  force?: Map<string, "SUBJECT_MATCH" | "LIKELY_SUBJECT" | "AMBIGUOUS" | "OTHER_SUBJECT">
) {
  const resolution = buildSubjectResolution({
    caseId,
    datasetId: `ds-${caseId}`,
    subject,
    items,
    sourceHashes: ["sha256:test"],
  });
  const byRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));
  if (force) {
    for (const [ref, decision] of force) {
      const cur = byRef.get(ref);
      if (cur) byRef.set(ref, { ...cur, decision, reasonCode: `forced:${decision}` });
    }
  }
  const synthesis = synthesizeFindings({
    caseId,
    datasetId: `ds-${caseId}`,
    items,
    resolutionByRef: byRef,
    sourceHashes: ["sha256:test"],
  });
  const dispositionLedger = buildObservationDispositionLedger({
    caseId,
    datasetId: `ds-${caseId}`,
    inventoryReportRunId: "base-run-1",
    sourceHashes: ["sha256:test"],
    items,
    resolutionByRef: byRef,
    synthesis,
  });
  const claimsBundle = buildCanonicalClaimsBundle({
    caseId,
    datasetId: `ds-${caseId}`,
    subjectId: subject.displayName,
    sourceHashes: ["sha256:test"],
    items,
    synthesis,
    dispositionLedger,
  });
  const result = selectRepresentativeEvidence({
    caseId,
    datasetId: `ds-${caseId}`,
    subjectId: subject.displayName,
    sourceHashes: ["sha256:test"],
    claimsBundle,
  });
  return { ...result, claimsBundle };
}

describe("representative-evidence-selector Stage 3", () => {
  it("validates sample contract", () => {
    const parsed = validateStage1Contract(
      "RepresentativeEvidenceSelection",
      sampleRepresentativeEvidenceSelection()
    );
    expect(parsed.success).toBe(true);
  });

  it("covers every material theme including corruption not crowded out by politics", () => {
    const politicsMany = Array.from({ length: 5 }, (_, i) =>
      item(CASE_A, {
        title: `Политические связи Тестова с правительством №${i + 1}`,
        snippet: "political exposure parliament government",
        sourceUrl: `https://politics.example/${i + 1}`,
      })
    );
    const corruption = item(CASE_A, {
      title: "Расследование ФБК о коррупции и конфликте интересов Тестова",
      snippet: "коррупционные риски и этика",
      sourceUrl: "https://www.currenttime.tv/a/corruption-fixture",
    });
    const items = [...politicsMany, corruption];
    const force = new Map(
      items.map((it) => [`inventory:${it.inventoryId}`, "SUBJECT_MATCH" as const])
    );
    const { selection, coverage } = selectFor(CASE_A, SUBJECT_A, items, force);
    assertRepresentativeGatesPass(selection);
    expect(selection.gates.MATERIAL_THEME_COVERAGE).toBe(100);

    expect(selection.materialThemeIds).toContain("corruption_integrity");
    expect(selection.materialThemeIds).toContain("political_public_exposure");
    expect((selection.selectedByTheme.corruption_integrity ?? []).length).toBeGreaterThanOrEqual(
      1
    );
    expect(
      (selection.selectedByTheme.political_public_exposure ?? []).length
    ).toBeGreaterThanOrEqual(1);

    const corrCov = coverage.themes.find((t) => t.themeId === "corruption_integrity");
    expect(corrCov?.covered).toBe(true);
  });

  it("one evidence can support two different themes in selection", () => {
    const both = item(CASE_A, {
      title:
        "Расследование ФБК об отдыхе заместителя главы правительства — коррупция и политика",
      snippet: "политическая экспозиция и конфликт интересов",
      sourceUrl: "https://www.currenttime.tv/a/both",
    });
    const force = new Map([[`inventory:${both.inventoryId}`, "SUBJECT_MATCH" as const]]);
    const { selection, claimsBundle } = selectFor(CASE_A, SUBJECT_A, [both], force);
    const claim = claimsBundle.claims.find(
      (c) =>
        c.themeIds.includes("corruption_integrity") &&
        c.themeIds.includes("political_public_exposure")
    );
    expect(claim).toBeTruthy();
    const inCorruption = (selection.selectedByTheme.corruption_integrity ?? []).some(
      (s) => s.claimId === claim!.claimId
    );
    const inPolitics = (selection.selectedByTheme.political_public_exposure ?? []).some(
      (s) => s.claimId === claim!.claimId
    );
    expect(inCorruption || inPolitics).toBe(true);
    // Multi-theme claim may appear in both theme slots (coverage-first).
    if (
      selection.materialThemeIds.includes("corruption_integrity") &&
      selection.materialThemeIds.includes("political_public_exposure")
    ) {
      expect(inCorruption && inPolitics).toBe(true);
    }
  });

  it("duplicate plots from different URLs keep provenance but do not fill all slots", () => {
    const a = item(CASE_A, {
      title: "Санкции PEP watchlist по Тестову — одинаковый сюжет",
      sourceUrl: "https://rupep.org/a",
    });
    const b = item(CASE_A, {
      title: "Санкции PEP watchlist по Тестову — одинаковый сюжет",
      sourceUrl: "https://mirror.example/a",
    });
    const other = item(CASE_A, {
      title: "Уголовное дело Тестова в суде — независимый сюжет",
      sourceUrl: "https://reuters.com/criminal",
    });
    const force = new Map(
      [a, b, other].map((it) => [`inventory:${it.inventoryId}`, "SUBJECT_MATCH" as const])
    );
    const { selection } = selectFor(CASE_A, SUBJECT_A, [a, b, other], force);
    assertRepresentativeGatesPass(selection);
    const sanctions = selection.selectedByTheme.sanctions_pep_rca_compliance ?? [];
    // At most 2 slots; duplicate plot should not occupy both if alternative exists elsewhere.
    expect(sanctions.length).toBeLessThanOrEqual(2);
    if (sanctions.length === 2) {
      expect(sanctions[0]!.plotKey).not.toBe(sanctions[1]!.plotKey);
    }
  });

  it("long sentence excerpt is not mid-cut with dangling tail", () => {
    const claim: CanonicalClaim = {
      claimId: "claim-long",
      subjectId: SUBJECT_A.displayName,
      fullClaimText:
        "Найдены материалы о коррупционных рисках. «Очень длинное законченное предложение про расследование и конфликт интересов субъекта без обрыва на предлоге» — источник currenttime.tv. Это усиливает вопросы к этике.",
      displayExcerpt: "",
      claimKind: "SOURCE_ALLEGATION",
      subjectMatch: "SUBJECT_MATCH",
      confidence: 0.9,
      themeIds: ["corruption_integrity"],
      adverseType: "adverse_media_or_legal",
      materialityLevel: "HIGH",
      materialityReasons: ["test"],
      namedEntities: [],
      dates: [],
      regions: ["RU"],
      contradictions: [],
      evidenceRefs: ["inventory:x"],
      sourceDomains: ["currenttime.tv"],
      provenance: { providers: ["yandex"], reportRunIds: ["base"], findingIds: [] },
      originalTitle: "Очень длинное законченное предложение про расследование",
      originalFullTextRef: "url:https://www.currenttime.tv/a/1",
      clientQualification: "Медийное утверждение источника.",
      recommendedAction: "Проверить.",
      dispositionRef: "inventory:x",
      summaryOverrideRequired: true,
    };
    const excerpt = buildSemanticDisplayExcerpt(claim, 120);
    expect(excerpt).toMatch(/[.!?…»)]$/u);
    expect(excerpt).not.toMatch(/\s(?:и|в|на|по|of|the)\s*$/iu);
    expect(excerpt.includes("«") || excerpt.includes("источник") || excerpt.length > 20).toBe(
      true
    );
  });

  it("shuffle of claims input yields the same selection fingerprint", () => {
    const items = [
      item(CASE_A, {
        title: "Уголовное дело Тестова в суде",
        sourceUrl: "https://a.example/1",
      }),
      item(CASE_A, {
        title: "Тестов PEP watchlist санкции",
        sourceUrl: "https://rupep.org/2",
      }),
      item(CASE_A, {
        title: "Расследование ФБК о коррупции Тестова",
        sourceUrl: "https://www.currenttime.tv/a/3",
      }),
      item(CASE_A, {
        title: "Политические связи Тестова с правительством",
        sourceUrl: "https://theguardian.com/4",
      }),
    ];
    const force = new Map(
      items.map((it) => [`inventory:${it.inventoryId}`, "SUBJECT_MATCH" as const])
    );
    const a = selectFor(CASE_A, SUBJECT_A, items, force).selection;
    const b = selectFor(CASE_A, SUBJECT_A, [...items].reverse(), force).selection;
    expect(representativeSelectionFingerprint(a)).toBe(representativeSelectionFingerprint(b));
    expect(a.gates).toEqual(b.gates);
  });

  it("second subject selection does not include first subject's evidence", () => {
    const aItem = item(CASE_A, {
      title: "Уголовное дело бизнесмена Тестова",
      sourceUrl: "https://a.example/testov",
    });
    const bItem = item(CASE_B, {
      title: "John Smith sanctioned PEP watchlist profile",
      sourceUrl: "https://b.example/smith",
    });
    const forceA = new Map([[`inventory:${aItem.inventoryId}`, "SUBJECT_MATCH" as const]]);
    const forceB = new Map([[`inventory:${bItem.inventoryId}`, "SUBJECT_MATCH" as const]]);
    const selA = selectFor(CASE_A, SUBJECT_A, [aItem], forceA).selection;
    const selB = selectFor(CASE_B, SUBJECT_B, [bItem], forceB).selection;
    expect(selA.subjectId).toBe(SUBJECT_A.displayName);
    expect(selB.subjectId).toBe(SUBJECT_B.displayName);
    expect(selA.evidenceRefs).not.toContain(`inventory:${bItem.inventoryId}`);
    expect(selB.evidenceRefs).not.toContain(`inventory:${aItem.inventoryId}`);
  });

  it("P1/P2 findings are accounted in selection or appendix reason", () => {
    const criminal = item(CASE_A, {
      title: "Уголовное дело и суд по Тестову — criminal links",
      sourceUrl: "https://www.theguardian.com/criminal",
    });
    const force = new Map([[`inventory:${criminal.inventoryId}`, "SUBJECT_MATCH" as const]]);
    const { selection } = selectFor(CASE_A, SUBJECT_A, [criminal], force);
    expect(selection.gates.P1_P2_ACCOUNTED).toBe(100);
    for (const row of selection.p1p2Account) {
      expect(
        row.status === "IN_SUMMARY_SELECTION" || row.status === "APPENDIX_WITH_REASON"
      ).toBe(true);
      expect(row.reasonCode.length).toBeGreaterThan(0);
    }
  });
});
