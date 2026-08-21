/**
 * Предупреждения прогона не переживают починку.
 *
 * Пункт AV бэклога: токены ворот телеметрии (`renderer-clip:*`,
 * `renderer-layout:*`) висели в `job.warnings` и в манифесте диагностического
 * бандла вечно — даже когда клипов на новом рендере уже не было. Оператор читал
 * починенный прогон как сломанный.
 *
 * Очевидная правка — дописать префикс в список замены `mergeJobWarnings` —
 * **неверна**: та замена снимает прежние токены семейства при появлении каждого
 * нового, а токенов клипа на прогоне бывает несколько (по одному на страницу),
 * и от семейства осталась бы одна последняя страница. Нужен отдельный
 * механизм: снять семейство целиком до записи новых.
 */

import { describe, expect, it } from "vitest";
import {
  mergeJobWarnings,
  refreshRunWarnings,
  REFRESHED_WARNING_FAMILIES,
} from "@/modules/digital-profile/services/report-quality-summary";
import { warningsSurvivingSuccessfulPrepare } from "@/modules/digital-profile/services/unified-orion-collection-orchestrator";

describe("предупреждения прогона", () => {
  it("токены починенного семейства снимаются, даже если новых нет", () => {
    const previous = [
      "arsenkin-awaiting-ingest",
      "renderer-clip:page=4:TEXT_CLIPPED",
      "renderer-clip:page=7:TEXT_CLIPPED",
      "renderer-layout:page=4:OVERFLOW",
    ];
    // Новый рендер чист: ни одного токена ворот телеметрии.
    expect(refreshRunWarnings(previous, ["empty-state-slides:2"])).toEqual([
      "arsenkin-awaiting-ingest",
      "empty-state-slides:2",
    ]);
  });

  it("несколько токенов одного семейства доезжают все", () => {
    // Клип бывает на нескольких страницах: замена «по одному» оставила бы
    // только последнюю.
    const fresh = ["renderer-clip:page=4:TEXT_CLIPPED", "renderer-clip:page=7:TEXT_CLIPPED"];
    expect(refreshRunWarnings(["renderer-clip:page=1:TEXT_CLIPPED"], fresh)).toEqual(fresh);
  });

  it("чужие предупреждения не трогаются", () => {
    const previous = ["STALE_NO_PROGRESS", "compliance-hits-pending-review:OPEN_SANCTIONS:1"];
    expect(refreshRunWarnings(previous, [])).toEqual(previous);
  });

  it("семейства объявлены списком, а не рассыпаны по условиям", () => {
    expect(REFRESHED_WARNING_FAMILIES).toContain("renderer-clip:");
    expect(REFRESHED_WARNING_FAMILIES).toContain("renderer-layout:");
    expect(REFRESHED_WARNING_FAMILIES).toContain("visual-asset-warning:");
  });

  it("слияние двух свежих источников остаётся слиянием", () => {
    // `mergeJobWarnings` соединяет два источника **одного** прогона: снимать
    // там семейства нельзя — свежие токены ворот приезжают именно первым
    // аргументом.
    expect(
      mergeJobWarnings(["renderer-clip:page=4:TEXT_CLIPPED"], ["empty-state-slides:2"])
    ).toEqual(["renderer-clip:page=4:TEXT_CLIPPED", "empty-state-slides:2"]);
  });

  it("готовый отчёт не несёт токенов ворот прошлой попытки", () => {
    /*
     * Место, где это важно: `warningsSurvivingSuccessfulPrepare` — граница
     * «состояние задания ↔ итог прогона». Пока она звала обычное слияние,
     * клипы прошлой попытки доезжали до готового отчёта и до манифеста
     * диагностического бандла.
     */
    const survived = warningsSurvivingSuccessfulPrepare({
      jobWarnings: [
        "renderer-clip:page=4:TEXT_CLIPPED",
        "renderer-layout:page=4:OVERFLOW",
        "compliance-hits-pending-review:OPEN_SANCTIONS:1",
      ],
      qualityWarnings: ["empty-state-slides:2"],
      enrichmentComplete: true,
      failedAgentCount: 0,
    });
    expect(survived).not.toContain("renderer-clip:page=4:TEXT_CLIPPED");
    expect(survived).not.toContain("renderer-layout:page=4:OVERFLOW");
    expect(survived).toContain("compliance-hits-pending-review:OPEN_SANCTIONS:1");
    expect(survived).toContain("empty-state-slides:2");
  });

  it("клипы нынешнего прогона до отчёта доезжают все", () => {
    const survived = warningsSurvivingSuccessfulPrepare({
      jobWarnings: ["renderer-clip:page=1:TEXT_CLIPPED"],
      qualityWarnings: [
        "renderer-clip:page=4:TEXT_CLIPPED",
        "renderer-clip:page=7:TEXT_CLIPPED",
      ],
      enrichmentComplete: true,
      failedAgentCount: 0,
    });
    expect(survived).toEqual([
      "renderer-clip:page=4:TEXT_CLIPPED",
      "renderer-clip:page=7:TEXT_CLIPPED",
    ]);
  });
});
