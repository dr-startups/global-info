/**
 * Stage 4 — ClientSummaryPack.
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
import { selectRepresentativeEvidence } from "../../src/modules/digital-profile/orion-golden/analytics/representative-evidence-selector";
import {
  assertClientSummaryPackGatesPass,
  buildClientSummaryPack,
  INTERNAL_CLIENT_TOKEN_RE,
} from "../../src/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import { validateStage1Contract } from "../../src/modules/digital-profile/orion-golden/contracts";
import { sampleClientSummaryPack } from "../../src/modules/digital-profile/orion-golden/contracts/sample-contracts";
import type { ClientSummaryPack } from "../../src/modules/digital-profile/orion-golden/contracts/client-summary-pack";

const CASE_A = "case-pack-a";
const CASE_B = "case-pack-b";

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

function buildPack(
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
  const representative = selectRepresentativeEvidence({
    caseId,
    datasetId: `ds-${caseId}`,
    subjectId: subject.displayName,
    sourceHashes: ["sha256:test"],
    claimsBundle,
  });
  const pack = buildClientSummaryPack({
    caseId,
    datasetId: `ds-${caseId}`,
    subjectId: subject.displayName,
    sourceHashes: ["sha256:test"],
    claimsBundle,
    representative: representative.selection,
  });
  return { pack, claimsBundle, representative };
}

function clientFieldTexts(pack: ClientSummaryPack): string[] {
  const out: string[] = [
    pack.overallAssessment.conclusion,
    ...pack.overallAssessment.reasons,
    ...pack.nextSteps,
  ];
  for (const t of pack.materialThemes) {
    out.push(t.clientTitle, t.conclusion, t.whyItMatters, t.qualification, ...t.concreteClaims);
    for (const a of t.representativeArticles) {
      out.push(a.title, a.domain, a.conciseCompleteDescription, a.clientQualification);
    }
  }
  return out;
}

describe("следующие проверки не повторяют друг друга", () => {
  /*
   * На живом отчёте 21.08 список «Следующие проверки» шёл так:
   *   2) Подготовить согласованную позицию для KYC и партнёрских запросов.
   *   4) Подготовить единый пакет документов для KYC и партнёрских запросов.
   * Один вопрос — «что готовить к KYC» — и два ответа подряд в нумерованном
   * списке. Строка «согласованная позиция» стояла в `recommendedChecks`
   * каждой темы, хотя одинакова у всех тем и ничего о теме не говорит:
   * `collapseRecommendations` склеивает по форме предложения, а формы у этих
   * двух строк разные, поэтому обе доезжали до клиента (пункт CR).
   */
  it("подготовка к KYC названа один раз", () => {
    const corruption = item(CASE_A, {
      title: "Тестов Иван уголовное дело о взятке",
      sourceUrl: "https://news.example/corruption-1",
    });
    const politics = item(CASE_A, {
      title: "Тестов Иван политические связи и госконтракты",
      sourceUrl: "https://news.example/politics-1",
    });
    const sanctions = item(CASE_A, {
      title: "Тестов PEP watchlist санкции RuPEP",
      sourceUrl: "https://rupep.org/person/2",
    });
    const force = new Map(
      [corruption, politics, sanctions].map((it) => [
        `inventory:${it.inventoryId}`,
        "SUBJECT_MATCH" as const,
      ])
    );
    const { pack } = buildPack(CASE_A, SUBJECT_A, [corruption, politics, sanctions], force);

    const kyc = pack.nextSteps.filter((s) => /^Подготовить/u.test(s));
    expect(kyc).toHaveLength(1);
    // Оба обещания сохранены — дубль снят склейкой, а не выбрасыванием одного.
    expect(kyc[0]).toContain("позицию");
    expect(kyc[0]).toContain("пакет документов");
  });

  it("проверка темы говорит о теме, а не о KYC вообще", () => {
    const corruption = item(CASE_A, {
      title: "Тестов Иван уголовное дело о взятке",
      sourceUrl: "https://news.example/corruption-2",
    });
    const force = new Map([
      [`inventory:${corruption.inventoryId}`, "SUBJECT_MATCH" as const],
    ]);
    const { pack } = buildPack(CASE_A, SUBJECT_A, [corruption], force);
    for (const t of pack.materialThemes) {
      for (const c of t.recommendedChecks) {
        expect(c).toContain(t.clientTitle);
      }
    }
  });
});

describe("client-summary-pack Stage 4", () => {
  it("validates sample contract", () => {
    const parsed = validateStage1Contract("ClientSummaryPack", sampleClientSummaryPack());
    expect(parsed.success).toBe(true);
  });

  it("includes CRITICAL/HIGH themes with articles, evidence and qualifications", () => {
    const corruption = item(CASE_A, {
      title: "Расследование ФБК о коррупции Тестова",
      snippet: "конфликт интересов",
      sourceUrl: "https://www.currenttime.tv/a/c",
    });
    const politics = item(CASE_A, {
      title: "Тестов: favourite with strong ties to UK politics",
      snippet: "government parliament",
      sourceUrl: "https://www.theguardian.com/p",
    });
    const sanctions = item(CASE_A, {
      title: "Тестов PEP watchlist санкции RuPEP",
      sourceUrl: "https://rupep.org/person/1",
    });
    const force = new Map(
      [corruption, politics, sanctions].map((it) => [
        `inventory:${it.inventoryId}`,
        "SUBJECT_MATCH" as const,
      ])
    );
    const { pack } = buildPack(CASE_A, SUBJECT_A, [corruption, politics, sanctions], force);
    assertClientSummaryPackGatesPass(pack);
    expect(pack.gates.CLIENT_SUMMARY_PACK_VALID).toBe(true);
    expect(pack.gates.MATERIAL_THEMES_MISSING).toBe(0);
    expect(pack.materialThemes.length).toBeGreaterThan(0);
    for (const t of pack.materialThemes) {
      expect(t.evidenceRefs.length).toBeGreaterThan(0);
      expect(t.concreteClaims.length).toBeGreaterThan(0);
      expect(t.representativeArticles.length).toBeGreaterThan(0);
      for (const a of t.representativeArticles) {
        expect(a.title.length).toBeGreaterThan(0);
        expect(a.domain.length).toBeGreaterThan(0);
        expect(a.conciseCompleteDescription.length).toBeGreaterThan(0);
        if (a.claimKind === "SOURCE_ALLEGATION") {
          expect(a.clientQualification.trim().length).toBeGreaterThan(10);
        }
      }
    }
    const themeIds = pack.materialThemes.map((t) => t.themeId);
    expect(
      themeIds.includes("corruption_integrity") || themeIds.includes("political_public_exposure")
    ).toBe(true);
  });

  it("fails gate when a HIGH theme is removed from pack (missing material theme)", () => {
    const politics = item(CASE_A, {
      title: "Политические связи Тестова с правительством",
      sourceUrl: "https://www.theguardian.com/x",
    });
    const force = new Map([[`inventory:${politics.inventoryId}`, "SUBJECT_MATCH" as const]]);
    const { pack, representative } = buildPack(CASE_A, SUBJECT_A, [politics], force);
    // Simulate missing theme by clearing materialThemes while selection still has HIGH theme.
    const broken = {
      ...pack,
      materialThemes: [],
      gates: {
        ...pack.gates,
        CLIENT_SUMMARY_PACK_VALID: false,
        MATERIAL_THEMES_MISSING: 1,
      },
    };
    expect(representative.selection.materialThemeIds.length).toBeGreaterThan(0);
    expect(broken.gates.MATERIAL_THEMES_MISSING).toBe(1);
    expect(broken.gates.CLIENT_SUMMARY_PACK_VALID).toBe(false);
    expect(() => assertClientSummaryPackGatesPass(broken as ClientSummaryPack)).toThrow(
      /CLIENT_SUMMARY_PACK_VALID|MATERIAL_THEMES_MISSING/
    );
  });

  it("rejects internal tokens in client fields", () => {
    const sample = sampleClientSummaryPack();
    const dirty = {
      ...sample,
      overallAssessment: {
        ...sample.overallAssessment,
        conclusion: `Плохо: findingId=${sample.trace.findingIds[0]} inventory:obs-leak`,
      },
    };
    expect(INTERNAL_CLIENT_TOKEN_RE.test(dirty.overallAssessment.conclusion)).toBe(true);
    const texts = clientFieldTexts(dirty as ClientSummaryPack);
    expect(texts.some((t) => INTERNAL_CLIENT_TOKEN_RE.test(t))).toBe(true);
  });

  it("OTHER_SUBJECT does not appear in client material themes", () => {
    const subjectHit = item(CASE_A, {
      title: "Уголовное дело Тестова в суде",
      sourceUrl: "https://reuters.com/s",
    });
    const other = item(CASE_A, {
      title: "Однофамилец Тестов — namesake other subject composer",
      sourceUrl: "https://wiki.example/other",
    });
    const force = new Map([
      [`inventory:${subjectHit.inventoryId}`, "SUBJECT_MATCH" as const],
      [`inventory:${other.inventoryId}`, "OTHER_SUBJECT" as const],
    ]);
    const { pack } = buildPack(CASE_A, SUBJECT_A, [subjectHit, other], force);
    assertClientSummaryPackGatesPass(pack);
    const blob = JSON.stringify(pack.materialThemes);
    expect(blob).not.toMatch(/composer/i);
    expect(pack.materialThemes.every((t) => t.themeId !== "identity_mismatch")).toBe(true);
  });

  it("second subject pack does not leak first subject articles", () => {
    const aItem = item(CASE_A, {
      title: "Уголовное дело бизнесмена Тестова",
      sourceUrl: "https://a.example/testov",
    });
    const bItem = item(CASE_B, {
      title: "John Smith sanctioned PEP watchlist",
      sourceUrl: "https://rupep.org/smith",
    });
    const packA = buildPack(
      CASE_A,
      SUBJECT_A,
      [aItem],
      new Map([[`inventory:${aItem.inventoryId}`, "SUBJECT_MATCH"]])
    ).pack;
    const packB = buildPack(
      CASE_B,
      SUBJECT_B,
      [bItem],
      new Map([[`inventory:${bItem.inventoryId}`, "SUBJECT_MATCH"]])
    ).pack;
    expect(packA.subjectId).toBe(SUBJECT_A.displayName);
    expect(packB.subjectId).toBe(SUBJECT_B.displayName);
    const titlesA = packA.materialThemes.flatMap((t) =>
      t.representativeArticles.map((a) => a.title)
    );
    const titlesB = packB.materialThemes.flatMap((t) =>
      t.representativeArticles.map((a) => a.title)
    );
    expect(titlesA.join(" ")).toMatch(/Тестов/i);
    expect(titlesB.join(" ")).not.toMatch(/Тестов/i);
    expect(titlesB.join(" ")).toMatch(/Smith|sanction|PEP/i);
  });

  it("client fields have no internal tokens on happy path", () => {
    const it = item(CASE_A, {
      title: "Санкции и уголовный суд по Тестову",
      sourceUrl: "https://www.theguardian.com/mix",
    });
    const { pack } = buildPack(
      CASE_A,
      SUBJECT_A,
      [it],
      new Map([[`inventory:${it.inventoryId}`, "SUBJECT_MATCH"]])
    );
    assertClientSummaryPackGatesPass(pack);
    expect(pack.gates.INTERNAL_TOKENS_IN_CLIENT_FIELDS).toBe(0);
    for (const t of clientFieldTexts(pack)) {
      expect(INTERNAL_CLIENT_TOKEN_RE.test(t)).toBe(false);
    }
  });
});
