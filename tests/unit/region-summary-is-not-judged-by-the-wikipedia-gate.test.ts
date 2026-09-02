/**
 * Региональное резюме о Википедии не говорит — и воротами Википедии не судится.
 *
 * Область фрагмента `RU_SUMMARY`/`UAE_SUMMARY` задана всеми поверхностями
 * таблицы покрытия, включая `wikipedia`, поэтому лист резюме по построению
 * несёт доказательства **всего** региона: и записи проверки «статьи нет», и
 * любую `/wiki/`-строку выдачи. Текст листа при этом — о темах, а не о
 * Википедии, и адреса статьи не содержит никогда.
 *
 * 01.09.2026 одной такой строки хватило, чтобы обязательная секция
 * `UAE_SUMMARY` получила `FAILED` и сборка деки остановилась целиком при
 * полностью оплаченном сборе.
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

const CHECK_REF = "inventory:wiki-check";
const NAMESAKE_REF = "inventory:ss-namesake";
const REFS = [CHECK_REF, NAMESAKE_REF];

const BUNDLE = {
  schemaVersion: "verified-finding-bundle-v1",
  caseId: "c1",
  datasetId: "d1",
  reportRunId: "r1",
  findings: [],
  excludedFindingIds: [],
} as unknown as VerifiedFindingBundle;

/**
 * Набор кейса DPA-2026-0046: отрицательная проверка плюс статья тёзки.
 *
 * Живая строка `en.wikipedia.org/wiki/Alexei_Borisov` лежала на `organic`
 * (Google/ОАЭ, Serper, позиция 9) — она и стоит первой в разборе ниже.
 * `images` и `paa_related` — не воспроизведение, а края: предикат ворот
 * спрашивает `kind !== "wikipedia_check"`, поэтому в область попадает любая
 * поверхность таблицы покрытия, и падение резюме от выбора поверхности не
 * зависит.
 */
function evidenceIndex(opts: {
  language: string;
  /** Поверхность строки — любая из таблицы покрытия, кроме самой проверки. */
  kind: string;
  article: string;
}): ScopedEvidenceIndex {
  return {
    [CHECK_REF]: {
      kind: "wikipedia_check",
      wikipediaExists: false,
      language: opts.language,
      domain: `${opts.language}.wikipedia.org`,
      query: "Борисов Анатолий Анатольевич",
    },
    [NAMESAKE_REF]: {
      kind: opts.kind,
      domain: `${opts.language}.wikipedia.org`,
      url: `https://${opts.article}`,
      title: "Alexei Borisov",
      subjectDecision: "SUBJECT_MATCH",
      rank: 4,
      engine: "GOOGLE",
    },
  } as unknown as ScopedEvidenceIndex;
}

/** Текст резюме — о темах региона; ни адреса, ни слова о Википедии. */
const SUMMARY_NARRATIVE =
  "По региону собрано 76 материалов: преобладают деловые публикации и профили " +
  "в справочниках, тем с негативной окраской не выявлено.";

function summaryPack(opts: {
  fragmentKey: "RU_SUMMARY" | "UAE_SUMMARY";
  sectionId: string;
  slideId: string;
  withContinuation?: boolean;
}): SectionPackV2 {
  const slide = (slideId: string, continuationOf: string | null) => ({
    schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
    slideId,
    baseSlotId: opts.slideId,
    sectionId: opts.sectionId,
    templateId: "regional-summary",
    title: "Резюме аудита",
    findingIds: [],
    evidenceRefs: REFS,
    isContinuation: Boolean(continuationOf),
    continuationOf,
    continuationIndex: continuationOf ? 1 : null,
    visualAssetRefs: [],
    metrics: {},
    content: continuationOf
      ? { bullets: ["Продолжение обзора региона: справочники и деловые публикации."] }
      : { narrative: SUMMARY_NARRATIVE, bullets: ["Деловые публикации — основная часть выдачи."] },
  });
  return {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: opts.sectionId,
    sectionType: opts.sectionId,
    fragmentKey: opts.fragmentKey,
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    sourceDatasetId: "d1",
    contentVersion: "deck-sections-test",
    promptVersion: "regional-summary-deterministic-v1",
    contentHash: "sha256:x",
    inputHash: "h1",
    generatedAt: "2026-09-01T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: REFS,
    inputs: { findingIds: [], evidenceRefs: REFS, metricSnapshotId: "m1" },
    slides: opts.withContinuation
      ? [slide(opts.slideId, null), slide(`${opts.slideId}__cont1`, opts.slideId)]
      : [slide(opts.slideId, null)],
    metrics: {
      datasetCount: 76,
      displayedCount: 76,
      adverseDatasetCount: 0,
      adverseDisplayedCount: 0,
    },
    provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: REFS },
    validation: { passed: true, issues: [] },
  } as unknown as SectionPackV2;
}

function validate(pack: SectionPackV2, index: ScopedEvidenceIndex) {
  return validateSectionPack({
    pack,
    expectedCaseId: "c1",
    expectedReportRunId: "r1",
    expectedDatasetId: "d1",
    bundle: BUNDLE,
    knownEvidenceRefs: new Set(REFS),
    evidenceIndex: index,
  });
}

describe("ворота Википедии и региональное резюме", () => {
  it.each(["organic", "images", "paa_related"])(
    "строка чужой статьи на поверхности %s не роняет резюме ОАЭ",
    (kind) => {
      const report = validate(
        summaryPack({
          fragmentKey: "UAE_SUMMARY",
          sectionId: "UAE_PROFILE",
          slideId: "p24_uae_summary",
        }),
        evidenceIndex({
          language: "en",
          kind,
          article: "en.wikipedia.org/wiki/Alexei_Borisov",
        })
      );
      expect(report.issues.filter((i) => i.includes("wikipedia denial"))).toEqual([]);
      expect(report.passed).toBe(true);
    }
  );

  it("то же на русской стороне: ru-проверка и ru-статья тёзки", () => {
    const report = validate(
      summaryPack({
        fragmentKey: "RU_SUMMARY",
        sectionId: "RU_PROFILE",
        slideId: "p07_ru_summary",
      }),
      evidenceIndex({
        language: "ru",
        kind: "images",
        article: "ru.wikipedia.org/wiki/Борисов,_Алексей_Иванович",
      })
    );
    expect(report.issues.filter((i) => i.includes("wikipedia denial"))).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("продолжение резюме наследует доказательства базы и тоже не судится", () => {
    const report = validate(
      summaryPack({
        fragmentKey: "UAE_SUMMARY",
        sectionId: "UAE_PROFILE",
        slideId: "p24_uae_summary",
        withContinuation: true,
      }),
      evidenceIndex({
        language: "en",
        kind: "images",
        article: "en.wikipedia.org/wiki/Alexei_Borisov",
      })
    );
    expect(report.issues.filter((i) => i.includes("wikipedia denial"))).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
