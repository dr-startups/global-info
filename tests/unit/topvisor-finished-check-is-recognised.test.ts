/**
 * Проверка Topvisor, закончившаяся, пока никто не смотрел, узнаётся по снимку.
 *
 * Прогон DPA-2026-0054 (11.09.2026): проверка позиций завершилась в первые
 * минуты, пока прогон лежал на ошибке PAA. Вернувшись, тик увидел
 * `status_positions: 0`, `status_positions_percent: 0`, дату проверки — свою,
 * а снимки за дату уже лежали во всех трёх регионах. Но завершение он узнавал
 * только по `status_positions_percent >= 100`, который после завершения
 * обнуляется, — и ждал 47 минут до исчерпания бюджета.
 *
 * Завершение проверки — это снимок за дату проверки (данные), а процент —
 * мгновенный статус. Снимков нет — проверка ещё в очереди, ждём как прежде и
 * второй раз её не заказываем.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TopvisorCallFn, TopvisorCallInput } from "@/modules/digital-profile/providers/topvisor/client";
import { createMemoryTopvisorTaskStore } from "@/modules/digital-profile/providers/topvisor/task-store";
import { createTopvisorFixtureCall, PILOT_KEYWORDS } from "@/modules/digital-profile/providers/topvisor/fixtures/fixture-call";
import { runTopvisorPositionsTick } from "@/modules/digital-profile/services/topvisor-positions-tick";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";

const ENV = {
  SERP_COLLECTION_PROVIDER: "topvisor",
  TOPVISOR_API_KEY: "k",
  TOPVISOR_USER_ID: "100001",
} as Record<string, string | undefined>;

/** День фикстур пилота: снимки датированы 2026-09-03. */
const NOW = () => new Date("2026-09-03T10:00:00.000Z");

/** Статус, наблюдённый на прогоне 0054: проверка не идёт, процент обнулён, дата — наша. */
const IDLE_TODAY = {
  result: [{ id: 32742967, status_positions: 0, status_positions_percent: 0, status_positions_date: "2026-09-03" }],
  total: 1,
};

function job(state: UnifiedCollectionJob["topvisorEnrichmentState"] = null): UnifiedCollectionJob {
  return { caseId: "pilot-2026-09-03", unifiedJobId: "job-1", topvisorEnrichmentState: state } as unknown as UnifiedCollectionJob;
}

function routeKey(input: TopvisorCallInput): string {
  return [input.action, input.service, input.method].filter(Boolean).join("/");
}

/** Фикстурный вызов, у которого статус проверки и (по желанию) снимки подменены. */
function callWith(options: { status: unknown; snapshots?: unknown }) {
  const base = createTopvisorFixtureCall({ projectExists: true });
  const keys: string[] = [];
  const call = (async (input: TopvisorCallInput) => {
    const key = routeKey(input);
    keys.push(key);
    const fields = Array.isArray(input.payload?.fields) ? (input.payload.fields as string[]) : [];
    if (key === "get/projects_2/projects" && fields.includes("status_positions")) {
      return { ok: true, httpStatus: 200, body: options.status, errors: [] };
    }
    if (options.snapshots !== undefined && key === "get/snapshots_2/history") {
      return { ok: true, httpStatus: 200, body: options.snapshots, errors: [] };
    }
    return base.call(input);
  }) as TopvisorCallFn;
  return { call, keys };
}

async function drive(call: TopvisorCallFn, turns: number) {
  const taskStore = createMemoryTopvisorTaskStore();
  const outs = [];
  let out = await runTopvisorPositionsTick({ job: job(), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV, now: NOW });
  outs.push(out);
  for (let i = 1; i < turns; i += 1) {
    if (out.state.phase === "DONE" || out.blockPipeline) break;
    out = await runTopvisorPositionsTick({ job: job(out.state), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV, now: NOW });
    outs.push(out);
  }
  return outs;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("проверка Topvisor, закончившаяся без наблюдателя", () => {
  it("узнаётся по снимку за дату проверки и читается", async () => {
    const { call, keys } = callWith({ status: IDLE_TODAY });
    const outs = await drive(call, 6);
    const last = outs[outs.length - 1]!;
    expect(last.state.phase, JSON.stringify(last.state)).not.toBe("CHECKING");
    expect(outs.some((o) => o.observations.length > 0)).toBe(true);
    expect(outs.flatMap((o) => o.warnings).join(" ")).toContain("topvisor-check-finished-while-away");
    // Платный запуск — один, второй раз проверку не заказывали.
    expect(keys.filter((k) => k === "edit/positions_2/checker/go")).toHaveLength(1);
  });

  it("без снимка за дату — проверка ещё в очереди: ждём, второй раз не заказываем", async () => {
    const { call, keys } = callWith({ status: IDLE_TODAY, snapshots: { result: { keywords: [], existsDates: [] } } });
    const outs = await drive(call, 4);
    const last = outs[outs.length - 1]!;
    expect(last.state.phase).toBe("CHECKING");
    expect(last.waiting).toBe(true);
    expect(last.blockPipeline).toBe(false);
    expect(keys.filter((k) => k === "edit/positions_2/checker/go")).toHaveLength(1);
  });

  it("проверка, дошедшая до 100 % на глазах, читается как прежде", async () => {
    const base = createTopvisorFixtureCall({ projectExists: true, checkPollsUntilDone: 1 });
    const outs = await drive(base.call, 6);
    expect(outs[outs.length - 1]!.state.phase).not.toBe("CHECKING");
    expect(outs.some((o) => o.observations.length > 0)).toBe(true);
  });
});
