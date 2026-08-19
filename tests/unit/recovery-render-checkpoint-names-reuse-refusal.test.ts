/**
 * Чекпоинт рендера, который пишет восстановление, называет причину отказа.
 *
 * `RENDER_RESUME` заранее проверяет, годится ли собранная дека, и пишет в
 * `render-checkpoint.json` либо `READY` с хэшем сборки, либо `NEEDS_ASSEMBLY`.
 * Второй ответ был безымянным: оператор видел, что «повтор рендера» превратился
 * в полную пересборку, но не почему — а причин пять, и лечатся они по-разному.
 *
 * Офлайн: хранилище прогонов файловое, во временном каталоге репозитория.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  patchUnifiedCollectionJob,
  unifiedArtifactsDir,
  unifiedJobDir,
  writeUnifiedArtifact,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import { recoverUnifiedOrionCollectionJob } from "@/modules/digital-profile/services/unified-collection-recovery";
import { seedAssembledDeckDir } from "../fixtures/tiny-canonical-prepare";

const CASE = `unit-render-resume-checkpoint-${Date.now()}`;

type Checkpoint = {
  status?: string;
  assemblyHash?: string | null;
  reuseRefusedReason?: string | null;
};

/**
 * Прогон без конвейера шагов, упавший на рендере: сбор оплачен и цел, дека
 * собрана. Ровно то состояние, в котором оператору предлагают повтор рендера.
 */
async function jobFailedOnRender(
  deckOf: (compositeDatasetId: string) => string | null
): Promise<string> {
  const { job } = await findOrCreateUnifiedCollectionJob({
    caseId: CASE,
    requestedBy: "unit-tester",
  });
  const compositeDatasetId = `composite-${job.unifiedJobId}`;
  await writeUnifiedArtifact(CASE, job.unifiedJobId, "base-collection-manifest.json", {
    version: "base-collection-manifest-v1",
    caseId: CASE,
    unifiedJobId: job.unifiedJobId,
    baseReportRunId: "base-run",
    baseCount: 3,
    actualProviders: [{ providerId: "yandex", runtime: "real", status: "completed" }],
    realCollectionSufficient: true,
  });
  await writeUnifiedArtifact(CASE, job.unifiedJobId, "report-data-binding.json", {
    version: "report-data-binding-v1",
    caseId: CASE,
    unifiedJobId: job.unifiedJobId,
    compositeDatasetId,
  });
  const deckDatasetId = deckOf(compositeDatasetId);
  if (deckDatasetId) {
    // Дека снимается с настоящей подготовки: годность считается по её
    // собственным полям и штампу приёмки, слепить её литералами нельзя.
    await seedAssembledDeckDir({
      artifactsDir: unifiedArtifactsDir(CASE, job.unifiedJobId),
      caseId: CASE,
      datasetId: deckDatasetId,
    });
  }
  await patchUnifiedCollectionJob(CASE, {
    stage: "FAILED_TERMINAL",
    status: "FAILED",
    baseReportRunId: "base-run",
    enrichmentRunIds: ["e1", "e2", "e3", "e4", "e5"],
    compositeDatasetId,
    lastError: "render failed",
    lastErrorCode: "RENDER_FAILED",
    completedAt: new Date().toISOString(),
  });
  return job.unifiedJobId;
}

async function recoverAndReadCheckpoint(jobId: string): Promise<Checkpoint> {
  const res = await recoverUnifiedOrionCollectionJob({
    caseId: CASE,
    jobId,
    actorId: "unit-tester",
    deps: { autoSchedule: false },
  });
  expect(res.recoveryReason).toBe("RENDER_RESUME");
  return JSON.parse(
    readFileSync(join(unifiedArtifactsDir(CASE, jobId), "render-checkpoint.json"), "utf8")
  ) as Checkpoint;
}

describe("чекпоинт возобновления с рендера", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("деки нет вовсе: NEEDS_ASSEMBLY с причиной", async () => {
    const jobId = await jobFailedOnRender(() => null);
    const cp = await recoverAndReadCheckpoint(jobId);
    expect(cp.status).toBe("NEEDS_ASSEMBLY");
    expect(cp.reuseRefusedReason).toBe("missing-files");
  });

  it("целая дека того же набора даёт READY", async () => {
    const jobId = await jobFailedOnRender((datasetId) => datasetId);
    const cp = await recoverAndReadCheckpoint(jobId);
    expect(cp.status).toBe("READY");
    expect(cp.assemblyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(cp.reuseRefusedReason ?? null).toBeNull();
  });

  it("дека другого набора: NEEDS_ASSEMBLY с названной причиной", async () => {
    const foreign = "composite-cmreamy2t0002o30f29urzcog-59139ee6683b";
    const jobId = await jobFailedOnRender(() => foreign);
    const cp = await recoverAndReadCheckpoint(jobId);
    expect(cp.status).toBe("NEEDS_ASSEMBLY");
    expect(cp.assemblyHash ?? null).toBeNull();
    expect(cp.reuseRefusedReason).toContain("dataset-mismatch");
    expect(cp.reuseRefusedReason).toContain(foreign);
  });
});
