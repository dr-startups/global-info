/**
 * Входы пересборки на диске — так, как их оставляет сбор, доехавший до слияния.
 *
 * `stepComposite` пишет три файла, а потом патчит джобу ссылкой
 * `compositeDatasetId`: два действия одного шага, и здоровый прогон приходит к
 * подготовке с обоими. Расходятся они намеренно — восстановление подводки
 * Arsenkin снимает ссылку, оставляя файлы лежать, и это отдельное состояние со
 * своим тестом. Поэтому ссылка возвращается вызывающему: фикстура, писавшая
 * файлы и молчавшая о ссылке, изображала не тот случай, что имела в виду.
 */

import { writeUnifiedArtifact } from "@/modules/digital-profile/services/unified-collection-job-store";

export type UnifiedRebuildInputsSeed = {
  /** Идентификатор набора для патча джобы; `null` — слияния не было. */
  compositeDatasetId: string | null;
};

export async function seedUnifiedRebuildInputs(input: {
  caseId: string;
  unifiedJobId: string;
  /** `false` — сбор до слияния не дошёл: манифест базы есть, набора нет. */
  merged?: boolean;
}): Promise<UnifiedRebuildInputsSeed> {
  const { caseId, unifiedJobId } = input;
  await writeUnifiedArtifact(caseId, unifiedJobId, "base-collection-manifest.json", {
    version: "base-collection-manifest-v1",
    caseId,
    unifiedJobId,
    baseReportRunId: "base-run",
    actualProviders: [{ providerId: "yandex", runtime: "real", status: "completed" }],
    realCollectionSufficient: true,
  });
  if (input.merged === false) return { compositeDatasetId: null };

  const compositeDatasetId = `composite-${unifiedJobId}`;
  await writeUnifiedArtifact(caseId, unifiedJobId, "report-data-binding.json", {
    version: "report-data-binding-v1",
    caseId,
    unifiedJobId,
    compositeDatasetId,
  });
  await writeUnifiedArtifact(caseId, unifiedJobId, "composite-serp-observations.json", {
    compositeDatasetId,
    provenance: { unifiedJobId },
    observations: [],
  });
  return { compositeDatasetId };
}
