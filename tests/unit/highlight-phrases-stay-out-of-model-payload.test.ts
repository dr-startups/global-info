/**
 * Фразы «Почему выделено» модель не пишет и не правит.
 *
 * Фраза собирается детерминированно из решения по прочитанной странице: сюжет,
 * дословная цитата, проверенная аудитором, и адрес наблюдения. Единственное,
 * что делает её проверяемой, — то, что она не проходила через модель на сборке
 * деки. Поведение уже такое; тест не даёт добавить `highlightExplanations` в
 * payload GPT-стадий «за компанию» с остальными полями слайда.
 */

import { describe, expect, it } from "vitest";
import { enhanceSectionPacksWithGptCopy } from "@/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import { runGptDeckEditorPass } from "@/modules/digital-profile/orion-golden/deck-sections/gpt-deck-editor";
import { getFragmentPrompt } from "@/modules/digital-profile/orion-golden/deck-sections/prompts";
import { SECTION_PACK_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { SectionPackV2 } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { VerifiedFindingBundle } from "@/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";

const PHRASE =
  "На странице rupep.org — санкции и заморозка активов: «Активы заморожены решением Совета ЕС.» rupep.org/ru/person/8095";

const BUNDLE = {
  schemaVersion: "verified-finding-bundle-v1",
  caseId: "c1",
  datasetId: "d1",
  reportRunId: "r1",
  generatedAt: "2026-08-19T00:00:00.000Z",
  sourceHashes: [],
  kpiEligibleSubjectMatches: ["SUBJECT_MATCH"],
  findings: [],
  excludedFindingIds: [],
  exclusionReasons: {},
} as unknown as VerifiedFindingBundle;

const EVIDENCE_INDEX = {
  "inventory:row-1": { domain: "rupep.org", title: "Сергей Глинка — RUPEP" },
} as never;

function snapshotPack(): SectionPackV2 {
  return {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: "RU_PROFILE",
    sectionType: "RU_PROFILE",
    fragmentKey: "RU_SERP_SCREENSHOT",
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    sourceDatasetId: "d1",
    contentVersion: "test-content-version",
    promptVersion: getFragmentPrompt("RU_SERP_SCREENSHOT").promptVersion,
    contentHash: "sha256:x",
    inputHash: "h1",
    generatedAt: "2026-08-19T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: ["inventory:row-1"],
    inputs: { findingIds: [], evidenceRefs: ["inventory:row-1"], metricSnapshotId: "m1" },
    slides: [
      {
        schemaVersion: "slide-content-v1",
        slideId: "p10_ru_serp_visual",
        baseSlotId: "p10_ru_serp_visual",
        sectionId: "RU_PROFILE",
        templateId: "serp-screenshot-analysis",
        title: "Россия — снимок выдачи",
        findingIds: [],
        evidenceRefs: ["inventory:row-1"],
        isContinuation: false,
        continuationOf: null,
        continuationIndex: null,
        visualAssetRefs: ["ru_serp_snapshot"],
        metrics: { adverseHighlights: 1 },
        content: {
          narrative: "Состояние первой страницы выдачи (Россия).",
          whatWasFound: "На снимке выделено результатов повышенного внимания: 1.",
          highlightExplanations: [{ clientReason: PHRASE, frameTone: "red" }],
        },
      },
    ],
    metrics: {},
    provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: ["inventory:row-1"] },
    validation: { passed: true, issues: [] },
  } as unknown as SectionPackV2;
}

describe("payload GPT-стадий не несёт фраз «Почему выделено»", () => {
  it("стадия копирайта фразы модели не показывает", async () => {
    const payloads: unknown[] = [];
    await enhanceSectionPacksWithGptCopy({
      packs: [snapshotPack()],
      subject: { displayName: "Сергей Глинка", aliases: [] },
      caller: async (input) => {
        payloads.push(input.userPayload);
        return { slides: [] };
      },
      caseAnalysis: null,
      bundle: BUNDLE,
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: () => ({ passed: true, issues: [] }),
      forceRefresh: true,
    });
    expect(payloads.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain("highlightExplanations");
    expect(serialized).not.toContain("clientReason");
    expect(serialized).not.toContain("Активы заморожены решением Совета ЕС");
  });

  it("редакторский проход фразы модели не показывает", async () => {
    const payloads: unknown[] = [];
    await runGptDeckEditorPass({
      packs: [snapshotPack()],
      subject: { displayName: "Сергей Глинка", aliases: [] },
      caller: async (input) => {
        payloads.push(input.userPayload);
        return { slides: [] };
      },
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: () => ({ passed: true, issues: [] }),
    });
    expect(payloads.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(payloads);
    expect(serialized).not.toContain("highlightExplanations");
    expect(serialized).not.toContain("clientReason");
    expect(serialized).not.toContain("Активы заморожены решением Совета ЕС");
  });
});
