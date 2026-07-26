/**
 * Stage 5 — ClientSummaryComposer.
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
import { buildClientSummaryPack } from "../../src/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import {
  assertComposedSummaryGatesPass,
  composeClientSummary,
  countIncompleteSentences,
} from "../../src/modules/digital-profile/orion-golden/analytics/client-summary-composer";
import { INTERNAL_CLIENT_TOKEN_RE } from "../../src/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import { validateStage1Contract } from "../../src/modules/digital-profile/orion-golden/contracts";
import {
  sampleClientSummaryPack,
  sampleComposedClientSummary,
} from "../../src/modules/digital-profile/orion-golden/contracts/sample-contracts";
import type { ClientSummaryPack } from "../../src/modules/digital-profile/orion-golden/contracts/client-summary-pack";

const CASE_A = "case-composer-a";
const CASE_B = "case-composer-b";

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
): ClientSummaryPack {
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
  return buildClientSummaryPack({
    caseId,
    datasetId: `ds-${caseId}`,
    subjectId: subject.displayName,
    sourceHashes: ["sha256:test"],
    claimsBundle,
    representative: representative.selection,
  });
}

describe("client-summary-composer Stage 5", () => {
  it("validates sample contract", () => {
    const parsed = validateStage1Contract("ComposedClientSummary", sampleComposedClientSummary());
    expect(parsed.success).toBe(true);
  });

  it("CurrentTime-like corruption fixture yields a concrete thematic paragraph", () => {
    const corruption = item(CASE_A, {
      title: "Расследование ФБК о коррупции Тестова",
      snippet: "конфликт интересов Приходько",
      sourceUrl: "https://www.currenttime.tv/a/c",
    });
    const pack = buildPack(
      CASE_A,
      SUBJECT_A,
      [corruption],
      new Map([[`inventory:${corruption.inventoryId}`, "SUBJECT_MATCH"]])
    );
    const summary = composeClientSummary({ pack });
    assertComposedSummaryGatesPass(summary);
    const corruptionSection = summary.sections.themes.find(
      (t) => t.themeId === "corruption_integrity"
    );
    expect(corruptionSection).toBeTruthy();
    expect(corruptionSection!.body).toMatch(/ФБК|коррупц|Current Time|currenttime/i);
    expect(corruptionSection!.articleTitles.length).toBeGreaterThan(0);
    expect(corruptionSection!.evidenceRefs.length).toBeGreaterThan(0);
    expect(summary.fullText).toContain("Коротко по итогам аудита");
  });

  it("Guardian-like politics fixture yields a separate concrete paragraph", () => {
    const politics = item(CASE_A, {
      title: "Тестов: favourite with strong ties to UK politics",
      snippet: "government parliament",
      sourceUrl: "https://www.theguardian.com/p",
    });
    const pack = buildPack(
      CASE_A,
      SUBJECT_A,
      [politics],
      new Map([[`inventory:${politics.inventoryId}`, "SUBJECT_MATCH"]])
    );
    const summary = composeClientSummary({ pack });
    assertComposedSummaryGatesPass(summary);
    const politicsSection = summary.sections.themes.find(
      (t) => t.themeId === "political_public_exposure"
    );
    expect(politicsSection).toBeTruthy();
    expect(politicsSection!.body).toMatch(/политич|Guardian|theguardian|UK|правит/i);
    expect(politicsSection!.articleDomains.some((d) => /guardian/i.test(d))).toBe(true);
  });

  it("one article in two themes does not create a meaningless duplicate", () => {
    const shared = item(CASE_A, {
      title: "ФБК и политические связи Тестова — расследование",
      snippet: "коррупция правительство конфликт интересов",
      sourceUrl: "https://www.currenttime.tv/a/dual",
    });
    const pack = buildPack(
      CASE_A,
      SUBJECT_A,
      [shared],
      new Map([[`inventory:${shared.inventoryId}`, "SUBJECT_MATCH"]])
    );
    const summary = composeClientSummary({ pack });
    assertComposedSummaryGatesPass(summary);
    const themes = summary.sections.themes.filter((t) =>
      t.articleTitles.some((title) => title.includes("ФБК"))
    );
    if (themes.length >= 2) {
      const bodies = themes.map((t) => t.body);
      const secondMentionsSame = bodies.some((b) => /Тот же материал/u.test(b));
      expect(secondMentionsSame || new Set(bodies).size === bodies.length).toBe(true);
    }
    expect(summary.gates.SUMMARY_UNSUPPORTED_ASSERTIONS).toBe(0);
  });

  it("preserves qualifications and forbids unsupported / technical / incomplete text", () => {
    const pack = sampleClientSummaryPack();
    const summary = composeClientSummary({ pack });
    assertComposedSummaryGatesPass(summary);
    expect(summary.fullText).toMatch(/утвержден|не равны|первичн|оговорк|подтвержден/i);
    expect(INTERNAL_CLIENT_TOKEN_RE.test(summary.fullText)).toBe(false);
    expect(summary.gates.SUMMARY_TECHNICAL_COPY_TOKENS).toBe(0);
    expect(summary.gates.SUMMARY_INCOMPLETE_SENTENCES).toBe(0);
    expect(countIncompleteSentences(summary.fullText)).toBe(0);
    expect(summary.gates.SUMMARY_MATERIAL_THEME_COVERAGE).toBe(100);
    expect(summary.gates.SUMMARY_CONCRETE_EXAMPLES_PRESENT).toBe(true);
  });

  it("sparse case yields honest limited summary without invented risks", () => {
    const base = sampleClientSummaryPack();
    const sparse: ClientSummaryPack = {
      ...base,
      materialThemes: [],
      overallAssessment: {
        ...base.overallAssessment,
        riskLevel: "low",
        conclusion: "Итоговая оценка: низкий риск. Существенных рисковых тем в выборке нет.",
        reasons: ["Существенных рисковых тем в текущей выборке не выделено."],
        evidenceRefs: base.evidenceRefs,
      },
      gates: {
        ...base.gates,
        MATERIAL_THEMES_MISSING: 0,
      },
    };
    const summary = composeClientSummary({ pack: sparse });
    assertComposedSummaryGatesPass(summary);
    expect(summary.sections.themes).toHaveLength(0);
    expect(summary.fullText).toMatch(/недостаточно|не выделен|ограничен/i);
    expect(summary.fullText).not.toMatch(/ФБК|Приходько|Дерипаск/i);
    expect(summary.gates.SUMMARY_CONCRETE_EXAMPLES_PRESENT).toBe(true);
  });

  it("second subject does not receive first subject facts", () => {
    const aItem = item(CASE_A, {
      title: "Расследование ФБК о коррупции Тестова",
      sourceUrl: "https://www.currenttime.tv/a/a",
    });
    const bItem = item(CASE_B, {
      title: "John Smith sanctioned PEP watchlist",
      sourceUrl: "https://rupep.org/smith",
    });
    const summaryA = composeClientSummary({
      pack: buildPack(
        CASE_A,
        SUBJECT_A,
        [aItem],
        new Map([[`inventory:${aItem.inventoryId}`, "SUBJECT_MATCH"]])
      ),
    });
    const summaryB = composeClientSummary({
      pack: buildPack(
        CASE_B,
        SUBJECT_B,
        [bItem],
        new Map([[`inventory:${bItem.inventoryId}`, "SUBJECT_MATCH"]])
      ),
    });
    assertComposedSummaryGatesPass(summaryA);
    assertComposedSummaryGatesPass(summaryB);
    expect(summaryA.fullText).toMatch(/Тестов/i);
    expect(summaryB.fullText).not.toMatch(/Тестов|ФБК/i);
    expect(summaryB.fullText).toMatch(/Smith|sanction|PEP|RuPEP|баз/i);
  });

  it("continues summary instead of truncating when many material themes exist", () => {
    const pack = sampleClientSummaryPack();
    const themeIds = [
      "corruption_integrity",
      "political_public_exposure",
      "sanctions_pep_rca_compliance",
      "criminal_judicial",
      "business_ownership_associates",
    ] as const;
    const multi: ClientSummaryPack = {
      ...pack,
      materialThemes: themeIds.map((themeId, i) => ({
        ...pack.materialThemes[0]!,
        themeId,
        clientTitle: `Тема ${i + 1}`,
        conclusion: `Вывод по теме ${i + 1}.`,
        representativeArticles: [
          {
            ...pack.materialThemes[0]!.representativeArticles[0]!,
            title: `Article ${i + 1} unique title`,
            domain: `news${i}.example`,
            conciseCompleteDescription: `«Article ${i + 1} unique title» — источник news${i}.example. Краткое описание сюжета ${i + 1}.`,
            evidenceRefs: [`inventory:obs-${i}`],
          },
        ],
        evidenceRefs: [`inventory:obs-${i}`],
        sourceDomains: [`news${i}.example`],
      })),
    };
    const summary = composeClientSummary({ pack: multi });
    assertComposedSummaryGatesPass(summary);
    expect(summary.sections.themes).toHaveLength(5);
    expect(summary.continuationThemeIds.length).toBe(2);
    expect(summary.fullText).toContain("Продолжение резюме");
    for (const t of summary.sections.themes) {
      expect(summary.fullText).toContain(t.heading);
      expect(t.body.length).toBeGreaterThan(40);
    }
  });
});
