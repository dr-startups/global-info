/**
 * Offline acceptance for unified ORION + Arsenkin collection.
 * NETWORK_CALLS=0 — no live Arsenkin / Yandex / Serper.
 *
 * Хранилище прогонов переводится в файловый режим до первого импорта стора:
 * `getUnifiedCollectionJobStoreMode()` читает переменную в момент вызова, но
 * полагаться на порядок вызовов незачем — режим объявляется здесь.
 *
 * Смок назывался офлайновым и при этом писал строку в `dp_unified_collection_jobs`
 * через Prisma. На машине разработчика он проходил за счёт оставшейся базы, а в
 * CI, где Postgres не поднимается вовсе, шаг «офлайн-смоки» пройти не мог.
 * Файловый режим для того и оставлен (см. комментарий в самом сторе).
 */

process.env.UNIFIED_COLLECTION_JOB_STORE = "file";

import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  deleteUnifiedCollectionJobForTests,
  getUnifiedCollectionJobStoreMode,
  loadUnifiedCollectionJob,
  readUnifiedArtifact,
} from "../src/modules/digital-profile/services/unified-collection-job-store";
import {
  startUnifiedOrionCollection,
  runUnifiedCollectionTick,
} from "../src/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { CanonicalPrepareBlockedError } from "../src/modules/digital-profile/services/canonical-report-prepare";
import { assertReportReadyGates } from "../src/modules/digital-profile/services/report-ready-gates";
import { mergeCompositeSerp, buildReportDataBinding } from "../src/modules/digital-profile/services/composite-serp-merge";
import { listAgentDefinitions, getAgent } from "../src/modules/digital-profile/agents/registry";
import { ARSENKIN_REAL_AGENT_NAMES } from "../src/modules/digital-profile/agents/real/real-arsenkin-agents";
import type { FullAuditResultDTO } from "../src/modules/digital-profile/services/agent-run-service";
import type { BaseCollectionManifest } from "../src/modules/digital-profile/services/unified-collection-types";
import { emptyCoverage, FIRST36_PLANNED_SUPPORTED_SURFACES } from "../src/modules/digital-profile/services/unified-collection-types";
import type { CompositeMergeResult } from "../src/modules/digital-profile/services/composite-serp-merge";
import { createMemoryTopvisorTaskStore } from "../src/modules/digital-profile/providers/topvisor/task-store";
import { createTopvisorFixtureCall, PILOT_KEYWORDS } from "../src/modules/digital-profile/providers/topvisor/fixtures/fixture-call";

process.env.NETWORK_CALLS = "0";

const CASE_ID = "unified-smoke-case-1";
const SMOKE_CASE_IDS = [
  CASE_ID,
  "unified-smoke-mock-base",
  "unified-smoke-stale-prepare",
  "unified-smoke-idempotent",
] as const;

function mockFullAuditReal(): FullAuditResultDTO {
  return {
    outcome: "SUCCESS",
    runs: [],
    runSummary: [
      {
        providerId: "yandex",
        phase: "collection",
        status: "completed",
        runtime: "real",
        agentName: "REAL_YANDEX_SEARCH",
        reason: "ok",
      },
      {
        providerId: "google",
        phase: "collection",
        status: "completed",
        runtime: "real",
        agentName: "REAL_GOOGLE_SEARCH",
        reason: "ok",
      },
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
      realProvidersAvailable: 3,
      mockProvidersAvailable: 0,
      fallbackEvents: [],
      warnings: [],
      decisions: [],
    },
  };
}

/** Итог базового сбора в режиме `topvisor`: агенты выдачи выключены составом, профиль собран. */
function mockFullAuditTopvisorMode(): FullAuditResultDTO {
  return {
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
  };
}

function mockFullAuditMockFallback(): FullAuditResultDTO {
  const base = mockFullAuditReal();
  return {
    ...base,
    runSummary: base.runSummary.map((r) =>
      r.providerId === "yandex" || r.providerId === "google" || r.providerId === "orion_profile"
        ? { ...r, runtime: "mock" as const }
        : r
    ),
  };
}

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
  {
    key: "organic|ru|google|fio|https://b.example",
    kind: "organic" as const,
    region: "RU",
    engine: "GOOGLE",
    query: "fio",
    url: "https://b.example",
    providers: ["serper"],
    primaryProvider: "serper",
    evidenceRefs: ["searchResult:sr2"],
    baseSearchResultId: "sr2",
  },
];

/**
 * Состояние ворот выбора персоны подставляется явно.
 *
 * Это не обход ворот: у смока нет ни строки `Case`, ни базы — он работает с
 * файловым хранилищем прогонов, поэтому спросить состояние ему не у кого.
 * Обход по `isFixture` здесь не годится: он сделал бы проверку ворот пустой,
 * а пропуск, выглядящий как pass, — ровно то, чего раннер смоков не допускает.
 */
const DECIDED_SUBJECT_HASH = "unified-smoke-subject";

const personaDecided = {
  loadPersonaGateInput: async () => ({
    isFixture: false,
    subjectInputHash: DECIDED_SUBJECT_HASH,
    decidedHashes: [DECIDED_SUBJECT_HASH],
  }),
};

async function drainJob(caseId: string, deps: Parameters<typeof runUnifiedCollectionTick>[1], max = 20) {
  for (let i = 0; i < max; i++) {
    const job = await runUnifiedCollectionTick(caseId, deps);
    if (!job) break;
    if (
      job.stage === "REPORT_READY" ||
      job.stage === "COMPLETED_PARTIAL" ||
      job.stage === "FAILED_TERMINAL" ||
      job.stage === "CANCELLED"
    ) {
      return job;
    }
  }
  return await loadUnifiedCollectionJob(caseId);
}

describe("unified orion arsenkin collection", () => {
  before(async () => {
    process.env.NETWORK_CALLS = "0";
    // Кейс-заглушка в базе больше не нужна: в файловом режиме прогон лежит
    // в `storage/`, а внешнего ключа на `cases`, ради которого она заводилась,
    // здесь нет.
    await deleteUnifiedCollectionJobForTests(CASE_ID);
  });

  it("NETWORK_CALLS=0", () => {
    assert.equal(process.env.NETWORK_CALLS, "0");
  });

  it("офлайновый смок не ходит в базу: хранилище прогонов файловое", () => {
    // Проверка защищает сам контракт офлайновости. Стоит режиму вернуться в
    // `db`, смок снова начнёт зависеть от Postgres — и это будет видно здесь,
    // а не в CI без базы.
    assert.equal(getUnifiedCollectionJobStoreMode(), "file");
  });

  it("five Arsenkin agents registered as REAL", () => {
    const defs = listAgentDefinitions();
    for (const name of ARSENKIN_REAL_AGENT_NAMES) {
      const d = defs.find((x) => x.name === name);
      assert.ok(d, name);
      assert.equal(d!.kind, "REAL");
      assert.ok(getAgent(name));
    }
  });

  it("agentId isolation: shared SEARCH_SURFACES does not cross-collide in keying logic", () => {
    // Simulate listAgents keying: only input.agentId maps to registry name
    const runs = [
      { agentName: "SEARCH_SURFACES", input: { agentId: "ARSENKIN_SEARCH_TOP_REAL" }, status: "SUCCEEDED" },
      { agentName: "SEARCH_SURFACES", input: { agentId: "ARSENKIN_PAA_REAL" }, status: "FAILED" },
      { agentName: "SEARCH_SURFACES", input: {}, status: "SUCCEEDED" },
    ];
    const latest = new Map<string, (typeof runs)[number]>();
    for (const r of runs) {
      const agentId = (r.input as { agentId?: string }).agentId;
      if (typeof agentId === "string" && agentId.trim()) {
        if (!latest.has(agentId)) latest.set(agentId, r);
        continue;
      }
      if (r.agentName === "SEARCH_SURFACES") continue;
      if (!latest.has(r.agentName)) latest.set(r.agentName, r);
    }
    assert.equal(latest.get("ARSENKIN_SEARCH_TOP_REAL")?.status, "SUCCEEDED");
    assert.equal(latest.get("ARSENKIN_PAA_REAL")?.status, "FAILED");
    assert.equal(latest.has("SEARCH_SURFACES"), false);
  });

  it("composite merge dedupes arsenkin duplicate with base provenance", async () => {
    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: "unified-test",
      caseId: CASE_ID,
      capturedAt: new Date().toISOString(),
      baseReportRunId: "orion-base-1",
      searchResultIds: ["sr1", "sr2"],
      searchSurfaceItemIds: [],
      baseCount: 2,
      actualProviders: [],
      realCollectionSufficient: true,
    };
    const merge = await mergeCompositeSerp({
      manifest,
      fixtureBaseRows,
      arsenkinObservations: [
        {
          kind: "organic",
          region: "RU",
          engine: "YANDEX",
          query: "fio",
          url: "https://a.example",
          providerTaskId: "pt1",
        },
      ],
      enrichmentRunIds: ["arsenkin-1"],
    });
    const row = merge.observations.find((o) => o.url === "https://a.example");
    assert.ok(row);
    assert.ok(row!.providers.includes("yandex"));
    assert.ok(row!.providers.includes("arsenkin"));
    assert.equal(row!.primaryProvider, "yandex");
    assert.ok(merge.compositeCount >= 2);
  });

  it("REPORT_READY gate fails when prepare reads stale base dataset", () => {
    const manifest: BaseCollectionManifest = {
      version: "base-collection-manifest-v1",
      unifiedJobId: "u1",
      caseId: CASE_ID,
      capturedAt: new Date().toISOString(),
      baseReportRunId: "base-1",
      searchResultIds: ["sr1"],
      searchSurfaceItemIds: [],
      baseCount: 1,
      actualProviders: [],
      realCollectionSufficient: true,
    };
    const merge = {
      compositeDatasetId: "composite-u1",
      observations: [],
      providerCounts: { yandex: 1, serper: 0, arsenkin: 0, composite: 1 },
      baseCount: 1,
      compositeCount: 1,
      provenance: {
        unifiedJobId: "u1",
        baseProviders: ["yandex"],
        enrichmentProviders: ["arsenkin"],
        baseSearchResultIds: ["sr1"],
        baseSearchSurfaceItemIds: [],
        enrichmentRunIds: ["a1"],
      },
    };
    const binding = buildReportDataBinding({
      caseId: CASE_ID,
      unifiedJobId: "u1",
      baseReportRunId: "base-1",
      enrichmentRunIds: ["a1"],
      compositeDatasetId: "composite-u1",
      providerCounts: merge.providerCounts,
    });
    const gate = assertReportReadyGates({
      binding,
      manifest,
      merge,
      prepareDatasetId: "stale-base-orion-run",
      realCollectionSufficient: true,
    });
    assert.equal(gate.ok, false);
    assert.match(gate.errors.join(" "), /stale dataset/i);
  });

  it("happy path: real base + arsenkin partial → COMPLETED_PARTIAL or REPORT_READY with artifacts", async () => {
    await deleteUnifiedCollectionJobForTests(CASE_ID);
    const deps = {
      autoSchedule: false as const,
      allowMockReport: false,
      fixtureBaseRows,
      runFullAudit: async () => mockFullAuditReal(),
      runArsenkinEnrichment: async () => ({
        arsenkinReportRunId: "arsenkin-enrich-1",
        enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n, i) => `arsenkin-enrich-${i + 1}`),
        coverage: {
          ...emptyCoverage(FIRST36_PLANNED_SUPPORTED_SURFACES.length),
          measured: 2,
          noResults: 1,
          notSupported: 1,
          failedFinal: 0,
          progressRatio: 4 / 12,
        },
        observations: [
          {
            kind: "organic" as const,
            region: "RU",
            engine: "GOOGLE",
            query: "fio",
            url: "https://new.example",
            providerTaskId: "pt-new",
          },
        ],
        warnings: [],
        partial: false,
        enrichmentComplete: true,
      }),
      runPrepare: async ({ binding }: { binding: { compositeDatasetId: string } }) => ({
        prepareDatasetId: binding.compositeDatasetId,
        pdf: "/tmp/demo.pdf",
      }),
    };
    const started = await startUnifiedOrionCollection({
      caseId: CASE_ID,
      requestedBy: "smoke",
      deps: { ...deps, ...personaDecided },
    });
    assert.equal(started.created, true);
    // Drain synchronously (avoid relying on setImmediate race)
    const job = await drainJob(CASE_ID, deps);
    assert.ok(job);
    assert.ok(
      job!.stage === "REPORT_READY" || job!.stage === "COMPLETED_PARTIAL",
      `stage=${job!.stage} err=${job!.lastError}`
    );
    const manifest = await readUnifiedArtifact<BaseCollectionManifest>(
      CASE_ID,
      job!.unifiedJobId,
      "base-collection-manifest.json"
    );
    assert.ok(manifest);
    assert.ok(manifest!.searchResultIds.includes("sr1"));
    assert.ok(existsSync(join(
      process.cwd(),
      "storage",
      "digital-profile",
      "unified-orion-collection",
      CASE_ID,
      job!.unifiedJobId,
      "report-data-binding.json"
    )));
    const bindingRaw = readFileSync(
      join(
        process.cwd(),
        "storage",
        "digital-profile",
        "unified-orion-collection",
        CASE_ID,
        job!.unifiedJobId,
        "report-data-binding.json"
      ),
      "utf-8"
    );
    assert.match(bindingRaw, /compositeDatasetId/);
  });

  it("mock/fallback base cannot unlock REPORT_READY", async () => {
    const caseId = "unified-smoke-mock-base";
    await deleteUnifiedCollectionJobForTests(caseId);
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows,
      runFullAudit: async () => mockFullAuditMockFallback(),
      runArsenkinEnrichment: async () => ({
        arsenkinReportRunId: null,
        coverage: emptyCoverage(12),
        observations: [],
        warnings: ["skipped"],
        partial: true,
        enrichmentComplete: true,
      }),
      runPrepare: async ({ binding }: { binding: { compositeDatasetId: string } }) => ({
        prepareDatasetId: binding.compositeDatasetId,
      }),
    };
    await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps: { ...deps, ...personaDecided } });
    const job = await drainJob(caseId, deps);
    assert.equal(job?.stage, "FAILED_TERMINAL");
    // Шаг 13, B2: сообщение называет причину вместо «mock/fallback».
    assert.match(
      String(job?.lastError ?? ""),
      /demo data cannot be presented as a real collection|no required search provider/i
    );
  });

  it("stale prepare dataset → fail-closed not REPORT_READY", async () => {
    const caseId = "unified-smoke-stale-prepare";
    await deleteUnifiedCollectionJobForTests(caseId);
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows,
      runFullAudit: async () => mockFullAuditReal(),
      runArsenkinEnrichment: async () => ({
        arsenkinReportRunId: "a1",
        enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n, i) => `a${i + 1}`),
        coverage: { ...emptyCoverage(12), measured: 12, progressRatio: 1 },
        observations: [],
        enrichmentComplete: true,
      }),
      runPrepare: async () => ({
        prepareDatasetId: "old-base-dataset-not-composite",
      }),
    };
    await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps: { ...deps, ...personaDecided } });
    const job = await drainJob(caseId, deps);
    assert.equal(job?.stage, "FAILED_TERMINAL");
    assert.equal(job?.lastErrorCode, "REPORT_READY_GATE_FAILED");
  });

  /*
   * Недоступная база на подготовке — наша авария, а не результат сбора.
   *
   * Собранное цело, платить заново не за что, поэтому прогон возвращается к
   * этому шагу сам. Терминальная ветка здесь была бы дороже отказа: она
   * закрывает джобу и требует человека.
   */
  it("недоступная база на подготовке → возврат к шагу, а не терминал", async () => {
    const caseId = "unified-smoke-db-unavailable";
    await deleteUnifiedCollectionJobForTests(caseId);
    const deps = {
      autoSchedule: false as const,
      fixtureBaseRows,
      runFullAudit: async () => mockFullAuditReal(),
      runArsenkinEnrichment: async () => ({
        arsenkinReportRunId: "a1",
        enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n, i) => `a${i + 1}`),
        coverage: { ...emptyCoverage(12), measured: 12, progressRatio: 1 },
        observations: [],
        enrichmentComplete: true,
      }),
      runPrepare: async () => {
        throw new CanonicalPrepareBlockedError(
          "PREPARE_DB_UNAVAILABLE",
          "prisma client unavailable"
        );
      },
    };
    await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps: { ...deps, ...personaDecided } });
    for (let i = 0; i < 20; i += 1) {
      const ticked = await runUnifiedCollectionTick(caseId, deps);
      if (!ticked || ticked.stage === "FAILED_RETRYABLE" || ticked.stage === "FAILED_TERMINAL") break;
    }
    const job = await loadUnifiedCollectionJob(caseId);
    assert.equal(job?.stage, "FAILED_RETRYABLE");
    assert.equal(job?.lastErrorCode, "PREPARE_DB_UNAVAILABLE");
    // Ссылки прежнего отчёта эта ветка не трогает.
    assert.equal(job?.reportLinks?.pdf ?? null, null);
  });

  it("idempotent start does not create second active job", async () => {
    const caseId = "unified-smoke-idempotent";
    await deleteUnifiedCollectionJobForTests(caseId);
    const holdDeps = {
      autoSchedule: false as const,
      fixtureBaseRows,
      runFullAudit: async () => mockFullAuditReal(),
      runArsenkinEnrichment: async () => ({
        arsenkinReportRunId: "hold-run",
        enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n, i) => `hold-${i + 1}`),
        coverage: emptyCoverage(12),
        observations: [],
        warnings: ["hold"],
        partial: true,
        enrichmentComplete: false,
      }),
    };
    const a = await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps: { ...holdDeps, ...personaDecided } });
    // Drain until WAITING arsenkin ingest — not terminal REPORT_READY
    for (let i = 0; i < 6; i++) {
      const j = await runUnifiedCollectionTick(caseId, holdDeps);
      if (j?.stage === "ARSENKIN_ENRICHMENT" && j.status === "WAITING") break;
    }
    const b = await startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps: { ...holdDeps, ...personaDecided } });
    assert.equal(b.created, false);
    assert.equal(a.unifiedJobId, b.unifiedJobId);
  });

  /*
   * Ворота выбора персоны на живом маршруте старта.
   *
   * Кейс подтеста фикстурным **не** помечается: обход по `isFixture` сделал бы
   * проверку пустой — она прошла бы, ничего не проверив.
   */
  it("без решения по персоне платный прогон не рождается, с решением — стартует", async () => {
    const caseId = "unified-smoke-persona-gate";
    await deleteUnifiedCollectionJobForTests(caseId);
    const deps = { autoSchedule: false as const, fixtureBaseRows };
    const pending = {
      loadPersonaGateInput: async () => ({
        isFixture: false,
        subjectInputHash: DECIDED_SUBJECT_HASH,
        decidedHashes: [] as string[],
      }),
    };

    await assert.rejects(
      () => startUnifiedOrionCollection({ caseId, requestedBy: "smoke", deps: { ...deps, ...pending } }),
      (err: unknown) => {
        const e = err as { code?: string; details?: { reason?: string } };
        assert.equal(e.code, "CONFLICT");
        assert.equal(e.details?.reason, "PERSONA_NOT_CONFIRMED");
        return true;
      }
    );
    assert.equal(await loadUnifiedCollectionJob(caseId), null);

    const started = await startUnifiedOrionCollection({
      caseId,
      requestedBy: "smoke",
      deps: { ...deps, ...personaDecided },
    });
    assert.equal(started.created, true);
    await deleteUnifiedCollectionJobForTests(caseId);
  });

  it("режим topvisor: обе позиционные таблицы собираются из снимков Topvisor, базовые агенты выдачи выключены", async () => {
    /*
     * Критерий готовности T1b (план 0052): офлайн-прогон на фикстурах пилота
     * собирает позиционные таблицы Яндекса и Google из Topvisor, а базовые
     * провайдеры органики не зовутся. Здесь итог базового сбора объявляет их
     * выключенными составом — как делает стратегия в режиме `topvisor`
     * (закреплено тестом «один переключатель»), — а слияние получает строки
     * Topvisor через тот же артефакт обогащения, что и строки Arsenkin.
     */
    const caseId = "unified-smoke-topvisor";
    await deleteUnifiedCollectionJobForTests(caseId);
    const previousEnv = {
      SERP_COLLECTION_PROVIDER: process.env.SERP_COLLECTION_PROVIDER,
      TOPVISOR_API_KEY: process.env.TOPVISOR_API_KEY,
      TOPVISOR_USER_ID: process.env.TOPVISOR_USER_ID,
    };
    process.env.SERP_COLLECTION_PROVIDER = "topvisor";
    process.env.TOPVISOR_API_KEY = "smoke-key";
    process.env.TOPVISOR_USER_ID = "100001";
    try {
      const { call, log } = createTopvisorFixtureCall({ projectExists: true, checkPollsUntilDone: 1 });
      let capturedMerge: CompositeMergeResult | null = null;
      const deps = {
        autoSchedule: false as const,
        allowMockReport: false,
        // Базовые строки здесь — поверхности Serper, которые Topvisor не заменяет.
        fixtureBaseRows,
        runFullAudit: async () => mockFullAuditTopvisorMode(),
        runArsenkinEnrichment: async () => ({
          arsenkinReportRunId: "arsenkin-enrich-tv-1",
          enrichmentRunIds: ARSENKIN_REAL_AGENT_NAMES.map((n, i) => `arsenkin-enrich-tv-${i + 1}`),
          observations: [],
          warnings: [],
          partial: false,
          enrichmentComplete: true,
        }),
        topvisorCall: call,
        topvisorTaskStore: createMemoryTopvisorTaskStore(),
        topvisorKeywords: PILOT_KEYWORDS,
        runPrepare: async ({ binding, merge }: { binding: { compositeDatasetId: string }; merge: CompositeMergeResult }) => {
          capturedMerge = merge;
          return { prepareDatasetId: binding.compositeDatasetId, pdf: "/tmp/demo.pdf" };
        },
      };
      const started = await startUnifiedOrionCollection({
        caseId,
        requestedBy: "smoke",
        deps: { ...deps, ...personaDecided },
      });
      assert.equal(started.created, true);
      const job = await drainJob(caseId, deps);
      assert.ok(job);
      assert.ok(
        job!.stage === "REPORT_READY" || job!.stage === "COMPLETED_PARTIAL",
        `stage=${job!.stage} err=${job!.lastErrorCode}:${job!.lastError}`
      );
      assert.equal(job!.topvisorEnrichmentState?.phase, "DONE");
      // Проверка Topvisor запускалась ровно один раз — платный вызов не дублируется.
      assert.equal(log.filter((e) => e.method === "checker/go").length, 1);

      const merge = capturedMerge as CompositeMergeResult | null;
      assert.ok(merge, "runPrepare не получил слияние");
      const rows = merge!.observations.filter((o) => o.providers.some((p) => /^topvisor-/.test(p)));
      assert.ok(rows.length > 0, "в слиянии нет строк Topvisor");
      // Номер есть у строки выдачи; у AI-ответа места в выдаче нет по существу.
      const organic = rows.filter((o) => o.surface === "organic");
      const tables = [...new Set(organic.map((o) => `${o.region}/${o.engine}`))].sort();
      assert.deepEqual(tables, ["RU/GOOGLE", "RU/YANDEX", "UAE/GOOGLE"]);
      for (const row of organic) {
        assert.equal(typeof row.rank, "number", `строка без номера: ${row.url}`);
        assert.match(String(row.rankSource), /^topvisor-(yandex|google)$/);
        assert.ok(
          (row.engine === "YANDEX" && row.rankSource === "topvisor-yandex") ||
            (row.engine === "GOOGLE" && row.rankSource === "topvisor-google"),
          `чужой номер: ${row.engine} ← ${row.rankSource}`
        );
      }
      assert.ok((merge!.providerCounts.topvisor ?? 0) >= organic.length);
      assert.equal(merge!.providerCounts.arsenkin, 0);

      /*
       * AI-ответы (T2): тело ответа — строка со своим текстом и без публичного
       * адреса, источники — строки с адресами. Дека различает их именно так
       * (`isAnswerBody`/`isSourceRef`), и подпись «чей это ответ» она берёт из
       * провайдера наблюдения.
       */
      const ai = merge!.observations.filter((o) => o.surface === "ai_answer");
      const bodies = ai.filter((o) => !o.url);
      const sources = ai.filter((o) => o.url);
      assert.ok(bodies.length > 0, "в слиянии нет тел AI-ответов");
      assert.ok(sources.length >= bodies.length, "у AI-ответов нет источников");
      for (const b of bodies) {
        assert.ok(String(b.snippet ?? "").length > 0, "тело AI-ответа пустое");
        assert.doesNotMatch(String(b.snippet), /<b>|<u>|<br>/, "в тело ответа просочилась разметка");
        assert.match(String(b.primaryProvider), /^topvisor-(yandex|google)$/);
      }
      for (const src of sources) assert.match(String(src.url), /^https?:\/\//);
      // Алиса и AI Overview приходят одним чтением — оба движка представлены.
      assert.deepEqual(
        [...new Set(bodies.map((b) => b.engine))].sort(),
        ["GOOGLE", "YANDEX"]
      );

      /*
       * Подсказки (T3): собирает их Topvisor, Serper в этом режиме их не даёт.
       * Строка автодополнения несёт исходную фразу запросом и собранную —
       * подсказкой; источник подсказок в прогоне ровно один.
       */
      const suggestions = merge!.observations.filter((o) => o.kind === "suggestion");
      assert.ok(suggestions.length > 0, "в слиянии нет подсказок Topvisor");
      for (const sg of suggestions) {
        assert.match(String(sg.primaryProvider), /^topvisor-(yandex|google)$/);
        assert.ok(String(sg.suggestion ?? "").length > 0, "подсказка без текста");
      }
      assert.equal(
        suggestions.filter((sg) => /serper|arsenkin/i.test(String(sg.primaryProvider))).length,
        0,
        "у подсказок больше одного источника"
      );

      const bindingRaw = readFileSync(
        join(process.cwd(), "storage", "digital-profile", "unified-orion-collection", caseId, job!.unifiedJobId, "report-data-binding.json"),
        "utf-8"
      );
      const binding = JSON.parse(bindingRaw) as { providerCounts: { topvisor?: number } };
      assert.ok((binding.providerCounts.topvisor ?? 0) > 0, "привязка не считает строки Topvisor");
    } finally {
      for (const [k, v] of Object.entries(previousEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await deleteUnifiedCollectionJobForTests(caseId);
    }
  });

  it("coverage breakdown exposes measured/noResults/notSupported/failedFinal", () => {
    const c = {
      plannedSupportedSurfaces: 12,
      measured: 3,
      noResults: 2,
      notSupported: 1,
      failedFinal: 1,
      failedRetryable: 0,
      inFlight: 5,
      progressRatio: 7 / 12,
    };
    assert.equal(c.measured + c.noResults + c.notSupported + c.failedFinal, 7);
    assert.ok(c.progressRatio < 1);
  });
});
