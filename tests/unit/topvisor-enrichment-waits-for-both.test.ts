/**
 * Шаг обогащения ждёт обоих провайдеров.
 *
 * Arsenkin завершён, Topvisor ещё проверяет — шаг остаётся в ожидании, а не
 * уходит к слиянию с половиной выдачи. Рост процента проверки Topvisor —
 * продвижение для бюджета ожидания, а не простой Arsenkin.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runUnifiedCollectionTick,
  startUnifiedOrionCollection,
} from "@/modules/digital-profile/services/unified-orion-collection-orchestrator";
import {
  deleteUnifiedCollectionJobForTests,
  loadUnifiedCollectionJob,
  readUnifiedArtifact,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import { ARSENKIN_REAL_AGENT_NAMES } from "@/modules/digital-profile/agents/real/real-arsenkin-agents";
import { decideEnrichmentPoll, markEnrichmentProgress } from "@/modules/digital-profile/services/arsenkin-poll-budget";
import { emptyArsenkinEnrichmentState } from "@/modules/digital-profile/services/arsenkin-enrichment-state";
import { createMemoryTopvisorTaskStore } from "@/modules/digital-profile/providers/topvisor/task-store";
import { createTopvisorFixtureCall, PILOT_KEYWORDS } from "../support/topvisor-fixture-call";

const CASE_ID = "unified-topvisor-waits-1";

const fixtureBaseRows = [
  {
    key: "organic|ru|yandex|fio|https://a.example",
    kind: "organic" as const,
    region: "RU",
    engine: "YANDEX",
    query: "fio",
    url: "https://a.example",
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: ["searchResult:sr1"],
    baseSearchResultId: "sr1",
  },
];

// Состояние ворот персоны подставляется явно: у теста нет ни строки `Case`,
// ни базы — форма та же, что в офлайн-смоке.
const personaDecided = {
  loadPersonaGateInput: async () => ({
    isFixture: false,
    subjectInputHash: "topvisor-waits-subject",
    decidedHashes: ["topvisor-waits-subject"],
  }),
};

/**
 * Итог базового сбора в режиме `topvisor`: базовые агенты выдачи выключены
 * составом (`skipped`), профиль ORION собран. Форма — та же, что у офлайн-смока.
 */
function baseAuditTopvisorMode() {
  return async () =>
    ({
      outcome: "SUCCESS",
      runs: [],
      runSummary: [
        { providerId: "yandex", phase: "collection", status: "skipped", runtime: "none", reason: "collected by Topvisor" },
        { providerId: "google", phase: "collection", status: "skipped", runtime: "none", reason: "collected by Topvisor" },
        {
          providerId: "orion_profile",
          phase: "collection",
          status: "completed",
          runtime: "real",
          agentName: "REAL_ORION_SEARCH_PROFILE",
          reason: "ok",
        },
      ],
      runtimeStrategy: {
        mode: "real_first_with_fallback",
        selectedOrder: [],
        fallbackPolicy: "allow_mock_fallback",
        realProvidersAvailable: 1,
        mockProvidersAvailable: 0,
        fallbackEvents: [],
        warnings: [],
        decisions: [],
      },
    }) as never;
}

function arsenkinComplete() {
  return async () => ({
    arsenkinReportRunId: "arsenkin-enrich-1",
    enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n, i) => `arsenkin-enrich-${i + 1}`),
    observations: [],
    warnings: [],
    partial: false,
    enrichmentComplete: true,
  });
}

beforeEach(async () => {
  // Хранилище прогонов — файловое, как у офлайн-смока: базы у теста нет.
  vi.stubEnv("UNIFIED_COLLECTION_JOB_STORE", "file");
  vi.stubEnv("NETWORK_CALLS", "0");
  vi.stubEnv("SERP_COLLECTION_PROVIDER", "topvisor");
  vi.stubEnv("TOPVISOR_API_KEY", "k");
  vi.stubEnv("TOPVISOR_USER_ID", "100001");
  await deleteUnifiedCollectionJobForTests(CASE_ID);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("обогащение в режиме topvisor", () => {
  it("Arsenkin готов, Topvisor ещё нет — шаг ждёт; готов — идёт дальше со строками обоих", async () => {
    const { call } = createTopvisorFixtureCall({ projectExists: true, checkPollsUntilDone: 1 });
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows,
      runFullAudit: baseAuditTopvisorMode(),
      runArsenkinEnrichment: arsenkinComplete(),
      topvisorCall: call,
      topvisorTaskStore: createMemoryTopvisorTaskStore(),
      topvisorKeywords: PILOT_KEYWORDS,
      runPrepare: async ({ binding }: { binding: { compositeDatasetId: string } }) => ({
        prepareDatasetId: binding.compositeDatasetId,
        pdf: "/tmp/demo.pdf",
      }),
      ...personaDecided,
    };
    await startUnifiedOrionCollection({ caseId: CASE_ID, requestedBy: "test", deps });

    // Базовый сбор → первый оборот обогащения: проверка запущена, ждём.
    let job = await runUnifiedCollectionTick(CASE_ID, deps);
    for (let i = 0; i < 3 && job && !job.topvisorEnrichmentState; i += 1) {
      job = await runUnifiedCollectionTick(CASE_ID, deps);
    }
    expect(job?.stage).toBe("ARSENKIN_ENRICHMENT");
    expect(job?.status).toBe("WAITING");
    expect(job?.topvisorEnrichmentState?.phase).toBe("CHECKING");
    expect(job?.arsenkinEnrichmentState?.enrichmentComplete).toBe(true);

    // Первый опрос статуса — 0 %: всё ещё ждём.
    job = await runUnifiedCollectionTick(CASE_ID, { ...deps, now: () => new Date(Date.now() + 60_000) });
    expect(job?.stage).toBe("ARSENKIN_ENRICHMENT");
    expect(job?.topvisorEnrichmentState?.phase).toBe("CHECKING");

    // Второй опрос — 100 %: приём, шаг уходит дальше.
    job = await runUnifiedCollectionTick(CASE_ID, { ...deps, now: () => new Date(Date.now() + 120_000) });
    expect(job?.topvisorEnrichmentState?.phase).toBe("DONE");
    expect(["COMPOSITE_MERGE", "ORION_PREPARE", "CLIENT_CONTENT", "REPORT_READY", "COMPLETED_PARTIAL"]).toContain(
      job?.stage
    );

    const artifact = await readUnifiedArtifact<{ observations: Array<{ provider?: string }> }>(
      CASE_ID,
      job!.unifiedJobId,
      "arsenkin-enrichment-observations.json"
    );
    const providers = new Set((artifact?.observations ?? []).map((o) => o.provider));
    expect(providers.has("topvisor-yandex")).toBe(true);
    expect(providers.has("topvisor-google")).toBe(true);

    const final = await loadUnifiedCollectionJob(CASE_ID);
    expect(final?.lastErrorCode ?? null).toBeNull();
  });

  it("набор запросов не прочитался из базы — отказ шага с кодом, а не падение тика", async () => {
    /*
     * Без подстановки набора тик читает `dp_search_queries`. Сбой чтения —
     * названный отказ `TOPVISOR_KEYWORDS_UNAVAILABLE`, который видно оператору
     * и который повторяется кнопкой, а не `UNIFIED_TICK_FAILED` из необработанного
     * исключения.
     */
    const { call } = createTopvisorFixtureCall({ projectExists: true });
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows,
      runFullAudit: baseAuditTopvisorMode(),
      runArsenkinEnrichment: arsenkinComplete(),
      topvisorCall: call,
      topvisorTaskStore: createMemoryTopvisorTaskStore(),
      // Загрузчик набора — то, что отказывает на живом пути (чтение базы).
      topvisorKeywords: async () => {
        throw new Error("relation dp_search_queries does not exist");
      },
      ...personaDecided,
    };
    await startUnifiedOrionCollection({ caseId: CASE_ID, requestedBy: "test", deps });
    let job = await runUnifiedCollectionTick(CASE_ID, deps);
    for (let i = 0; i < 3 && job && job.stage === "ARSENKIN_ENRICHMENT" && job.status === "RUNNING"; i += 1) {
      job = await runUnifiedCollectionTick(CASE_ID, deps);
    }
    expect(job?.lastErrorCode).toBe("TOPVISOR_KEYWORDS_UNAVAILABLE");
    expect(String(job?.lastError)).toContain("dp_search_queries");
  });

  it("рост процента проверки Topvisor — продвижение, а не простой", () => {
    const state = emptyArsenkinEnrichmentState({ caseId: "c", unifiedJobId: "j" });
    const before = markEnrichmentProgress(state, { topvisorPercent: 10 });
    const after = markEnrichmentProgress(state, { topvisorPercent: 40 });

    const decision = decideEnrichmentPoll({
      previous: before,
      current: after,
      idlePolls: 39,
      waitStartedAt: new Date().toISOString(),
      now: new Date(),
    });
    expect(decision.kind).toBe("wait");
    expect((decision as { advanced: boolean }).advanced).toBe(true);
    expect((decision as { idlePolls: number }).idlePolls).toBe(0);
  });
});
