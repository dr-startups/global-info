/**
 * Возрастной останов не выдаётся за первопричину.
 *
 * Сторож закрывал прогон, переписывая `lastError`/`lastErrorCode` на
 * `STALE_NO_PROGRESS`. У владельца это стёрло `CONTENT_DROPPED_BY_RENDERER` —
 * единственное знание о том, **почему** прогон встал и что сбор при этом
 * завершён и оплачен. По коду отказа решают восстановление и интерфейс, поэтому
 * потеря первопричины стоит оператору предложенного выхода.
 *
 * Возраст — следствие, и его место в предупреждениях, а не в коде отказа.
 *
 * Модуль поднимается с подменённым хранилищем прогонов: ни базы, ни файлов.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const claim = vi.fn();
const patch = vi.fn(async (_caseId: string, p: Record<string, unknown>) => ({ ...JOB, ...p }));

vi.mock("@/modules/digital-profile/services/unified-collection-job-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  claimUnifiedJobLease: (...args: unknown[]) => claim(...args),
  releaseUnifiedJobLease: vi.fn(async () => undefined),
  patchUnifiedCollectionJob: (...args: unknown[]) =>
    patch(...(args as [string, Record<string, unknown>])),
}));

/** Кейс, у которого входы пересборки действительно лежат на диске. */
const SEEDED_CASE = `unit-stale-watchdog-${Date.now()}`;

/** Прогон, вставший на воротах рендерера и простоявший ночь. */
const JOB = {
  caseId: SEEDED_CASE,
  unifiedJobId: "u-1",
  stage: "ORION_PREPARE",
  status: "WAITING",
  cancelRequested: false,
  warnings: ["CANONICAL_PREPARE_BLOCKED"],
  startedAt: "2026-08-19T00:00:00.000Z",
  compositeDatasetId: `composite-${SEEDED_CASE}-job`,
  lastError: "прогон остановлен: рендерер выбросил содержимое (стр. 11, 29)",
  lastErrorCode: "CONTENT_DROPPED_BY_RENDERER",
};

async function closeByAge(over: Record<string, unknown> = {}) {
  const { runUnifiedCollectionTick, UNIFIED_RUN_MAX_MS } = await import(
    "@/modules/digital-profile/services/unified-orion-collection-orchestrator"
  );
  claim.mockClear();
  patch.mockClear();
  const job = { ...JOB, ...over };
  claim.mockResolvedValue(job);

  const started = Date.parse(JOB.startedAt);
  await runUnifiedCollectionTick(job.caseId, {
    now: () => new Date(started + UNIFIED_RUN_MAX_MS + 60_000),
  } as never);

  expect(patch).toHaveBeenCalledTimes(1);
  const [, patched] = patch.mock.calls[0] as unknown as [string, Record<string, unknown>];
  return patched;
}

describe("сторож возраста и первопричина", () => {
  /*
   * Сторож спрашивает о годности пересборки те же данные, что и кнопка, —
   * значит, у прогона с целым сбором артефакты обязаны быть на диске. Ссылка на
   * набор без его файлов — отдельный случай, он проверяется своим тестом.
   */
  beforeAll(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    const { seedUnifiedRebuildInputs } = await import("../fixtures/unified-rebuild-inputs");
    const seed = await seedUnifiedRebuildInputs({
      caseId: SEEDED_CASE,
      unifiedJobId: JOB.unifiedJobId,
    });
    JOB.compositeDatasetId = String(seed.compositeDatasetId);
  });

  afterAll(async () => {
    const { unifiedJobDir } = await import(
      "@/modules/digital-profile/services/unified-collection-job-store"
    );
    rmSync(unifiedJobDir(SEEDED_CASE), { recursive: true, force: true });
  });

  it("прежний код отказа переживает возрастной останов", async () => {
    const patched = await closeByAge();

    expect(patched.lastErrorCode).toBe("CONTENT_DROPPED_BY_RENDERER");
    expect(String(patched.lastError)).toContain("рендерер выбросил содержимое");
  });

  it("возрастной останов остаётся в предупреждениях", async () => {
    const patched = await closeByAge();

    expect(patched.warnings).toContain("STALE_NO_PROGRESS");
    expect(patched.stage).toBe("FAILED_TERMINAL");
  });

  it("целый сбор зовут пересобрать, а не собирать заново", async () => {
    // Самый дорогой выход не предлагается там, где данные уже оплачены:
    // составной набор на джобе означает, что слияние состоялось.
    const patched = await closeByAge();

    expect(String(patched.lastError)).toContain("Пересобрать отчёт");
    expect(String(patched.lastError)).not.toContain("Запустите сбор заново");
  });

  it("ссылка на набор без его файлов пересобрать не зовёт", async () => {
    // Совет обязан спрашивать то же, что и кнопка: у джобы бывает ссылка на
    // набор, которого на диске уже нет, — и звать пересобирать там значит
    // обещать кнопку, которой не будет.
    const patched = await closeByAge({ caseId: `no-artifacts-${Date.now()}` });

    expect(String(patched.lastError)).not.toContain("Пересобрать отчёт");
    expect(String(patched.lastError)).toContain("Запустите сбор заново");
  });

  it("без составного набора совет прежний", async () => {
    const patched = await closeByAge({ compositeDatasetId: null });

    expect(String(patched.lastError)).toContain("Запустите сбор заново");
  });

  it("отметка о простое не переживает успешную подготовку", async () => {
    // Она описывает **попытку**, а не прогон: на готовом отчёте жалоба на
    // застой читается как «собрано сломанным».
    const { warningsSurvivingSuccessfulPrepare } = await import(
      "@/modules/digital-profile/services/unified-orion-collection-orchestrator"
    );

    expect(
      warningsSurvivingSuccessfulPrepare({
        jobWarnings: ["STALE_NO_PROGRESS", "иное"],
        qualityWarnings: [],
        enrichmentComplete: true,
        failedAgentCount: 0,
      })
    ).toEqual(["иное"]);
  });

  it("прогон без прежнего отказа закрывается кодом сторожа", async () => {
    const patched = await closeByAge({ lastError: null, lastErrorCode: null });

    expect(patched.lastErrorCode).toBe("STALE_NO_PROGRESS");
  });
});
