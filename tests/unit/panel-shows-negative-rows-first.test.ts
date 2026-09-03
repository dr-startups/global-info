/**
 * Негативная строка панели видна, а не спрятана за десятой.
 *
 * Отчёт 83 (DPA-2026-0050): «Россия — подсказки Яндекса: 1 негативная
 * формулировка», а на панели её нет — панель брала первые десять строк в
 * порядке сбора, и «судимости» стояли дальше. Красная строка с меткой
 * «нежелательный» у панели есть; ей просто не доставалась негативная строка.
 *
 * Здесь же — словарь: «судимости» и «криминал» в подсказке — негативные
 * формулировки, обе (решение владельца 03.09.2026, В1 плана 0053).
 */

import { describe, expect, it } from "vitest";
import { buildCanonicalVisualAssets } from "@/modules/digital-profile/services/canonical-visual-assets";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

const SUBJECT = "Кремлёв Умар Назарович";

function suggestion(i: number, title: string): RawInventoryItem {
  return {
    inventoryId: `sug-${i}`,
    caseId: "case-1",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "topvisor-yandex",
    region: "RU",
    query: SUBJECT,
    collectedAt: "2026-09-03T00:00:00.000Z",
    evidenceType: "suggestion",
    title,
    snippet: "",
    sourceUrl: `topvisor://suggestion/${i}`,
    rawMetadata: { engine: "YANDEX", surface: "autocomplete", provider: "topvisor-yandex" },
  } as unknown as RawInventoryItem;
}

const NEUTRAL = [
  "кремлев умар назарович биография",
  "умар назарович кремлев личная жизнь",
  "кремлев умар назарович федерация",
  "кремлев умар назарович биография национальность",
  "бокс кремлев умар назарович",
  "кремлев умар назарович федерация бокса",
  "умар назарович кремлев фамилия",
  "умар назарович кремлев википедия",
  "умар назарович кремлев настоящая фамилия",
  "умар назарович кремлев кто по национальности",
  "кремлев умар назарович рольф",
];

async function yandexPanelRows(titles: string[]) {
  const visuals = await buildCanonicalVisualAssets({
    subjectName: SUBJECT,
    items: titles.map((t, i) => suggestion(i + 1, t)),
    allowImagePreviewNetwork: false,
  });
  return (visuals.visualAssets.p11_ru_suggestions_yandex ?? []).flatMap((a) => a.visibleItems ?? []);
}

describe("панель подсказок", () => {
  it("негативная строка из хвоста набора рисуется первой и красной", async () => {
    const rows = await yandexPanelRows([...NEUTRAL, "кремлев умар назарович уголовное дело"]);
    expect(rows).toHaveLength(10);
    expect(rows[0]?.title).toBe("кремлев умар назарович уголовное дело");
    expect(rows[0]?.adverse).toBe(true);
    // Остальные — в порядке сбора, как их видит пользователь поисковика.
    expect(rows.slice(1).map((r) => r.title)).toEqual(NEUTRAL.slice(0, 9));
  });

  it("«судимости» и «криминал» — обе негативные формулировки", async () => {
    const rows = await yandexPanelRows([
      ...NEUTRAL.slice(0, 8),
      "умар назарович кремлев судимости",
      "кремлев умар назарович криминал",
    ]);
    const adverse = rows.filter((r) => r.adverse).map((r) => r.title);
    expect(adverse).toEqual(["умар назарович кремлев судимости", "кремлев умар назарович криминал"]);
  });
});
