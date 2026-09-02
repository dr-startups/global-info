/**
 * Отказ ворот телеметрии не запирает оплаченный сбор.
 *
 * `CONTENT_DROPPED_BY_RENDERER` и `RENDER_TELEMETRY_MISSING` наступают после
 * того, как сбор закончен и оплачен: данные целы, испорчен только документ.
 * Пока пересборка отвечала `JOB_NOT_COMPLETED`, оператору оставалась кнопка
 * «начать новый аудит с повторным сбором», то есть заплатить за сбор заново
 * из-за потерянной карточки.
 *
 * Ровно на пересборке стоят два обещания шага: «после починки ёмкости
 * пересборка дорисует» и «ре-рендер после деплоя рендерера проходит» (окно, в
 * котором новое приложение работает со старым рендерером, ещё не отдающим
 * телеметрию).
 *
 * Офлайн: хранилище прогонов файловое, во временном каталоге репозитория.
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

const CASE = `unit-rebuild-after-loss-${Date.now()}`;

/**
 * Прогон, доехавший до рендера и упавший на воротах телеметрии.
 *
 * `collected: false` — сбор до слияния не дошёл: манифест базы есть, привязки и
 * составного набора нет. Писать их прогону, умершему на обогащении, значило бы
 * проверять состояние, которого живой путь не создаёт.
 */
async function failedAfterRender(code: string, collected = true): Promise<string> {
  const { job } = await findOrCreateUnifiedCollectionJob({
    caseId: CASE,
    requestedBy: "unit-tester",
  });
  const seed = await seedUnifiedRebuildInputs({
    caseId: CASE,
    unifiedJobId: job.unifiedJobId,
    merged: collected,
  });
  await patchUnifiedCollectionJob(CASE, {
    ...seed,
    stage: "FAILED_TERMINAL",
    status: "FAILED",
    lastError: `прогон остановлен: ${code}`,
    lastErrorCode: code,
    completedAt: new Date().toISOString(),
  });
  return job.unifiedJobId;
}

describe("отказ ворот телеметрии как послесборочный", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("пересборка открыта для прогона с потерянным содержимым", async () => {
    const jobId = await failedAfterRender("CONTENT_DROPPED_BY_RENDERER");
    const elig = await evaluateUnifiedReportRebuildEligibility({
      caseId: CASE,
      job: await loadUnifiedCollectionJob(CASE),
      requestedJobId: jobId,
      ignoreLease: true,
    });
    expect(elig.rebuildBlockerReason).toBeNull();
    expect(elig.rebuildAllowed).toBe(true);
  });

  it("пересборка открыта и после окна деплоя без телеметрии", async () => {
    const jobId = await failedAfterRender("RENDER_TELEMETRY_MISSING");
    const elig = await evaluateUnifiedReportRebuildEligibility({
      caseId: CASE,
      job: await loadUnifiedCollectionJob(CASE),
      requestedJobId: jobId,
      ignoreLease: true,
    });
    expect(elig.rebuildAllowed).toBe(true);
  });

  it("отказ самого сбора пересборкой по-прежнему не лечится", async () => {
    // Контроль: пересобирать нечего, когда данных нет. Отказ называет именно
    // это — раньше здесь стоял `JOB_NOT_COMPLETED` от списка кодов, и он был
    // вторым ответом на вопрос «цел ли сбор».
    const jobId = await failedAfterRender("ARSENKIN_ENRICHMENT_FAILED", false);
    const elig = await evaluateUnifiedReportRebuildEligibility({
      caseId: CASE,
      job: await loadUnifiedCollectionJob(CASE),
      requestedJobId: jobId,
      ignoreLease: true,
    });
    expect(elig.rebuildAllowed).toBe(false);
    expect(elig.rebuildBlockerReason).toBe("REBUILD_INPUTS_MISSING");
  });
});
