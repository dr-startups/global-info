/**
 * Пока конвейер собирается вернуться к работе сам, пересборку не предлагают.
 *
 * Правило шага 14: кнопка уместна ровно тогда, когда без неё ничего не
 * произойдёт. Кнопка восстановления его чтит (`recoveryNeedsUser`), а
 * пересборка отдавала `rebuildAllowed` сырым — и на `FAILED_RETRYABLE` с
 * назначенным повтором звала оператора делать работу оркестратора.
 *
 * Ответ на вопрос «продолжится ли само» в проекте один — `autoResumeState` по
 * строкам шагов. Ворота годности его спрашивают, а не заводят свой.
 *
 * Офлайн: таблицы шагов нет, поэтому проверяется и та ветка, где ответ
 * подаётся вызывающим (так делает статусный маршрут, уже посчитавший его для
 * кнопки восстановления).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { evaluateUnifiedReportRebuildEligibility } from "@/modules/digital-profile/services/unified-report-rebuild";
import {
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  unifiedJobDir,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import { seedUnifiedRebuildInputs } from "../fixtures/unified-rebuild-inputs";

const CASE = `unit-rebuild-vs-autoresume-${Date.now()}`;

async function retryableJob(): Promise<string> {
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
    stage: "FAILED_RETRYABLE",
    status: "WAITING",
    lastError: "database unavailable",
    lastErrorCode: "PREPARE_DB_UNAVAILABLE",
  });
  return job.unifiedJobId;
}

describe("пересборка и автоматическое продолжение", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("шаг вернётся по расписанию — кнопки нет", async () => {
    const jobId = await retryableJob();
    const elig = await evaluateUnifiedReportRebuildEligibility({
      caseId: CASE,
      job: await loadUnifiedCollectionJob(CASE),
      requestedJobId: jobId,
      ignoreLease: true,
      autoResumePending: true,
    });

    expect(elig.rebuildAllowed).toBe(false);
    expect(elig.rebuildBlockerReason).toBe("JOB_PROGRESSING");
  });

  it("возвращаться нечему — кнопка остаётся", async () => {
    const jobId = await retryableJob();
    const elig = await evaluateUnifiedReportRebuildEligibility({
      caseId: CASE,
      job: await loadUnifiedCollectionJob(CASE),
      requestedJobId: jobId,
      ignoreLease: true,
      autoResumePending: false,
    });

    expect(elig.rebuildAllowed).toBe(true);
  });

  it("недоступная таблица шагов кнопку не отнимает", async () => {
    // Ответ не подан, спросить не у кого (офлайн: делегата шагов у заглушки
    // Prisma нет) — считаем, что автоматического продолжения нет. Так же
    // поступает статусный маршрут.
    const jobId = await retryableJob();
    const elig = await evaluateUnifiedReportRebuildEligibility({
      caseId: CASE,
      job: await loadUnifiedCollectionJob(CASE),
      requestedJobId: jobId,
      ignoreLease: true,
    });

    expect(elig.rebuildAllowed).toBe(true);
  });
});
