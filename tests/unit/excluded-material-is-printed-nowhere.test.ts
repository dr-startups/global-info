/**
 * Снятый аналитиком материал не печатается в отчёте нигде.
 *
 * До этого шага «убрать» умело только одно — не считать материал негативным
 * (`markNeutral`): строка оставалась в таблице, плитка на сетке, цитата в теме.
 * Кнопка с подписью «убрать из отчёта» врала бы, поэтому её и не было.
 *
 * Снятие живёт в загрузчике входов деки, а не в наборе наблюдений: аналитика
 * обязана продолжать видеть материал — по нему считается охват и реестр
 * расположения. Убрать его из набора значило бы объявить, что его не собирали,
 * — это другое утверждение и другая ложь.
 */

import { describe, expect, it } from "vitest";
import { dropAnalystExcludedFromDeckInputs } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { SurfaceAnalysisUnit } from "@/modules/digital-profile/orion-golden/contracts/surface-analysis";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";

const GONE = "inventory:gone";
const KEPT = "inventory:kept";

function inputs() {
  const evidenceIndex = {
    [GONE]: { url: "https://gone.example/1", title: "Снятый материал", rank: 14, region: "RU" },
    [KEPT]: { url: "https://kept.example/1", title: "Оставленный материал", rank: 3, region: "RU" },
  } as unknown as ScopedEvidenceIndex;
  const surfaceUnits = [
    {
      surface: "organic",
      region: "RU",
      metrics: [],
      claims: [
        { claimId: "c1", text: "Утверждение", subjectMatch: "SUBJECT_MATCH", evidenceRefs: [GONE, KEPT] },
        { claimId: "c2", text: "Только снятый", subjectMatch: "SUBJECT_MATCH", evidenceRefs: [GONE] },
      ],
      evidenceRefs: [GONE, KEPT],
      emptyMarkerRefs: [GONE],
    },
  ] as unknown as SurfaceAnalysisUnit[];
  const findings = [
    {
      findingId: "f1",
      theme: "Криминальные / судебные материалы",
      evidenceRefs: [GONE, KEPT],
    },
  ] as unknown as Finding[];
  return { evidenceIndex, surfaceUnits, findings };
}

describe("снятый материал уходит из входов деки", () => {
  it("его ссылки не остаются ни в индексе улик, ни в опорах, ни в уликах находок", () => {
    const { evidenceIndex, surfaceUnits, findings } = inputs();
    const removed = dropAnalystExcludedFromDeckInputs({
      evidenceIndex,
      surfaceUnits,
      findings,
      excludedRefs: new Set([GONE]),
    });

    expect(Object.keys(evidenceIndex)).toEqual([KEPT]);
    expect(surfaceUnits[0]!.evidenceRefs).toEqual([KEPT]);
    expect(surfaceUnits[0]!.emptyMarkerRefs).toEqual([]);
    expect(findings[0]!.evidenceRefs).toEqual([KEPT]);
    // Утверждение, у которого не осталось ни одной улики, исчезает целиком:
    // печатать его было бы нечем подтвердить.
    expect(surfaceUnits[0]!.claims.map((c) => c.claimId)).toEqual(["c1"]);
    expect(surfaceUnits[0]!.claims[0]!.evidenceRefs).toEqual([KEPT]);
    expect(removed.count).toBe(1);
  });

  it("снятые номера позиций собираются по регионам — страница о них скажет", () => {
    const { evidenceIndex, surfaceUnits, findings } = inputs();
    const removed = dropAnalystExcludedFromDeckInputs({
      evidenceIndex,
      surfaceUnits,
      findings,
      excludedRefs: new Set([GONE]),
    });
    expect(removed.ranksByRegion).toEqual({ RU: [14] });
  });

  it("без снятых ничего не двигается", () => {
    const { evidenceIndex, surfaceUnits, findings } = inputs();
    const removed = dropAnalystExcludedFromDeckInputs({
      evidenceIndex,
      surfaceUnits,
      findings,
      excludedRefs: new Set<string>(),
    });
    expect(Object.keys(evidenceIndex).sort()).toEqual([GONE, KEPT].sort());
    expect(surfaceUnits[0]!.claims).toHaveLength(2);
    expect(removed.count).toBe(0);
  });
});
