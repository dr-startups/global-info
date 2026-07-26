/**
 * Stage 2 — CanonicalClaim / themes / materiality.
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
import {
  assertCanonicalClaimGatesPass,
  buildCanonicalClaimsBundle,
  buildCanonicalClaimsSummary,
  canonicalClaimsFingerprint,
} from "../../src/modules/digital-profile/orion-golden/analytics/canonical-claim-builder";
import { classifyCanonicalThemes } from "../../src/modules/digital-profile/orion-golden/analytics/canonical-themes";
import { validateStage1Contract } from "../../src/modules/digital-profile/orion-golden/contracts";
import { sampleCanonicalClaimsBundle } from "../../src/modules/digital-profile/orion-golden/contracts/sample-contracts";

const CASE_A = "case-claim-a";
const CASE_B = "case-claim-b";

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

/** Second subject: Latin given-first, no patronymic. */
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

function buildClaims(
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
  const bundle = buildCanonicalClaimsBundle({
    caseId,
    datasetId: `ds-${caseId}`,
    subjectId: subject.displayName,
    sourceHashes: ["sha256:test"],
    items,
    synthesis,
    dispositionLedger,
  });
  return { bundle, synthesis, dispositionLedger };
}

describe("canonical themes classifier", () => {
  it("distinguishes corruption and politics and allows both", () => {
    const corruption = classifyCanonicalThemes(
      "Расследование ФБК о коррупции и конфликте интересов замглавы правительства"
    );
    const politics = classifyCanonicalThemes(
      "Politician favourite with strong ties to UK politics and government"
    );
    const both = classifyCanonicalThemes(
      "Расследование ФБК об отдыхе заместителя главы правительства — политическая экспозиция и коррупционные риски"
    );
    expect(corruption).toContain("corruption_integrity");
    expect(politics).toContain("political_public_exposure");
    expect(both).toContain("corruption_integrity");
    expect(both).toContain("political_public_exposure");
  });
});

describe("canonical-claim Stage 2", () => {
  it("validates sample contract", () => {
    const parsed = validateStage1Contract(
      "CanonicalClaimsBundle",
      sampleCanonicalClaimsBundle()
    );
    expect(parsed.success).toBe(true);
  });

  it("corruption and politics fixtures coexist on one claim without collapse", () => {
    const corruptionPolitics = item(CASE_A, {
      title:
        "Расследование ФБК об отдыхе заместителя главы правительства — коррупционные риски",
      snippet: "политическая экспозиция и конфликт интересов",
      sourceUrl: "https://www.currenttime.tv/a/fixture-corruption",
    });
    const politicsOnly = item(CASE_A, {
      title: "Businessman: Putin favourite with strong ties to UK politics",
      snippet: "government and parliament exposure",
      sourceUrl: "https://www.theguardian.com/fixture-politics",
    });
    const force = new Map([
      [`inventory:${corruptionPolitics.inventoryId}`, "SUBJECT_MATCH" as const],
      [`inventory:${politicsOnly.inventoryId}`, "SUBJECT_MATCH" as const],
    ]);
    const { bundle } = buildClaims(CASE_A, SUBJECT_A, [corruptionPolitics, politicsOnly], force);
    assertCanonicalClaimGatesPass(bundle);

    const withBoth = bundle.claims.filter(
      (c) =>
        c.themeIds.includes("corruption_integrity") &&
        c.themeIds.includes("political_public_exposure")
    );
    expect(withBoth.length).toBeGreaterThanOrEqual(1);
    // Multi-theme claim is a single claim with themeIds.length >= 2 — not collapsed to one theme.
    expect(withBoth[0]!.themeIds.length).toBeGreaterThanOrEqual(2);

    const politicsClaims = bundle.claims.filter((c) =>
      c.themeIds.includes("political_public_exposure")
    );
    expect(politicsClaims.length).toBeGreaterThanOrEqual(1);
  });

  it("SOURCE_ALLEGATION always has clientQualification; media is not FACT", () => {
    const media = item(CASE_A, {
      title: "Уголовное дело и суд: litigant had criminal links",
      snippet: "авторы публикации утверждают",
      sourceUrl: "https://www.theguardian.com/law/fixture",
    });
    const force = new Map([[`inventory:${media.inventoryId}`, "SUBJECT_MATCH" as const]]);
    const { bundle } = buildClaims(CASE_A, SUBJECT_A, [media], force);
    const allegations = bundle.claims.filter((c) => c.claimKind === "SOURCE_ALLEGATION");
    expect(allegations.length).toBeGreaterThan(0);
    for (const c of allegations) {
      expect(c.clientQualification.trim().length).toBeGreaterThan(20);
      expect(c.claimKind).not.toBe("FACT");
    }
    expect(bundle.gates.UNQUALIFIED_MEDIA_ALLEGATIONS).toBe(0);
  });

  it("covers criminal, sanctions, ambiguous, OTHER_SUBJECT fixtures", () => {
    const criminal = item(CASE_A, {
      title: "Уголовное дело бизнесмена Тестова: суд и следствие",
      sourceUrl: "https://news.example/criminal",
    });
    const sanctions = item(CASE_A, {
      title: "Тестов в санкционном watchlist PEP RCA — World-Check",
      sourceUrl: "https://rupep.org/person/fixture",
    });
    const ambiguous = item(CASE_A, {
      title: "Тестов выступил с комментарием",
      snippet: "фамилия без идентификаторов",
      sourceUrl: "https://news.example/amb",
    });
    const other = item(CASE_A, {
      title: "Другой однофамилец Тестов — namesake composer profile",
      sourceUrl: "https://wiki.example/other",
    });
    const force = new Map([
      [`inventory:${criminal.inventoryId}`, "SUBJECT_MATCH" as const],
      [`inventory:${sanctions.inventoryId}`, "SUBJECT_MATCH" as const],
      [`inventory:${ambiguous.inventoryId}`, "AMBIGUOUS" as const],
      [`inventory:${other.inventoryId}`, "OTHER_SUBJECT" as const],
    ]);
    const { bundle } = buildClaims(
      CASE_A,
      SUBJECT_A,
      [criminal, sanctions, ambiguous, other],
      force
    );
    assertCanonicalClaimGatesPass(bundle);
    expect(
      bundle.claims.some((c) => c.themeIds.includes("criminal_judicial"))
    ).toBe(true);
    expect(
      bundle.claims.some((c) => c.themeIds.includes("sanctions_pep_rca_compliance"))
    ).toBe(true);
    const otherClaims = bundle.claims.filter((c) =>
      c.evidenceRefs.includes(`inventory:${other.inventoryId}`)
    );
    for (const c of otherClaims) {
      expect(c.themeIds).toContain("identity_mismatch");
      expect(c.materialityLevel).toBe("CONTEXT_ONLY");
    }
  });

  it("P1/P2-class adverse remains material with summary override", () => {
    const adverse = item(CASE_A, {
      title: "Коррупционное расследование ФБК и уголовный суд по Тестову",
      snippet: "санкции и политическая экспозиция",
      sourceUrl: "https://www.currenttime.tv/a/p1",
    });
    const force = new Map([[`inventory:${adverse.inventoryId}`, "SUBJECT_MATCH" as const]]);
    const { bundle } = buildClaims(CASE_A, SUBJECT_A, [adverse], force);
    const material = bundle.claims.filter(
      (c) =>
        c.materialityLevel === "CRITICAL" ||
        c.materialityLevel === "HIGH" ||
        c.materialityLevel === "MEDIUM"
    );
    expect(material.length).toBeGreaterThan(0);
    expect(material.some((c) => c.summaryOverrideRequired)).toBe(true);
  });

  it("contradicting sources stay as separate evidenceRefs on claim", () => {
    const asserting = item(CASE_A, {
      title: "Суд подтвердил уголовные обвинения против Тестова",
      snippet: "confirmed criminal charges",
      sourceUrl: "https://reuters.com/a",
    });
    const denying = item(CASE_A, {
      title: "Тестов опроверг уголовные обвинения — dismissed by court",
      snippet: "denied and cleared",
      sourceUrl: "https://reuters.com/b",
    });
    const force = new Map([
      [`inventory:${asserting.inventoryId}`, "SUBJECT_MATCH" as const],
      [`inventory:${denying.inventoryId}`, "SUBJECT_MATCH" as const],
    ]);
    const { bundle } = buildClaims(CASE_A, SUBJECT_A, [asserting, denying], force);
    const criminal = bundle.claims.find((c) => c.themeIds.includes("criminal_judicial"));
    expect(criminal).toBeTruthy();
    expect(criminal!.evidenceRefs.length).toBeGreaterThanOrEqual(1);
    // fullClaimText preserved (not mid-cut to empty)
    expect(criminal!.fullClaimText.length).toBeGreaterThan(40);
    expect(criminal!.displayExcerpt.length).toBeLessThanOrEqual(
      criminal!.fullClaimText.length
    );
  });

  it("shuffle of input yields the same claims fingerprint", () => {
    const items = [
      item(CASE_A, {
        title: "Уголовное дело Тестова в суде",
        sourceUrl: "https://a.example/1",
      }),
      item(CASE_A, {
        title: "Тестов PEP watchlist санкции",
        sourceUrl: "https://b.example/2",
      }),
      item(CASE_A, {
        title: "Политические связи Тестова с правительством",
        sourceUrl: "https://c.example/3",
      }),
    ];
    const force = new Map(
      items.map((it) => [`inventory:${it.inventoryId}`, "SUBJECT_MATCH" as const])
    );
    const a = buildClaims(CASE_A, SUBJECT_A, items, force).bundle;
    const b = buildClaims(CASE_A, SUBJECT_A, [...items].reverse(), force).bundle;
    expect(canonicalClaimsFingerprint(a)).toBe(canonicalClaimsFingerprint(b));
  });

  it("second subject does not receive first subject's claims", () => {
    const aItem = item(CASE_A, {
      title: "Уголовное дело бизнесмена Тестова",
      sourceUrl: "https://a.example/testov",
    });
    const bItem = item(CASE_B, {
      title: "John Smith investor profile biography",
      sourceUrl: "https://b.example/smith",
    });
    const forceA = new Map([[`inventory:${aItem.inventoryId}`, "SUBJECT_MATCH" as const]]);
    const forceB = new Map([[`inventory:${bItem.inventoryId}`, "SUBJECT_MATCH" as const]]);
    const bundleA = buildClaims(CASE_A, SUBJECT_A, [aItem], forceA).bundle;
    const bundleB = buildClaims(CASE_B, SUBJECT_B, [bItem], forceB).bundle;
    expect(bundleA.subjectId).toBe(SUBJECT_A.displayName);
    expect(bundleB.subjectId).toBe(SUBJECT_B.displayName);
    expect(bundleA.evidenceRefs).not.toContain(`inventory:${bItem.inventoryId}`);
    expect(bundleB.evidenceRefs).not.toContain(`inventory:${aItem.inventoryId}`);
    expect(bundleA.claims.every((c) => c.subjectId === SUBJECT_A.displayName)).toBe(true);
    expect(bundleB.claims.every((c) => c.subjectId === SUBJECT_B.displayName)).toBe(true);
    expect(bundleA.gates.SUBJECT_UNIVERSALITY_PASS).toBe(true);
  });

  it("summary aggregates match claim counts", () => {
    const it = item(CASE_A, {
      title: "Санкции и PEP по Тестову",
      sourceUrl: "https://rupep.org/x",
    });
    const force = new Map([[`inventory:${it.inventoryId}`, "SUBJECT_MATCH" as const]]);
    const { bundle } = buildClaims(CASE_A, SUBJECT_A, [it], force);
    const summary = buildCanonicalClaimsSummary(bundle);
    expect(summary.claimCount).toBe(bundle.claims.length);
    expect(summary.gates).toEqual(bundle.gates);
  });
});
