/**
 * Годность пересборки решают собранные данные, а не имя кода отказа.
 *
 * Наблюдалось у владельца 19.08: прогон встал на воротах
 * `CONTENT_DROPPED_BY_RENDERER`, простоял ночь, и сторож возраста закрыл его
 * кодом `STALE_NO_PROGRESS`. Этого кода нет в списке «отказов после сбора» —
 * пересборка ответила `JOB_NOT_COMPLETED`, и единственной кнопкой остался новый
 * платный сбор поверх уже оплаченного.
 *
 * Список кодов был вторым ответом на вопрос «цел ли сбор». Настоящий ответ
 * лежит ниже по функции: манифест, привязка и составной набор существуют и
 * сходятся по происхождению. Стадия и статус отвечают на другой вопрос — «идёт
 * ли работа прямо сейчас», и он остаётся.
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
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";

const CASE = `unit-rebuild-by-data-${Date.now()}`;

async function jobWith(
  patch: Partial<UnifiedCollectionJob>,
  opts: { merged: boolean } = { merged: true }
): Promise<UnifiedCollectionJob | null> {
  const { job } = await findOrCreateUnifiedCollectionJob({
    caseId: CASE,
    requestedBy: "unit-tester",
  });
  const seed = await seedUnifiedRebuildInputs({
    caseId: CASE,
    unifiedJobId: job.unifiedJobId,
    merged: opts.merged,
  });
  await patchUnifiedCollectionJob(CASE, { ...seed, ...patch });
  return await loadUnifiedCollectionJob(CASE);
}

async function eligibilityOf(job: UnifiedCollectionJob | null) {
  return await evaluateUnifiedReportRebuildEligibility({
    caseId: CASE,
    job,
    requestedJobId: job?.unifiedJobId ?? null,
    ignoreLease: true,
  });
}

describe("годность пересборки решают собранные данные", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("прогон, закрытый сторожем по возрасту, пересобирается", async () => {
    // Ровно состояние джобы владельца: ворота рендерера, ночь простоя, поверх —
    // возрастной останов. Оплаченный сбор при этом цел.
    const job = await jobWith({
      stage: "FAILED_TERMINAL",
      status: "FAILED",
      lastError: "Прогон не продвигался дольше шести часов и остановлен.",
      lastErrorCode: "STALE_NO_PROGRESS",
      warnings: ["STALE_NO_PROGRESS"],
      completedAt: new Date().toISOString(),
    });

    const elig = await eligibilityOf(job);

    expect(elig.rebuildBlockerReason).toBeNull();
    expect(elig.rebuildAllowed).toBe(true);
  });

  it("незнакомый код отказа целый сбор не запирает", async () => {
    // Список кодов старел молча: каждые новые ворота запирали пересборку до
    // тех пор, пока кто-нибудь не вспомнит дописать их имя.
    const job = await jobWith({
      stage: "FAILED_TERMINAL",
      status: "FAILED",
      lastError: "прогон остановлен: ворота, которых ещё не было",
      lastErrorCode: "SOME_FUTURE_GATE_FAILED",
      completedAt: new Date().toISOString(),
    });

    const elig = await eligibilityOf(job);

    expect(elig.rebuildAllowed).toBe(true);
  });

  it("прогон, не доехавший до слияния, отказывает по существу", async () => {
    // Пересобирать здесь нечего, и отказ обязан называть именно это, а не
    // «прогон не завершён»: сбор как раз завершился, только отказом.
    const job = await jobWith(
      {
        stage: "FAILED_TERMINAL",
        status: "FAILED",
        lastError: "обогащение Arsenkin не завершилось",
        lastErrorCode: "ARSENKIN_ENRICHMENT_FAILED",
        completedAt: new Date().toISOString(),
      },
      { merged: false }
    );

    const elig = await eligibilityOf(job);

    expect(elig.rebuildAllowed).toBe(false);
    expect(elig.rebuildBlockerReason).toBe("REBUILD_INPUTS_MISSING");
  });

  it("прогон, который ещё работает, пересобирать не предлагают", async () => {
    // Ложное срабатывание стоит дороже отказа: подготовка идёт, входы на месте,
    // и разрешённая пересборка увела бы живой прогон на второй круг.
    const job = await jobWith({
      stage: "ORION_PREPARE",
      status: "WAITING",
    });

    const elig = await eligibilityOf(job);

    expect(elig.rebuildAllowed).toBe(false);
    expect(elig.rebuildBlockerReason).toBe("JOB_NOT_COMPLETED");
  });

  it("исполняемая прямо сейчас стадия пересборку не открывает", async () => {
    const job = await jobWith({
      stage: "COMPOSITE_MERGE",
      status: "RUNNING",
    });

    const elig = await eligibilityOf(job);

    expect(elig.rebuildAllowed).toBe(false);
    expect(elig.rebuildBlockerReason).toBe("JOB_NOT_COMPLETED");
  });

  it("прогон, ждущий новых наблюдений Arsenkin, пересобирать рано", async () => {
    /*
     * Восстановление подводки Arsenkin снимает `compositeDatasetId` и метит
     * составной набор устаревшим: отчёт положено пересобирать после того, как
     * наблюдения доедут. Файлы прошлого слияния при этом остаются лежать, и
     * без вопроса «а считает ли прогон этот набор текущим» пересборка
     * предложилась бы поверх них — до подводки, ради которой и восстанавливали.
     */
    const job = await jobWith({
      stage: "FAILED_RETRYABLE",
      status: "WAITING",
      compositeDatasetId: null,
      resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
      lastError: "подводка Arsenkin не завершилась",
      lastErrorCode: "ARSENKIN_INGEST_FAILED",
    });

    const elig = await eligibilityOf(job);

    expect(elig.rebuildAllowed).toBe(false);
    expect(elig.rebuildBlockerReason).toBe("COMPOSITE_NOT_CURRENT");
  });

  it("завершённая стадия в статусе RUNNING пересборку не открывает", async () => {
    // Стадия говорит «кончено», статус — «исполняется прямо сейчас». Верить
    // надо тому, что означает работу: патч, поставивший стадию, мог не
    // доехать до статуса.
    const job = await jobWith({
      stage: "FAILED_TERMINAL",
      status: "RUNNING",
      lastErrorCode: "CONTENT_DROPPED_BY_RENDERER",
    });

    const elig = await eligibilityOf(job);

    expect(elig.rebuildAllowed).toBe(false);
    expect(elig.rebuildBlockerReason).toBe("JOB_NOT_COMPLETED");
  });

  it("готовый отчёт по-прежнему пересобирается", async () => {
    const job = await jobWith({
      stage: "REPORT_READY",
      status: "COMPLETED",
      completedAt: new Date().toISOString(),
    });

    const elig = await eligibilityOf(job);

    expect(elig.rebuildAllowed).toBe(true);
  });
});
