process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
process.env.NETWORK_CALLS = "0";

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteUnifiedCollectionJobForTests,
  readUnifiedArtifact,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import {
  runUnifiedCollectionTick,
  startUnifiedOrionCollection,
} from "@/modules/digital-profile/services/unified-orion-collection-orchestrator";
import { runCanonicalReportPrepare } from "@/modules/digital-profile/services/canonical-report-prepare";
import { buildCanonicalVisualAssets } from "@/modules/digital-profile/services/canonical-visual-assets";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";
import type { BaseCollectionManifest } from "@/modules/digital-profile/services/unified-collection-types";
import { tinyPrepareInput } from "../fixtures/tiny-canonical-prepare";

/**
 * Сбор нейро-ответа подменён счётчиком.
 *
 * Шпион на `fetch` здесь ничего не докажет: `providerConfig` читает окружение
 * при импорте модуля, поэтому подставленный ключ до провайдера не доходит и
 * вызов гасится доступностью, а не гардом. Считать надо сам запуск сбора — это
 * и есть то, чего в офлайн-контуре быть не должно.
 */
const genAnswerCalls: string[] = [];
vi.mock("@/modules/digital-profile/services/yandex-gen-answer-collection", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    collectYandexGenAnswer: async (input: { caseId: string }) => {
      genAnswerCalls.push(input.caseId);
      return {
        status: "SUCCESS",
        query: "тестов иван",
        errorCode: null,
        message: null,
        attemptedAt: "2026-08-20T00:00:00.000Z",
      };
    },
  };
});

/**
 * Шаг AO. Три звена проводки, без каждого из которых шаг молча ничего не делает
 * (или делает лишнее): офлайн-гард единственного платного вызова, чтение
 * ячеек покрытия на подготовке и предпочтение строки-тела в SVG-панели.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

const CASE_ID = "case-gen-wiring";

const fixtureBaseRows = [
  {
    key: "organic|ru|yandex|q|https://a.example/1",
    kind: "organic" as const,
    surface: "organic",
    region: "RU",
    engine: "YANDEX",
    query: "тестов иван",
    url: "https://a.example/1",
    title: "Материал о субъекте",
    providers: ["yandex"],
    primaryProvider: "yandex",
    evidenceRefs: ["searchResult:sr-1"],
    baseSearchResultId: "sr-1",
  },
];

const mockAudit = {
  runSummary: [
    { providerId: "yandex", agentName: "YANDEX_SEARCH", runtime: "real", status: "completed" },
  ],
} as never;

/**
 * База, которой достаточно шагу базового сбора.
 *
 * Она обязана быть **и в офлайн-случае тоже**: без неё гард срабатывает второй
 * половиной («базы нет»), первая («строки взяты из фикстуры») остаётся мёртвым
 * кодом, и сценарий охраняет не то, что объявляет.
 */
function stubPrisma() {
  const runs: Array<{ id: string; caseId: string; metadataJson: unknown }> = [];
  return {
    searchResult: { findMany: async () => [] },
    searchSurfaceItem: { findMany: async () => [] },
    orionReportRun: {
      findFirst: async () => null,
      findMany: async () => runs,
      create: async ({ data }: { data: { id: string; caseId: string; metadataJson: unknown } }) => {
        runs.push(data);
        return data;
      },
    },
  } as never;
}

async function tickBaseCollection(deps: Record<string, unknown>) {
  genAnswerCalls.length = 0;
  globalThis.fetch = (async () => {
    throw new Error("офлайн-контур в сеть не ходит");
  }) as typeof globalThis.fetch;
  await deleteUnifiedCollectionJobForTests(CASE_ID);
  const started = await startUnifiedOrionCollection({
    caseId: CASE_ID,
    requestedBy: "test",
    // Ворота выбора персоны получают состояние явно: у сценария нет ни строки
    // `Case`, ни базы, и спрашивать её здесь нечего. Предмет проверки — гард
    // единственного платного вызова, а не ворота.
    deps: {
      ...deps,
      loadPersonaGateInput: async () => ({
        isFixture: false,
        subjectInputHash: "gen-answer-wiring-subject",
        decidedHashes: ["gen-answer-wiring-subject"],
      }),
    } as never,
  });
  expect(started.stage).toBe("BASE_COLLECTION");
  const job = await runUnifiedCollectionTick(CASE_ID, deps as never);
  const manifest = await readUnifiedArtifact<BaseCollectionManifest>(
    CASE_ID,
    started.unifiedJobId,
    "base-collection-manifest.json"
  );
  await deleteUnifiedCollectionJobForTests(CASE_ID);
  return { job, manifest };
}

describe("единственный платный вызов шага защищён составом прогона", () => {
  it("фикстурные строки при живой базе нейро-ответ не спрашивают", async () => {
    // База передана намеренно: проверяется ровно половина гарда «строки взяты
    // из фикстуры», а не «базы нет вовсе».
    const { job, manifest } = await tickBaseCollection({
      autoSchedule: false as const,
      prisma: stubPrisma(),
      fixtureBaseRows,
      runFullAudit: async () => mockAudit,
    });
    expect(job?.stage).toBe("ARSENKIN_ENRICHMENT");
    expect(manifest).toBeTruthy();
    expect(JSON.parse(JSON.stringify(manifest))).not.toHaveProperty("yandexGenAnswerProbe");
    expect(genAnswerCalls).toEqual([]);
  });

  it("живой сбор нейро-ответ спрашивает — ровно один раз, и пишет исход", async () => {
    // Зеркало: без него «вызова не было» проходит и на удалённом вызове.
    const { manifest } = await tickBaseCollection({
      autoSchedule: false as const,
      prisma: stubPrisma(),
      runFullAudit: async () => mockAudit,
    });
    expect(genAnswerCalls).toEqual([CASE_ID]);
    expect(manifest?.yandexGenAnswerProbe).toMatchObject({ status: "SUCCESS" });
  });
});

describe("ячейка покрытия из пробы доезжает до provenance", () => {
  it("подготовка отчёта читает манифест базового сбора", async () => {
    const root = mkdtempSync(join(tmpdir(), "gen-answer-wiring-"));
    writeFileSync(
      join(root, "base-collection-manifest.json"),
      JSON.stringify({
        yandexGenAnswerProbe: {
          status: "FAILED",
          query: "тестов иван",
          errorCode: "PROVIDER_TIMEOUT",
          message: "Provider request timed out.",
          attemptedAt: "2026-08-20T00:00:00.000Z",
        },
      }),
      "utf8"
    );
    const res = await runCanonicalReportPrepare(await tinyPrepareInput(root));
    expect(res.ok).toBe(true);
    const provenance = JSON.parse(
      readFileSync(join(root, "analytics", "composite-serp-provenance.json"), "utf8")
    ) as { nonOkCoverageCells: Array<Record<string, unknown>> };
    expect(provenance.nonOkCoverageCells).toContainEqual({
      region: "RU",
      engine: "YANDEX",
      surface: "ai_answers",
      status: "ERROR",
      provider: "yandex",
      errorCode: "PROVIDER_TIMEOUT",
    });
  });

  it("прогон без пробы ячеек нейро-ответа не заводит", async () => {
    const root = mkdtempSync(join(tmpdir(), "gen-answer-wiring-none-"));
    const res = await runCanonicalReportPrepare(await tinyPrepareInput(root));
    expect(res.ok).toBe(true);
    const provenance = JSON.parse(
      readFileSync(join(root, "analytics", "composite-serp-provenance.json"), "utf8")
    ) as { nonOkCoverageCells: Array<{ provider?: string }> };
    expect(provenance.nonOkCoverageCells.filter((c) => c.provider === "yandex")).toEqual([]);
  });
});

describe("панель знаний рисует тело ответа, а не его источник", () => {
  const item = (partial: Partial<RawInventoryItem>): RawInventoryItem =>
    ({
      caseId: "case-1",
      reportRunId: "run-1",
      source: "serp_observation",
      provider: "yandex",
      region: "RU",
      collectedAt: "2026-08-20T00:00:00.000Z",
      evidenceType: "ai_answer",
      rawMetadata: { engine: "YANDEX", surface: "ai_answer" },
      ...partial,
    }) as RawInventoryItem;

  it("сводкой панели становится текст ответа, даже если источник идёт первым", async () => {
    const built = await buildCanonicalVisualAssets({
      subjectName: "Тестов Иван",
      allowImagePreviewNetwork: false,
      items: [
        item({
          inventoryId: "obs-src",
          title: "Профиль предпринимателя",
          snippet: "Описание страницы источника, к ответу поисковика отношения не имеющее.",
          sourceUrl: "https://source.example/a",
        }),
        item({
          inventoryId: "obs-body",
          title: "Нейро-ответ Яндекса (официальный API): Тестов Иван",
          snippet: "Тестов Иван — предприниматель, по данным поисковой системы.",
          sourceUrl: "yandex-gen://answer/abc123",
        }),
      ],
    });
    const panel = built.assets.find((a) => a.kind === "knowledge_panel");
    if (!panel) throw new Error("панель знаний не собралась");
    expect((panel.evidenceRefs as string[])[0]).toBe("inventory:obs-body");
  });
});
