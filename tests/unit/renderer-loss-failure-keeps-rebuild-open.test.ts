/**
 * Отказ ворот телеметрии не запирает оплаченный сбор.
 *
 * `CONTENT_DROPPED_BY_RENDERER` и `RENDER_TELEMETRY_MISSING` наступают после
 * того, как сбор закончен и оплачен: данные целы, испорчен только документ.
 * Пока эти коды не опознаются как послесборочные, прогон уходит в
 * `FAILED_TERMINAL`, пересборка отвечает `JOB_NOT_COMPLETED` — и оператору
 * остаётся кнопка «начать новый аудит с повторным сбором», то есть заплатить
 * за сбор заново из-за потерянной карточки.
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
import { isPostCollectionFailure } from "@/modules/digital-profile/services/unified-post-collection-failure";
import { evaluateUnifiedReportRebuildEligibility } from "@/modules/digital-profile/services/unified-report-rebuild";
import {
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  unifiedJobDir,
  writeUnifiedArtifact,
} from "@/modules/digital-profile/services/unified-collection-job-store";

const CASE = `unit-rebuild-after-loss-${Date.now()}`;

/** Прогон, доехавший до рендера и упавший на воротах телеметрии. */
async function failedAfterRender(code: string): Promise<string> {
  const { job } = await findOrCreateUnifiedCollectionJob({
    caseId: CASE,
    requestedBy: "unit-tester",
  });
  const datasetId = `composite-${job.unifiedJobId}`;
  await writeUnifiedArtifact(CASE, job.unifiedJobId, "base-collection-manifest.json", {
    version: "base-collection-manifest-v1",
    caseId: CASE,
    unifiedJobId: job.unifiedJobId,
    baseReportRunId: "base-run",
    actualProviders: [{ providerId: "yandex", runtime: "real", status: "completed" }],
    realCollectionSufficient: true,
  });
  await writeUnifiedArtifact(CASE, job.unifiedJobId, "report-data-binding.json", {
    version: "report-data-binding-v1",
    caseId: CASE,
    unifiedJobId: job.unifiedJobId,
    compositeDatasetId: datasetId,
  });
  await writeUnifiedArtifact(CASE, job.unifiedJobId, "composite-serp-observations.json", {
    compositeDatasetId: datasetId,
    provenance: { unifiedJobId: job.unifiedJobId },
    observations: [],
  });
  await patchUnifiedCollectionJob(CASE, {
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

  it("оба кода опознаются как отказ после сбора", () => {
    expect(isPostCollectionFailure({ lastErrorCode: "CONTENT_DROPPED_BY_RENDERER" })).toBe(true);
    expect(isPostCollectionFailure({ lastErrorCode: "RENDER_TELEMETRY_MISSING" })).toBe(true);
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
    // Контроль: открыты именно послесборочные коды, а не все подряд —
    // пересобирать нечего, когда данных нет.
    const jobId = await failedAfterRender("ARSENKIN_ENRICHMENT_FAILED");
    const elig = await evaluateUnifiedReportRebuildEligibility({
      caseId: CASE,
      job: await loadUnifiedCollectionJob(CASE),
      requestedJobId: jobId,
      ignoreLease: true,
    });
    expect(elig.rebuildAllowed).toBe(false);
    expect(elig.rebuildBlockerReason).toBe("JOB_NOT_COMPLETED");
  });
});
