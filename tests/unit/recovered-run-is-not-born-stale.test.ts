/**
 * Восстановление начинает отсчёт возраста заново.
 *
 * Сторож закрывает прогон, не двигавшийся дольше шести часов, и меряет возраст
 * от `startedAt`. Восстановление эту отметку не трогало — а нажимают
 * «Возобновить рендер» ровно на прогоне, который простоял ночь: восстановление
 * переводит его в `ORION_PREPARE/WAITING` и тут же зовёт тик, а первое, что
 * делает тик, — возрастные ворота. Прогон умирал, не начав работы, и, поскольку
 * восстановление уже обнулило код отказа, сторож писал `STALE_NO_PROGRESS` —
 * первопричина терялась целиком.
 *
 * Право работать отсчитывается от начала текущей попытки; `createdAt` остаётся
 * историей прогона.
 *
 * Офлайн: файловое хранилище, конвейера шагов нет (отвечает прежняя эвристика),
 * базовый прогон переиспользуется — восстановление с чекпоинта рендера в базу
 * не ходит.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { recoverUnifiedOrionCollectionJob } from "@/modules/digital-profile/services/unified-collection-recovery";
import { UNIFIED_RUN_MAX_MS } from "@/modules/digital-profile/services/unified-orion-collection-orchestrator";
import {
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  unifiedJobDir,
  writeUnifiedArtifact,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";

const CASE = `unit-recover-age-${Date.now()}`;
const NOW = new Date("2026-08-20T09:00:00.000Z");
const STARTED = new Date(NOW.getTime() - 10 * 60 * 60 * 1000).toISOString();

/** Прогон владельца: ворота рендерера, ночь простоя, сбор цел. */
async function seedStaleRenderFailure(): Promise<string> {
  const { job } = await findOrCreateUnifiedCollectionJob({
    caseId: CASE,
    requestedBy: "unit-tester",
  });
  await writeUnifiedArtifact(CASE, job.unifiedJobId, "base-collection-manifest.json", {
    version: "base-collection-manifest-v1",
    caseId: CASE,
    unifiedJobId: job.unifiedJobId,
    baseReportRunId: "base-run",
    searchResultIds: ["sr-1", "sr-2"],
    baseCount: 2,
    actualProviders: [{ providerId: "yandex", runtime: "real", status: "completed" }],
    realCollectionSufficient: true,
  });
  await patchUnifiedCollectionJob(CASE, {
    stage: "FAILED_TERMINAL",
    status: "FAILED",
    startedAt: STARTED,
    baseReportRunId: "base-run",
    compositeDatasetId: `composite-${job.unifiedJobId}`,
    enrichmentRunIds: ["e1", "e2", "e3", "e4", "e5"],
    arsenkinEnrichmentState: {
      enrichmentComplete: true,
    } as UnifiedCollectionJob["arsenkinEnrichmentState"],
    lastError: "прогон остановлен: рендерер выбросил содержимое (стр. 11, 29)",
    lastErrorCode: "CONTENT_DROPPED_BY_RENDERER",
    completedAt: NOW.toISOString(),
  });
  return job.unifiedJobId;
}

describe("возраст восстановленного прогона", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("восстановление не приходит в сторожа уже просроченным", async () => {
    const jobId = await seedStaleRenderFailure();

    const res = await recoverUnifiedOrionCollectionJob({
      caseId: CASE,
      jobId,
      actorId: "unit-tester",
      deps: { autoSchedule: false, now: () => NOW },
    });
    expect(res.recoveryReason).toBe("RENDER_RESUME");

    const job = await loadUnifiedCollectionJob(CASE);
    expect(NOW.getTime() - Date.parse(String(job?.startedAt))).toBeLessThan(UNIFIED_RUN_MAX_MS);
  });
});
