/**
 * Идущая проверка Topvisor — не простой.
 *
 * Бюджет простоя считает опросы без продвижения, а продвижение Topvisor — рост
 * процента. Проверка в очереди у сервиса стоит со `status_positions: 2` и 0 %:
 * для бюджета это молчание, и за 40 опросов (20 минут) прогон падал, хотя
 * провайдер прямо сообщал, что работает (прогон DPA-2026-0054, шаг 0074).
 *
 * Пока провайдер сообщает, что проверка идёт или стоит в очереди, опрос не
 * холостой. Предел кладёт общий бюджет ожидания — он остаётся.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_PROGRESS_MARK,
  MAX_ENRICHMENT_WAIT_MS,
  MAX_IDLE_POLLS,
  decideEnrichmentPoll,
  markEnrichmentProgress,
  type EnrichmentProgressMark,
} from "@/modules/digital-profile/services/arsenkin-poll-budget";
import type { TopvisorCallFn, TopvisorCallInput } from "@/modules/digital-profile/providers/topvisor/client";
import { createMemoryTopvisorTaskStore } from "@/modules/digital-profile/providers/topvisor/task-store";
import { createTopvisorFixtureCall, PILOT_KEYWORDS } from "@/modules/digital-profile/providers/topvisor/fixtures/fixture-call";
import { runTopvisorPositionsTick } from "@/modules/digital-profile/services/topvisor-positions-tick";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";

const NOW = new Date("2026-09-11T09:30:00.000Z");
const mark = (over: Partial<EnrichmentProgressMark> = {}): EnrichmentProgressMark => ({
  ...EMPTY_PROGRESS_MARK,
  ...over,
});

describe("бюджет ожидания при идущей проверке Topvisor", () => {
  it("опрос без продвижения, но с идущей проверкой — не холостой", () => {
    const d = decideEnrichmentPoll({
      previous: mark({ topvisorPercent: 0 }),
      current: mark({ topvisorPercent: 0, topvisorCheckInProgress: true }),
      idlePolls: MAX_IDLE_POLLS - 1,
      waitStartedAt: new Date(NOW.getTime() - 25 * 60_000).toISOString(),
      now: NOW,
    });
    expect(d.kind).toBe("wait");
    if (d.kind === "wait") expect(d.idlePolls).toBe(0);
  });

  it("без признака проверки счётчик идёт как прежде и исчерпывается", () => {
    const d = decideEnrichmentPoll({
      previous: mark({ topvisorPercent: 0 }),
      current: mark({ topvisorPercent: 0 }),
      idlePolls: MAX_IDLE_POLLS,
      waitStartedAt: new Date(NOW.getTime() - 25 * 60_000).toISOString(),
      now: NOW,
    });
    expect(d.kind).toBe("exhausted");
  });

  it("общий бюджет ожидания исчерпывается и при идущей проверке", () => {
    const d = decideEnrichmentPoll({
      previous: mark({ topvisorPercent: 0 }),
      current: mark({ topvisorPercent: 0, topvisorCheckInProgress: true }),
      idlePolls: 3,
      waitStartedAt: new Date(NOW.getTime() - MAX_ENRICHMENT_WAIT_MS - 1000).toISOString(),
      now: NOW,
    });
    expect(d.kind).toBe("exhausted");
    if (d.kind === "exhausted") expect(d.retryable).toBe(false);
  });

  it("признак попадает в метку только у прогона с Topvisor", () => {
    expect(markEnrichmentProgress(null, { topvisorPercent: 0, topvisorCheckInProgress: true })).toMatchObject({
      topvisorPercent: 0,
      topvisorCheckInProgress: true,
    });
    expect("topvisorCheckInProgress" in markEnrichmentProgress(null, {})).toBe(false);
  });
});

const ENV = {
  SERP_COLLECTION_PROVIDER: "topvisor",
  TOPVISOR_API_KEY: "k",
  TOPVISOR_USER_ID: "100001",
} as Record<string, string | undefined>;
const TICK_NOW = () => new Date("2026-09-03T10:00:00.000Z");

function job(state: UnifiedCollectionJob["topvisorEnrichmentState"] = null): UnifiedCollectionJob {
  return { caseId: "pilot-2026-09-03", unifiedJobId: "job-1", topvisorEnrichmentState: state } as unknown as UnifiedCollectionJob;
}

function callWithStatus(status: unknown, snapshots?: unknown) {
  const base = createTopvisorFixtureCall({ projectExists: true });
  return (async (input: TopvisorCallInput) => {
    const key = [input.action, input.service, input.method].filter(Boolean).join("/");
    const fields = Array.isArray(input.payload?.fields) ? (input.payload.fields as string[]) : [];
    if (key === "get/projects_2/projects" && fields.includes("status_positions")) {
      return { ok: true, httpStatus: 200, body: status, errors: [] };
    }
    if (snapshots !== undefined && key === "get/snapshots_2/history") {
      return { ok: true, httpStatus: 200, body: snapshots, errors: [] };
    }
    return base.call(input);
  }) as TopvisorCallFn;
}

async function secondTurn(call: TopvisorCallFn) {
  const taskStore = createMemoryTopvisorTaskStore();
  const first = await runTopvisorPositionsTick({ job: job(), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV, now: TICK_NOW });
  return runTopvisorPositionsTick({ job: job(first.state), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV, now: TICK_NOW });
}

describe("тик Topvisor называет идущую проверку", () => {
  it("проверка в очереди у сервиса: статус 2, ноль процентов", async () => {
    const out = await secondTurn(
      callWithStatus({ result: [{ id: 32742967, status_positions: 2, status_positions_percent: 0, status_positions_date: "2026-09-03" }], total: 1 })
    );
    expect(out.waiting).toBe(true);
    expect(out.checkInProgress).toBe(true);
  });

  it("проект не в проверке и снимка нет: признака нет", async () => {
    const out = await secondTurn(
      callWithStatus(
        { result: [{ id: 32742967, status_positions: 0, status_positions_percent: 0, status_positions_date: "2026-09-03" }], total: 1 },
        { result: { keywords: [], existsDates: [] } }
      )
    );
    expect(out.waiting).toBe(true);
    expect(out.checkInProgress).toBe(false);
  });
});
