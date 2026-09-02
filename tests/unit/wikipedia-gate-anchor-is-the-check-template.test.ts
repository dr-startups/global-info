/**
 * Область ворот — положительный якорь по шаблону, а не имя слота и не список
 * исключений.
 *
 * Отрицание «Проверка по этому запросу статью не нашла» печатает не только
 * страница `wikipedia-check`: тот же `resultSentence` уходит на лист
 * `coverage-empty-state` того же слота, когда строк выдачи не собрано вовсе
 * (`fragment-builders/identity.ts`, ветка `collectedRows === 0 &&
 * checkExists === false`). Сегодня ворота там молчали бы и без якоря — в
 * доказательствах того листа лежит одна запись проверки, спорить не с чем. Но
 * держится это на составе доказательств чужого построителя, а не на правиле:
 * стоит тому листу однажды получить ссылки региона, и ворота начали бы
 * требовать адрес от страницы, которая его не печатает.
 *
 * Поэтому здесь закреплено само правило: судится шаблон, который печатает
 * проверку с чем спорить, и только он. Слепота за его пределами — записанная
 * цена положительного якоря (`docs/ENGINEERING.md` §8), а не недосмотр.
 */

import { describe, expect, it } from "vitest";
import { validateSectionPack } from "@/modules/digital-profile/orion-golden/deck-sections/section-validation";
import {
  SECTION_PACK_SCHEMA_VERSION,
  SLIDE_CONTENT_SCHEMA_VERSION,
} from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { SectionPackV2 } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { VerifiedFindingBundle } from "@/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";

const CHECK_REF = "inventory:wiki-check-en";
const ROW_REF = "inventory:obs-wiki-row";
const REFS = [CHECK_REF, ROW_REF];
const ARTICLE_LINK = "en.wikipedia.org/wiki/Alexei_Borisov";

const BUNDLE = {
  schemaVersion: "verified-finding-bundle-v1",
  caseId: "c1",
  datasetId: "d1",
  reportRunId: "r1",
  findings: [],
  excludedFindingIds: [],
} as unknown as VerifiedFindingBundle;

/** Обе половины ворот: отрицательная проверка и `/wiki/`-строка тёзки. */
const EVIDENCE_INDEX = {
  [CHECK_REF]: {
    kind: "wikipedia_check",
    wikipediaExists: false,
    language: "en",
    domain: "en.wikipedia.org",
    query: "Anatoliy Borisov",
  },
  [ROW_REF]: {
    kind: "wikipedia",
    domain: "en.wikipedia.org",
    url: `https://${ARTICLE_LINK}`,
    title: "Alexei Borisov",
    subjectDecision: "SUBJECT_MATCH",
    rank: 1,
    engine: "GOOGLE",
  },
} as unknown as ScopedEvidenceIndex;

/** Абзац пустого состояния — с тем же отрицанием, что печатает страница проверки. */
const EMPTY_STATE_NARRATIVE =
  "Проверка выполнена прямым запросом к API англоязычного раздела. " +
  "Проверка по этому запросу статью не нашла. Это итог выполненной проверки, " +
  "а не пропуск сбора. Энциклопедических материалов о субъекте в поисковой " +
  "выдаче по этому контуру также не зафиксировано.";

/**
 * Слот тот же (`p29_uae_wikipedia`) — построитель отдаёт пустое состояние на
 * место страницы проверки, поэтому имя слайда о его шаблоне ничего не говорит.
 */
function emptyStatePack(): SectionPackV2 {
  return {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: "UAE_PROFILE",
    sectionType: "UAE_PROFILE",
    fragmentKey: "UAE_IDENTITY_WIKIPEDIA",
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    sourceDatasetId: "d1",
    contentVersion: "deck-sections-test",
    promptVersion: "uae-identity-analysis-deterministic-v1",
    contentHash: "sha256:x",
    inputHash: "h1",
    generatedAt: "2026-09-02T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: REFS,
    inputs: { findingIds: [], evidenceRefs: REFS, metricSnapshotId: "m1" },
    slides: [
      {
        schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
        slideId: "p29_uae_wikipedia",
        baseSlotId: "p29_uae_wikipedia",
        sectionId: "UAE_PROFILE",
        templateId: "coverage-empty-state",
        title: "ОАЭ — Википедия",
        findingIds: [],
        evidenceRefs: REFS,
        isContinuation: false,
        continuationOf: null,
        continuationIndex: null,
        visualAssetRefs: [],
        metrics: { wikipediaCheckExists: 0 },
        content: {
          narrative: EMPTY_STATE_NARRATIVE,
          bullets: ["Панель знаний собирается отдельно от статьи."],
        },
      },
    ],
    metrics: {
      datasetCount: 0,
      displayedCount: 0,
      adverseDatasetCount: 0,
      adverseDisplayedCount: 0,
    },
    provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: REFS },
    validation: { passed: true, issues: [] },
  } as unknown as SectionPackV2;
}

describe("якорь ворот Википедии", () => {
  it("лист другого шаблона на том же слоте воротами не судится", () => {
    const report = validateSectionPack({
      pack: emptyStatePack(),
      expectedCaseId: "c1",
      expectedReportRunId: "r1",
      expectedDatasetId: "d1",
      bundle: BUNDLE,
      knownEvidenceRefs: new Set(REFS),
      evidenceIndex: EVIDENCE_INDEX,
    });
    expect(report.issues.filter((i) => i.includes("wikipedia denial"))).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
