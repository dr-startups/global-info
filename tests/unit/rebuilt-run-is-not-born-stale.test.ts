/**
 * Пересборка начинает отсчёт возраста заново.
 *
 * Сторож закрывает прогон, который не продвигался дольше шести часов, и меряет
 * возраст от `startedAt`. Пересборка эту отметку не трогала — а нажимают
 * «Пересобрать отчёт» как раз на прогоне, который простоял ночь. Первый же тик
 * пересборки видел бы возраст в восемь часов и закрывал её, не начав работы:
 * кнопка была бы разблокирована и бесполезна.
 *
 * Право работать отсчитывается от начала **текущей** попытки — ровно так же,
 * как `requeueStepsForRebuild` обнуляет `startedAt` у строк шагов.
 *
 * Офлайн: хранилище прогонов файловое, расписание отключено (`autoSchedule`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { rebuildUnifiedReport } from "@/modules/digital-profile/services/unified-report-rebuild";
import { UNIFIED_RUN_MAX_MS } from "@/modules/digital-profile/services/unified-orion-collection-orchestrator";
import {
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  unifiedJobDir,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import { seedUnifiedRebuildInputs } from "../fixtures/unified-rebuild-inputs";

const CASE = `unit-rebuild-age-${Date.now()}`;
const NOW = new Date("2026-08-20T09:00:00.000Z");
/** Прогон встал вчера вечером и простоял ночь — старше предела сторожа. */
const STARTED = new Date(NOW.getTime() - 10 * 60 * 60 * 1000).toISOString();

async function seedStaleRunWithCollectedData(): Promise<string> {
  const { job } = await findOrCreateUnifiedCollectionJob({
    caseId: CASE,
    requestedBy: "unit-tester",
  });
  const seed = await seedUnifiedRebuildInputs({
    caseId: CASE,
    unifiedJobId: job.unifiedJobId,
  });
  await patchUnifiedCollectionJob(CASE, {
    ...seed,
    stage: "FAILED_TERMINAL",
    status: "FAILED",
    startedAt: STARTED,
    lastError: "прогон остановлен: рендерер выбросил содержимое (стр. 11, 29)",
    lastErrorCode: "CONTENT_DROPPED_BY_RENDERER",
    warnings: ["STALE_NO_PROGRESS"],
    completedAt: NOW.toISOString(),
  });
  return job.unifiedJobId;
}

describe("возраст пересобранного прогона", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("пересборка не приходит в сторожа уже просроченной", async () => {
    const jobId = await seedStaleRunWithCollectedData();

    await rebuildUnifiedReport({
      caseId: CASE,
      jobId,
      actorId: "unit-tester",
      deps: { autoSchedule: false, now: () => NOW },
    });

    const job = await loadUnifiedCollectionJob(CASE);
    expect(job?.stage).toBe("COMPOSITE_MERGE");
    expect(NOW.getTime() - Date.parse(String(job?.startedAt))).toBeLessThan(UNIFIED_RUN_MAX_MS);
  });

  it("время создания прогона пересборкой не переписывается", async () => {
    // `createdAt` — это когда кейс начали собирать, и он остаётся историей
    // прогона; заново отсчитывается только право работать.
    const jobId = await seedStaleRunWithCollectedData();
    const before = await loadUnifiedCollectionJob(CASE);

    await rebuildUnifiedReport({
      caseId: CASE,
      jobId,
      actorId: "unit-tester",
      deps: { autoSchedule: false, now: () => NOW },
    });

    const after = await loadUnifiedCollectionJob(CASE);
    expect(after?.createdAt).toBe(before?.createdAt);
  });
});
