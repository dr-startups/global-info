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
import type { BaseCollectionManifest } from "@/modules/digital-profile/services/unified-collection-types";

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
  /*
   * Форма манифеста **проверяется**, а не утверждается: `satisfies` не даёт
   * фикстуре разойтись с типом молча — так у неё уже пропадали списки
   * идентификаторов, и потребители падали на итерации по `undefined`.
   */
  await writeUnifiedArtifact(caseId, unifiedJobId, "base-collection-manifest.json", {
    version: "base-collection-manifest-v1",
    caseId,
    unifiedJobId,
    capturedAt: "2026-08-18T00:00:00.000Z",
    baseReportRunId: "base-run",
    /*
     * Списки идентификаторов присутствуют всегда — пустые, если база ничего не
     * дала: их пишет сам `stepBaseCollection`. Без них манифест выглядел
     * похоже, но его потребители (покрытие наблюдений, ворота готовности
     * данных) падают на итерации по `undefined` — состояние, которого на живом
     * пути не бывает.
     */
    searchResultIds: [],
    searchSurfaceItemIds: [],
    baseCount: 0,
    actualProviders: [{ providerId: "yandex", runtime: "real", status: "completed" }],
    realCollectionSufficient: true,
  } satisfies BaseCollectionManifest);
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
    /*
     * Провайдеры базы названы, потому что живое слияние выводит их из
     * `actualProviders` манифеста (реальные и завершённые) и без них не бывает.
     * Набор без единого названного провайдера — форма, которой на живом пути
     * нет, а ворота готовности данных как раз её и проверяют.
     */
    provenance: {
      unifiedJobId,
      baseProviders: ["yandex"],
      baseSearchResultIds: [],
      baseSearchSurfaceItemIds: [],
    },
    observations: [],
  });
  return { compositeDatasetId };
}
