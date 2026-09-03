/**
 * Строки Topvisor в слиянии: провайдер — из наблюдения, имя несёт движок.
 *
 * `rankInOneScale` и `rankSourceBelongsToEngine` узнают движок подстрокой
 * `yandex`/`google` в имени провайдера — потому строки называются
 * `topvisor-yandex`/`topvisor-google`, и позиционные таблицы берут их номера
 * без правки этих двух мест. Базовый провайдер, если он есть (режим legacy
 * при случайно живых задачах), остаётся первичным — сторож на смешение режимов.
 */

import { describe, expect, it } from "vitest";
import { mergeCompositeSerp, rankInOneScale } from "@/modules/digital-profile/services/composite-serp-merge";
import { rankSourceBelongsToEngine } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { BaseCollectionManifest } from "@/modules/digital-profile/services/unified-collection-types";

const manifest: BaseCollectionManifest = {
  version: "base-collection-manifest-v1",
  unifiedJobId: "job-1",
  caseId: "case-1",
  capturedAt: "2026-09-03T00:00:00.000Z",
  baseReportRunId: "base-1",
  searchResultIds: [],
  searchSurfaceItemIds: [],
  baseCount: 0,
  actualProviders: [],
  realCollectionSufficient: true,
};

const topvisorRows = [
  {
    kind: "organic" as const,
    surface: "organic",
    region: "RU",
    engine: "YANDEX",
    query: "Кремлёв Умар Назарович",
    url: "https://en.wikipedia.org/wiki/Umar_Kremlev",
    title: "Umar Kremlev - Wikipedia",
    rank: 3,
    provider: "topvisor-yandex",
    providerTaskId: "pt-tv",
  },
  {
    kind: "organic" as const,
    surface: "organic",
    region: "UAE",
    engine: "GOOGLE",
    query: "Umar Kremlev",
    url: "https://www.iba.sport/",
    title: "IBA",
    rank: 5,
    provider: "topvisor-google",
    providerTaskId: "pt-tv",
  },
];

describe("слияние строк Topvisor", () => {
  it("провайдер строки — из наблюдения, номер — его", async () => {
    const merge = await mergeCompositeSerp({
      manifest,
      fixtureBaseRows: [],
      arsenkinObservations: topvisorRows,
      enrichmentRunIds: ["topvisor-positions-job-1"],
    });

    const yandex = merge.observations.find((o) => o.engine === "YANDEX");
    const google = merge.observations.find((o) => o.engine === "GOOGLE");
    expect(yandex?.providers).toEqual(["topvisor-yandex"]);
    expect(yandex?.primaryProvider).toBe("topvisor-yandex");
    expect(yandex?.rank).toBe(3);
    expect(yandex?.rankSource).toBe("topvisor-yandex");
    expect(google?.rank).toBe(5);
    expect(google?.rankSource).toBe("topvisor-google");
    expect(google?.region).toBe("UAE");
    expect(merge.providerCounts.topvisor).toBe(2);
    expect(merge.providerCounts.arsenkin).toBe(0);
    expect(merge.provenance.enrichmentProviders).toEqual(
      expect.arrayContaining(["topvisor-yandex", "topvisor-google"])
    );
    expect(merge.provenance.enrichmentProviders).not.toContain("arsenkin");
  });

  it("номер Topvisor принадлежит своему движку и никакому другому", () => {
    expect(rankSourceBelongsToEngine("topvisor-google", "GOOGLE")).toBe(true);
    expect(rankSourceBelongsToEngine("topvisor-google", "YANDEX")).toBe(false);
    expect(rankSourceBelongsToEngine("topvisor-yandex", "YANDEX")).toBe(true);
    expect(rankInOneScale({ ranksByProvider: { "topvisor-google": 4 } })).toEqual({
      rank: 4,
      source: "topvisor-google",
    });
  });

  it("базовый провайдер остаётся первичным, если он есть", async () => {
    const merge = await mergeCompositeSerp({
      manifest: { ...manifest, baseCount: 1, searchResultIds: ["sr1"] },
      fixtureBaseRows: [
        {
          key: "organic|ru|yandex|кремлёв умар назарович|https://en.wikipedia.org/wiki/umar_kremlev",
          kind: "organic",
          region: "RU",
          engine: "YANDEX",
          query: "Кремлёв Умар Назарович",
          url: "https://en.wikipedia.org/wiki/Umar_Kremlev",
          rank: 7,
          providers: ["yandex"],
          primaryProvider: "yandex",
          evidenceRefs: ["searchResult:sr1"],
          baseSearchResultId: "sr1",
        },
      ],
      arsenkinObservations: [topvisorRows[0]!],
    });

    const row = merge.observations.find((o) => o.engine === "YANDEX");
    expect(row?.providers).toEqual(expect.arrayContaining(["yandex", "topvisor-yandex"]));
    expect(row?.primaryProvider).toBe("yandex");
    expect(row?.rank).toBe(7);
    expect(row?.rankSource).toBe("yandex");
  });
});
