/**
 * Пакет, собранный без раскроя, не выдаётся за раскроенный.
 *
 * Раскрой снимается мерой рендерера, и приложение поднимается раньше него:
 * службы Railway поднимаются по отдельности. Сборка, попавшая в это окно,
 * зовёт мерный прогон рендерера прошлой версии, записей таблиц не получает и
 * пишет пакеты выдачи сидовыми — три строки на лист. Рендерер догоняет, но
 * следующая пересборка того же отчёта берёт пакет **из кэша**: раскрой в
 * `inputHash` не входил, и ключ не менялся. Документ оставался с тремя
 * строками на листе до следующего подъёма версии содержимого — без отказа и
 * без телеметрии.
 */

import { describe, expect, it } from "vitest";
import {
  buildSectionPackForFragment,
  type FragmentKey,
  type SectionBuildContext,
} from "@/modules/digital-profile/orion-golden/deck-sections";
import { DECK_CONTENT_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/content-version";
import { tableCutKey } from "@/modules/digital-profile/orion-golden/deck-sections/measured-table-fit";
import { loadReport72DeckInputs } from "../../scripts/run-orion-deck-sections-report72";

const KEY: FragmentKey = "RU_SERP";
const SLOT = "p09_ru_serp_table";
const inputs = loadReport72DeckInputs();

/**
 * Раскрой на строки эталона-72: у «Яндекса» их 15, у Google — 14.
 *
 * Суммы обязаны сходиться со строками — раскрой, посчитанный не про этот набор,
 * построитель отвергает целиком и режет сидом.
 */
const CUT = new Map([
  [tableCutKey(SLOT, "YANDEX"), [8, 7]],
  [tableCutKey(SLOT, "GOOGLE"), [7, 7]],
]);

function makeCtx(extras: Partial<SectionBuildContext["extras"]> = {}): SectionBuildContext {
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
    buildLog: [],
    extras: {
      executiveSummary: inputs.executiveSummary as never,
      surfaceCollectionHints: inputs.surfaceCollectionHints,
      complianceScreenings: inputs.complianceScreenings,
      visualAssets: {},
      ...extras,
    },
  } as SectionBuildContext;
}

describe("раскрой таблиц — вход фрагмента, а не свойство прогона", () => {
  it("пакет, записанный сидовым, не переиспользуется, когда раскрой появился", () => {
    const seed = buildSectionPackForFragment(KEY, makeCtx());
    expect(seed.slides).toHaveLength(10);

    const buildLog: SectionBuildContext["buildLog"] = [];
    const rebuilt = buildSectionPackForFragment(KEY, {
      ...makeCtx({ tableCut: CUT }),
      previousPacks: new Map([[KEY, seed]]),
      buildLog,
    });

    expect(buildLog.map((l) => l.action)).toEqual(["REGENERATED"]);
    expect(rebuilt.slides).toHaveLength(4);
  });

  it("раскрой соседнего слота чужой пакет не обесценивает", () => {
    // Пакеты каждой страны хранятся порознь, и раскрой выдачи ОАЭ не повод
    // платить за пересборку российской: в ключ идут только слоты фрагмента.
    // Слот назван настоящий (`p26_uae_serp_table` из `CANONICAL_BASE_SLOTS`), а
    // не любой чужой: перепиши кто-нибудь фильтр в белый список слотов, тест с
    // выдуманным именем остался бы зелёным и про ОАЭ по-прежнему промолчал.
    const seed = buildSectionPackForFragment(KEY, makeCtx());
    const buildLog: SectionBuildContext["buildLog"] = [];
    buildSectionPackForFragment(KEY, {
      ...makeCtx({ tableCut: new Map([[tableCutKey("p26_uae_serp_table", "GOOGLE"), [7, 7]]]) }),
      previousPacks: new Map([[KEY, seed]]),
      buildLog,
    });
    expect(buildLog.map((l) => l.action)).toEqual(["REUSED_CACHE"]);
  });

  it("порядок страниц в раскрое ключа не двигает", () => {
    // Раскрой собирается обходом страниц черновой деки, и порядок страниц —
    // свойство прогона, а не содержимого раскроя. Тот же раскрой, встреченный
    // в другом порядке, обязан оставить пакет в кэше: иначе перестановка
    // страниц оплачивала бы стадию 2 заново, ничего не изменив в документе.
    const built = buildSectionPackForFragment(KEY, makeCtx({ tableCut: CUT }));
    const buildLog: SectionBuildContext["buildLog"] = [];
    buildSectionPackForFragment(KEY, {
      ...makeCtx({ tableCut: new Map([...CUT].reverse()) }),
      previousPacks: new Map([[KEY, built]]),
      buildLog,
    });
    expect(buildLog.map((l) => l.action)).toEqual(["REUSED_CACHE"]);
  });
});
