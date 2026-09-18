/**
 * У продолжений резюме одна подпись на цепочку.
 *
 * Построитель подписывал каждый лист по виду его блоков: «Резюме — темы
 * риска», если на листе только темы, иначе «Резюме». Перекладка по мере
 * блоки между листами переставляет, а подпись остаётся за листом — и дека
 * золотого кейса печатала «Резюме — темы риска (продолжение 1/3)», «Резюме
 * (продолжение 2/3)» с теми же темами и снова «темы риска 3/3». С перекладкой
 * назад (шаг 0102) это случалось бы чаще. Вид блоков — свойство цепочки, а не
 * листа: набор блоков цепочки перекладка не меняет.
 */

import { describe, expect, it } from "vitest";
import { buildExecutiveSummaryFromComposed } from "@/modules/digital-profile/orion-golden/deck-sections";
import { sampleComposedClientSummary } from "@/modules/digital-profile/orion-golden/contracts/sample-contracts";
import { stripContinuationSuffix } from "@/modules/digital-profile/orion-golden/deck-sections/continuation-slide";
import { fragmentScope } from "@/modules/digital-profile/orion-golden/deck-sections";
import { loadReport72DeckInputs } from "../../scripts/run-orion-deck-sections-report72";
import { runDeckBuild } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import { DECK_CONTENT_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/content-version";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("подписи продолжений резюме", () => {
  it("на эталонном корпусе у всех продолжений резюме одна подпись без суффикса", () => {
    const inputs = loadReport72DeckInputs();
    const result = runDeckBuild({
      ctx: {
        caseId: inputs.caseId,
        reportRunId: inputs.reportRunId,
        sourceDatasetId: inputs.sourceDatasetId,
        contentVersion: DECK_CONTENT_VERSION,
        subject: { displayName: "Сергей Глинка", aliases: ["Sergey Glinka"] },
        bundle: inputs.mergedBundle,
        surfaceUnits: inputs.surfaceUnits,
        metricSnapshot: inputs.metricSnapshot,
        evidenceIndex: inputs.evidenceIndex,
        extras: {
          executiveSummary: inputs.executiveSummary as never,
          composedClientSummary: (inputs.composedClientSummary as never) ?? undefined,
          surfaceCollectionHints: inputs.surfaceCollectionHints,
          complianceScreenings: inputs.complianceScreenings,
          visualAssets: {},
        },
      },
      bundleForValidation: inputs.mergedBundle,
      knownEvidenceRefs: inputs.knownEvidenceRefs,
      outputRoot: mkdtempSync(join(tmpdir(), "resume-titles-")),
      baseObservationCountBefore: inputs.baseCountBefore,
      baseObservationCountAfter: inputs.baseCountAfter,
      serpObservations: inputs.serpObservations,
    } as never);
    const conts = result.assembly.rendererSlides.filter(
      (s) => s.isContinuation && s.baseSlotId === "p03_executive"
    );
    expect(conts.length).toBeGreaterThanOrEqual(2);
    const bases = new Set(conts.map((s) => stripContinuationSuffix(s.title)));
    expect([...bases]).toHaveLength(1);
  });

  it("построитель составного резюме: смешанные листы не получают разных подписей", () => {
    // Составное резюме с темами и другими блоками: сид кладёт их на разные
    // листы, и подпись обязана быть одна на всю цепочку.
    const composed = sampleComposedClientSummary();
    const executiveSummary = {
      verdict: "ELEVATED",
      executiveConclusion: "Собранные материалы формируют заметный негативный фон вокруг субъекта.",
      keyFindings: [],
      priorityActions: ["Проверить первоисточники по незакрытым направлениям."],
      identityCaveats: [],
      dataLimitations: [],
    };
    const out = buildExecutiveSummaryFromComposed(
      "EXECUTIVE" as never,
      {
        subject: { displayName: "Тестов", aliases: [] },
        findings: [],
        surfaceUnits: [],
        evidenceIndex: {},
        scope: fragmentScope("EXECUTIVE_SUMMARY"),
        metricSnapshot: {
          metricSnapshotId: "m",
          datasetId: "d",
          reportRunId: "r",
          baseCount: 100,
          enrichmentCount: 0,
          compositeCount: 100,
          subjectMatchCount: 40,
          likelySubjectCount: 3,
          ambiguousCount: 5,
          otherSubjectCount: 2,
          adverseFindingCount: 1,
          perRegionCounts: { RU: 60, UAE: 40 },
        },
      } as never,
      { executiveSummary, composedClientSummary: composed } as never,
      composed
    );
    const conts = out.slides.filter((s) => s.isContinuation);
    const bases = new Set(conts.map((s) => stripContinuationSuffix(s.title)));
    expect(bases.size).toBeLessThanOrEqual(1);
    // Подпись прежняя там, где на всех листах только темы, и «Резюме» — где нет.
    for (const base of bases) expect(["Резюме", "Резюме — темы риска"]).toContain(base);
  });
});
