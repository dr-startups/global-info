/**
 * Пересборка отчёта кнопкой «Golden Prepare» читает базу — или отказывается.
 *
 * Сервисный путь запускал полную подготовку без единого делегата prisma:
 * подтверждение аналитика, итоги скринингов, дополнение Wikipedia и снимков
 * выдачи, аналитические оверрайды и счётчики воронки молча заменялись пустотой,
 * а артефакты перезаписывались этой пустотой поверх правильных. Сценарий из
 * бэклога: аналитик подтвердил совпадение → нажал «Пересобрать» → в деке хит
 * снова «не подтверждён», страницы баз отрицают выполненный скрининг.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CASE_ID = "unit-golden-prepare-service";
const JOB_ID = "unified-golden-prepare-service";

const server = vi.hoisted(() => {
  const delegate = (name: string) => ({ name, findMany: async () => [], count: async () => 0 });
  return {
    available: true,
    client: {
      searchResult: delegate("searchResult"),
      searchSurfaceItem: delegate("searchSurfaceItem"),
      databaseProfile: delegate("databaseProfile"),
      complianceScreeningRun: delegate("complianceScreeningRun"),
      riskFinding: delegate("riskFinding"),
      wikipediaCheck: delegate("wikipediaCheck"),
      serpCapture: delegate("serpCapture"),
    },
  };
});

vi.mock("@/server/prisma/client", () => ({
  get prisma() {
    if (!server.available) throw new Error("prisma client unavailable");
    return server.client;
  },
}));

const prepare = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  qualityWarnings: [] as string[],
}));

vi.mock("@/modules/digital-profile/services/canonical-report-prepare", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runCanonicalReportPrepare: async (input: Record<string, unknown>) => {
    prepare.calls.push(input);
    return {
      ok: true,
      prepareDatasetId: "composite-1",
      analyticsDir: "",
      deckDir: "",
      renderDir: "",
      pageCount: 36,
      assemblyCount: 1,
      renderCount: 1,
      baseSlotCoverage: 36,
      requiredSectionsFailed: [],
      qualityWarnings: prepare.qualityWarnings,
    };
  },
}));

const job = vi.hoisted(() => ({ dir: "" }));

vi.mock(
  "@/modules/digital-profile/services/unified-collection-job-store",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    loadUnifiedCollectionJob: async () => ({
      caseId: "unit-golden-prepare-service",
      unifiedJobId: "unified-golden-prepare-service",
      jobId: "unified-golden-prepare-service",
    }),
    readUnifiedArtifact: async (_caseId: string, _jobId: string, name: string) =>
      name === "report-data-binding.json"
        ? {
            version: "report-data-binding-v1",
            caseId: "unit-golden-prepare-service",
            unifiedJobId: "unified-golden-prepare-service",
            baseReportRunId: "base-1",
            enrichmentRunIds: [],
            compositeDatasetId: "composite-1",
          }
        : { compositeDatasetId: "composite-1", compositeCount: 1, observations: [] },
    unifiedArtifactsDir: () => job.dir,
  })
);

const UI_ROOT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "orion-golden-prepare-ui",
  "cases",
  CASE_ID
);

async function settledRun() {
  const { getOrionGoldenPrepareSummary } = await import(
    "@/modules/digital-profile/services/orion-golden-prepare-service"
  );
  for (let i = 0; i < 400; i += 1) {
    const summary = getOrionGoldenPrepareSummary(CASE_ID);
    if (summary.status !== "running") return summary;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("подготовка не завершилась");
}

/** Артефакт прошлого прогона: по нему видно, тронули диск или нет. */
const PREVIOUS_INVENTORY = { version: "compliance-inventory-v1", count: 1, items: [{ id: "hit-1" }] };

beforeEach(() => {
  prepare.calls.length = 0;
  prepare.qualityWarnings = [];
  server.available = true;
  rmSync(UI_ROOT, { recursive: true, force: true });
  job.dir = mkdtempSync(join(tmpdir(), "golden-prepare-service-"));
  mkdirSync(join(job.dir, "analytics"), { recursive: true });
  writeFileSync(
    join(job.dir, "analytics", "compliance-inventory.json"),
    `${JSON.stringify(PREVIOUS_INVENTORY, null, 2)}\n`,
    "utf8"
  );
});

afterAll(() => {
  rmSync(UI_ROOT, { recursive: true, force: true });
});

describe("пересборка отчёта из интерфейса", () => {
  it("передаёт подготовке все делегаты базы, а не запускает её вслепую", async () => {
    const { enqueueOrionGoldenPrepare } = await import(
      "@/modules/digital-profile/services/orion-golden-prepare-service"
    );

    await enqueueOrionGoldenPrepare(CASE_ID, JOB_ID);
    const summary = await settledRun();

    expect(summary.status).toBe("completed");
    expect(prepare.calls).toHaveLength(1);
    const passed = prepare.calls[0]!.prisma as Record<string, unknown> | null | undefined;
    expect(passed).toBeTruthy();
    for (const name of [
      "searchResult",
      "searchSurfaceItem",
      "databaseProfile",
      "complianceScreeningRun",
      "riskFinding",
      "wikipediaCheck",
      "serpCapture",
    ] as const) {
      expect(passed![name]).toBe(server.client[name]);
    }
  });

  it("предупреждения качества доезжают до записи прогона", async () => {
    prepare.qualityWarnings = ["link-verdicts-lost:schema-mismatch", "empty-state-slides:2"];
    const { enqueueOrionGoldenPrepare } = await import(
      "@/modules/digital-profile/services/orion-golden-prepare-service"
    );

    await enqueueOrionGoldenPrepare(CASE_ID, JOB_ID);
    const summary = await settledRun();

    expect(summary.warnings).toContain("link-verdicts-lost:schema-mismatch");
    expect(summary.warnings).toContain("empty-state-slides:2");
  });

  it("недоступная база останавливает пересборку до первой записи на диск", async () => {
    server.available = false;
    const { enqueueOrionGoldenPrepare } = await import(
      "@/modules/digital-profile/services/orion-golden-prepare-service"
    );

    await enqueueOrionGoldenPrepare(CASE_ID, JOB_ID);
    const summary = await settledRun();

    expect(summary.status).toBe("failed");
    expect(summary.verdict).toBe("PREPARE_DB_UNAVAILABLE");
    // Подготовка не начиналась — значит, артефакты прошлого прогона целы.
    expect(prepare.calls).toHaveLength(0);
    const onDisk = join(job.dir, "analytics", "compliance-inventory.json");
    expect(existsSync(onDisk)).toBe(true);
    expect(JSON.parse(readFileSync(onDisk, "utf8"))).toEqual(PREVIOUS_INVENTORY);
  });
});
