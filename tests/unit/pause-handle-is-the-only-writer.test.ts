/**
 * Признак паузы выставляет ровно одна ручка.
 *
 * До шага 0027 `cancelRequested` во всём коде только инициализировался `false`
 * и проверялся: оркестратор его honors, хранилище переживает перезапуск, а
 * выставить было некому. Оператор не мог остановить идущий прогон иначе как
 * заплатив за новый сбор (пункт CC, вопрос владельца от 20.08).
 *
 * Годность считается одной функцией и для статуса, и для ручки: интерфейс не
 * должен показывать кнопку, которую сервер откажется исполнить.
 *
 * Офлайн: файловое хранилище прогонов во временном каталоге репозитория.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import {
  evaluateUnifiedPauseEligibility,
  pauseUnifiedCollectionRun,
  PAUSE_MARKER,
} from "@/modules/digital-profile/services/unified-collection-pause";
import {
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  unifiedJobDir,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";

const CASE = `unit-pause-handle-${Date.now()}`;

async function jobAt(patch: Partial<UnifiedCollectionJob>): Promise<UnifiedCollectionJob> {
  await findOrCreateUnifiedCollectionJob({ caseId: CASE, requestedBy: "unit-tester" });
  await patchUnifiedCollectionJob(CASE, patch);
  const job = await loadUnifiedCollectionJob(CASE);
  if (!job) throw new Error("джоба не завелась");
  return job;
}

describe("годность паузы", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("идущий прогон остановить можно", async () => {
    const job = await jobAt({ stage: "ARSENKIN_ENRICHMENT", status: "WAITING" });
    expect(evaluateUnifiedPauseEligibility(job)).toEqual({
      pauseAllowed: true,
      pauseBlockerReason: null,
    });
  });

  it("завершённый прогон останавливать нечего", async () => {
    const job = await jobAt({ stage: "REPORT_READY", status: "COMPLETED" });
    expect(evaluateUnifiedPauseEligibility(job).pauseAllowed).toBe(false);
    expect(evaluateUnifiedPauseEligibility(job).pauseBlockerReason).toBe(
      "STAGE_NOT_RUNNING:REPORT_READY"
    );
  });

  it("дважды не останавливают", async () => {
    const job = await jobAt({
      stage: "ARSENKIN_ENRICHMENT",
      status: "WAITING",
      cancelRequested: true,
    });
    expect(evaluateUnifiedPauseEligibility(job)).toEqual({
      pauseAllowed: false,
      pauseBlockerReason: "ALREADY_PAUSED",
    });
  });
});

describe("ручка паузы", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("поднимает признак и помечает, что остановил человек", async () => {
    const job = await jobAt({ stage: "BASE_COLLECTION", status: "RUNNING" });
    const res = await pauseUnifiedCollectionRun({
      caseId: CASE,
      jobId: job.unifiedJobId,
      actorId: "unit-tester",
    });
    expect(res.accepted).toBe(true);

    const after = await loadUnifiedCollectionJob(CASE);
    expect(after?.cancelRequested).toBe(true);
    expect(after?.warnings).toContain(PAUSE_MARKER);
    // Стадию ручка не трогает: в `CANCELLED` прогон переводит ближайший тик,
    // чтобы пауза не обрывала шаг посередине и не спорила с лизой.
    expect(after?.stage).toBe("BASE_COLLECTION");
  });

  it("завершённый прогон останавливать отказывается", async () => {
    const job = await jobAt({ stage: "REPORT_READY", status: "COMPLETED" });
    await expect(
      pauseUnifiedCollectionRun({
        caseId: CASE,
        jobId: job.unifiedJobId,
        actorId: "unit-tester",
      })
    ).rejects.toThrow();
    const after = await loadUnifiedCollectionJob(CASE);
    expect(after?.cancelRequested).toBe(false);
  });

  it("чужой jobId не останавливает ничего", async () => {
    await jobAt({ stage: "BASE_COLLECTION", status: "RUNNING" });
    await expect(
      pauseUnifiedCollectionRun({ caseId: CASE, jobId: "unified-чужая", actorId: "unit-tester" })
    ).rejects.toThrow();
    const after = await loadUnifiedCollectionJob(CASE);
    expect(after?.cancelRequested).toBe(false);
  });
});
