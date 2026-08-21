/**
 * Пересборка не предлагается, когда она уже провалилась ровно так же.
 *
 * `paidRecollectionRequired` возвращает `false`, как только доступна
 * пересборка, — правило верное: платить за то, что уже собрано, предлагать
 * нельзя. Но пересборка воспроизводит отказ, причина которого записана на
 * сборе: она читает те же строки из базы и падает тем же кодом. Счётчика
 * попыток у неё нет, поэтому цикл замкнут — провал, снова доступна, снова
 * провал, — и **платной кнопки оператор не видит никогда**.
 *
 * Владелец упёрся в это 20.08 на кейсе Прохорова: у него не осталось ни одного
 * действия, которое сработало бы (пункт CD).
 *
 * Признак «уже пробовали» лежит на самой джобе: неудачная попытка оставляет
 * `report-rebuild-failed:<код>`, а причину прогона возвращает на место
 * `restoreStateAfterFailedRebuild`. Совпали код прогона и код неудачной
 * попытки — пересборка воспроизведёт отказ, и предлагать её нечестно.
 *
 * Офлайн: хранилище прогонов файловое, во временном каталоге репозитория.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { evaluateUnifiedReportRebuildEligibility } from "@/modules/digital-profile/services/unified-report-rebuild";
import { paidRecollectionRequired } from "@/modules/digital-profile/services/unified-action-policy";
import {
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  unifiedJobDir,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import { seedUnifiedRebuildInputs } from "../fixtures/unified-rebuild-inputs";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";

const CASE = `unit-rebuild-repeat-${Date.now()}`;
/** Код отказа кейса Прохорова: причина записана на сборе, пересборка её повторит. */
const CODE = "WIKIPEDIA_CHECK_ROWS_MISSING";

async function jobWith(patch: Partial<UnifiedCollectionJob>): Promise<UnifiedCollectionJob | null> {
  const { job } = await findOrCreateUnifiedCollectionJob({
    caseId: CASE,
    requestedBy: "unit-tester",
  });
  const seed = await seedUnifiedRebuildInputs({ caseId: CASE, unifiedJobId: job.unifiedJobId });
  await patchUnifiedCollectionJob(CASE, {
    stage: "FAILED_TERMINAL",
    status: "FAILED",
    lastError: "Пересборка отчёта отказана: нет строк проверки Википедии.",
    lastErrorCode: CODE,
    completedAt: new Date().toISOString(),
    ...seed,
    ...patch,
  });
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

describe("пересборка, которая пройти не может", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("первая попытка предлагается", async () => {
    const job = await jobWith({ warnings: [CODE] });
    const elig = await eligibilityOf(job);
    expect(elig.rebuildAllowed).toBe(true);
  });

  it("после провала тем же кодом не предлагается", async () => {
    const job = await jobWith({ warnings: [CODE, `report-rebuild-failed:${CODE}`] });
    const elig = await eligibilityOf(job);
    expect(elig.rebuildAllowed).toBe(false);
    expect(elig.rebuildBlockerReason).toBe("REBUILD_ALREADY_FAILED");
  });

  it("провал другим кодом пересборку не закрывает", async () => {
    // Отказ мог быть случайным — сорванной записью, недоступным рендерером.
    // Закрывает пересборку только повтор **той же** причины.
    const job = await jobWith({ warnings: [CODE, "report-rebuild-failed:RENDERER_UNAVAILABLE"] });
    const elig = await eligibilityOf(job);
    expect(elig.rebuildAllowed).toBe(true);
  });

  it("и тогда оператору наконец предлагается платный сбор", async () => {
    const job = await jobWith({ warnings: [CODE, `report-rebuild-failed:${CODE}`] });
    const elig = await eligibilityOf(job);
    expect(
      paidRecollectionRequired({
        preserved: true,
        recoveryAllowed: false,
        recoveryBlockerReason: "JOB_ALREADY_COMPLETED",
        rebuildAllowed: elig.rebuildAllowed,
        suggestionsMissingResult: false,
      })
    ).toBe(true);
  });
});
