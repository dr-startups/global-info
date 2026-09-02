import { describe, expect, it } from "vitest";
import { enhanceSectionPacksWithGptCopy } from "@/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import { getFragmentPrompt } from "@/modules/digital-profile/orion-golden/deck-sections/prompts";
import { SECTION_PACK_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { SectionPackV2 } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { VerifiedFindingBundle } from "@/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";

/**
 * Страницы фактических проверок модель не переписывает.
 *
 * На прогоне 76 стадия копирайта переписала нарратив страницы Википедии и
 * выбросила из него метод проверки, дату и URL найденной статьи — при том что
 * URL лежал в данных. Полировать можно интерпретацию, но не страницу, чья
 * ценность — дословные факты проверки; ровно так после шага F устроен
 * комплаенс.
 */

const BUNDLE = {
  schemaVersion: "verified-finding-bundle-v1",
  caseId: "c1",
  datasetId: "d1",
  reportRunId: "r1",
  generatedAt: "2026-08-17T00:00:00.000Z",
  sourceHashes: [],
  kpiEligibleSubjectMatches: ["SUBJECT_MATCH"],
  findings: [],
  excludedFindingIds: [],
  exclusionReasons: {},
} as unknown as VerifiedFindingBundle;

const EVIDENCE_INDEX = {
  "inventory:wiki-1": { domain: "ru.wikipedia.org", title: "Рашников, Виктор Филиппович" },
} as never;

const NARRATIVE =
  "Наличие статьи о проверяемом лице проверено через официальный поисковый API Википедии " +
  "в русскоязычном разделе (ru.wikipedia.org); запрос: «Рашников Виктор Филиппович», " +
  "проверка выполнена 17.08.2026. Результат проверки: статья о проверяемом лице найдена — " +
  "«Рашников, Виктор Филиппович», https://ru.wikipedia.org/wiki/Рашников,_Виктор_Филиппович.";

function identityPack(fragmentKey: "RU_IDENTITY_WIKIPEDIA" | "UAE_IDENTITY_WIKIPEDIA"): SectionPackV2 {
  const ru = fragmentKey === "RU_IDENTITY_WIKIPEDIA";
  return {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: ru ? "RU_PROFILE" : "UAE_PROFILE",
    sectionType: ru ? "RU_PROFILE" : "UAE_PROFILE",
    fragmentKey,
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    sourceDatasetId: "d1",
    contentVersion: "deck-sections-v88",
    promptVersion: getFragmentPrompt(fragmentKey).promptVersion,
    contentHash: "sha256:x",
    inputHash: "h1",
    generatedAt: "2026-08-17T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: ["inventory:wiki-1"],
    inputs: { findingIds: [], evidenceRefs: ["inventory:wiki-1"], metricSnapshotId: "m1" },
    slides: [
      {
        schemaVersion: "slide-content-v1",
        slideId: ru ? "p13_ru_wikipedia" : "p29_uae_wikipedia",
        baseSlotId: ru ? "p13_ru_wikipedia" : "p29_uae_wikipedia",
        sectionId: ru ? "RU_PROFILE" : "UAE_PROFILE",
        templateId: "wikipedia-check",
        title: ru ? "Россия — Википедия" : "ОАЭ — Википедия",
        findingIds: [],
        evidenceRefs: ["inventory:wiki-1"],
        isContinuation: false,
        continuationOf: null,
        continuationIndex: null,
        visualAssetRefs: [],
        metrics: { wikipediaCheckExists: 1 },
        content: {
          narrative: NARRATIVE,
          bullets: ["Рашников, Виктор Филиппович — ru.wikipedia.org"],
        },
      },
    ],
    metrics: {},
    provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: ["inventory:wiki-1"] },
    validation: { passed: true, issues: [] },
  } as unknown as SectionPackV2;
}

async function runStage2(pack: SectionPackV2) {
  let calls = 0;
  const out = await enhanceSectionPacksWithGptCopy({
    packs: [pack],
    subject: { displayName: "Виктор Рашников", aliases: [] },
    caller: async () => {
      calls += 1;
      return {
        slides: [
          {
            slideId: pack.slides[0]!.slideId,
            narrative:
              "Субъект широко представлен в энциклопедических источниках, что формирует устойчивый образ.",
          },
        ],
      };
    },
    caseAnalysis: null,
    bundle: BUNDLE,
    evidenceIndex: EVIDENCE_INDEX,
    validatePack: () => ({ passed: true, issues: [] }),
  });
  return { ...out, calls };
}

describe("идентификационные фрагменты детерминированы", () => {
  for (const key of ["RU_IDENTITY_WIKIPEDIA", "UAE_IDENTITY_WIKIPEDIA"] as const) {
    it(`${key}: промпт помечен детерминированным`, () => {
      expect(getFragmentPrompt(key).deterministic).toBe(true);
    });

    it(`${key}: стадия копирайта не зовёт модель и не трогает пак`, async () => {
      const pack = identityPack(key);
      const out = await runStage2(pack);
      expect(out.calls).toBe(0);
      expect(JSON.stringify(out.packs[0])).toBe(JSON.stringify(pack));
      const report = out.report.fragments.find((f) => f.fragmentKey === key)!;
      expect(report.status).toBe("SKIPPED_DETERMINISTIC");
    });
  }

  it("метод, дата и ссылка остаются в нарративе после стадии", async () => {
    const out = await runStage2(identityPack("RU_IDENTITY_WIKIPEDIA"));
    const narrative = out.packs[0]!.slides[0]!.content.narrative ?? "";
    expect(narrative).toContain("официальный поисковый API Википедии");
    expect(narrative).toContain("проверка выполнена 17.08.2026");
    expect(narrative).toContain("https://ru.wikipedia.org/wiki/");
  });
});
