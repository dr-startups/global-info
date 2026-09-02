/**
 * Отказанная пересборка не будит конвейер шагов.
 *
 * `scheduleRebuild` и `requeueResumeStep` стоят в `finally`, поэтому
 * перепоставляют шаги и тогда, когда работа отказана **после** взятия лизы:
 * повторная проверка годности, пропавший артефакт, любой сбой записи. Ранние
 * отказы (негодность, занятая лиза) брошены до `try` и сюда не доходят —
 * поэтому дефект и не был виден.
 *
 * `requeueStepsForRebuild` ставит строкам `PENDING`, обнуляет `attempts` и
 * **стирает `lastError`/`lastErrorCode`**: отказанная пересборка не просто
 * будит конвейер, она уносит память о том, кто упал. Дальше проснувшийся шаг
 * на терминальной джобе объявляется сделанным, стадия дрейфует в
 * `REPORT_READY`, и кнопки «Возобновить» больше нет — это и был дрейф на
 * прогоне Мордашова 19.08 (пункт BT).
 *
 * Офлайн: файловое хранилище прогонов, конвейер шагов подменён.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";

const spies = vi.hoisted(() => ({
  requeueStepsForRebuild: vi.fn(async (_input: { jobId: string; names: readonly string[] }) => 2),
  requeueStep: vi.fn(async (_input: { jobId: string; name: string }) => true),
  /** Имя артефакта, запись которого должна упасть, — `null` — не падать. */
  failWrite: null as string | null,
  /** Имя артефакта, второе чтение которого отдаёт пустоту. */
  emptyOnSecondRead: null as string | null,
  reads: new Map<string, number>(),
}));

vi.mock("@/modules/digital-profile/workflow/step-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requeueStepsForRebuild: (input: { jobId: string; names: readonly string[] }) =>
    spies.requeueStepsForRebuild(input),
  requeueStep: (input: { jobId: string; name: string }) => spies.requeueStep(input),
  listPipelineSteps: async () => [
    {
      id: "s-4",
      caseId: "c",
      jobId: "j",
      name: "REPORT_PREPARE",
      position: 4,
      state: "FAILED",
      attempts: 1,
      maxAttempts: 40,
      nextRunAt: null,
      leaseOwner: null,
      leaseUntil: null,
      startedAt: null,
    },
  ],
}));

vi.mock("@/modules/digital-profile/services/unified-collection-job-store", async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  const write = orig.writeUnifiedArtifact as (...a: unknown[]) => Promise<unknown>;
  const read = orig.readUnifiedArtifact as (...a: unknown[]) => Promise<unknown>;
  return {
    ...orig,
    writeUnifiedArtifact: async (...a: unknown[]) => {
      if (spies.failWrite && a[2] === spies.failWrite) throw new Error("том недоступен");
      return await write(...a);
    },
    readUnifiedArtifact: async (...a: unknown[]) => {
      const name = String(a[2]);
      const n = (spies.reads.get(name) ?? 0) + 1;
      spies.reads.set(name, n);
      if (spies.emptyOnSecondRead === name && n >= 2) return null;
      return await read(...a);
    },
  };
});

const CASE = `unit-refused-wake-${Date.now()}`;
const NOW = new Date("2026-08-20T09:00:00.000Z");

async function seedFailedRunWithCollectedData(): Promise<string> {
  const store = await import("@/modules/digital-profile/services/unified-collection-job-store");
  const { seedUnifiedRebuildInputs } = await import("../fixtures/unified-rebuild-inputs");
  const { job } = await store.findOrCreateUnifiedCollectionJob({
    caseId: CASE,
    requestedBy: "unit-tester",
  });
  const seed = await seedUnifiedRebuildInputs({ caseId: CASE, unifiedJobId: job.unifiedJobId });
  await store.patchUnifiedCollectionJob(CASE, {
    ...seed,
    stage: "FAILED_TERMINAL",
    status: "FAILED",
    baseReportRunId: "base-run",
    startedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    enrichmentRunIds: ["e1", "e2", "e3", "e4", "e5"],
    lastError: "прогон остановлен: рендерер выбросил содержимое (стр. 11, 29)",
    lastErrorCode: "CONTENT_DROPPED_BY_RENDERER",
    completedAt: NOW.toISOString(),
  });
  return job.unifiedJobId;
}

describe("пробуждение конвейера принадлежит принятой работе", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    spies.requeueStepsForRebuild.mockClear();
    spies.requeueStep.mockClear();
    spies.failWrite = null;
    spies.emptyOnSecondRead = null;
    spies.reads.clear();
    const store = await import("@/modules/digital-profile/services/unified-collection-job-store");
    await store.deleteUnifiedCollectionJobForTests(CASE);
    rmSync(store.unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    const store = await import("@/modules/digital-profile/services/unified-collection-job-store");
    await store.deleteUnifiedCollectionJobForTests(CASE);
    rmSync(store.unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("принятая пересборка конвейер будит", async () => {
    const { rebuildUnifiedReport } = await import(
      "@/modules/digital-profile/services/unified-report-rebuild"
    );
    const jobId = await seedFailedRunWithCollectedData();

    const res = await rebuildUnifiedReport({
      caseId: CASE,
      jobId,
      actorId: "unit-tester",
      deps: { now: () => NOW },
    });

    expect(res.accepted).toBe(true);
    expect(spies.requeueStepsForRebuild).toHaveBeenCalledTimes(1);
    expect(spies.requeueStepsForRebuild.mock.calls[0]![0]).toMatchObject({
      names: ["COMPOSITE_MERGE", "REPORT_PREPARE"],
    });
  });

  it("пересборка, отказанная после взятия лизы, конвейер не будит", async () => {
    const { rebuildUnifiedReport } = await import(
      "@/modules/digital-profile/services/unified-report-rebuild"
    );
    const jobId = await seedFailedRunWithCollectedData();
    // Сбой записи снимка — «любой сбой записи» из BT: том Railway отвалился.
    spies.failWrite = "unified-rebuild-audit.json";

    await expect(
      rebuildUnifiedReport({ caseId: CASE, jobId, actorId: "unit-tester", deps: { now: () => NOW } })
    ).rejects.toThrow();

    expect(spies.requeueStepsForRebuild).not.toHaveBeenCalled();
  });

  it("восстановление, отказанное после взятия лизы, шаг не будит", async () => {
    const { recoverUnifiedOrionCollectionJob } = await import(
      "@/modules/digital-profile/services/unified-collection-recovery"
    );
    const jobId = await seedFailedRunWithCollectedData();
    // Годность проверяется дважды, до лизы и после. Между проверками манифест
    // пропал — повторная проверка отказывает уже внутри `try`.
    spies.emptyOnSecondRead = "base-collection-manifest.json";

    await expect(
      recoverUnifiedOrionCollectionJob({
        caseId: CASE,
        jobId,
        actorId: "unit-tester",
        deps: { now: () => NOW },
      })
    ).rejects.toThrow();

    expect(spies.requeueStep).not.toHaveBeenCalled();
  });
});
