/**
 * Страница печатает то, что нарисовано на её панели.
 *
 * На приёмке под снимком панели с четырьмя связанными запросами стояло
 * «0 связанных запросов», под панелью с десятью подсказками — ни одной строки,
 * а таблица ТОП-20 состояла из одной строки: все ссылки сливались в одну
 * группу, потому что записи индекса были пустыми. Числа берутся с картинки,
 * поэтому проверяется именно это — от разрешения строк ассета до буллетов на
 * листе.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadReport72DeckInputs,
  loadReportAssets,
} from "../../scripts/run-orion-deck-sections-report72";
import { buildSectionPackForFragment } from "@/modules/digital-profile/orion-golden/deck-sections/section-builders";
import type { SectionBuildContext } from "@/modules/digital-profile/orion-golden/deck-sections/section-builders";
import type { ExecutiveSummaryExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { DECK_ASSET_FIXTURE_PATH } from "../../scripts/deck-asset-fixture-path";

const inputs = loadReport72DeckInputs();
const { visualAssets } = loadReportAssets(inputs.evidenceIndex);

function makeCtx(): SectionBuildContext {
  return {
    caseId: inputs.caseId,
    reportRunId: inputs.reportRunId,
    sourceDatasetId: inputs.sourceDatasetId,
    contentVersion: "test-content-version",
    subject: { displayName: "Сергей Глинка", aliases: ["Sergey Glinka"] },
    bundle: inputs.mergedBundle,
    surfaceUnits: inputs.surfaceUnits,
    metricSnapshot: inputs.metricSnapshot,
    evidenceIndex: inputs.evidenceIndex,
    extras: {
      executiveSummary: inputs.executiveSummary as unknown as ExecutiveSummaryExtras,
      surfaceCollectionHints: inputs.surfaceCollectionHints,
      visualAssets,
    },
    buildLog: [],
  };
}

/** Строки панели, у которых есть текст: только они попадают на страницу. */
function titledRows(slotId: string): number {
  return (visualAssets[slotId] ?? [])
    .flatMap((a) => a.visibleItems ?? [])
    .filter((v) => String(v.title ?? "").trim().length > 0).length;
}

describe("панели фикстуры дают титулованные строки", () => {
  it.each([
    ["p20_ru_related_1", 4],
    ["p21_ru_related_2", 3],
    ["p22_ru_related_3", 3],
    ["p11_ru_suggestions_yandex", 10],
    ["p12_ru_suggestions_google", 8],
    ["p31_uae_knowledge", 1],
    ["p32_uae_related", 1],
  ])("%s → %i строк с текстом", (slotId, expected) => {
    expect(titledRows(String(slotId))).toBe(Number(expected));
  });
});

describe("построители печатают строки панелей", () => {
  it("связанные запросы России — 4, 3 и 3 строки со своими ссылками", () => {
    const pack = buildSectionPackForFragment("RU_RELATED", makeCtx());
    const bySlot = new Map(pack.slides.map((s) => [s.baseSlotId, s]));
    expect(bySlot.get("p20_ru_related_1")?.content.bullets).toHaveLength(4);
    expect(bySlot.get("p21_ru_related_2")?.content.bullets).toHaveLength(3);
    expect(bySlot.get("p22_ru_related_3")?.content.bullets).toHaveLength(3);
    // Ссылки страницы — ровно ссылки её панели: клиент сверяет текст с
    // картинкой, и трасса ссылок обязана вести к тем же наблюдениям.
    const fixture = JSON.parse(readFileSync(DECK_ASSET_FIXTURE_PATH, "utf8")) as Array<{
      assetRef: string;
      evidenceRefs?: string[];
    }>;
    const panelRefs = new Set(fixture.find((a) => a.assetRef === "ru_related_1")?.evidenceRefs ?? []);
    expect(new Set(bySlot.get("p20_ru_related_1")?.evidenceRefs ?? [])).toEqual(panelRefs);
  });

  it("подсказки России — 10 у Яндекса и 8 у Google", () => {
    const pack = buildSectionPackForFragment("RU_SUGGESTIONS", makeCtx());
    const bySlot = new Map(pack.slides.map((s) => [s.baseSlotId, s]));
    expect(bySlot.get("p11_ru_suggestions_yandex")?.content.bullets).toHaveLength(10);
    expect(bySlot.get("p12_ru_suggestions_google")?.content.bullets).toHaveLength(8);
    // Сайдбар говорит о панели, а не «существенных материалов не обнаружено».
    expect(bySlot.get("p11_ru_suggestions_yandex")?.content.whatWasFound ?? "").toMatch(
      /на панели — 10 подсказок/iu
    );
  });

  it("таблица выдачи России многострочная и не длиннее ёмкости листа", () => {
    const pack = buildSectionPackForFragment("RU_SERP", makeCtx());
    const tables = pack.slides.map((s) => s.content.table?.rows?.length ?? 0);
    // Ровно одна строка — сигнатура слитых в одну группу пустых записей индекса.
    expect(tables.reduce((a, b) => a + b, 0)).toBeGreaterThan(1);
    for (const rows of tables) expect(rows).toBeLessThanOrEqual(12);
  });
});
