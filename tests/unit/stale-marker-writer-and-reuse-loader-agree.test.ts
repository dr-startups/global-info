/**
 * Стоп-маркер пишет один модуль, а читает другой — и имя файла у них общее.
 *
 * Инвалидация после дозагрузки наблюдений выводит имя маркера из имени
 * артефакта (`<имя>.stale.json`), загрузчик реюза по этому имени отказывает.
 * Пока обе стороны чеканили строку сами, переименование артефакта, смена
 * суффикса или переезд маркеров в подкаталог оставляли бы тесты зелёными, а
 * единственную защиту от реюза доингестной деки — выключенной.
 *
 * Поэтому здесь работают настоящий писатель и настоящий читатель, а не их
 * пересказ литералами.
 *
 * Офлайн: хранилище прогонов файловое, во временном каталоге репозитория.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import {
  deleteUnifiedCollectionJobForTests,
  findOrCreateUnifiedCollectionJob,
  unifiedArtifactsDir,
  unifiedJobDir,
} from "@/modules/digital-profile/services/unified-collection-job-store";
import { invalidateDownstreamAfterEnrichmentIngest } from "@/modules/digital-profile/services/unified-downstream-invalidation";
import { loadReusableAssembledDeck } from "@/modules/digital-profile/services/canonical-report-prepare";
import { seedAssembledDeckDir } from "../fixtures/tiny-canonical-prepare";

const CASE = `unit-stale-marker-agreement-${Date.now()}`;

/** Прогон с годной собранной декой в своём каталоге артефактов. */
async function jobWithAssembledDeck(): Promise<{
  artifactsDir: string;
  caseId: string;
  datasetId: string;
  job: Awaited<ReturnType<typeof findOrCreateUnifiedCollectionJob>>["job"];
}> {
  const { job } = await findOrCreateUnifiedCollectionJob({
    caseId: CASE,
    requestedBy: "unit-tester",
  });
  const artifactsDir = unifiedArtifactsDir(CASE, job.unifiedJobId);
  const ids = await seedAssembledDeckDir({
    artifactsDir,
    caseId: CASE,
    datasetId: `composite-${job.unifiedJobId}`,
  });
  return { artifactsDir, ...ids, job };
}

function load(artifactsDir: string, caseId: string, datasetId: string) {
  return loadReusableAssembledDeck({ artifactsDir, caseId, expectedDatasetId: datasetId });
}

describe("маркер инвалидации и загрузчик реюза сходятся именем", () => {
  beforeEach(async () => {
    process.env.UNIFIED_COLLECTION_JOB_STORE = "file";
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  afterEach(async () => {
    await deleteUnifiedCollectionJobForTests(CASE);
    rmSync(unifiedJobDir(CASE), { recursive: true, force: true });
  });

  it("до инвалидации дека реюзится", async () => {
    // Контроль: без него «отказ после инвалидации» ничего не доказывает —
    // отказать эта дека могла бы и по любой другой причине.
    const { artifactsDir, caseId, datasetId } = await jobWithAssembledDeck();
    expect(load(artifactsDir, caseId, datasetId).refusedReason).toBeNull();
  });

  it("маркер, написанный инвалидацией, отбивает реюз", async () => {
    const { artifactsDir, caseId, datasetId, job } = await jobWithAssembledDeck();
    await invalidateDownstreamAfterEnrichmentIngest({
      job,
      reason: "arsenkin-ingest-recovery",
    });
    expect(load(artifactsDir, caseId, datasetId).refusedReason).toBe("stale-marker");
  });
});
