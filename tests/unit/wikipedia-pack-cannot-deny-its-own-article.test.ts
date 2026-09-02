import { describe, expect, it } from "vitest";
import { validateSectionPack } from "@/modules/digital-profile/orion-golden/deck-sections/section-validation";
import { SECTION_PACK_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { SectionPackV2 } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { VerifiedFindingBundle } from "@/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";

/**
 * Отчёт не спорит сам с собой.
 *
 * На прогоне 76 страница ОАЭ утверждала «отдельная статья в англоязычной
 * Википедии не найдена», а шестью страницами раньше та же статья стояла первой
 * строкой таблицы выдачи того же документа. Проверка вернула `exists=false`
 * честно — но запрос был кириллицей, и утверждение оказалось шире наблюдения.
 * Секционная валидация закрывает регресс по данным слайда: статья о субъекте в
 * его же доказательствах обязана быть названа адресом.
 */

const CHECK_REF = "inventory:wiki-check-en";
const ROW_REF = "inventory:obs-serp-1";
const ARTICLE_LINK = "en.wikipedia.org/wiki/Viktor_Rashnikov";

const BUNDLE = {
  schemaVersion: "verified-finding-bundle-v1",
  caseId: "c1",
  datasetId: "d1",
  reportRunId: "r1",
  findings: [],
  excludedFindingIds: [],
} as unknown as VerifiedFindingBundle;

const EVIDENCE_INDEX: ScopedEvidenceIndex = {
  [CHECK_REF]: {
    kind: "wikipedia_check",
    wikipediaExists: false,
    language: "en",
    domain: "en.wikipedia.org",
    query: "Рашников Виктор Филиппович",
  },
  [ROW_REF]: {
    kind: "wikipedia",
    domain: "en.wikipedia.org",
    url: "https://en.wikipedia.org/wiki/Viktor_Rashnikov",
    title: "Viktor Rashnikov",
    subjectDecision: "SUBJECT_MATCH",
    rank: 1,
    engine: "GOOGLE",
  },
};

/** Текст стр. 48 живого прогона: утверждение шире наблюдения. */
const DENIAL =
  "Отдельная статья в англоязычной Википедии по имени субъекта не найдена. " +
  "Это итог выполненной проверки, а не пропуск сбора.";

/** Текст после починки: проверка названа запросом, наблюдение — адресом. */
const HONEST =
  "Проверка по этому запросу статью не нашла; при этом в поисковой выдаче зафиксирована " +
  `статья ${ARTICLE_LINK} (Google, позиция 1).`;

function identityPack(narrative: string, refs: string[]): SectionPackV2 {
  return {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: "UAE_PROFILE",
    sectionType: "UAE_PROFILE",
    fragmentKey: "UAE_IDENTITY_WIKIPEDIA",
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    sourceDatasetId: "d1",
    contentVersion: "deck-sections-v88",
    promptVersion: "uae-identity-analysis-deterministic-v1",
    contentHash: "sha256:x",
    inputHash: "h1",
    generatedAt: "2026-08-17T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: refs,
    inputs: { findingIds: [], evidenceRefs: refs, metricSnapshotId: "m1" },
    slides: [
      {
        schemaVersion: "slide-content-v1",
        slideId: "p29_uae_wikipedia",
        baseSlotId: "p29_uae_wikipedia",
        sectionId: "UAE_PROFILE",
        templateId: "wikipedia-check",
        title: "ОАЭ — Википедия",
        findingIds: [],
        evidenceRefs: refs,
        isContinuation: false,
        continuationOf: null,
        continuationIndex: null,
        visualAssetRefs: [],
        metrics: { wikipediaCheckExists: 0 },
        content: {
          narrative,
          bullets: ["Viktor Rashnikov — en.wikipedia.org"],
        },
      },
    ],
    metrics: {
      datasetCount: 1,
      displayedCount: 1,
      adverseDatasetCount: 0,
      adverseDisplayedCount: 0,
    },
    provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: refs },
    validation: { passed: true, issues: [] },
  } as unknown as SectionPackV2;
}

function validate(pack: SectionPackV2) {
  return validateSectionPack({
    pack,
    expectedCaseId: "c1",
    expectedReportRunId: "r1",
    expectedDatasetId: "d1",
    bundle: BUNDLE,
    knownEvidenceRefs: new Set([CHECK_REF, ROW_REF]),
    evidenceIndex: EVIDENCE_INDEX,
  });
}

describe("пак Википедии и его собственные доказательства", () => {
  it("отрицание статьи, которая лежит в доказательствах слайда, не проходит", () => {
    const report = validate(identityPack(DENIAL, [CHECK_REF, ROW_REF]));
    expect(report.passed).toBe(false);
    expect(report.issues.join(" | ")).toContain(ARTICLE_LINK);
  });

  it("названная адресом статья проверку проходит", () => {
    const report = validate(identityPack(HONEST, [CHECK_REF, ROW_REF]));
    expect(report.issues).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("без такой строки в доказательствах прежний текст остаётся законным", () => {
    const report = validate(identityPack(DENIAL, [CHECK_REF]));
    expect(report.issues).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
