/**
 * Пересборка не бросает оплаченные, но ещё не подведённые задачи Arsenkin.
 *
 * Точечный повтор (`unified-enrichment-targeted-retry.ts`) ставит задачу за
 * деньги, возвращает прогон в `ARSENKIN_ENRICHMENT/WAITING` с чекпоинтом
 * `ARSENKIN_RESULT_INGEST` и **не трогает** `compositeDatasetId`: набор первого
 * круга остаётся на джобе вместе со всеми тремя артефактами на диске. Когда
 * опрос выдыхается, `failRetryable` переводит прогон в `FAILED_RETRYABLE`, и по
 * данным он неотличим от готового к пересборке — пока не спросить, подведено ли
 * обогащение.
 *
 * Цена ошибки: кнопка «Пересобрать отчёт» рисуется выше кнопки восстановления,
 * а её нажатие снимает чекпоинт — оплаченные наблюдения были бы брошены, а
 * отчёт собран без них.
 *
 * Признак — именно неподведённое обогащение, а не чекпоинт: тот же
 * `ARSENKIN_RESULT_INGEST` ставит любой упавший тик (`persistUnifiedTickFailure`),
 * в том числе на подготовке, где пересборка и есть верное действие.
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
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";
import { seedUnifiedRebuildInputs } from "../fixtures/unified-rebuild-inputs";

const CASE = `unit-rebuild-vs-ingest-${Date.now()}`;

/** Состояние обогащения ровно в той полноте, какую читают ворота. */
function enrichmentState(complete: boolean): UnifiedCollectionJob["arsenkinEnrichmentState"] {
  return { enrichmentComplete: complete } as UnifiedCollectionJob["arsenkinEnrichmentState"];
}

async function eligibilityFor(patch: Partial<UnifiedCollectionJob>) {
  const { job } = await findOrCreateUnifiedCollectionJob({
    caseId: CASE,
    requestedBy: "unit-tester",
  });
  const seed = await seedUnifiedRebuildInputs({
    caseId: CASE,
    unifiedJobId: job.unifiedJobId,
  });
  await patchUnifiedCollectionJob(CASE, { ...seed, ...patch });
  return await evaluateUnifiedReportRebuildEligibility({
    caseId: CASE,
    job: await loadUnifiedCollectionJob(CASE),
    requestedJobId: job.unifiedJobId,
    ignoreLease: true,
  });
}

describe("пересборка и неподведённое обогащение", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("оплаченная задача Arsenkin не подведена — пересборку не предлагают", async () => {
    const elig = await eligibilityFor({
      stage: "FAILED_RETRYABLE",
      status: "WAITING",
      resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
      arsenkinEnrichmentState: enrichmentState(false),
      lastError: "Опрос Arsenkin не удаётся 12 раз подряд",
      lastErrorCode: "ARSENKIN_POLL_ATTEMPTS_EXCEEDED",
    });

    expect(elig.rebuildAllowed).toBe(false);
    expect(elig.rebuildBlockerReason).toBe("ARSENKIN_INGEST_PENDING");
  });

  it("упавший тик подготовки с тем же чекпоинтом пересобирается", async () => {
    // Контроль: чекпоинт признаком не является. Обогащение подведено, отказ
    // случился после него — пересборка и есть верное действие.
    const elig = await eligibilityFor({
      stage: "FAILED_RETRYABLE",
      status: "WAITING",
      resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
      arsenkinEnrichmentState: enrichmentState(true),
      lastError: "unified tick failed",
      lastErrorCode: "UNIFIED_TICK_FAILED",
    });

    expect(elig.rebuildBlockerReason).toBeNull();
    expect(elig.rebuildAllowed).toBe(true);
  });

  it("прогон без состояния обогащения кнопку не теряет", async () => {
    // Контроль на противоположную ошибку: молчание — не «есть неподведённые
    // задачи». Требовать `enrichmentComplete === true` значило бы отнять
    // пересборку у прогонов, где обогащения не было вовсе.
    const elig = await eligibilityFor({
      stage: "REPORT_READY",
      status: "COMPLETED",
      arsenkinEnrichmentState: null,
      completedAt: new Date().toISOString(),
    });

    expect(elig.rebuildAllowed).toBe(true);
  });
});
