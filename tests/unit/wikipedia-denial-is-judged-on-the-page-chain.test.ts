/**
 * Отрицание статьи судится один раз на страницу, а не на каждый её лист.
 *
 * Абзац страницы Википедии режется по листам
 * (`SILENTLY_CLIPPED_NARRATIVE_TEMPLATES`), продолжение наследует доказательства
 * базы целиком, а оговорка с адресом печатается один раз внутри
 * `resultSentence`. Требовать адрес от каждого листа — значит ронять
 * обязательную секцию `*_IDENTITY_WIKIPEDIA` на её же честном тексте, как
 * только страница переросла один лист.
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
const BASE_ID = "p29_uae_wikipedia";
const CONT_ID = "p29_uae_wikipedia__cont1";

const BUNDLE = {
  schemaVersion: "verified-finding-bundle-v1",
  caseId: "c1",
  datasetId: "d1",
  reportRunId: "r1",
  findings: [],
  excludedFindingIds: [],
} as unknown as VerifiedFindingBundle;

function evidenceIndex(subjectDecision: string): ScopedEvidenceIndex {
  return {
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
      subjectDecision,
      rank: 1,
      engine: "GOOGLE",
    },
  } as unknown as ScopedEvidenceIndex;
}

const EVIDENCE_INDEX = evidenceIndex("SUBJECT_MATCH");

/** Текст без адреса: страница промолчала о статье из своих же доказательств. */
const SILENT = "Проверка по этому запросу статью не нашла.";
/** Тот же текст с напечатанной оговоркой — так его собирает построитель. */
const HONEST =
  `${SILENT} При этом в поисковой выдаче зафиксирована статья ${ARTICLE_LINK} ` +
  "(Google, позиция 1).";

function wikipediaPack(opts: {
  baseNarrative: string;
  continuationBullets?: string[];
}): SectionPackV2 {
  const slide = (slideId: string, continuationOf: string | null) => ({
    schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
    slideId,
    baseSlotId: BASE_ID,
    sectionId: "UAE_PROFILE",
    templateId: "wikipedia-check",
    title: "ОАЭ — Википедия",
    findingIds: [],
    evidenceRefs: REFS,
    isContinuation: Boolean(continuationOf),
    continuationOf,
    continuationIndex: continuationOf ? 1 : null,
    visualAssetRefs: [],
    metrics: { wikipediaCheckExists: 0 },
    content: continuationOf
      ? { bullets: opts.continuationBullets ?? [] }
      : { narrative: opts.baseNarrative, bullets: [] },
  });
  const slides = opts.continuationBullets
    ? [slide(BASE_ID, null), slide(CONT_ID, BASE_ID)]
    : [slide(BASE_ID, null)];
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
    generatedAt: "2026-09-01T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: REFS,
    inputs: { findingIds: [], evidenceRefs: REFS, metricSnapshotId: "m1" },
    slides,
    metrics: {
      datasetCount: 1,
      displayedCount: 1,
      adverseDatasetCount: 0,
      adverseDisplayedCount: 0,
    },
    provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: REFS },
    validation: { passed: true, issues: [] },
  } as unknown as SectionPackV2;
}

function denials(pack: SectionPackV2, index: ScopedEvidenceIndex = EVIDENCE_INDEX): string[] {
  return validateSectionPack({
    pack,
    expectedCaseId: "c1",
    expectedReportRunId: "r1",
    expectedDatasetId: "d1",
    bundle: BUNDLE,
    knownEvidenceRefs: new Set(REFS),
    evidenceIndex: index,
  }).issues.filter((i) => i.includes("wikipedia denial"));
}

describe("ворота Википедии судят цепочку страницы", () => {
  it("страница из одного листа, промолчавшая о статье, не проходит", () => {
    const issues = denials(wikipediaPack({ baseNarrative: SILENT }));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(`on ${BASE_ID}:`);
    expect(issues[0]).toContain(ARTICLE_LINK);
  });

  it("продолжение не судится как второе отрицание", () => {
    expect(
      denials(
        wikipediaPack({
          baseNarrative: HONEST,
          continuationBullets: ["Фрагменты статьи и прочие строки выдачи региона."],
        })
      )
    ).toEqual([]);
  });

  it("адрес, уехавший резаком на продолжение, засчитывается цепочке", () => {
    expect(
      denials(
        wikipediaPack({
          baseNarrative: SILENT,
          continuationBullets: [
            `В поисковой выдаче зафиксирована статья ${ARTICLE_LINK} (Google, позиция 1).`,
          ],
        })
      )
    ).toEqual([]);
  });

  /*
   * Предикат принадлежности — тот же, что у построителя (`identity.ts`).
   *
   * Расширить его до `LIKELY_SUBJECT` выглядит очевидным улучшением, и
   * §8 «Предикат этой оговорки уже обещания» объявляет это расширение
   * осознанно отвергнутым: построитель такую статью адресом не назовёт, а
   * ворота стали бы её требовать — обязательная секция `*_IDENTITY_WIKIPEDIA`
   * получила бы `FAILED` на своём же честном тексте. Живой пример из того же
   * абзаца: en-строка прогона Мордашова имела `LIKELY_SUBJECT @0.62`.
   */
  it("вероятная принадлежность строки отказа не даёт", () => {
    expect(
      denials(wikipediaPack({ baseNarrative: SILENT }), evidenceIndex("LIKELY_SUBJECT"))
    ).toEqual([]);
  });

  it("цепочка, не назвавшая адрес ни на одном листе, получает ровно один отказ", () => {
    const issues = denials(
      wikipediaPack({
        baseNarrative: SILENT,
        continuationBullets: ["Фрагменты статьи и прочие строки выдачи региона."],
      })
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain(`on ${BASE_ID}:`);
    expect(issues[0]).toContain(ARTICLE_LINK);
  });
});
