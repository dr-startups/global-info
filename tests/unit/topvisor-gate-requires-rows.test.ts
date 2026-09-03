/**
 * Ворота готовности данных судят по данным прогона, а не по режиму машины.
 *
 * Есть состояние Topvisor — значит, выдачу собирал он, и без его строк отчёт
 * рисовать нельзя: таблицы выдачи вышли бы пустыми при зелёном прогоне.
 * Прогон без состояния Topvisor (legacy) ворота не трогают.
 */

import { describe, expect, it } from "vitest";
import { assertPreRenderDataGates } from "@/modules/digital-profile/services/pre-render-data-gates";
import type { CompositeMergeResult } from "@/modules/digital-profile/services/composite-serp-merge";
import type { TopvisorEnrichmentState } from "@/modules/digital-profile/services/topvisor-positions-tick";

function merge(providers: string[][]): CompositeMergeResult {
  return {
    compositeDatasetId: "cd-1",
    observations: providers.map((p, i) => ({
      key: `organic|ru|yandex|q|https://x${i}.example`,
      kind: "organic",
      providers: p,
      primaryProvider: p[0]!,
      evidenceRefs: [],
    })),
    providerCounts: { yandex: 0, serper: 0, arsenkin: 0, composite: providers.length },
    baseCount: 0,
    compositeCount: providers.length,
    provenance: {
      unifiedJobId: "job-1",
      baseProviders: ["orion_profile"],
      enrichmentProviders: [],
      baseSearchResultIds: [],
      baseSearchSurfaceItemIds: [],
      enrichmentRunIds: [],
    },
  };
}

function topvisorState(phase: TopvisorEnrichmentState["phase"]): TopvisorEnrichmentState {
  return {
    version: "topvisor-enrichment-state-v1",
    phase,
    projectId: 32742967,
    reportRunId: "topvisor-positions-job-1",
    providerTaskId: "pt-1",
    externalTaskId: "32742967:2026-09-03",
    checkDate: "2026-09-03",
    regions: [],
    keywords: 12,
    lastPercent: 100,
    observationCount: 0,
    aiAnswerCount: 0,
    aiAbsentQueries: [],
    suggest: [],
    suggestionCount: 0,
    errorCode: null,
    errorMessage: null,
    updatedAt: "2026-09-03T00:00:00.000Z",
  };
}

const base = {
  binding: null,
  manifest: null,
  enrichmentState: null,
  realCollectionSufficient: true,
};

describe("ворота готовности и строки Topvisor", () => {
  it("состояние Topvisor есть, строк нет — отказ с названной причиной", () => {
    const gate = assertPreRenderDataGates({ ...base, merge: merge([["yandex"]]), topvisorState: topvisorState("DONE") });
    expect(gate.errors.some((e) => /topvisor/i.test(e) && /строк|rows/i.test(e))).toBe(true);
  });

  it("проверка Topvisor не закончена — отказ", () => {
    const gate = assertPreRenderDataGates({ ...base, merge: merge([["topvisor-yandex"]]), topvisorState: topvisorState("CHECKING") });
    expect(gate.errors.some((e) => /topvisor/i.test(e))).toBe(true);
  });

  it("строки Topvisor есть — по этой части ворота молчат", () => {
    const gate = assertPreRenderDataGates({ ...base, merge: merge([["topvisor-yandex"], ["topvisor-google"]]), topvisorState: topvisorState("DONE") });
    expect(gate.errors.filter((e) => /topvisor/i.test(e))).toEqual([]);
  });

  it("без состояния Topvisor (legacy) требования нет", () => {
    const gate = assertPreRenderDataGates({ ...base, merge: merge([["yandex"]]), topvisorState: null });
    expect(gate.errors.filter((e) => /topvisor/i.test(e))).toEqual([]);
  });
});
