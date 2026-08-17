/**
 * Текст резюме отвечается один раз — композером.
 *
 * Стадия 2 переписывала буллеты резюме и на пути составленного резюме: модель
 * получала готовый текст и возвращала свой. Это уже стоило карточки (PDF 29), а
 * с приходом сюжетов стало единственным местом, где в резюме мог появиться
 * сюжет, которого нет в артефакте: гарды стадии 2 сверяют домены и цитаты, но
 * названия темы не закрепляют никак.
 *
 * Признак — данные слайда: метрика `composedSummary` стоит ровно на том
 * резюме, которое собрано композером. Легаси-резюме (без составленного
 * артефакта) переписывается как раньше.
 */

import { describe, expect, it } from "vitest";
import { enhanceSectionPacksWithGptCopy } from "@/modules/digital-profile/orion-golden/deck-sections/llm-slide-copy";
import { SECTION_PACK_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { SectionPackV2 } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { VerifiedFindingBundle } from "@/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";

const PLOT_BULLET =
  "Уголовное дело о налоговом мошенничестве в Стокгольме. По сюжету прочитано 5 публикаций, 4 из них нежелательные. " +
  "Источники: affarsposten.se, pravo-obzor.ru.";

/** Что вернула бы модель: сюжет переименован, и в артефакте его нет. */
const INVENTED_BULLET =
  "Хищение средств инвестиционного фонда. По материалам выдачи прослеживается вывод активов через связанные компании.";

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
  "inventory:obs-01": { domain: "affarsposten.se", title: "Tax probe", adverse: true },
} as never;

function executivePack(composedSummary: boolean): SectionPackV2 {
  return {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: "EXECUTIVE",
    sectionType: "EXECUTIVE",
    fragmentKey: "EXECUTIVE_SUMMARY",
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    sourceDatasetId: "d1",
    contentVersion: "deck-sections-v27",
    promptVersion: "executive-summary-v3",
    contentHash: "sha256:x",
    inputHash: "h1",
    generatedAt: "2026-08-17T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: ["inventory:obs-01"],
    inputs: { findingIds: [], evidenceRefs: ["inventory:obs-01"], metricSnapshotId: "m1" },
    slides: [
      {
        schemaVersion: "slide-content-v1",
        slideId: "p03_executive",
        baseSlotId: "p03_executive",
        sectionId: "EXECUTIVE",
        fragmentKey: "EXECUTIVE_SUMMARY",
        templateId: "executive-dashboard",
        title: "Резюме для руководства",
        findingIds: [],
        evidenceRefs: ["inventory:obs-01"],
        isContinuation: false,
        continuationOf: null,
        continuationIndex: null,
        visualAssetRefs: [],
        metrics: composedSummary ? { composedSummary: 1 } : {},
        content: {
          narrative: "Итоговая оценка: высокий риск.",
          bullets: [PLOT_BULLET],
        },
      },
    ],
    metrics: {},
    provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: ["inventory:obs-01"] },
    validation: { passed: true, issues: [] },
  } as unknown as SectionPackV2;
}

async function runStage2(pack: SectionPackV2) {
  let calls = 0;
  const out = await enhanceSectionPacksWithGptCopy({
    packs: [pack],
    subject: { displayName: "Anders Holmström", aliases: [] },
    caller: async () => {
      calls += 1;
      return { slides: [{ slideId: "p03_executive", bullets: [INVENTED_BULLET] }] };
    },
    caseAnalysis: null,
    bundle: BUNDLE,
    evidenceIndex: EVIDENCE_INDEX,
    validatePack: () => ({ passed: true, issues: [] }),
  });
  return { ...out, calls };
}

describe("стадия 2 и составленное резюме", () => {
  it("пак с метрикой составленного резюме не тронут байт в байт", async () => {
    const pack = executivePack(true);
    const out = await runStage2(pack);
    expect(out.calls).toBe(0);
    expect(JSON.stringify(out.packs[0])).toBe(JSON.stringify(pack));
    const report = out.report.fragments.find((f) => f.fragmentKey === "EXECUTIVE_SUMMARY")!;
    expect(report.status).toBe("SKIPPED_DETERMINISTIC");
    expect(report.detail).toBe("composed-summary");
  });

  it("легаси-резюме переписывается как раньше", async () => {
    const out = await runStage2(executivePack(false));
    expect(out.calls).toBe(1);
    expect(out.packs[0]!.slides[0]!.content.bullets).toEqual([INVENTED_BULLET]);
    expect(
      out.report.fragments.find((f) => f.fragmentKey === "EXECUTIVE_SUMMARY")!.status
    ).toBe("APPLIED");
  });
});
