/**
 * Адрес внутри предложения печатается целиком.
 *
 * Правило §«Источник называется полным адресом» знало одно исключение — узкую
 * колонку таблицы. Колонки больше нет (адрес стоит полосой во всю ширину),
 * поэтому исключения нет тоже: фраза «в поисковой выдаче зафиксирована статья
 * …» обязана назвать адрес, по которому статья открывается.
 *
 * Вторая половина — ворота: игла, которой секционная валидация ищет названную
 * статью в тексте страницы, обязана совпадать с тем, что напечатано. Обрезок в
 * полном адресе не находится, и ворота уронили бы обязательную секцию на
 * совершенно здоровом тексте.
 */

import { describe, expect, it } from "vitest";
import { buildIdentityFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/identity";
import { validateSectionPack } from "@/modules/digital-profile/orion-golden/deck-sections/section-validation";
import {
  SECTION_PACK_SCHEMA_VERSION,
  SLIDE_CONTENT_SCHEMA_VERSION,
} from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { SectionPackV2 } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type {
  ScopedEvidenceIndex,
  ScopedFragmentInput,
} from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { VerifiedFindingBundle } from "@/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";

const CHECK_REF = "inventory:wiki-check-ru";
const ROW_REF = "inventory:obs-wiki-row";

/*
 * Адрес статьи длиннее прежнего предела колонки (62 знака): именно на таком
 * дефект и виден — печаталось `ru.wikipedia.org/wiki/Глинка,_Сергей_Влади…`.
 */
const ARTICLE_URL =
  "https://ru.wikipedia.org/wiki/%D0%93%D0%BB%D0%B8%D0%BD%D0%BA%D0%B0,_%D0%A1%D0%B5%D1%80%D0%B3%D0%B5%D0%B9_%D0%92%D0%BB%D0%B0%D0%B4%D0%B8%D0%BC%D0%B8%D1%80%D0%BE%D0%B2%D0%B8%D1%87_(%D0%BF%D1%80%D0%B5%D0%B4%D0%BF%D1%80%D0%B8%D0%BD%D0%B8%D0%BC%D0%B0%D1%82%D0%B5%D0%BB%D1%8C)";
const ARTICLE_ADDRESS =
  "ru.wikipedia.org/wiki/Глинка,_Сергей_Владимирович_(предприниматель)";

const EVIDENCE_INDEX: ScopedEvidenceIndex = {
  [CHECK_REF]: {
    kind: "wikipedia_check",
    wikipediaExists: false,
    language: "ru",
    domain: "ru.wikipedia.org",
    region: "RU",
    query: "Глинка Сергей Владимирович",
    checkedAt: "2026-08-01T10:00:00.000Z",
  },
  [ROW_REF]: {
    kind: "wikipedia",
    region: "RU",
    domain: "ru.wikipedia.org",
    url: ARTICLE_URL,
    title: "Глинка, Сергей Владимирович (предприниматель)",
    subjectDecision: "SUBJECT_MATCH",
    rank: 1,
    engine: "YANDEX",
  },
} as unknown as ScopedEvidenceIndex;

const SCOPED = {
  subject: { displayName: "Сергей Глинка", aliases: [] },
  findings: [],
  surfaceUnits: [
    {
      surface: "wikipedia",
      region: "RU",
      claims: [],
      metrics: [
        { key: "totalCount", value: 1, sampleStatus: "MEASURED", denominator: 1 },
        { key: "subjectMatchCount", value: 1, sampleStatus: "MEASURED" },
        { key: "otherSubjectCount", value: 0, sampleStatus: "MEASURED" },
        { key: "ambiguousCount", value: 0, sampleStatus: "MEASURED" },
        { key: "adverseSubjectCount", value: 0, sampleStatus: "MEASURED", denominator: 0 },
      ],
      evidenceRefs: [ROW_REF],
      emptyMarkerRefs: [],
    },
  ],
  evidenceIndex: EVIDENCE_INDEX,
  scope: { regions: ["RU"], surfaces: ["wikipedia"], subjectMatch: null, findingIds: null },
  metricSnapshot: {},
} as unknown as ScopedFragmentInput;

const BUNDLE = {
  schemaVersion: "verified-finding-bundle-v1",
  caseId: "c1",
  datasetId: "d1",
  reportRunId: "r1",
  findings: [],
  excludedFindingIds: [],
} as unknown as VerifiedFindingBundle;

function identitySlides() {
  return buildIdentityFragment("RU_IDENTITY_WIKIPEDIA", "RU_PROFILE", "Россия", SCOPED).slides;
}

function packOf(slides: ReturnType<typeof identitySlides>): SectionPackV2 {
  const refs = [CHECK_REF, ROW_REF];
  return {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: "RU_PROFILE",
    sectionType: "RU_PROFILE",
    fragmentKey: "RU_IDENTITY_WIKIPEDIA",
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    sourceDatasetId: "d1",
    contentVersion: "deck-sections-test",
    promptVersion: "ru-identity-analysis-deterministic-v1",
    contentHash: "sha256:x",
    inputHash: "h1",
    generatedAt: "2026-08-25T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: refs,
    inputs: { findingIds: [], evidenceRefs: refs, metricSnapshotId: "m1" },
    slides: slides.map((s) => ({
      ...s,
      schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
      evidenceRefs: refs,
    })),
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

describe("статья, названная внутри предложения", () => {
  it("несёт полный адрес, а не обрезок колонки", () => {
    const narrative = identitySlides()
      .map((s) => s.content.narrative ?? "")
      .join(" ");
    expect(narrative).toContain("в поисковой выдаче зафиксирована статья");
    expect(narrative).toContain(ARTICLE_ADDRESS);
    expect(narrative).not.toMatch(/ru\.wikipedia\.org\/wiki\/[^\s]*…/u);
  });

  it("ворота Википедии находят её в тексте страницы", () => {
    const report = validateSectionPack({
      pack: packOf(identitySlides()),
      expectedCaseId: "c1",
      expectedReportRunId: "r1",
      expectedDatasetId: "d1",
      bundle: BUNDLE,
      knownEvidenceRefs: new Set([CHECK_REF, ROW_REF]),
      evidenceIndex: EVIDENCE_INDEX,
    });
    expect(report.issues.filter((i) => i.includes("wikipedia denial"))).toEqual([]);
  });

  it("страница, промолчавшая о статье, воротами по-прежнему ловится", () => {
    const slides = identitySlides().map((s) => ({
      ...s,
      content: { ...s.content, narrative: "Проверка по этому запросу статью не нашла.", bullets: [] },
    }));
    const report = validateSectionPack({
      pack: packOf(slides),
      expectedCaseId: "c1",
      expectedReportRunId: "r1",
      expectedDatasetId: "d1",
      bundle: BUNDLE,
      knownEvidenceRefs: new Set([CHECK_REF, ROW_REF]),
      evidenceIndex: EVIDENCE_INDEX,
    });
    expect(report.issues.join(" | ")).toContain(ARTICLE_ADDRESS);
  });
});
