/**
 * GPT levels plan (branch full-gpt) — offline unit acceptance:
 *
 *  Level 1:
 *   - B.1a repair-retry: an over-budget stage-2 field gets ONE compression
 *     call instead of an immediate reject; a failed repair falls back to the
 *     pre-B.1a reject behavior;
 *   - stage-3 deck editor: cross-page polish with the same fail-closed gates
 *     (budgets, tokens, domain gate, section QA rollback, transport fail-safe).
 *
 *  Level 2:
 *   - deck composer: the plan is validated fail-closed — unknown fragments,
 *     foreign findingIds, foreign/mock domains and unsafe story angles are
 *     dropped; transport errors return null and change nothing.
 */

import { beforeAll, describe, expect, it } from "vitest";
import {
  enhanceSectionPacksWithGptCopy,
  GPT_SLIDE_COPY_FIELD_BUDGETS,
  GPT_SLIDE_COPY_REPAIR_PROMPT_MARKER,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import {
  runGptDeckEditorPass,
  GPT_DECK_EDITOR_PROMPT_MARKER,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/gpt-deck-editor";
import {
  runGptDeckComposer,
  GPT_DECK_COMPOSER_PROMPT_MARKER,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/gpt-deck-composer";
import { OpenAiCallError } from "../../src/modules/digital-profile/orion-golden/gpt/gpt-call-queue";
import type { SectionPackV2 } from "../../src/modules/digital-profile/orion-golden/deck-sections/contracts";
import { SECTION_PACK_SCHEMA_VERSION } from "../../src/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { VerifiedFindingBundle } from "../../src/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";

beforeAll(() => {
  process.env.NETWORK_CALLS = "0";
});

const BUDGETS = GPT_SLIDE_COPY_FIELD_BUDGETS;

const BUNDLE = {
  schemaVersion: "verified-finding-bundle-v1",
  caseId: "c1",
  datasetId: "d1",
  reportRunId: "r1",
  generatedAt: new Date().toISOString(),
  sourceHashes: [],
  kpiEligibleSubjectMatches: ["SUBJECT_MATCH"],
  findings: [
    {
      findingId: "f1",
      theme: "Налоговое расследование",
      claim: "В выдаче есть материалы о налоговом расследовании субъекта.",
      riskLevel: "high",
      subjectMatch: "SUBJECT_MATCH",
      sourceDomains: ["di.se"],
      recommendedAction: "Проверить первоисточник.",
    },
  ],
  excludedFindingIds: [],
  exclusionReasons: {},
} as unknown as VerifiedFindingBundle;

const EVIDENCE_INDEX = {
  "inventory:a": { domain: "di.se", title: "Tax probe", adverse: true },
} as never;

function ruSerpPack(): SectionPackV2 {
  return {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: "RU_PROFILE",
    sectionType: "RU_PROFILE",
    fragmentKey: "RU_SERP",
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    sourceDatasetId: "d1",
    contentVersion: "deck-sections-v27",
    promptVersion: "ru-serp-analysis-v3",
    contentHash: "sha256:x",
    inputHash: "h1",
    generatedAt: "2026-01-01T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: ["f1"],
    evidenceRefs: ["inventory:a"],
    inputs: { findingIds: ["f1"], evidenceRefs: ["inventory:a"], metricSnapshotId: "m1" },
    slides: [
      {
        schemaVersion: "slide-content-v1",
        slideId: "p10_ru_serp",
        baseSlotId: "p10_ru_serp",
        sectionId: "RU_PROFILE",
        fragmentKey: "RU_SERP",
        templateId: "serp-table",
        title: "Россия — позиции в поисковой выдаче",
        findingIds: ["f1"],
        evidenceRefs: ["inventory:a"],
        isContinuation: false,
        continuationOf: null,
        continuationIndex: null,
        visualAssetRefs: [],
        metrics: {},
        content: {
          narrative: "Черновой вывод по странице.",
          bullets: ["Черновой пункт."],
          whatToCheck: "Проверить первоисточник.",
        },
      },
    ],
    metrics: {
      datasetCount: 1,
      displayedCount: 1,
      adverseDatasetCount: 1,
      adverseDisplayedCount: 1,
    },
    provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: ["inventory:a"] },
    validation: { passed: true, issues: [] },
  } as unknown as SectionPackV2;
}

const okValidate = () => ({ passed: true, issues: [] });

function longNarrative(): string {
  const sentence =
    "Публикации о налоговом расследовании видны на первой странице выдачи и влияют на решения банков и контрагентов при проверке субъекта. ";
  let out = "";
  while (out.length <= BUDGETS.narrative) out += sentence;
  return out.trim();
}

const COMPRESSED_NARRATIVE =
  "Публикации о налоговом расследовании видны на первой странице выдачи и влияют на решения банков и контрагентов; рекомендуем подготовить официальную позицию и подтверждающие документы.";

describe("level 1 — B.1a repair-retry for over-budget stage-2 fields", () => {
  it("compresses an over-budget narrative in one repair call and applies it", async () => {
    let repairCalls = 0;
    const out = await enhanceSectionPacksWithGptCopy({
      packs: [ruSerpPack()],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async ({ systemPrompt, userPayload }) => {
        if (systemPrompt.includes(GPT_SLIDE_COPY_REPAIR_PROMPT_MARKER)) {
          repairCalls += 1;
          const payload = userPayload as {
            items: Array<{ slideId: string; field: string; text?: string; maxChars: number }>;
          };
          expect(payload.items).toHaveLength(1);
          expect(payload.items[0]!.field).toBe("narrative");
          expect(payload.items[0]!.maxChars).toBeLessThan(BUDGETS.narrative);
          return {
            items: [
              { slideId: "p10_ru_serp", field: "narrative", text: COMPRESSED_NARRATIVE },
            ],
          };
        }
        return {
          slides: [{ slideId: "p10_ru_serp", narrative: longNarrative() }],
        };
      },
      caseAnalysis: null,
      bundle: BUNDLE,
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: okValidate,
    });

    expect(repairCalls).toBe(1);
    const frag = out.report.fragments.find((f) => f.fragmentKey === "RU_SERP")!;
    expect(frag.status).toBe("APPLIED");
    expect(frag.repairedFields).toBe(1);
    expect(frag.rejectedFields).toEqual([]);
    expect(out.packs[0]!.slides[0]!.content.narrative).toBe(COMPRESSED_NARRATIVE);
  });

  it("falls back to the pre-repair reject when the repair call fails", async () => {
    const out = await enhanceSectionPacksWithGptCopy({
      packs: [ruSerpPack()],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async ({ systemPrompt }) => {
        if (systemPrompt.includes(GPT_SLIDE_COPY_REPAIR_PROMPT_MARKER)) {
          throw new OpenAiCallError("forced-repair-fail", { retryable: false });
        }
        return {
          slides: [{ slideId: "p10_ru_serp", narrative: longNarrative() }],
        };
      },
      caseAnalysis: null,
      bundle: BUNDLE,
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: okValidate,
    });

    const frag = out.report.fragments.find((f) => f.fragmentKey === "RU_SERP")!;
    expect(frag.status).toBe("NO_CHANGES");
    expect(frag.rejectedFields.some((r) => r.includes("over-budget"))).toBe(true);
    expect(out.packs[0]!.slides[0]!.content.narrative).toBe(
      "Черновой вывод по странице."
    );
  });

  it("skips the repair round entirely when everything fits the budgets", async () => {
    let repairCalls = 0;
    const out = await enhanceSectionPacksWithGptCopy({
      packs: [ruSerpPack()],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async ({ systemPrompt }) => {
        if (systemPrompt.includes(GPT_SLIDE_COPY_REPAIR_PROMPT_MARKER)) {
          repairCalls += 1;
          return { items: [] };
        }
        return {
          slides: [{ slideId: "p10_ru_serp", narrative: COMPRESSED_NARRATIVE }],
        };
      },
      caseAnalysis: null,
      bundle: BUNDLE,
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: okValidate,
    });
    expect(repairCalls).toBe(0);
    expect(out.report.fragments[0]!.status).toBe("APPLIED");
  });
});

describe("level 1 — stage-3 deck editor pass", () => {
  const EDITED = "Согласованный вывод: материалы о расследовании требуют официальной позиции.";

  it("applies safe cross-page edits and reports them", async () => {
    let sawMarker = false;
    const out = await runGptDeckEditorPass({
      packs: [ruSerpPack()],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async ({ systemPrompt, userPayload }) => {
        sawMarker = systemPrompt.includes(GPT_DECK_EDITOR_PROMPT_MARKER);
        const payload = userPayload as { slides: Array<{ slideId: string }> };
        expect(payload.slides.map((s) => s.slideId)).toContain("p10_ru_serp");
        return { slides: [{ slideId: "p10_ru_serp", narrative: EDITED }] };
      },
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: okValidate,
    });
    expect(sawMarker).toBe(true);
    expect(out.report.status).toBe("APPLIED");
    expect(out.report.appliedFields).toBe(1);
    expect(out.packs[0]!.slides[0]!.content.narrative).toBe(EDITED);
  });

  it("rejects fields with foreign domains and meta-speak individually", async () => {
    const out = await runGptDeckEditorPass({
      packs: [ruSerpPack()],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async () => ({
        slides: [
          {
            slideId: "p10_ru_serp",
            narrative: "Материалы также размещены на evil-attacker.example.",
            whatToCheck: "Сверить переданный черновик с источниками.",
          },
        ],
      }),
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: okValidate,
    });
    expect(out.report.appliedFields).toBe(0);
    const rejected = out.report.fragments.flatMap((f) => f.rejectedFields);
    expect(rejected.some((r) => r.includes("foreign-domain"))).toBe(true);
    expect(rejected.some((r) => r.includes("forbidden"))).toBe(true);
    expect(out.packs[0]!.slides[0]!.content.narrative).toBe(
      "Черновой вывод по странице."
    );
  });

  it("rolls the pack back when section QA fails after the edit", async () => {
    const out = await runGptDeckEditorPass({
      packs: [ruSerpPack()],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async () => ({
        slides: [{ slideId: "p10_ru_serp", narrative: EDITED }],
      }),
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: () => ({ passed: false, issues: ["forced-qa-failure"] }),
    });
    expect(out.report.appliedFields).toBe(0);
    expect(out.report.fragments[0]!.validationFallback).toContain("forced-qa-failure");
    expect(out.packs[0]!.slides[0]!.content.narrative).toBe(
      "Черновой вывод по странице."
    );
  });

  it("fails safe on transport errors — packs unchanged", async () => {
    const packs = [ruSerpPack()];
    const out = await runGptDeckEditorPass({
      packs,
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async () => {
        throw new OpenAiCallError("forced-editor-fail", { retryable: false });
      },
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: okValidate,
    });
    expect(out.report.status).toBe("FALLBACK_ERROR");
    expect(out.packs).toEqual(packs);
  });
});

describe("level 2 — deck composer fail-closed validation", () => {
  it("keeps only fragments/findings/domains from the fragment's own scope", async () => {
    let sawMarker = false;
    const composition = await runGptDeckComposer({
      packs: [ruSerpPack()],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async ({ systemPrompt, userPayload }) => {
        sawMarker = systemPrompt.includes(GPT_DECK_COMPOSER_PROMPT_MARKER);
        const payload = userPayload as {
          fragments: Array<{ fragmentKey: string; findings: Array<{ findingId: string }> }>;
        };
        expect(payload.fragments).toHaveLength(1);
        expect(payload.fragments[0]!.findings[0]!.findingId).toBe("f1");
        return {
          fragments: [
            {
              fragmentKey: "RU_SERP",
              storyAngle:
                "Начните с материалов о налоговом расследовании — они определяют восприятие субъекта при проверке.",
              emphasisFindingIds: ["f1", "f-foreign"],
              keyDomains: ["di.se", "evil.example", "en.wikipedia-mock.example"],
            },
            {
              fragmentKey: "UNKNOWN_FRAGMENT",
              storyAngle: "Не должен пройти.",
            },
          ],
        };
      },
      caseAnalysis: null,
      bundle: BUNDLE,
      evidenceIndex: EVIDENCE_INDEX,
    });

    expect(sawMarker).toBe(true);
    expect(composition).not.toBeNull();
    expect(composition!.fragments).toHaveLength(1);
    const plan = composition!.fragments[0]!;
    expect(plan.fragmentKey).toBe("RU_SERP");
    expect(plan.emphasisFindingIds).toEqual(["f1"]);
    expect(plan.keyDomains).toEqual(["di.se"]);
    expect(composition!.droppedFragments).toContain(
      "UNKNOWN_FRAGMENT:unknown-or-duplicate-fragment"
    );
    expect(
      composition!.droppedFields.some((d) => d.includes("f-foreign"))
    ).toBe(true);
    expect(
      composition!.droppedFields.some((d) => d.includes("evil.example"))
    ).toBe(true);
  });

  it("drops fragments whose story angle carries meta-speak or internal tokens", async () => {
    const composition = await runGptDeckComposer({
      packs: [ruSerpPack()],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async () => ({
        fragments: [
          {
            fragmentKey: "RU_SERP",
            storyAngle: "В переданном черновике не хватает данных для этой страницы.",
          },
        ],
      }),
      caseAnalysis: null,
      bundle: BUNDLE,
      evidenceIndex: EVIDENCE_INDEX,
    });
    expect(composition).toBeNull();
  });

  it("fails safe to null on transport errors", async () => {
    const composition = await runGptDeckComposer({
      packs: [ruSerpPack()],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async () => {
        throw new OpenAiCallError("forced-composer-fail", { retryable: false });
      },
      caseAnalysis: null,
      bundle: BUNDLE,
      evidenceIndex: EVIDENCE_INDEX,
    });
    expect(composition).toBeNull();
  });

  it("passes the validated plan into stage-2 prompts (themes, not ids)", async () => {
    let stage2Payload: Record<string, unknown> | null = null;
    await enhanceSectionPacksWithGptCopy({
      packs: [ruSerpPack()],
      subject: { displayName: "Anders Holmström", aliases: [] },
      caller: async ({ userPayload }) => {
        stage2Payload = userPayload as Record<string, unknown>;
        return { slides: [] };
      },
      caseAnalysis: null,
      composition: {
        version: "gpt-deck-composition-v1",
        promptVersion: "gpt-deck-composer-v1",
        generatedAt: new Date().toISOString(),
        fragments: [
          {
            fragmentKey: "RU_SERP",
            storyAngle: "Начните с налогового расследования.",
            emphasisFindingIds: ["f1"],
            keyDomains: ["di.se"],
          },
        ],
        droppedFragments: [],
        droppedFields: [],
      },
      bundle: BUNDLE,
      evidenceIndex: EVIDENCE_INDEX,
      validatePack: okValidate,
    });
    expect(stage2Payload).not.toBeNull();
    const plan = (stage2Payload as unknown as {
      compositionPlan: {
        storyAngle: string;
        emphasisThemes: string[];
        keyDomains: string[];
      } | null;
    }).compositionPlan;
    expect(plan).not.toBeNull();
    expect(plan!.storyAngle).toBe("Начните с налогового расследования.");
    expect(plan!.emphasisThemes).toEqual(["Налоговое расследование"]);
    expect(plan!.keyDomains).toEqual(["di.se"]);
  });
});
