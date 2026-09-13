/**
 * Дата проверки Topvisor — по календарю провайдера.
 *
 * QA MVP 14.09.2026: пять прогонов запущены в 22:04–22:13 UTC 13.09. Тик заводил
 * дату проверки как календарный день UTC (`2026-09-13`), а Topvisor ведёт
 * календарь по Москве и поставил проверку на `2026-09-14`. Проверки завершились
 * за минуты, но тик ждал проверку «за 13.09»: сверка дат не совпадала, снимки
 * читались за 13.09 и были пусты, прогоны стояли до исчерпания бюджета.
 *
 * Дата новой проверки считается в календаре провайдера, а его отчёт о проверке
 * более поздней датой принимается как факт: наш расчёт — догадка.
 */

import { describe, expect, it } from "vitest";
import type { TopvisorCallFn, TopvisorCallInput } from "@/modules/digital-profile/providers/topvisor/client";
import { createMemoryTopvisorTaskStore } from "@/modules/digital-profile/providers/topvisor/task-store";
import { createTopvisorFixtureCall, PILOT_KEYWORDS } from "@/modules/digital-profile/providers/topvisor/fixtures/fixture-call";
import { topvisorCalendarDate } from "@/modules/digital-profile/providers/topvisor/adapters/positions";
import { runTopvisorPositionsTick } from "@/modules/digital-profile/services/topvisor-positions-tick";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";

const ENV = { SERP_COLLECTION_PROVIDER: "topvisor", TOPVISOR_API_KEY: "k", TOPVISOR_USER_ID: "100001" } as Record<string, string | undefined>;

function job(state: UnifiedCollectionJob["topvisorEnrichmentState"] = null): UnifiedCollectionJob {
  return { caseId: "pilot-2026-09-03", unifiedJobId: "job-1", topvisorEnrichmentState: state } as unknown as UnifiedCollectionJob;
}

/** Снимки за дату по всем трём регионам аудита (индексы 1, 2, 2520). */
function snapshotsFor(date: string) {
  return {
    result: {
      existsDates: [date],
      keywords: [
        {
          name: "тестов сергей",
          snapshotsData: {
            [`${date}:1:1`]: { url: "https://a.example/1", domain: "a.example" },
            [`${date}:1:2`]: { url: "https://b.example/1", domain: "b.example" },
            [`${date}:1:2520`]: { url: "https://c.example/1", domain: "c.example" },
          },
        },
      ],
    },
  };
}

function idleStatus(date: string) {
  return { result: [{ id: 32742967, status_positions: 0, status_positions_percent: 0, status_positions_date: date, positions_percent: 100 }], total: 1 };
}

/** Фикстурный вызов, где статус и снимки задаются по оборотам. */
function callWith(status: () => unknown, snapshots: () => unknown) {
  const base = createTopvisorFixtureCall({ projectExists: true });
  return (async (input: TopvisorCallInput) => {
    const key = [input.action, input.service, input.method].filter(Boolean).join("/");
    const fields = Array.isArray(input.payload?.fields) ? (input.payload.fields as string[]) : [];
    if (key === "get/projects_2/projects" && fields.includes("status_positions")) return { ok: true, httpStatus: 200, body: status(), errors: [] };
    if (key === "get/snapshots_2/history") return { ok: true, httpStatus: 200, body: snapshots(), errors: [] };
    return base.call(input);
  }) as TopvisorCallFn;
}

describe("календарь Topvisor", () => {
  it("вечер по UTC — уже следующий день по Москве", () => {
    expect(topvisorCalendarDate(new Date("2026-09-13T22:30:00.000Z"))).toBe("2026-09-14");
    expect(topvisorCalendarDate(new Date("2026-09-13T12:00:00.000Z"))).toBe("2026-09-13");
    expect(topvisorCalendarDate(new Date("2026-09-13T20:59:59.000Z"))).toBe("2026-09-13");
  });
});

describe("дата проверки, о которой отчитался провайдер", () => {
  it("более поздняя дата принимается: снимки читаются за неё, проверка завершается", async () => {
    const taskStore = createMemoryTopvisorTaskStore();
    // Оборот 1 в полдень по UTC: дата проверки — 2026-09-03 в любом календаре.
    const noon = () => new Date("2026-09-03T12:00:00.000Z");
    let turn = 0;
    const call = callWith(
      () => (turn === 0 ? { result: [{ id: 32742967, status_positions: 2, status_positions_percent: 0, status_positions_date: "2026-09-03" }], total: 1 } : idleStatus("2026-09-04")),
      () => snapshotsFor("2026-09-04")
    );
    const first = await runTopvisorPositionsTick({ job: job(), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV, now: noon });
    expect(first.state.checkDate).toBe("2026-09-03");
    turn = 1;
    const second = await runTopvisorPositionsTick({ job: job(first.state), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV, now: noon });
    expect(second.warnings.join(" ")).toContain("topvisor-check-date-adopted:2026-09-03→2026-09-04");
    expect(second.state.checkDate).toBe("2026-09-04");
    expect(second.state.phase, JSON.stringify(second.state)).not.toBe("CHECKING");
    expect(second.observations.length).toBeGreaterThan(0);
  });

  it("более ранняя дата — прошлая проверка, не принимается", async () => {
    const taskStore = createMemoryTopvisorTaskStore();
    const noon = () => new Date("2026-09-03T12:00:00.000Z");
    let turn = 0;
    const call = callWith(
      () => (turn === 0 ? { result: [{ id: 32742967, status_positions: 2, status_positions_percent: 0, status_positions_date: "2026-09-03" }], total: 1 } : idleStatus("2026-09-02")),
      () => snapshotsFor("2026-09-02")
    );
    const first = await runTopvisorPositionsTick({ job: job(), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV, now: noon });
    turn = 1;
    const second = await runTopvisorPositionsTick({ job: job(first.state), keywords: PILOT_KEYWORDS, call, taskStore, env: ENV, now: noon });
    expect(second.state.checkDate).toBe("2026-09-03");
    expect(second.state.phase).toBe("CHECKING");
    expect(second.waiting).toBe(true);
  });
});
