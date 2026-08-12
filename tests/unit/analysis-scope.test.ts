/**
 * Область анализа — ТОП-20 выдачи по субъекту.
 *
 * Проверяется ровно то, что обещано клиенту в резюме: аудит идёт по первому
 * развороту выдачи и по международным базам, а всё остальное собрано, но темы
 * риска не рождает — и обязано иметь названную причину.
 *
 * NETWORK_CALLS=0 (vitest.config env).
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";
import {
  ANALYSIS_TOP_N,
  resolveAnalysisScope,
} from "../../src/modules/digital-profile/orion-golden/analytics/analysis-scope";
import {
  buildSubjectResolution,
  type SubjectIdentity,
} from "../../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { synthesizeFindings } from "../../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import {
  assertDispositionGatesPass,
  buildObservationDispositionLedger,
} from "../../src/modules/digital-profile/orion-golden/analytics/observation-disposition-ledger";

const CASE = "case-scope";

let seq = 0;
function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `sc-${seq}`,
    caseId: CASE,
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-07-16T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: partial.snippet ?? "полный сниппет без обрезки",
    sourceUrl: partial.sourceUrl ?? `https://news.example/${seq}`,
    ...partial,
  };
}

function organic(rank: number | null, extra?: Partial<RawInventoryItem>): RawInventoryItem {
  return item({
    title: `Материал позиции ${rank ?? "без номера"}`,
    ...extra,
    rawMetadata: {
      surface: "organic",
      engine: "YANDEX",
      ...(rank === null ? {} : { rank }),
      ...((extra?.rawMetadata as Record<string, unknown>) ?? {}),
    },
  });
}

describe("analysis-scope: предмет аудита — ТОП-20 и международные базы", () => {
  it("берёт органику до двадцатой позиции и не берёт глубже", () => {
    const items = [organic(1), organic(ANALYSIS_TOP_N), organic(ANALYSIS_TOP_N + 1), organic(87)];
    const scope = resolveAnalysisScope(items);

    expect(scope.inScope.map((i) => i.inventoryId)).toEqual([
      items[0]!.inventoryId,
      items[1]!.inventoryId,
    ]);
    expect(scope.summary.excludedByReason.below_top_n).toBe(2);
    expect(scope.outOfScope.every((d) => d.reason === "below_top_n")).toBe(true);
  });

  it("материал без позиции в аудит не берётся, а получает причину", () => {
    const scope = resolveAnalysisScope([organic(null)]);

    expect(scope.inScope).toHaveLength(0);
    expect(scope.summary.excludedByReason.rank_unknown).toBe(1);
    expect(scope.outOfScope[0]!.reason).toBe("rank_unknown");
  });

  it("подсказки, картинки и видео остаются вне предмета аудита", () => {
    const items = [
      organic(3),
      item({
        title: "Подсказка поисковика",
        rawMetadata: { surface: "suggestions", engine: "YANDEX", rank: 1 },
      }),
      item({
        title: "Картинка",
        rawMetadata: { surface: "images", engine: "GOOGLE", rank: 2 },
      }),
      item({
        title: "Видео",
        rawMetadata: { surface: "video", engine: "GOOGLE", rank: 1 },
      }),
    ];
    const scope = resolveAnalysisScope(items);

    expect(scope.inScope).toHaveLength(1);
    expect(scope.summary.excludedByReason.surface_out_of_scope).toBe(3);
  });

  it("международные базы и Википедия входят в аудит без позиции в выдаче", () => {
    const items = [
      item({
        title: "Dow Jones Risk & Compliance — PEP/RCA",
        source: "database_profile",
        evidenceType: "compliance_hit",
        rawMetadata: { surface: "compliance_hit" },
      }),
      item({
        title: "Wikipedia — карточка личности",
        source: "wikipedia_check",
        evidenceType: "wikipedia_check",
        rawMetadata: { surface: "wikipedia" },
      }),
    ];
    const scope = resolveAnalysisScope(items);

    expect(scope.inScope).toHaveLength(2);
    expect(scope.summary.analyzedBySource).toEqual({ serpTop: 0, databases: 2 });
    expect(scope.outOfScope).toHaveLength(0);
  });

  it("глубина считается внутри разреза «движок × регион»", () => {
    const items = [
      organic(19, { region: "RU", rawMetadata: { surface: "organic", engine: "YANDEX", rank: 19 } }),
      organic(21, { region: "RU", rawMetadata: { surface: "organic", engine: "YANDEX", rank: 21 } }),
      organic(2, { region: "UAE", rawMetadata: { surface: "organic", engine: "GOOGLE", rank: 2 } }),
    ];
    const scope = resolveAnalysisScope(items);
    const lanes = Object.fromEntries(scope.summary.lanes.map((l) => [l.lane, l]));

    expect(lanes["YANDEX|RU"]).toMatchObject({ analyzed: 1, organic: 2, deepestRank: 19 });
    expect(lanes["GOOGLE|UAE"]).toMatchObject({ analyzed: 1, organic: 1, deepestRank: 2 });
  });

  it("сводка сходится: собрано = проанализировано + причины исключения", () => {
    const items = [organic(1), organic(25), organic(null), item({ title: "Подсказка", rawMetadata: { surface: "suggestions" } })];
    const s = resolveAnalysisScope(items).summary;
    const excluded = Object.values(s.excludedByReason).reduce((a, b) => a + b, 0);

    expect(s.collected).toBe(items.length);
    expect(s.analyzed + excluded).toBe(s.collected);
  });

  it("глубину можно объявить другой — правило не зашито в число", () => {
    const scope = resolveAnalysisScope([organic(5), organic(11)], { topN: 10 });

    expect(scope.summary.topN).toBe(10);
    expect(scope.inScope).toHaveLength(1);
  });
});

const SUBJECT: SubjectIdentity = {
  displayName: "Глинка Сергей Михайлович",
  lastName: "Глинка",
  lastNameVariants: ["glinka"],
  firstNames: ["Сергей", "sergey"],
  patronymics: ["Михайлович"],
  aliases: ["Глинка Сергей Михайлович"],
  strongIdentifiers: ["773800015809"],
  contextIdentifiers: ["бизнесмен"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

describe("ledger: материал вне области получает названную причину", () => {
  it("EXCLUDE_OUT_OF_SCOPE проставляется с причиной и не считается молчаливой потерей", () => {
    const items = [
      item({
        title: "Глинка Сергей Михайлович, бизнесмен — интервью",
        rawMetadata: { surface: "organic", engine: "YANDEX", rank: 3 },
      }),
      item({
        title: "Глинка Сергей Михайлович, бизнесмен — старая заметка",
        sourceUrl: "https://news.example/deep",
        rawMetadata: { surface: "organic", engine: "YANDEX", rank: 44 },
      }),
    ];
    const scope = resolveAnalysisScope(items);
    const resolution = buildSubjectResolution({
      caseId: CASE,
      datasetId: `ds-${CASE}`,
      subject: SUBJECT,
      items,
      sourceHashes: ["sha256:test"],
    });
    const byRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));
    const synthesis = synthesizeFindings({
      caseId: CASE,
      datasetId: `ds-${CASE}`,
      items: scope.inScope,
      resolutionByRef: byRef,
      sourceHashes: ["sha256:test"],
    });
    const ledger = buildObservationDispositionLedger({
      caseId: CASE,
      datasetId: `ds-${CASE}`,
      inventoryReportRunId: "base-run-1",
      sourceHashes: ["sha256:test"],
      items,
      resolutionByRef: byRef,
      synthesis,
      outOfScopeByRef: new Map(scope.outOfScope.map((d) => [d.evidenceRef, String(d.reason)])),
    });

    const deep = ledger.entries.find((e) => e.rawObservationId.endsWith(items[1]!.inventoryId));
    expect(deep?.disposition).toBe("EXCLUDE_OUT_OF_SCOPE");
    expect(deep?.reasonCode).toBe("analysis_scope:below_top_n");
    expect(deep?.decidedBy.stage).toBe("analysis-scope");
    expect(deep?.decidedBy.functionName).toBe("resolveAnalysisScope");

    // Каждый материал учтён и ни один не выброшен без причины.
    expect(ledger.gates.RAW_OBSERVATION_ACCOUNTING).toBe(100);
    expect(ledger.gates.UNREASONED_DROPS).toBe(0);
    expect(() => assertDispositionGatesPass(ledger)).not.toThrow();
  });
});
