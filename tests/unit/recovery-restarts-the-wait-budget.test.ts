/**
 * Принятое восстановление начинает ожидание заново.
 *
 * Полная ветка восстановления обнуляла счётчик простоя при возобновлении
 * ингеста и рендера, а начало ожидания — только при ингесте. Идемпотентная
 * ветка (джоба уже на активной стадии) джобу не трогала: `pollAttempt: 40` и
 * начало ожидания двухчасовой давности переживали кнопку, и первый же опрос
 * после неё исчерпывал бюджет (прогон DPA-2026-0054, шаг 0074).
 *
 * Восстановление — решение человека, который видит очередь провайдера:
 * ожидание отсчитывается заново в любой ветке. Автоматическому повтору
 * попытки (шаг 0073) такого права по-прежнему нет.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { recoverUnifiedOrionCollectionJob } from "@/modules/digital-profile/services/unified-collection-recovery";
import {
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  loadUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  unifiedJobDir,
  writeUnifiedArtifact,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import type { UnifiedCollectionJob } from "@/modules/digital-profile/services/unified-collection-types";

const CASE = `unit-recover-wait-${Date.now()}`;
const NOW = new Date("2026-09-11T09:48:00.000Z");
const WAIT_STARTED = new Date(NOW.getTime() - 2 * 60 * 60 * 1000).toISOString();

async function seedStalledEnrichment(): Promise<string> {
  const { job } = await findOrCreateUnifiedCollectionJob({ caseId: CASE, requestedBy: "unit-tester" });
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
    stage: "ARSENKIN_ENRICHMENT",
    status: "WAITING",
    startedAt: WAIT_STARTED,
    baseReportRunId: "base-run",
    enrichmentRunIds: ["e1", "e2", "e3", "e4", "e5"],
    resumeCheckpoint: "ARSENKIN_RESULT_INGEST",
    // Опрос просрочен на час: иначе восстановление ответит «прогон идёт».
    nextPollAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
    pollAttempt: 40,
    enrichmentWaitStartedAt: WAIT_STARTED,
  } as Partial<UnifiedCollectionJob>);
  return job.unifiedJobId;
}

describe("бюджет ожидания после восстановления", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });
  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("счётчик простоя и начало ожидания отсчитываются заново", async () => {
    const jobId = await seedStalledEnrichment();
    const res = await recoverUnifiedOrionCollectionJob({
      caseId: CASE,
      jobId,
      actorId: "unit-tester",
      deps: { autoSchedule: false, now: () => NOW },
    });
    expect(res.accepted).toBe(true);
    const job = await loadUnifiedCollectionJob(CASE);
    expect(job?.pollAttempt ?? 0, `причина восстановления: ${res.recoveryReason}`).toBe(0);
    expect(job?.enrichmentWaitStartedAt ?? null).toBeNull();
  });
});
