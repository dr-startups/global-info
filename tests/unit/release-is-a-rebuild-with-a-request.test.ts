/**
 * Выпуск — это пересборка с запросом, а не пометка на готовом файле.
 *
 * Пометить выпуском уже собранный документ значило бы выпустить то, что
 * собрано до последних решений аналитика. Поэтому «Выпустить» идёт тем же
 * путём, что «Пересобрать отчёт», и оставляет на джобе запрос: сборка,
 * закончившись, превратит его в выпуск.
 *
 * Запрос лежит в данных, а не в памяти процесса: пересборка асинхронна, воркер
 * может смениться, а вопрос «эта сборка — выпуск или очередной черновик?»
 * задаётся уже после неё.
 *
 * Офлайн: хранилище прогонов файловое, расписание отключено.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { rebuildUnifiedReport } from "@/modules/digital-profile/services/unified-report-rebuild";
import {
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  unifiedJobDir,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import { seedUnifiedRebuildInputs } from "../fixtures/unified-rebuild-inputs";

const CASE = `unit-release-${Date.now()}`;
const NOW = new Date("2026-09-06T09:00:00.000Z");

async function seedReadyReport(): Promise<string> {
  const { job } = await findOrCreateUnifiedCollectionJob({
    caseId: CASE,
    requestedBy: "unit-tester",
  });
  const seed = await seedUnifiedRebuildInputs({ caseId: CASE, unifiedJobId: job.unifiedJobId });
  await patchUnifiedCollectionJob(CASE, {
    ...seed,
    stage: "REPORT_READY",
    status: "COMPLETED",
    progress: 1,
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    release: { state: "draft" },
  });
  return job.unifiedJobId;
}

describe("выпуск отчёта", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("запрос выпуска остаётся на джобе вместе с автором", async () => {
    const jobId = await seedReadyReport();
    await rebuildUnifiedReport({
      caseId: CASE,
      jobId,
      actorId: "analyst-1",
      requestRelease: true,
      deps: { autoSchedule: false, now: () => NOW },
    });
    const job = await loadUnifiedCollectionJob(CASE);
    expect(job?.release?.requested?.by).toBe("analyst-1");
    expect(job?.release?.state).toBe("draft");
  });

  it("обычная пересборка выпуска не запрашивает", async () => {
    const jobId = await seedReadyReport();
    await rebuildUnifiedReport({
      caseId: CASE,
      jobId,
      actorId: "analyst-1",
      deps: { autoSchedule: false, now: () => NOW },
    });
    const job = await loadUnifiedCollectionJob(CASE);
    expect(job?.release?.requested ?? null).toBeNull();
  });
});
