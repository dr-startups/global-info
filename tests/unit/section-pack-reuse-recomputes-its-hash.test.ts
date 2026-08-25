/**
 * Пакет, взятый из кэша, уезжает на диск со своим собственным хэшем.
 *
 * Ветка реюза возвращала прочитанный пакет дословно — вместе с `contentHash`,
 * посчитанным когда-то по другой формуле. Файл записывался заново, а хэш в нём
 * оставался чужим: рассогласование тихое, потому что внутри прогона хэш ни с
 * чем сохранённым не сравнивается. Пересчёт о собственные слайды приводит такой
 * пакет в согласие с самим собой за один прогон — без пересборки и без модели.
 */

import { describe, expect, it } from "vitest";
import {
  buildSectionPackForFragment,
  contentHashOf,
  CONTENT_HASH_REPAIRED,
  type FragmentKey,
  type SectionBuildContext,
  type SectionPackV2,
} from "@/modules/digital-profile/orion-golden/deck-sections";
import { DECK_CONTENT_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/content-version";
import { loadReport72DeckInputs } from "../../scripts/run-orion-deck-sections-report72";

/** Титульный фрагмент: аналитического входа у него нет, сборка дешёвая. */
const KEY: FragmentKey = "FRONT_MATTER_MAIN";
const inputs = loadReport72DeckInputs();

function makeCtx(): SectionBuildContext {
  return {
    caseId: inputs.caseId,
    reportRunId: inputs.reportRunId,
    sourceDatasetId: inputs.sourceDatasetId,
    contentVersion: DECK_CONTENT_VERSION,
    subject: { displayName: "Сергей Глинка", aliases: ["Sergey Glinka"] },
    bundle: inputs.mergedBundle,
    surfaceUnits: inputs.surfaceUnits,
    metricSnapshot: inputs.metricSnapshot,
    evidenceIndex: inputs.evidenceIndex,
    extras: {
      executiveSummary: inputs.executiveSummary as never,
      surfaceCollectionHints: inputs.surfaceCollectionHints,
      complianceScreenings: inputs.complianceScreenings,
      visualAssets: {},
    },
  };
}

describe("реюз пакета секции", () => {
  it("пересчитывает contentHash о слайды, которые реюзит, и не пересобирает пакет", () => {
    const fresh = buildSectionPackForFragment(KEY, { ...makeCtx(), buildLog: [] });
    expect(["READY", "EMPTY_VALID"]).toContain(fresh.status);

    // Пакет с боевого тома: слайды те же, хэш посчитан прежней формулой.
    const stale: SectionPackV2 = { ...fresh, contentHash: "sha256:legacy-formula-hash" };
    const buildLog: SectionBuildContext["buildLog"] = [];
    const reused = buildSectionPackForFragment(KEY, {
      ...makeCtx(),
      previousPacks: new Map([[KEY, stale]]),
      buildLog,
    });

    // Проверяется «переиспользовано, а не пересобрано»; точный состав записи
    // журнала держат две проверки ниже — на этой фикстуре в ней ещё стоит
    // предупреждение о починке хэша.
    expect(buildLog.map((l) => [l.fragmentKey, l.action])).toEqual([[KEY, "REUSED_CACHE"]]);
    expect(reused.slides).toEqual(stale.slides);
    expect(reused.generatedAt).toBe(stale.generatedAt);
    expect(reused.contentHash).toBe(contentHashOf(reused.slides));
    expect(reused.contentHash).not.toBe(stale.contentHash);
  });

  it("называет починку хэша в журнале сборки, а не молчит о ней", () => {
    /*
     * Пересчёт стирает единственный след того, что пакет на диске не сходился
     * сам с собой — а это либо форма прежней формулы, либо правка руками. След
     * должен остаться в артефакте прогона: `section-build-log.json` пишется из
     * этого журнала.
     */
    const fresh = buildSectionPackForFragment(KEY, { ...makeCtx(), buildLog: [] });
    const stale: SectionPackV2 = { ...fresh, contentHash: "sha256:legacy-formula-hash" };
    const buildLog: SectionBuildContext["buildLog"] = [];
    buildSectionPackForFragment(KEY, {
      ...makeCtx(),
      previousPacks: new Map([[KEY, stale]]),
      buildLog,
    });

    expect(buildLog[0]?.warning).toBe(`${CONTENT_HASH_REPAIRED}:sha256:legacy-formula-hash`);
  });

  it("о согласованном пакете в журнале молчит", () => {
    // Иначе предупреждение перестало бы что-либо значить: оно стояло бы на
    // каждом реюзе.
    const fresh = buildSectionPackForFragment(KEY, { ...makeCtx(), buildLog: [] });
    const buildLog: SectionBuildContext["buildLog"] = [];
    buildSectionPackForFragment(KEY, {
      ...makeCtx(),
      previousPacks: new Map([[KEY, fresh]]),
      buildLog,
    });

    expect(buildLog).toEqual([{ fragmentKey: KEY, action: "REUSED_CACHE" }]);
  });
});
