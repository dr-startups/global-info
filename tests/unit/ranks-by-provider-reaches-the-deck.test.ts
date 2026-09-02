/**
 * «Кто какую позицию намерил» доезжает от слияния сбора до деки.
 *
 * Слияние (`composite-serp-merge`) сохраняет оба чтения полем `ranksByProvider`
 * — на прогоне 91 оно есть у 602 органических наблюдений, и у `rutube.ru` там
 * стоит `{"yandex": 15, "arsenkin": 17}`. До деки поле не доезжало, и терялось
 * оно **трижды подряд, всякий раз одинаково** — на списке полей, куда его
 * забыли вписать: в `rawMetadata` строки инвентаря, в `toRow` сборщика набора
 * и в схеме набора. Без него лист не может сказать, чем занят пропущенный
 * номер, и остаётся либо соврать, либо промолчать.
 *
 * Проверка сквозная: свойство «поле доехало» нельзя проверить ни на одном
 * звене по отдельности — ровно потому, что каждое звено выглядит целым.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCanonicalReportPrepare } from "@/modules/digital-profile/services/canonical-report-prepare";
import {
  loadDeckInputsFromAnalyticsDir,
  mergeRanksByProvider,
} from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import { CompositeObservationRowSchema } from "@/modules/digital-profile/orion-golden/contracts/composite-dataset";
import { tinyPrepareInput } from "../fixtures/tiny-canonical-prepare";

describe("схема набора знает поле", () => {
  it("принимает форму, которую кладёт слияние: имя провайдера → номер", () => {
    // Замер на бандле 91: ключи `yandex`/`serper`/`arsenkin`, значения —
    // целые от 1 до 20, пустых словарей нет ни одного.
    const row = {
      observationKey: "k1",
      provider: "yandex",
      providers: ["yandex", "arsenkin"],
      engine: "YANDEX",
      surface: "organic",
      region: "RU",
      evidenceRefs: ["inventory:1"],
      provenanceOwner: "base",
      rank: 15,
      rankSource: "yandex",
      ranksByProvider: { yandex: 15, arsenkin: 17 },
    };
    const parsed = CompositeObservationRowSchema.parse(row);
    expect(parsed.ranksByProvider).toEqual({ yandex: 15, arsenkin: 17 });
  });

  it("наборы без поля разбираются как прежде", () => {
    const parsed = CompositeObservationRowSchema.parse({
      observationKey: "k2",
      provider: "yandex",
      providers: ["yandex"],
      engine: "YANDEX",
      surface: "organic",
      region: "RU",
      evidenceRefs: ["inventory:2"],
      provenanceOwner: "base",
    });
    expect(parsed.ranksByProvider).toBeUndefined();
  });

  it("дробную и нулевую позицию схема не принимает", () => {
    const bad = {
      observationKey: "k3",
      provider: "yandex",
      providers: ["yandex"],
      engine: "YANDEX",
      surface: "organic",
      region: "RU",
      evidenceRefs: ["inventory:3"],
      provenanceOwner: "base",
      ranksByProvider: { yandex: 0 },
    };
    expect(CompositeObservationRowSchema.safeParse(bad).success).toBe(false);
  });
});

describe("поле доезжает до набора, который читает дека", () => {
  it("сквозная подготовка сохраняет ranksByProvider в артефакте аналитики", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ranks-by-provider-"));
    await runCanonicalReportPrepare(await tinyPrepareInput(dir));
    const dataset = JSON.parse(
      readFileSync(join(dir, "analytics", "composite-serp-observations.json"), "utf8")
    ) as { observations: Array<Record<string, unknown>> };
    const organic = dataset.observations.filter((o) => o.surface === "organic" && o.rank);
    expect(organic.length).toBeGreaterThan(0);
    for (const o of organic) {
      // Слияние записывает позицию за её провайдером даже когда провайдер один:
      // без этого материал, впервые увиденный поисковиком и позже дополненный
      // обогатителем, получал бы позицию обогатителя.
      expect(o.ranksByProvider).toBeDefined();
      expect(o.ranksByProvider).toMatchObject({ [String(o.rankSource)]: o.rank });
    }

    /*
     * И доезжает до **индекса доказательств** — звена, которым дека это поле
     * читает. Цепь из пяти звеньев проверялась порознь: сквозной тест
     * доходил до артефакта, юниты построителя клали поле в индекс руками, и
     * посередине оставался разрыв. Снятое четвёртое звено не краснило ничего,
     * а лист молча уходил бы в третью ветку и причину пропуска не называл
     * никогда — ровно тот отказ, который в этой цепи случился трижды подряд.
     */
    const inputs = loadDeckInputsFromAnalyticsDir(join(dir, "analytics"));
    const withRanks = Object.values(inputs.evidenceIndex).filter(
      (e) => e?.ranksByProvider && Object.keys(e.ranksByProvider).length > 0
    );
    expect(withRanks.length).toBeGreaterThan(0);
    for (const e of withRanks) {
      expect(e.ranksByProvider).toMatchObject({ [String(e.rankSource)]: e.rank });
    }
  });

  it("номера одного материала сводятся по измерителям, а не затирают друг друга", () => {
    // Материал приходит несколькими запросами, и у каждого своя пара
    // «измеритель → номер»: берётся лучший номер каждого измерителя — той же
    // линейкой, что и `rank`.
    expect(
      mergeRanksByProvider({ yandex: 15, arsenkin: 17 }, { yandex: 3 })
    ).toEqual({ yandex: 3, arsenkin: 17 });
    // И в обратном развороте: «лучший» и «последний» дают один ответ только
    // тогда, когда лучший пришёл вторым, — на этом примере правило проверяется
    // той стороной, которой оно и ломается.
    expect(mergeRanksByProvider({ yandex: 3 }, { yandex: 15 })).toEqual({ yandex: 3 });
    expect(mergeRanksByProvider(undefined, undefined)).toBeUndefined();
    // Пустой словарь не подделывается: отсутствие поля — признак набора,
    // снятого до проводки, и ветка «занято» на нём исполниться не должна.
    expect(mergeRanksByProvider({}, {})).toBeUndefined();
  });
});
