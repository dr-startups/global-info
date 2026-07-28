/**
 * Слежение страницы за живым прогоном.
 *
 * Наблюдалось на боевом прогоне 28.07: страница открыта, прогон идёт двадцать
 * две минуты, а шапка семнадцать минут подряд показывает снимок первой минуты —
 * «Этап: Базовый сбор», «Arsenkin scheduled 0/5». Слежение заканчивалось через
 * шестьдесят секунд и молчало об этом.
 *
 * Проверяем свойство: пока прогон не закончился — следим; срок следующего
 * вопроса берём у самого прогона.
 */

import { describe, expect, it } from "vitest";
import {
  isUnifiedRunTerminal,
  nextFollowDelayMs,
  shouldFollowUnifiedRun,
  FOLLOW_MIN_DELAY_MS,
  FOLLOW_MAX_DELAY_MS,
} from "../../src/modules/digital-profile/client/unified-run-follow";
import type { UnifiedCollectionJobStatus } from "../../src/modules/digital-profile/client/api";

function job(over: Partial<UnifiedCollectionJobStatus> = {}): UnifiedCollectionJobStatus {
  return {
    jobId: "unified-1",
    unifiedJobId: "unified-1",
    stage: "ARSENKIN_ENRICHMENT",
    status: "WAITING",
    ...over,
  } as UnifiedCollectionJobStatus;
}

describe("когда следить за прогоном", () => {
  it("следим на каждой рабочей стадии, а не только сразу после нажатия", () => {
    for (const stage of [
      "BASE_COLLECTION",
      "ARSENKIN_ENRICHMENT",
      "COMPOSITE_MERGE",
      "ORION_PREPARE",
      "CLIENT_CONTENT",
      "REPORT_PREPARE",
    ]) {
      expect(shouldFollowUnifiedRun(job({ stage }))).toBe(true);
    }
  });

  it("перестаём следить на каждом конечном исходе", () => {
    for (const stage of [
      "REPORT_READY",
      "COMPLETED_PARTIAL",
      "FAILED_TERMINAL",
      "FAILED_RETRYABLE",
      "CANCELLED",
    ]) {
      expect(isUnifiedRunTerminal(job({ stage }))).toBe(true);
      expect(shouldFollowUnifiedRun(job({ stage }))).toBe(false);
    }
    expect(isUnifiedRunTerminal(job({ stage: "ARSENKIN_ENRICHMENT", status: "COMPLETED" }))).toBe(
      true
    );
  });

  it("без прогона следить не за чем", () => {
    expect(shouldFollowUnifiedRun(null)).toBe(false);
    expect(isUnifiedRunTerminal(null)).toBe(false);
  });
});

describe("срок следующего вопроса", () => {
  const now = Date.parse("2026-07-28T10:00:00.000Z");

  it("берётся у самого прогона, а не назначается заранее", () => {
    const delay = nextFollowDelayMs(
      job({ nextPollAt: new Date(now + 8_000).toISOString() }),
      now
    );
    expect(delay).toBe(8_000);
  });

  it("выбирается ближайший из сроков опроса и возврата к работе", () => {
    const delay = nextFollowDelayMs(
      job({
        nextPollAt: new Date(now + 12_000).toISOString(),
        autoResumeAt: new Date(now + 4_000).toISOString(),
      }),
      now
    );
    expect(delay).toBe(4_000);
  });

  it("не спрашивает чаще нижней границы", () => {
    // Прошедший срок — не повод долбить: он значит «уже пора», а не «постоянно».
    expect(nextFollowDelayMs(job({ nextPollAt: new Date(now - 5_000).toISOString() }), now)).toBe(
      FOLLOW_MIN_DELAY_MS
    );
    expect(nextFollowDelayMs(job({ nextPollAt: new Date(now + 100).toISOString() }), now)).toBe(
      FOLLOW_MIN_DELAY_MS
    );
  });

  it("не молчит дольше верхней границы", () => {
    expect(
      nextFollowDelayMs(job({ autoResumeAt: new Date(now + 10 * 60_000).toISOString() }), now)
    ).toBe(FOLLOW_MAX_DELAY_MS);
  });

  it("без сроков спрашивает по нижней границе", () => {
    expect(nextFollowDelayMs(job(), now)).toBe(FOLLOW_MIN_DELAY_MS);
    expect(nextFollowDelayMs(job({ nextPollAt: null, autoResumeAt: null }), now)).toBe(
      FOLLOW_MIN_DELAY_MS
    );
    expect(nextFollowDelayMs(job({ nextPollAt: "не-дата" }), now)).toBe(FOLLOW_MIN_DELAY_MS);
    expect(nextFollowDelayMs(null, now)).toBe(FOLLOW_MIN_DELAY_MS);
  });

  it("двадцатиминутный прогон не превращается в тысячи запросов", () => {
    // Прежний шаг 500 мс дал бы около 2400 запросов на прогон и всё равно ни
    // одной новости раньше срока, названного сервером.
    const runMs = 22 * 60_000;
    const requests = runMs / nextFollowDelayMs(job(), now);
    expect(requests).toBeLessThanOrEqual(runMs / FOLLOW_MIN_DELAY_MS);
    expect(requests).toBeLessThan(1_000);
  });
});
