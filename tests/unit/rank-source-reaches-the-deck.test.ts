/**
 * Источник позиции едет данными до самой деки.
 *
 * Позиция выдачи имеет смысл только внутри нумерации одного поисковика, и чья
 * это нумерация, известно ровно один раз — на верхнеуровневом слиянии
 * (`rankInOneScale`). Дальше признак терялся: инвентарь копировал только
 * `rank`, в контракте analytics поля не было вовсе, и в бандле прогона 76
 * `rankSource` отсутствовал у всех 881 строк. Поэтому защита таблицы
 * «позиции только своего движка» была истинна вакуумно — она не отфильтровала
 * ни одной строки ни в одном живом прогоне, и половина таблицы ОАЭ приехала из
 * нумерации обогатителя.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compositeObservationsToInventory } from "@/modules/digital-profile/services/canonical-report-prepare";
import { buildAnalyticsCompositeDataset } from "@/modules/digital-profile/orion-golden/analytics/composite-dataset-builder";
import { CompositeObservationRowSchema } from "@/modules/digital-profile/orion-golden/contracts/composite-dataset";
import { loadDeckInputsFromAnalyticsDir } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import type { CompositeObservation } from "@/modules/digital-profile/services/composite-serp-merge";

const ANALYTICS_DIR = join(process.cwd(), "baselines/report-72/artifacts/analytics");

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** Верхнеуровневое наблюдение: позиция и её источник уже вычислены слиянием. */
function observation(partial: Partial<CompositeObservation>): CompositeObservation {
  return {
    key: "viktor rashnikov|GOOGLE|UAE|organic|metalinfo.ru",
    kind: "organic",
    surface: "organic",
    region: "UAE",
    engine: "GOOGLE",
    query: "viktor rashnikov",
    url: "https://metalinfo.ru/viktor-rashnikov",
    title: "Виктор Рашников — Metalinfo",
    rank: 4,
    rankSource: "arsenkin",
    queryPurpose: "subject_lookup",
    providers: ["arsenkin"],
    primaryProvider: "arsenkin",
    evidenceRefs: [],
    ...partial,
  } as CompositeObservation;
}

function inventoryOf(obs: CompositeObservation[]) {
  return compositeObservationsToInventory({
    caseId: "case-rank-source",
    baseReportRunId: "run-base",
    enrichmentRunId: null,
    observations: obs,
  });
}

describe("rankSource доезжает от слияния до деки", () => {
  it("инвентарь несёт источник позиции", () => {
    const [item] = inventoryOf([observation({})]);
    expect((item!.rawMetadata as Record<string, unknown>).rankSource).toBe("arsenkin");
  });

  it("строка analytics несёт источник позиции и переживает контракт", () => {
    const built = buildAnalyticsCompositeDataset({
      datasetId: "composite-unified-rank-source",
      caseId: "case-rank-source",
      baseItems: inventoryOf([observation({})]),
      enrichmentItems: [],
      binding: null,
      coverageRows: [],
      baseReportRunId: "run-base",
    });
    const row = built.dataset.observations[0]!;
    expect(row.rankSource).toBe("arsenkin");
    expect(CompositeObservationRowSchema.parse(row).rankSource).toBe("arsenkin");
  });

  it("наблюдение без позиции источника не выдумывает", () => {
    const built = buildAnalyticsCompositeDataset({
      datasetId: "composite-unified-rank-source",
      caseId: "case-rank-source",
      baseItems: inventoryOf([
        observation({ rank: undefined, rankSource: undefined, key: "no-rank|GOOGLE|UAE|organic|x.ru" }),
      ]),
      enrichmentItems: [],
      binding: null,
      coverageRows: [],
      baseReportRunId: "run-base",
    });
    expect(built.dataset.observations[0]!.rankSource).toBeUndefined();
  });

  it("индекс доказательств деки знает, чья это позиция", () => {
    const dir = mkdtempSync(join(tmpdir(), "rank-source-"));
    tempDirs.push(dir);
    cpSync(ANALYTICS_DIR, dir, { recursive: true });
    const observations = JSON.parse(
      readFileSync(join(dir, "composite-serp-observations.json"), "utf8")
    ) as { observations: Array<Record<string, unknown>> };
    observations.observations = [
      {
        observationKey: "viktor rashnikov|GOOGLE|UAE|organic|metalinfo.ru",
        provider: "arsenkin",
        providers: ["arsenkin"],
        engine: "GOOGLE",
        surface: "organic",
        region: "UAE",
        url: "https://metalinfo.ru/viktor-rashnikov",
        title: "Виктор Рашников — Metalinfo",
        domain: "metalinfo.ru",
        rank: 4,
        rankSource: "arsenkin",
        query: "viktor rashnikov",
        queryPurpose: "subject_lookup",
        evidenceRefs: ["inventory:obs-uae-ars-4"],
        provenanceOwner: "enrichment",
      },
    ];
    writeFileSync(
      join(dir, "composite-serp-observations.json"),
      JSON.stringify(observations),
      "utf8"
    );
    const entry = loadDeckInputsFromAnalyticsDir(dir).evidenceIndex["inventory:obs-uae-ars-4"];
    expect(entry?.rank).toBe(4);
    expect(entry?.rankSource).toBe("arsenkin");
  });
});
