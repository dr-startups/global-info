/**
 * У приостановленного прогона остаются кнопки.
 *
 * Решение владельца 21.08: отмена — это пауза. Значит, приостановленный прогон
 * и собирает отчёт из уже собранного, и продолжает сбор с места остановки.
 * Пока `CANCELLED` не входил в список улаженных стадий, пересборка отвечала
 * `JOB_NOT_COMPLETED`, а восстановление — `JOB_CANCELLED`: оплаченный сбор
 * становился недоступен, и оператору оставался только новый платный (пункт CC).
 *
 * Хранилище прогонов здесь настоящее (файловое), поэтому подмен модулей в файле
 * нет: мок `loadUnifiedCollectionJob` из соседнего файла отдавал бы чужой кейс.
 *
 * Офлайн: файловое хранилище во временном каталоге репозитория.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { evaluateUnifiedReportRebuildEligibility } from "@/modules/digital-profile/services/unified-report-rebuild";
import {
  evaluateUnifiedCollectionRecoveryEligibility,
  recoverUnifiedOrionCollectionJob,
} from "@/modules/digital-profile/services/unified-collection-recovery";
import {
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  unifiedJobDir,
  writeUnifiedArtifact,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import { seedUnifiedRebuildInputs } from "../fixtures/unified-rebuild-inputs";

/*
 * Конвейер шагов подменён: офлайн-контур в базу не ходит, а «где мы
 * остановились» восстановление спрашивает именно у строк шагов. Здесь они
 * такие, какими их оставляет пауза, — шаг обогащения остановлен кодом
 * `RUN_PAUSED`, следующие ещё не начинались.
 */
vi.mock("@/modules/digital-profile/workflow/step-store", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listPipelineSteps: async () => [
    {
      id: "s-1", caseId: "c", jobId: "j", name: "BASE_COLLECTION", position: 1,
      state: "DONE", attempts: 1, maxAttempts: 40, nextRunAt: null,
      leaseOwner: null, leaseUntil: null, inputHash: null, outputRef: null,
      lastError: null, lastErrorCode: null, startedAt: null,
    },
    {
      id: "s-2", caseId: "c", jobId: "j", name: "ARSENKIN_ENRICHMENT", position: 2,
      state: "DONE", attempts: 1, maxAttempts: 40, nextRunAt: null,
      leaseOwner: null, leaseUntil: null, inputHash: null, outputRef: null,
      lastError: null, lastErrorCode: null, startedAt: null,
    },
    {
      id: "s-3", caseId: "c", jobId: "j", name: "COMPOSITE_MERGE", position: 3,
      state: "DONE", attempts: 1, maxAttempts: 40, nextRunAt: null,
      leaseOwner: null, leaseUntil: null, inputHash: null, outputRef: null,
      lastError: null, lastErrorCode: null, startedAt: null,
    },
    {
      id: "s-4", caseId: "c", jobId: "j", name: "REPORT_PREPARE", position: 4,
      state: "FAILED", attempts: 1, maxAttempts: 40, nextRunAt: null,
      leaseOwner: null, leaseUntil: null, inputHash: null, outputRef: null,
      lastError: "Прогон приостановлен оператором", lastErrorCode: "RUN_PAUSED",
      startedAt: null,
    },
  ],
  requeueStep: async () => true,
}));

const CASE = `unit-pause-buttons-${Date.now()}`;
const NOW = new Date("2026-08-21T09:00:00.000Z");

async function seedPaused() {
  const { job } = await findOrCreateUnifiedCollectionJob({
    caseId: CASE,
    requestedBy: "unit-tester",
  });
  const seed = await seedUnifiedRebuildInputs({ caseId: CASE, unifiedJobId: job.unifiedJobId });
  // Восстановление спрашивает у манифеста, что база действительно собрана:
  // фикстура пересборки об объёме сбора молчит, ей это не нужно.
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
    ...seed,
    stage: "CANCELLED",
    status: "CANCELLED",
    baseReportRunId: "base-run",
    enrichmentRunIds: ["e1", "e2", "e3", "e4", "e5"],
    cancelRequested: true,
    completedAt: NOW.toISOString(),
  });
  return await loadUnifiedCollectionJob(CASE);
}

describe("приостановленный прогон и его кнопки", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("отчёт из уже собранного собрать можно", async () => {
    const job = await seedPaused();
    const elig = await evaluateUnifiedReportRebuildEligibility({
      caseId: CASE,
      job,
      requestedJobId: job?.unifiedJobId ?? null,
      ignoreLease: true,
      autoResumePending: false,
    });
    expect(elig).toEqual({ rebuildAllowed: true, rebuildBlockerReason: null });
  });

  it("сбор можно продолжить: пауза восстановлению не мешает", async () => {
    const job = await seedPaused();
    const elig = await evaluateUnifiedCollectionRecoveryEligibility({
      caseId: CASE,
      job,
      now: NOW,
      ignoreLease: true,
    });
    expect(elig.recoveryBlockerReason).not.toBe("JOB_CANCELLED");
    expect(elig.recoveryAllowed).toBe(true);
  });

  it("возобновление снимает паузу", async () => {
    /*
     * Без этого первый же тик увидел бы признак и остановил прогон снова:
     * кнопка «Продолжить» нажималась бы, а прогон стоял. Признак снимает
     * именно возобновление — оно и есть решение человека продолжить.
     */
    const job = await seedPaused();
    const res = await recoverUnifiedOrionCollectionJob({
      caseId: CASE,
      jobId: job!.unifiedJobId,
      actorId: "unit-tester",
      deps: { autoSchedule: false, now: () => NOW },
    });
    expect(res.accepted).toBe(true);

    const after = await loadUnifiedCollectionJob(CASE);
    expect(after?.cancelRequested).toBe(false);
    expect(after?.stage).not.toBe("CANCELLED");
  });
});
